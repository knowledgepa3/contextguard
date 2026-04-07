/**
 * Revive Manifest — provenance, verification, rehydration
 *
 * Every Revive run emits a manifest. The manifest is the contract that
 * makes "lossless" provable rather than vibes:
 *
 *   1. SHA-256 of the original source (so verify can detect drift)
 *   2. SHA-256 of the compacted output
 *   3. Every preserved anchor with its hash and original offsets
 *   4. Every dropped span with its hash, offsets, and a recovery hint
 *
 * `verify(manifest, original)` recomputes hashes and checks integrity.
 * `expand(manifest, spanId, original)` returns the original prose for a
 * single dropped span — this is how an agent that hits a dropped span at
 * runtime rehydrates just that one span instead of the whole session.
 *
 * @module revive/manifest
 */

import { createHash } from 'node:crypto';
import type { Anchor, AnchorKind } from './anchorExtractor.js';
import type { ProbativeWeight } from './probativeWeight.js';

// ─── Types ───────────────────────────────────────────────────────────

/** The Revive tier that produced a manifest. */
export type ReviveTier = 'sparkling' | 'electrolyte' | 'iv';

/** A span that was preserved verbatim in the compacted output. */
export interface PreservedSpan {
  id: number;
  kind: AnchorKind;
  /** ECV probative weight. */
  probativeWeight: ProbativeWeight;
  /** Offset in the ORIGINAL source. */
  originalStart: number;
  /** Exclusive end offset in the ORIGINAL source. */
  originalEnd: number;
  /** SHA-256 of the original text. */
  hash: string;
}

/** A span that was dropped or compressed. Recoverable via `expand`. */
export interface DroppedSpan {
  id: number;
  /** Offset in the ORIGINAL source. */
  originalStart: number;
  /** Exclusive end offset in the ORIGINAL source. */
  originalEnd: number;
  /** SHA-256 of the original text. */
  hash: string;
  /** Number of bytes dropped. */
  originalLength: number;
  /** Approximate token count of the dropped span. */
  approxTokens: number;
  /** Why this span was dropped (human-readable). */
  reason: string;
  /** Short recovery hint shown when expand is invoked. */
  recoveryHint: string;
}

/** The full Revive manifest. Stored at `.contextguard/revive-{ts}.json`. */
export interface ReviveManifest {
  /** Schema version of the manifest format. */
  schemaVersion: 1;
  /** Revive package version that produced this manifest. */
  reviveVersion: string;
  /** Tier used. */
  tier: ReviveTier;
  /** ISO 8601 timestamp of the run. */
  createdAt: string;
  /** SHA-256 of the original input. */
  originalHash: string;
  /** Length of the original input in bytes. */
  originalLength: number;
  /** Approximate original token count. */
  originalTokens: number;
  /** SHA-256 of the compacted output. */
  compactedHash: string;
  /** Length of the compacted output in bytes. */
  compactedLength: number;
  /** Approximate compacted token count. */
  compactedTokens: number;
  /** Anchors preserved verbatim, in original order. */
  preserved: PreservedSpan[];
  /** Spans dropped or compressed, in original order. */
  dropped: DroppedSpan[];
  /** Reduction percentage (0-1). */
  reductionPct: number;
  /** Optional path to the original source on disk. */
  originalPath?: string;
  /** Optional path to the compacted output on disk. */
  compactedPath?: string;
}

/** Result of running `verifyManifest`. */
export interface VerifyResult {
  ok: boolean;
  /** Number of preserved anchors that re-hashed correctly. */
  preservedOk: number;
  /** Number of preserved anchors that failed re-hash. */
  preservedFailed: number;
  /** Number of dropped spans that re-hashed correctly. */
  droppedOk: number;
  /** Number of dropped spans that failed re-hash. */
  droppedFailed: number;
  /** Whether the original source hash still matches. */
  originalIntact: boolean;
  /** Human-readable summary. */
  summary: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Build a manifest from the original source, the compacted output, the
 * preserved anchors, and the dropped span metadata.
 *
 * Callers (the tier compactors) supply the dropped-span metadata; this
 * function does the hashing, length, and percentage math.
 */
export function buildManifest(params: {
  tier: ReviveTier;
  reviveVersion: string;
  originalSource: string;
  compactedOutput: string;
  preservedAnchors: Anchor[];
  droppedSpans: Array<Omit<DroppedSpan, 'id' | 'hash' | 'originalLength'> & {
    text: string;
  }>;
  originalTokens: number;
  compactedTokens: number;
  originalPath?: string;
  compactedPath?: string;
}): ReviveManifest {
  const preserved: PreservedSpan[] = params.preservedAnchors.map((anchor, idx) => ({
    id: idx,
    kind: anchor.kind,
    probativeWeight: anchor.probativeWeight,
    originalStart: anchor.start,
    originalEnd: anchor.end,
    hash: anchor.hash,
  }));

  const dropped: DroppedSpan[] = params.droppedSpans.map((span, idx) => ({
    id: idx,
    originalStart: span.originalStart,
    originalEnd: span.originalEnd,
    hash: sha256(span.text),
    originalLength: span.text.length,
    approxTokens: span.approxTokens,
    reason: span.reason,
    recoveryHint: span.recoveryHint,
  }));

  const originalLength = params.originalSource.length;
  const compactedLength = params.compactedOutput.length;
  const reductionPct = params.originalTokens > 0
    ? Math.max(0, 1 - params.compactedTokens / params.originalTokens)
    : 0;

  const manifest: ReviveManifest = {
    schemaVersion: 1,
    reviveVersion: params.reviveVersion,
    tier: params.tier,
    createdAt: new Date().toISOString(),
    originalHash: sha256(params.originalSource),
    originalLength,
    originalTokens: params.originalTokens,
    compactedHash: sha256(params.compactedOutput),
    compactedLength,
    compactedTokens: params.compactedTokens,
    preserved,
    dropped,
    reductionPct,
  };

  if (params.originalPath !== undefined) {
    manifest.originalPath = params.originalPath;
  }
  if (params.compactedPath !== undefined) {
    manifest.compactedPath = params.compactedPath;
  }

  return manifest;
}

/**
 * Verify a manifest against an original source. Re-hashes every
 * preserved anchor and every dropped span. Reports per-category
 * pass/fail and overall integrity.
 *
 * Callers that lose access to the original source can still verify the
 * compacted output's hash by passing only the compacted text — see
 * `verifyCompacted`.
 */
export function verifyManifest(
  manifest: ReviveManifest,
  originalSource: string
): VerifyResult {
  const originalIntact = sha256(originalSource) === manifest.originalHash;

  let preservedOk = 0;
  let preservedFailed = 0;
  for (const span of manifest.preserved) {
    const text = originalSource.slice(span.originalStart, span.originalEnd);
    if (sha256(text) === span.hash) {
      preservedOk++;
    } else {
      preservedFailed++;
    }
  }

  let droppedOk = 0;
  let droppedFailed = 0;
  for (const span of manifest.dropped) {
    const text = originalSource.slice(span.originalStart, span.originalEnd);
    if (sha256(text) === span.hash) {
      droppedOk++;
    } else {
      droppedFailed++;
    }
  }

  const ok = originalIntact && preservedFailed === 0 && droppedFailed === 0;

  const summary = ok
    ? `Manifest intact: ${preservedOk} anchors and ${droppedOk} dropped spans verified.`
    : `Manifest FAILED: ${preservedFailed} anchor(s) and ${droppedFailed} dropped span(s) failed re-hash. Original intact: ${originalIntact}.`;

  return {
    ok,
    preservedOk,
    preservedFailed,
    droppedOk,
    droppedFailed,
    originalIntact,
    summary,
  };
}

/**
 * Lighter verification when the original source is not available.
 * Re-hashes only the compacted output.
 */
export function verifyCompacted(
  manifest: ReviveManifest,
  compactedOutput: string
): boolean {
  return sha256(compactedOutput) === manifest.compactedHash;
}

/**
 * Expand a single dropped span back to its original text. Requires the
 * original source. Returns `undefined` if the span ID is unknown or the
 * hash mismatches (drift detected — caller should refuse to use the
 * result and re-run Revive on the current source).
 */
export function expandSpan(
  manifest: ReviveManifest,
  spanId: number,
  originalSource: string
): { text: string; verified: true } | { text: null; verified: false; reason: string } {
  const span = manifest.dropped.find((s) => s.id === spanId);
  if (!span) {
    return { text: null, verified: false, reason: `No dropped span with id ${spanId}.` };
  }
  if (sha256(originalSource) !== manifest.originalHash) {
    return {
      text: null,
      verified: false,
      reason: 'Original source hash mismatch — source has drifted since manifest was created.',
    };
  }
  const text = originalSource.slice(span.originalStart, span.originalEnd);
  if (sha256(text) !== span.hash) {
    return {
      text: null,
      verified: false,
      reason: `Span ${spanId} hash mismatch — local edit detected at offset ${span.originalStart}.`,
    };
  }
  return { text, verified: true };
}

/**
 * Serialize a manifest to canonical JSON for disk storage. Stable key
 * order so the file diffs cleanly across runs.
 */
export function serializeManifest(manifest: ReviveManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}

/** Parse a manifest from JSON, validating the schema version. */
export function parseManifest(json: string): ReviveManifest {
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('schemaVersion' in parsed) ||
    (parsed as { schemaVersion: unknown }).schemaVersion !== 1
  ) {
    throw new Error('Unrecognised Revive manifest schema version. Expected 1.');
  }
  return parsed as ReviveManifest;
}

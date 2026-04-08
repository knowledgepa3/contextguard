/**
 * Chain Validator — the ECV proof layer for Revive
 *
 * "You are not compressing context. You are validating chain of
 *  evidence for machine working memory."
 *
 * Every Revive run produces a signed manifest. This module consumes
 * that manifest plus the original and compacted sources, runs four
 * validation levels, and returns a Chain Grade with a deterministic
 * approval decision. The grade is Zero Tolerance on the load-bearing
 * failures and thresholded on the rest (per William J. Storey III,
 * Sprint 1 ECV patch).
 *
 * Four levels:
 *
 *   LEVEL 1 — STRUCTURAL INTEGRITY
 *     - manifest schema valid
 *     - original source hash matches chain head
 *     - compacted output hash matches manifest
 *     - every preserved span re-hashes against the original
 *     - every dropped span re-hashes against the original
 *     - no duplicate span IDs
 *     (Any failure → auto Grade F.)
 *
 *   LEVEL 2 — EVIDENCE PRESERVATION
 *     - extract anchors from the original source
 *     - verify every HIGH probative anchor is in manifest.preserved
 *     - Moderate is thresholded
 *     - Low is informational
 *     (Any lost HIGH anchor → auto Grade F.)
 *
 *   LEVEL 3 — DRIFT / ADDITION CHECK
 *     - extract anchors from the COMPACTED output
 *     - every anchor hash in the compacted set must exist in the
 *       original anchor set
 *     - no new anchors, no synthetic evidence-like structures
 *     - "zero ungrounded content additions" (not literal zero tokens)
 *     (Any new anchor in compacted → auto Grade F.)
 *
 *   LEVEL 4 — RECOVERY SUFFICIENCY
 *     - for every dropped span, call expandSpan
 *     - the expansion must verify (return verified: true)
 *     - the expansion text must re-hash to the manifest's recorded hash
 *     - every dropped span must have a non-empty recovery hint
 *     (Any failed expand → auto Grade F.)
 *
 * @module revive/chainValidator
 */

import { createHash } from 'node:crypto';
import { extractAnchors, type Anchor } from './anchorExtractor.js';
import { expandSpan, type ReviveManifest } from './manifest.js';
import type { ProbativeWeight } from './probativeWeight.js';
import type { ParsedSession, SessionMessage } from './formats/jsonl.js';

/**
 * Filter out anchors that are artifacts of the synthetic `[role#N]`
 * message-boundary headers that `parseSessionJsonl` inserts into its
 * flat-text view. The identifier regex (`#\d{1,7}`) will match `#0`,
 * `#1`, etc. inside those headers, but those aren't real user anchors
 * — they're scaffolding. They also never appear in `manifest.preserved`
 * because Sparkling runs per-message and never sees them. To keep the
 * validator comparing like-with-like, we strip them from both sides.
 *
 * Scheduled for cleanup in Sprint 2 by removing synthetic headers from
 * the parser entirely.
 */
function stripSyntheticHeaderAnchors(source: string, anchors: Anchor[]): Anchor[] {
  return anchors.filter((a) => {
    // Only consider identifier-kind anchors as candidates.
    if (a.kind !== 'identifier') return true;
    // Check the five characters just before the anchor start: if they
    // form `[role`, this is a synthetic header identifier.
    // Examples: "[user#0]", "[assistant#1]", "[system#2]", "[tool#3]"
    const windowStart = Math.max(0, a.start - 12);
    const window = source.slice(windowStart, a.start);
    if (/\[(?:user|assistant|system|tool)$/.test(window)) return false;
    return true;
  });
}

/**
 * Extract anchors per message, the same way Sparkling does.
 *
 * Sparkling iterates messages and calls `extractAnchors` on each
 * message's content in isolation. The chain validator's original
 * implementation extracted anchors from the concatenated flat-text
 * view, which does NOT match Sparkling's extraction universe.
 *
 * On real Claude sessions (~3K messages, ~1.3 MB flat text), that
 * asymmetry produced "ghost anchors" — lazy regexes (code_block
 * fences in particular) would greedily span hundreds of kilobytes
 * across message boundaries, creating 50 KB–340 KB "code blocks"
 * that never existed in any single message. Those ghosts always
 * failed the hash lookup against `manifest.preserved` because
 * Sparkling had never produced them, leading to false "lost high
 * anchor" reports and a spurious Grade F.
 *
 * Extracting per-message on the validator side makes both sides
 * compare the same anchor universe, killing the ghost class
 * entirely. See `docs/SPRINT-2-DRIFT-DIAGNOSIS.md` for the full
 * root-cause analysis and the diagnostic script.
 *
 * Anchors returned from this helper carry offsets that are relative
 * to each individual message rather than to the flat text. Neither
 * `validateLevel2` nor `validateLevel3` reads offsets from the
 * anchor list — they only use `hash`, `kind`, `text`, and
 * `probativeWeight` — so the offset mismatch is harmless.
 */
function extractAnchorsPerMessage(messages: SessionMessage[]): Anchor[] {
  const all: Anchor[] = [];
  for (const msg of messages) {
    const { anchors } = extractAnchors(msg.content);
    all.push(...anchors);
  }
  return all;
}

// ─── Public types ────────────────────────────────────────────────────

export type ChainGrade = 'A' | 'B' | 'C' | 'D' | 'F';

/** A single check inside a level. */
export interface ChainCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Result of one validation level. */
export interface LevelResult {
  name: string;
  passed: boolean;
  /** If true, this level's failure forces Grade F regardless of the other levels. */
  autoFail: boolean;
  checks: ChainCheck[];
}

/** Full chain validation report. Attached to ReviveResult. */
export interface ChainValidationReport {
  grade: ChainGrade;
  /** Human-facing approval decision. Grade F or any autoFail = false. */
  approved: boolean;
  level1: LevelResult; // structural integrity
  level2: LevelResult; // evidence preservation
  level3: LevelResult; // drift / addition check
  level4: LevelResult; // recovery sufficiency
  /** Count of preserved anchors by probative weight. */
  preservedByWeight: Record<ProbativeWeight, number>;
  /** Count of LOST anchors (in original, not in manifest.preserved) by weight. */
  lostByWeight: Record<ProbativeWeight, number>;
  /** One-line summary for display. */
  summary: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function emptyWeightCount(): Record<ProbativeWeight, number> {
  return { high: 0, moderate: 0, low: 0 };
}

// ─── Level 1 — Structural Integrity ──────────────────────────────────

function validateLevel1(
  manifest: ReviveManifest,
  originalSource: string,
  compactedOutput: string
): LevelResult {
  const checks: ChainCheck[] = [];

  checks.push({
    name: 'Schema version',
    passed: manifest.schemaVersion === 1,
    detail: `schemaVersion = ${String(manifest.schemaVersion)}`,
  });

  const origOk = sha256(originalSource) === manifest.originalHash;
  checks.push({
    name: 'Original source hash',
    passed: origOk,
    detail: origOk ? 'matches chain head' : 'MISMATCH — source drifted',
  });

  const compactedOk = sha256(compactedOutput) === manifest.compactedHash;
  checks.push({
    name: 'Compacted output hash',
    passed: compactedOk,
    detail: compactedOk ? 'matches manifest' : 'MISMATCH — compacted altered',
  });

  // Every preserved span re-hashes
  let preservedOk = 0;
  let preservedFailed = 0;
  for (const span of manifest.preserved) {
    const text = originalSource.slice(span.originalStart, span.originalEnd);
    if (sha256(text) === span.hash) preservedOk++;
    else preservedFailed++;
  }
  checks.push({
    name: 'Preserved span hashes',
    passed: preservedFailed === 0,
    detail: `${preservedOk} ok, ${preservedFailed} failed of ${manifest.preserved.length}`,
  });

  // Every dropped span re-hashes
  let droppedOk = 0;
  let droppedFailed = 0;
  for (const span of manifest.dropped) {
    const text = originalSource.slice(span.originalStart, span.originalEnd);
    if (sha256(text) === span.hash) droppedOk++;
    else droppedFailed++;
  }
  checks.push({
    name: 'Dropped span hashes',
    passed: droppedFailed === 0,
    detail: `${droppedOk} ok, ${droppedFailed} failed of ${manifest.dropped.length}`,
  });

  // No duplicate IDs
  const preservedIds = new Set<number>();
  let preservedDupes = 0;
  for (const s of manifest.preserved) {
    if (preservedIds.has(s.id)) preservedDupes++;
    preservedIds.add(s.id);
  }
  const droppedIds = new Set<number>();
  let droppedDupes = 0;
  for (const s of manifest.dropped) {
    if (droppedIds.has(s.id)) droppedDupes++;
    droppedIds.add(s.id);
  }
  checks.push({
    name: 'Span ID uniqueness',
    passed: preservedDupes === 0 && droppedDupes === 0,
    detail:
      preservedDupes + droppedDupes === 0
        ? 'no duplicate ids'
        : `${preservedDupes} duplicate preserved, ${droppedDupes} duplicate dropped`,
  });

  const passed = checks.every((c) => c.passed);
  return { name: 'Structural Integrity', passed, autoFail: !passed, checks };
}

// ─── Level 2 — Evidence Preservation ─────────────────────────────────

function validateLevel2(
  manifest: ReviveManifest,
  originalAnchors: Anchor[]
): {
  result: LevelResult;
  preservedByWeight: Record<ProbativeWeight, number>;
  lostByWeight: Record<ProbativeWeight, number>;
} {
  const preservedHashes = new Set(manifest.preserved.map((p) => p.hash));

  const preservedByWeight = emptyWeightCount();
  const lostByWeight = emptyWeightCount();
  const lostHighTexts: string[] = [];
  const lostModerateTexts: string[] = [];
  const lostLowTexts: string[] = [];

  for (const anchor of originalAnchors) {
    if (preservedHashes.has(anchor.hash)) {
      preservedByWeight[anchor.probativeWeight]++;
    } else {
      lostByWeight[anchor.probativeWeight]++;
      if (anchor.probativeWeight === 'high') {
        lostHighTexts.push(truncate(anchor.text, 60));
      } else if (anchor.probativeWeight === 'moderate') {
        lostModerateTexts.push(truncate(anchor.text, 60));
      } else {
        lostLowTexts.push(truncate(anchor.text, 60));
      }
    }
  }

  const totalHigh = preservedByWeight.high + lostByWeight.high;
  const totalModerate = preservedByWeight.moderate + lostByWeight.moderate;
  const totalLow = preservedByWeight.low + lostByWeight.low;

  const highPct = totalHigh > 0 ? preservedByWeight.high / totalHigh : 1;
  const modPct = totalModerate > 0 ? preservedByWeight.moderate / totalModerate : 1;
  const lowPct = totalLow > 0 ? preservedByWeight.low / totalLow : 1;

  const checks: ChainCheck[] = [
    {
      name: 'HIGH probative preserved',
      passed: highPct === 1,
      detail:
        `${preservedByWeight.high}/${totalHigh} (${(highPct * 100).toFixed(1)}%)` +
        (lostHighTexts.length > 0 ? `; LOST: ${lostHighTexts.slice(0, 3).join(' | ')}` : ''),
    },
    {
      name: 'MODERATE probative preserved (>=85%)',
      passed: modPct >= 0.85,
      detail:
        `${preservedByWeight.moderate}/${totalModerate} (${(modPct * 100).toFixed(1)}%)` +
        (lostModerateTexts.length > 0
          ? `; lost ${lostModerateTexts.length}: ${lostModerateTexts.slice(0, 2).join(' | ')}`
          : ''),
    },
    {
      name: 'LOW probative preserved (informational)',
      passed: true, // low is always informational
      detail: `${preservedByWeight.low}/${totalLow} (${(lowPct * 100).toFixed(1)}%)` +
        (lostLowTexts.length > 0 ? `; lost ${lostLowTexts.length}` : ''),
    },
  ];

  const autoFail = highPct < 1;
  const passed = checks[0]!.passed && checks[1]!.passed;
  return {
    result: { name: 'Evidence Preservation', passed, autoFail, checks },
    preservedByWeight,
    lostByWeight,
  };
}

// ─── Level 3 — Drift / Addition Check ────────────────────────────────

function validateLevel3(
  originalAnchors: Anchor[],
  compactedAnchors: Anchor[]
): LevelResult {
  const originalHashes = new Set(originalAnchors.map((a) => a.hash));

  const newAnchorsInCompacted: Anchor[] = [];
  for (const anchor of compactedAnchors) {
    if (!originalHashes.has(anchor.hash)) {
      newAnchorsInCompacted.push(anchor);
    }
  }

  const checks: ChainCheck[] = [
    {
      name: 'No new anchors in compacted output',
      passed: newAnchorsInCompacted.length === 0,
      detail:
        newAnchorsInCompacted.length === 0
          ? `0 new anchors across ${compactedAnchors.length} in compacted`
          : `${newAnchorsInCompacted.length} ungrounded anchors: ${newAnchorsInCompacted
              .slice(0, 3)
              .map((a) => `[${a.kind}] ${truncate(a.text, 40)}`)
              .join(' | ')}`,
    },
  ];

  const passed = checks.every((c) => c.passed);
  return {
    name: 'Drift / Addition Check',
    passed,
    autoFail: !passed,
    checks,
  };
}

// ─── Level 4 — Recovery Sufficiency ──────────────────────────────────

function validateLevel4(
  manifest: ReviveManifest,
  originalSource: string
): LevelResult {
  let expandsOk = 0;
  let expandsFailed = 0;
  let missingHints = 0;
  const failures: string[] = [];

  for (const span of manifest.dropped) {
    // Every dropped span must have a non-empty recovery hint
    if (!span.recoveryHint || span.recoveryHint.trim().length === 0) {
      missingHints++;
    }

    const expansion = expandSpan(manifest, span.id, originalSource);
    if (!expansion.verified) {
      expandsFailed++;
      failures.push(`span ${span.id}: ${expansion.reason}`);
      continue;
    }
    if (sha256(expansion.text) !== span.hash) {
      expandsFailed++;
      failures.push(`span ${span.id}: hash mismatch after expand`);
      continue;
    }
    expandsOk++;
  }

  const checks: ChainCheck[] = [
    {
      name: 'Every dropped span recoverable',
      passed: expandsFailed === 0,
      detail:
        expandsFailed === 0
          ? `${expandsOk}/${manifest.dropped.length} round-tripped byte-for-byte`
          : `${expandsFailed} failed: ${failures.slice(0, 3).join(' | ')}`,
    },
    {
      name: 'Every dropped span has recovery hint',
      passed: missingHints === 0,
      detail:
        missingHints === 0
          ? `${manifest.dropped.length} hints present`
          : `${missingHints} spans missing recovery hint`,
    },
  ];

  const passed = checks.every((c) => c.passed);
  return {
    name: 'Recovery Sufficiency',
    passed,
    autoFail: !passed,
    checks,
  };
}

// ─── Grade computation ──────────────────────────────────────────────

function computeGrade(
  level1: LevelResult,
  level2: LevelResult,
  level3: LevelResult,
  level4: LevelResult,
  preservedByWeight: Record<ProbativeWeight, number>,
  lostByWeight: Record<ProbativeWeight, number>
): ChainGrade {
  // Zero-tolerance walls per William's Sprint 1 ECV guidance
  if (level1.autoFail) return 'F';
  if (level2.autoFail) return 'F'; // any lost HIGH anchor
  if (level3.autoFail) return 'F'; // any drift
  if (level4.autoFail) return 'F'; // any failed recovery

  // Compute moderate/low retention for grade gradation
  const totalMod = preservedByWeight.moderate + lostByWeight.moderate;
  const modPct = totalMod > 0 ? preservedByWeight.moderate / totalMod : 1;

  const totalLow = preservedByWeight.low + lostByWeight.low;
  const lowPct = totalLow > 0 ? preservedByWeight.low / totalLow : 1;

  // Grade A — high 100%, moderate >=95%, low >=90%
  if (modPct >= 0.95 && lowPct >= 0.9) return 'A';
  // Grade B — high 100%, moderate >=90%, low >=80%
  if (modPct >= 0.9 && lowPct >= 0.8) return 'B';
  // Grade C — high 100%, moderate >=85%, low informational
  if (modPct >= 0.85) return 'C';
  // Grade D — high 100%, moderate >=70%
  if (modPct >= 0.7) return 'D';
  return 'F';
}

// ─── Public entry point ─────────────────────────────────────────────

/**
 * Run the full ECV-style chain validation on a Revive result.
 *
 * @param manifest         the manifest produced by `revive()`
 * @param originalSource   the same flat-text the manifest was built from
 * @param compactedOutput  the compacted output produced by `revive()`
 * @param parsedOriginal   optional parsed form of the original session.
 *                         When provided, Level 2 extracts anchors
 *                         per-message the same way Sparkling does,
 *                         killing the ghost-anchor class described in
 *                         `docs/SPRINT-2-DRIFT-DIAGNOSIS.md`. When
 *                         omitted, falls back to flat-text extraction
 *                         with synthetic-header stripping (the legacy
 *                         behavior, retained for non-JSONL callers).
 * @param parsedCompacted  optional parsed form of the compacted output.
 *                         When provided, Level 3 does the same
 *                         per-message extraction on the compacted side.
 */
export function validateChain(
  manifest: ReviveManifest,
  originalSource: string,
  compactedOutput: string,
  parsedOriginal?: ParsedSession,
  parsedCompacted?: ParsedSession
): ChainValidationReport {
  // Level 1 — Structural Integrity
  const level1 = validateLevel1(manifest, originalSource, compactedOutput);

  // Level 2 — Evidence Preservation
  // Anchors from the ORIGINAL are the ground truth for what should
  // have been preserved. Prefer per-message extraction (matches
  // Sparkling's extraction strategy exactly, eliminates ghost anchors
  // on real sessions). Fall back to flat-text + synthetic-header strip
  // for callers that do not pass a parsed session (future markdown
  // format adapter, direct library users, etc).
  const cleanedOriginalAnchors = parsedOriginal
    ? extractAnchorsPerMessage(parsedOriginal.messages)
    : stripSyntheticHeaderAnchors(
        originalSource,
        extractAnchors(originalSource).anchors
      );
  const level2Result = validateLevel2(manifest, cleanedOriginalAnchors);

  // Level 3 — Drift / Addition Check
  // Same strategy for the compacted side: per-message when parsed,
  // flat-text with synthetic-header strip as a fallback.
  const cleanedCompactedAnchors = parsedCompacted
    ? extractAnchorsPerMessage(parsedCompacted.messages)
    : stripSyntheticHeaderAnchors(
        compactedOutput,
        extractAnchors(compactedOutput).anchors
      );
  const level3 = validateLevel3(cleanedOriginalAnchors, cleanedCompactedAnchors);

  // Level 4 — Recovery Sufficiency
  const level4 = validateLevel4(manifest, originalSource);

  const grade = computeGrade(
    level1,
    level2Result.result,
    level3,
    level4,
    level2Result.preservedByWeight,
    level2Result.lostByWeight
  );

  const approved = grade !== 'F' && !level1.autoFail && !level2Result.result.autoFail && !level3.autoFail && !level4.autoFail;

  const summary = buildSummary(
    grade,
    approved,
    level2Result.preservedByWeight,
    level2Result.lostByWeight
  );

  return {
    grade,
    approved,
    level1,
    level2: level2Result.result,
    level3,
    level4,
    preservedByWeight: level2Result.preservedByWeight,
    lostByWeight: level2Result.lostByWeight,
    summary,
  };
}

function buildSummary(
  grade: ChainGrade,
  approved: boolean,
  preservedByWeight: Record<ProbativeWeight, number>,
  lostByWeight: Record<ProbativeWeight, number>
): string {
  const totalH = preservedByWeight.high + lostByWeight.high;
  const totalM = preservedByWeight.moderate + lostByWeight.moderate;
  const totalL = preservedByWeight.low + lostByWeight.low;
  const verdict = approved ? 'APPROVED FOR USE' : 'NOT APPROVED';
  return (
    `Chain Grade ${grade} — ${verdict}. ` +
    `High ${preservedByWeight.high}/${totalH}, ` +
    `Moderate ${preservedByWeight.moderate}/${totalM}, ` +
    `Low ${preservedByWeight.low}/${totalL}.`
  );
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? flat.slice(0, max - 3) + '...' : flat;
}

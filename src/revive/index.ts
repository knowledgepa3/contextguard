/**
 * Revive — public API
 *
 * "ContextGuard measures the thirst. Revive is the drink."
 *
 * Top-level entry points:
 *
 *   revive(input, { tier })          // compact a session or markdown file
 *   verify(manifest, originalSource) // prove a manifest is intact
 *   expand(manifest, spanId, source) // rehydrate a single dropped span
 *
 * Sprint 1 ships Sparkling tier + JSONL format. Electrolyte and IV
 * tiers, and the markdown format, land in Sprint 2.
 *
 * @module revive
 */

import {
  parseSessionJsonl,
  writeSessionJsonl,
} from './formats/jsonl.js';
import {
  buildManifest,
  verifyManifest,
  expandSpan,
  type ReviveManifest,
  type ReviveTier,
  type VerifyResult,
} from './manifest.js';
import { compactSparklingSession } from './tiers/sparkling.js';
import { countTokensApprox } from '../engine/tokenCounter.js';
import { assessHealth } from '../engine/healthScorer.js';
import type { ContextHealth, ContextItem, BudgetStatus } from '../types/index.js';

// ─── Re-exports ──────────────────────────────────────────────────────

export type { Anchor, AnchorKind, AnchorExtractionResult } from './anchorExtractor.js';
export { extractAnchors, getCompactableRanges, countByKind } from './anchorExtractor.js';
export type {
  ReviveManifest,
  ReviveTier,
  PreservedSpan,
  DroppedSpan,
  VerifyResult,
} from './manifest.js';
export {
  buildManifest,
  verifyManifest,
  verifyCompacted,
  expandSpan,
  serializeManifest,
  parseManifest,
} from './manifest.js';
export type { SessionMessage, ParsedSession } from './formats/jsonl.js';
export { parseSessionJsonl, writeSessionJsonl } from './formats/jsonl.js';

// ─── Public API ──────────────────────────────────────────────────────

/** Hard-coded for now; aligns with package.json `version` field. */
const REVIVE_VERSION = '0.2.0-sprint1';

/** Input format detected from extension or explicitly passed. */
export type ReviveInputFormat = 'jsonl' | 'markdown';

/** Options for the `revive` call. */
export interface ReviveOptions {
  /** Compaction tier. Default: `'sparkling'` (only tier shipping in Sprint 1). */
  tier?: ReviveTier;
  /** Input format. Default: inferred from input shape. */
  format?: ReviveInputFormat;
  /** Optional original-source path for the manifest. */
  originalPath?: string;
  /** Optional compacted-output path for the manifest. */
  compactedPath?: string;
}

/** Result of running Revive. */
export interface ReviveResult {
  /** The compacted output as a string. */
  compacted: string;
  /** The full manifest. Persist with `serializeManifest`. */
  manifest: ReviveManifest;
  /** Approximate token count of the original. */
  originalTokens: number;
  /** Approximate token count of the compacted output. */
  compactedTokens: number;
  /** Reduction percentage (0-1). */
  reductionPct: number;
  /** Health grade before compaction. */
  beforeGrade: ContextHealth;
  /** Health grade after compaction. */
  afterGrade: ContextHealth;
}

/**
 * Compact a session or markdown file. Sprint 1 supports JSONL sessions
 * with the Sparkling tier; passing other formats or tiers throws a
 * clear "not yet shipped" error.
 */
export function revive(input: string, options: ReviveOptions = {}): ReviveResult {
  const tier = options.tier ?? 'sparkling';
  const format = options.format ?? inferFormat(input);

  if (tier !== 'sparkling') {
    throw new Error(
      `Revive tier '${tier}' is not implemented in Sprint 1. Only 'sparkling' is available. Electrolyte ships in Sprint 2, IV in Sprint 3.`
    );
  }
  if (format !== 'jsonl') {
    throw new Error(
      `Revive format '${format}' is not implemented in Sprint 1. Only 'jsonl' is available. Markdown ships in Sprint 2.`
    );
  }

  const parsed = parseSessionJsonl(input);
  const sparkling = compactSparklingSession(parsed.messages);

  // Re-serialize the compacted messages back to JSONL.
  const compactedOutput = writeSessionJsonl(sparkling.messages);

  const originalTokens = sparkling.originalTokens || countTokensApprox(parsed.flatText);
  const compactedTokens = sparkling.compactedTokens || countTokensApprox(compactedOutput);

  // The manifest's offsets are flat-text offsets. We rebuild the
  // canonical flat text the same way parseSessionJsonl does so verify
  // can replay it.
  const flatTextForManifest = parsed.flatText;

  const manifest = buildManifest({
    tier,
    reviveVersion: REVIVE_VERSION,
    originalSource: flatTextForManifest,
    compactedOutput,
    preservedAnchors: sparkling.preservedAnchors,
    droppedSpans: sparkling.droppedSpans,
    originalTokens,
    compactedTokens,
    ...(options.originalPath !== undefined ? { originalPath: options.originalPath } : {}),
    ...(options.compactedPath !== undefined ? { compactedPath: options.compactedPath } : {}),
  });

  const beforeGrade = quickGrade(originalTokens, parsed.messages.length);
  const afterGrade = quickGrade(compactedTokens, parsed.messages.length);

  return {
    compacted: compactedOutput,
    manifest,
    originalTokens,
    compactedTokens,
    reductionPct: manifest.reductionPct,
    beforeGrade,
    afterGrade,
  };
}

/** Verify a manifest against an original source. Wraps `verifyManifest`. */
export function verify(manifest: ReviveManifest, originalSource: string): VerifyResult {
  return verifyManifest(manifest, originalSource);
}

/** Expand a single dropped span. Wraps `expandSpan`. */
export function expand(
  manifest: ReviveManifest,
  spanId: number,
  originalSource: string
): { text: string; verified: true } | { text: null; verified: false; reason: string } {
  return expandSpan(manifest, spanId, originalSource);
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Quick-and-dirty grade computation for before/after display. Builds a
 * minimal ContextItem[] + BudgetStatus pair so the existing health
 * scorer can be reused without modification.
 *
 * Token budget assumed: 1,000,000 (Claude 1M-context window — the
 * default ContextGuard target). Caller-supplied budgets land in Sprint 2.
 */
function quickGrade(tokens: number, messageCount: number): ContextHealth {
  const maxTotalTokens = 1_000_000;
  const items: ContextItem[] = [];
  for (let i = 0; i < messageCount; i++) {
    items.push({
      id: `msg_${i}`,
      category: 'conversation',
      content: '',
      tokens: Math.round(tokens / Math.max(messageCount, 1)),
      addedAt: Date.now() - (messageCount - i) * 30_000,
      source: `msg_${i}`,
    });
  }
  const budget: BudgetStatus = {
    totalTokensUsed: tokens,
    totalTokensAvailable: maxTotalTokens,
    utilization: maxTotalTokens > 0 ? tokens / maxTotalTokens : 0,
    categories: [
      {
        category: 'conversation',
        tokensUsed: tokens,
        tokensAllocated: maxTotalTokens,
        percentage: maxTotalTokens > 0 ? tokens / maxTotalTokens : 0,
        itemCount: messageCount,
        overBudget: false,
        warning: false,
      },
    ],
    prunedItems: [],
    hasOverage: false,
    hasWarnings: false,
  };
  return assessHealth(items, budget);
}

function inferFormat(input: string): ReviveInputFormat {
  // Quick sniff: first non-blank line. If it parses as JSON with a role
  // or message field, treat as JSONL. Otherwise markdown.
  const firstLine = input.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  if (firstLine.startsWith('{') || firstLine.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(firstLine);
      if (typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        if ('role' in obj || 'message' in obj || 'type' in obj) {
          return 'jsonl';
        }
      }
    } catch {
      // fall through
    }
  }
  return 'markdown';
}

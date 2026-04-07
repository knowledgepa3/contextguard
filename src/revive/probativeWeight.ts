/**
 * Probative Weight Classifier — ECV Evidence Class Layer
 *
 * Every Revive anchor is classified as High / Moderate / Low based on
 * its load-bearing role in the session. This mirrors the ECV framework
 * (38 CFR 4.6-style evidence weighting) adapted for AI context.
 *
 * Rules (per William J. Storey III, Sprint 1 ECV patch):
 *
 *   HIGH — load-bearing. If it moves or disappears, the truth of the
 *   session changes. Zero-tolerance in the Chain Grade.
 *     - code_block
 *     - decision
 *     - error
 *     - hash (sha / uuid)
 *     - file_ref (path:line with location)
 *     - tool_call (arguments carry execution meaning)
 *
 *   MODERATE — meaningful but not load-bearing. Lose them and a reader
 *   can mostly reconstruct intent. Thresholded penalty in the grade.
 *     - file_path (bare path, no line location)
 *     - identifier (PR-123, ISSUE-456, ticket refs)
 *     - inline_code (operational meaning, conservative default)
 *     - URL with meaningful path/query
 *
 *   LOW — informational background. Degrades grade only cosmetically.
 *     - bare domain URL (https://host/ with no path or query)
 *
 * Decisions and tool_calls both stay HIGH — a decision changes
 * authority/meaning, a tool call changes action history. Both are
 * load-bearing.
 *
 * @module revive/probativeWeight
 */

import type { AnchorKind } from './anchorExtractor.js';

/** Evidence class (ECV-style). */
export type ProbativeWeight = 'high' | 'moderate' | 'low';

/** Classify a single anchor by its kind and text. */
export function classifyProbativeWeight(anchor: {
  kind: AnchorKind;
  text: string;
}): ProbativeWeight {
  switch (anchor.kind) {
    case 'code_block':
    case 'decision':
    case 'error':
    case 'hash':
    case 'file_ref':
    case 'tool_call':
      return 'high';
    case 'file_path':
    case 'identifier':
    case 'inline_code':
      return 'moderate';
    case 'url':
      return classifyUrl(anchor.text);
  }
}

/**
 * URLs with meaningful path or query = Moderate. Bare domains = Low.
 * Examples:
 *   https://example.com          → low
 *   https://example.com/         → low
 *   https://example.com/path     → moderate
 *   https://example.com/?q=foo   → moderate
 *   https://example.com/api/v1   → moderate
 */
function classifyUrl(url: string): ProbativeWeight {
  const match = /^https?:\/\/[^/?#]+([/?#].*)?$/.exec(url);
  if (!match) return 'low';
  const rest = match[1];
  if (rest === undefined || rest === '' || rest === '/') return 'low';
  return 'moderate';
}

/** Count anchors by probative weight class. */
export function countByWeight<T extends { probativeWeight: ProbativeWeight }>(
  items: T[]
): { high: number; moderate: number; low: number } {
  const out = { high: 0, moderate: 0, low: 0 };
  for (const item of items) out[item.probativeWeight]++;
  return out;
}

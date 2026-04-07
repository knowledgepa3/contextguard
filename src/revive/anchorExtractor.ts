/**
 * Anchor Extractor — Integrity-critical foundation of Revive
 *
 * "Anchors are sacred. Prose around them is fair game."
 *
 * An anchor is any span of text that MUST be preserved verbatim during
 * Revive compaction. The lossless guarantee of Revive rests entirely on
 * this extractor never returning a false negative — i.e. never missing
 * a code block, file path, hash, decision, tool call, or error.
 *
 * If this file regresses on fixture tests, Sprint 1 stops until it's fixed.
 * That is the contract.
 *
 * @module revive/anchorExtractor
 */

import { createHash } from 'node:crypto';
import { classifyProbativeWeight, type ProbativeWeight } from './probativeWeight.js';

// ─── Public types ────────────────────────────────────────────────────

/** Categories of preserved spans. Order matters for overlap resolution. */
export type AnchorKind =
  | 'code_block'    // Triple-backtick fenced block (any language)
  | 'inline_code'   // Single-backtick inline code
  | 'file_ref'      // path:line(:col)? reference
  | 'file_path'     // bare file path or directory path
  | 'hash'          // SHA-1, SHA-256, short SHA, UUID
  | 'tool_call'     // Tool invocation marker (provider-specific formats)
  | 'decision'      // "approved", "rejected", "decided", "blocked on", etc.
  | 'error'         // Error: / Exception: / Traceback / "at file:line"
  | 'identifier'    // Ticket refs (#123, PR-456, ISSUE-789)
  | 'url';          // http(s):// URLs

/** A single preserved span. The text is the source of truth. */
export interface Anchor {
  kind: AnchorKind;
  /** Exact text — never paraphrased, never edited, byte-for-byte. */
  text: string;
  /** Inclusive start offset in source. */
  start: number;
  /** Exclusive end offset in source. */
  end: number;
  /** SHA-256 of `text`. Used by manifest for provenance. */
  hash: string;
  /** ECV probative weight: high / moderate / low. */
  probativeWeight: ProbativeWeight;
}

/** Result of extracting anchors from a source string. */
export interface AnchorExtractionResult {
  anchors: Anchor[];
  source: string;
  sourceHash: string;
}

// ─── Detector regexes ────────────────────────────────────────────────
//
// Each regex is global + sticky-safe. Order of detection does not
// matter; overlap resolution happens after all detectors run.

/**
 * Triple-backtick fenced code blocks. Lazy match on body. Captures the
 * full fence including the opening ```lang and closing ```.
 */
const RE_CODE_BLOCK = /```[a-zA-Z0-9_+\-.]*\n[\s\S]*?\n```/g;

/**
 * Single-backtick inline code. Avoids matching empty `` `` and avoids
 * matching across newlines.
 */
const RE_INLINE_CODE = /`[^`\n]+`/g;

/**
 * File reference with line and optional column: `src/foo.ts:42`
 * or `lib\bar.py:42:7`. Matches Unix and Windows separators.
 * The path portion must contain at least one slash/backslash OR end
 * in a recognised extension.
 */
const RE_FILE_REF = /(?:[A-Za-z]:)?(?:[\w.\-]+[/\\])+[\w.\-]+\.[a-zA-Z][a-zA-Z0-9]{0,8}:\d+(?::\d+)?/g;

/**
 * Bare file path (no line number). Two patterns OR'd:
 *   1. Path containing at least one slash/backslash and ending in an extension
 *   2. Drive-letter Windows path (C:\foo\bar.txt)
 */
const RE_FILE_PATH = /(?:[A-Za-z]:[\\/])?(?:[\w.\-]+[/\\])+[\w.\-]+\.[a-zA-Z][a-zA-Z0-9]{0,8}/g;

/**
 * Hashes: SHA-256 (64 hex), SHA-1 (40 hex), short git SHA (7-12 hex).
 * Word-boundary anchored to avoid matching numbers in larger tokens.
 */
const RE_HASH_LONG = /\b[a-f0-9]{40,64}\b/gi;
const RE_HASH_SHORT = /\b[a-f0-9]{7,12}\b/gi;

/** UUID v1-v5: 8-4-4-4-12 hex with dashes. */
const RE_UUID = /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi;

/**
 * Tool call markers in common LLM session formats:
 *   - `<function_calls>` ... `</function_calls>` (Claude harness)
 *   - `[tool_use:name]` (compact form)
 *   - `<tool_use>` ... `</tool_use>` (XML form)
 */
const RE_TOOL_CALL_FENCED = /<function_calls>[\s\S]*?<\/antml:function_calls>/g;
const RE_TOOL_CALL_TAG = /<tool_use[^>]*>[\s\S]*?<\/tool_use>/g;
const RE_TOOL_CALL_COMPACT = /\[tool_use:[\w.\-]+(?:\s+[\w.\-]+=[^\]]+)*\]/g;

/**
 * Decision markers. Whole-line or inline. Case-insensitive. We capture
 * the whole sentence (up to next sentence terminator or newline) so the
 * decision text travels with the keyword.
 */
const RE_DECISION = /\b(?:approved|rejected|decided|blocked\s+on|blocker|TODO|FIXME|NOTE|WARNING|CRITICAL|MUST|MUST\s+NOT|SHIP\s+GATE|KILL|HOLD|DEFERRED)\b[^.!?\n]*[.!?]?/gi;

/**
 * Error / exception patterns. Captures the error line itself, not the
 * full stack trace (the stack trace will typically be inside a fenced
 * code block which is already preserved).
 */
const RE_ERROR_LINE = /(?:Error|Exception|Traceback|Caused by|Panic|Fatal|TypeError|ValueError|KeyError|IndexError|AttributeError|RuntimeError|SyntaxError|ReferenceError):\s*[^\n]+/g;

/** Stack frame: `at foo (file.ext:line:col)` or `File "x.py", line 42`. */
const RE_STACK_FRAME = /(?:at\s+\S+\s*\([^)]+:\d+(?::\d+)?\)|File\s+"[^"]+",\s+line\s+\d+)/g;

/** Ticket / PR / issue identifiers. */
const RE_IDENTIFIER = /\b(?:PR|MR|ISSUE|TICKET|JIRA|BUG|TASK|FEAT)[-\s]?\d+\b|#\d{1,7}\b/gi;

/** URLs (http and https only — other schemes left to detectors above). */
const RE_URL = /https?:\/\/[^\s<>"'`)\]]+/g;

// ─── Detection ───────────────────────────────────────────────────────

interface RawHit {
  kind: AnchorKind;
  start: number;
  end: number;
  text: string;
}

function collectMatches(source: string, regex: RegExp, kind: AnchorKind): RawHit[] {
  const hits: RawHit[] = [];
  // Reset lastIndex so calling collectMatches twice on the same regex is safe.
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const text = match[0];
    if (text.length === 0) {
      // Defensive: an empty match would loop forever. Advance past it.
      regex.lastIndex++;
      continue;
    }
    hits.push({
      kind,
      start: match.index,
      end: match.index + text.length,
      text,
    });
  }
  return hits;
}

/**
 * Resolve overlaps. A hit fully contained inside an earlier hit of equal
 * or higher precedence is dropped. Hits at the same start with overlap
 * keep the longest. Tie-broken by precedence rank.
 *
 * Precedence (higher = more authoritative): code_block > tool_call >
 * file_ref > error > file_path > hash > url > inline_code > decision
 * > identifier.
 */
const PRECEDENCE: Record<AnchorKind, number> = {
  code_block: 100,
  tool_call: 90,
  file_ref: 80,
  error: 75,
  file_path: 70,
  hash: 60,
  url: 50,
  inline_code: 40,
  decision: 30,
  identifier: 20,
};

function resolveOverlaps(hits: RawHit[]): RawHit[] {
  // Sort by start ascending, then by length descending, then by precedence desc.
  const sorted = [...hits].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lenA = a.end - a.start;
    const lenB = b.end - b.start;
    if (lenA !== lenB) return lenB - lenA;
    return PRECEDENCE[b.kind] - PRECEDENCE[a.kind];
  });

  const kept: RawHit[] = [];
  for (const hit of sorted) {
    let dominated = false;
    // Walk backward through recently-kept hits — overlap can only be
    // with hits whose start is <= this hit's start, and most overlaps
    // come from the immediately preceding kept hit.
    for (let i = kept.length - 1; i >= 0; i--) {
      const prev = kept[i];
      if (prev === undefined) continue;
      if (prev.end <= hit.start) {
        // No more overlap possible going further back if hits were sorted
        // strictly. But because we have ties, we need to keep walking until
        // prev.end < hit.start. We can break only when prev.end is well
        // before hit.start.
        if (prev.end + 1 < hit.start) break;
        continue;
      }
      // prev overlaps hit
      const fullyContains = prev.start <= hit.start && prev.end >= hit.end;
      if (fullyContains && PRECEDENCE[prev.kind] >= PRECEDENCE[hit.kind]) {
        dominated = true;
        break;
      }
      // If hit fully contains prev and has higher precedence, evict prev.
      const hitContainsPrev = hit.start <= prev.start && hit.end >= prev.end;
      if (hitContainsPrev && PRECEDENCE[hit.kind] > PRECEDENCE[prev.kind]) {
        kept.splice(i, 1);
      }
    }
    if (!dominated) kept.push(hit);
  }

  // Re-sort kept by start (eviction may have left things out of order
  // relative to each other, though insertion order was sorted).
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Extract every anchor in the source string. Order is by start offset.
 * Overlaps are resolved by precedence (see PRECEDENCE table).
 *
 * The contract: every span returned MUST be preserved verbatim by any
 * downstream Revive tier. Prose between anchors is the only thing that
 * compaction is allowed to touch.
 */
export function extractAnchors(source: string): AnchorExtractionResult {
  const allHits: RawHit[] = [
    ...collectMatches(source, RE_CODE_BLOCK, 'code_block'),
    ...collectMatches(source, RE_TOOL_CALL_FENCED, 'tool_call'),
    ...collectMatches(source, RE_TOOL_CALL_TAG, 'tool_call'),
    ...collectMatches(source, RE_TOOL_CALL_COMPACT, 'tool_call'),
    ...collectMatches(source, RE_FILE_REF, 'file_ref'),
    ...collectMatches(source, RE_ERROR_LINE, 'error'),
    ...collectMatches(source, RE_STACK_FRAME, 'error'),
    ...collectMatches(source, RE_FILE_PATH, 'file_path'),
    ...collectMatches(source, RE_HASH_LONG, 'hash'),
    ...collectMatches(source, RE_UUID, 'hash'),
    ...collectMatches(source, RE_HASH_SHORT, 'hash'),
    ...collectMatches(source, RE_URL, 'url'),
    ...collectMatches(source, RE_INLINE_CODE, 'inline_code'),
    ...collectMatches(source, RE_DECISION, 'decision'),
    ...collectMatches(source, RE_IDENTIFIER, 'identifier'),
  ];

  const resolved = resolveOverlaps(allHits);

  const anchors: Anchor[] = resolved.map((hit) => ({
    kind: hit.kind,
    text: hit.text,
    start: hit.start,
    end: hit.end,
    hash: sha256(hit.text),
    probativeWeight: classifyProbativeWeight({ kind: hit.kind, text: hit.text }),
  }));

  return {
    anchors,
    source,
    sourceHash: sha256(source),
  };
}

/**
 * Test helper: returns ranges between anchors that are eligible for
 * compaction. Each range is a `{start, end}` pair pointing into the
 * original source. Sparkling and Electrolyte tiers walk these ranges
 * and decide what to compress.
 */
export function getCompactableRanges(
  result: AnchorExtractionResult
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const anchor of result.anchors) {
    if (anchor.start > cursor) {
      ranges.push({ start: cursor, end: anchor.start });
    }
    cursor = Math.max(cursor, anchor.end);
  }
  if (cursor < result.source.length) {
    ranges.push({ start: cursor, end: result.source.length });
  }
  return ranges;
}

/**
 * Test helper: count anchors by kind. Used by the recall eval suite to
 * verify that no anchor kind is silently dropped.
 */
export function countByKind(result: AnchorExtractionResult): Record<AnchorKind, number> {
  const counts: Record<AnchorKind, number> = {
    code_block: 0,
    inline_code: 0,
    file_ref: 0,
    file_path: 0,
    hash: 0,
    tool_call: 0,
    decision: 0,
    error: 0,
    identifier: 0,
    url: 0,
  };
  for (const anchor of result.anchors) {
    counts[anchor.kind]++;
  }
  return counts;
}

/**
 * Sparkling Tier — the lightest Revive drink
 *
 * "Sparkling water — just takes the edge off."
 *
 * Sparkling targets 20–30% reduction with a 99% recall floor on
 * fixtures. The strategy is exclusively safe transformations:
 *
 *   1. Strip assistant preambles ("Let me…", "I'll now…", "Sure!", "Of course")
 *   2. Collapse runs of blank lines (3+ → 1)
 *   3. Drop polite filler phrases ("Great question!", "Hope that helps")
 *   4. Trim trailing whitespace per line
 *   5. Dedupe identical adjacent prose paragraphs
 *
 * NEVER touches anchors. NEVER paraphrases. NEVER drops a fact.
 *
 * The flow is:
 *   1. Extract anchors from each message
 *   2. For each compactable range (gap between anchors), apply the
 *      Sparkling rules
 *   3. Reassemble the message: anchor / compacted gap / anchor / ...
 *
 * @module revive/tiers/sparkling
 */

import { extractAnchors, getCompactableRanges, type Anchor } from '../anchorExtractor.js';
import type { SessionMessage } from '../formats/jsonl.js';
import type { DroppedSpan } from '../manifest.js';
import { countTokensApprox } from '../../engine/tokenCounter.js';

// ─── Types ───────────────────────────────────────────────────────────

/** A span that the tier dropped from a message. */
export interface SparklingDrop {
  /** Original message index this drop came from. */
  messageIndex: number;
  /** Offset within the original message content. */
  startInMessage: number;
  /** End offset within the original message content. */
  endInMessage: number;
  /** The dropped text. */
  text: string;
  /** Why it was dropped. */
  reason: string;
}

/** Result of running Sparkling on one message. */
export interface SparklingMessageResult {
  /** Compacted content for this message. */
  content: string;
  /** Anchors that were preserved (used for manifest). */
  preservedAnchors: Anchor[];
  /** Spans that were dropped (used for manifest). */
  drops: SparklingDrop[];
}

/** Result of running Sparkling on a whole session. */
export interface SparklingResult {
  /** The compacted messages, in original order. */
  messages: SessionMessage[];
  /** Every preserved anchor across the whole session. */
  preservedAnchors: Anchor[];
  /** Every drop, in a manifest-ready shape. */
  droppedSpans: Array<Omit<DroppedSpan, 'id' | 'hash' | 'originalLength'> & { text: string }>;
  /** Approximate token count of the original session. */
  originalTokens: number;
  /** Approximate token count of the compacted session. */
  compactedTokens: number;
}

// ─── Compaction rules ────────────────────────────────────────────────
//
// Each rule consumes a string and returns the compacted string plus a
// list of drops with their offsets in the ORIGINAL string.

interface RuleDrop {
  start: number;
  end: number;
  text: string;
  reason: string;
}

interface RuleResult {
  output: string;
  drops: RuleDrop[];
}

/**
 * Common assistant preamble patterns. Each pattern is line-anchored
 * (matches at start-of-text or after a newline) so we catch BOTH
 * message-start preambles AND mid-message paragraph preambles like
 * "...code block.\n\nLet me explain what that does."
 *
 * Each pattern is conservative — only drops phrasings that almost
 * never carry information. If a phrase passes one of these patterns
 * and turns out to carry meaning in some edge case, the manifest
 * still records it and `expand` rehydrates it byte-for-byte.
 */
// Boundary prefix shared by all preamble patterns. Zero-width in all
// cases so that consecutive matches don't accidentally consume each
// other's boundary characters:
//   - `^`              start of text (zero-width assertion)
//   - `(?<=\n)`        preceded by a newline (zero-width lookbehind)
//   - `(?<=[.!?]\s)`   preceded by sentence terminator + whitespace
//
// Without lookbehind, "Let me X. Let me Y. Let me Z." would only get
// the first "Let me" — the trailing space of pattern #1's match would
// eat the boundary that pattern #2 needs.
const BOUNDARY = '(?:^|(?<=\\n)|(?<=[.!?]\\s))';

const PREAMBLE_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    // Order matters: longer/more-specific alternatives first so the
    // greedy regex engine doesn't match the shorter prefix and leave
    // a tail behind ("Great question on next steps!" must not match
    // just "Great question" and orphan "on next steps!").
    regex: new RegExp(
      `${BOUNDARY}(?:Great question on[^.\\n]*[.!?]?|Great question[!,.]?|Of course[!,.]?|Certainly[!,.]?|Absolutely[!,.]?|Got it[!,.]?|Happy to help[!,.]?|No problem[!,.]?|Sure[!,.]?)[ \\t]*`,
      'gi'
    ),
    reason: 'preamble: filler greeting',
  },
  {
    // "Let me…" with optional leading transitional word.
    regex: new RegExp(
      `${BOUNDARY}(?:(?:First|Now|Then|Next|Also|So|OK|Okay|Alright|Right|Finally),?\\s+)?[Ll]et me\\s+[^.\\n]+?\\.[ \\t]*`,
      'g'
    ),
    reason: 'preamble: "Let me…" announcement',
  },
  {
    // "I'll/I will/I'm going to…" with optional leading transitional word.
    regex: new RegExp(
      `${BOUNDARY}(?:(?:First|Now|Then|Next|Also|So|OK|Okay|Alright|Right|Finally),?\\s+)?I(?:'ll| will| am going to| can|'m going to)\\s+[^.\\n]+?\\.[ \\t]*`,
      'g'
    ),
    reason: 'preamble: "I will…" announcement',
  },
  {
    regex: new RegExp(
      `${BOUNDARY}I would (?:recommend|suggest|like to|propose)\\s+[^.\\n]+?\\.[ \\t]*`,
      'g'
    ),
    reason: 'preamble: "I would recommend…"',
  },
  {
    regex: new RegExp(
      `${BOUNDARY}Here(?:'s| is)\\s+(?:what|how|the|a)\\s+[^.\\n]+?[.:][ \\t]*`,
      'gi'
    ),
    reason: 'preamble: "Here is what…" announcement',
  },
];

/**
 * Trailing patterns. Each pattern matches at the end of the text or
 * before a blank line.
 */

const TRAILING_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /\s*(?:Hope (?:this|that) helps[!.]?|Let me know if [^.\n]+?[.!]?|Feel free to [^.\n]+?[.!]?|Want me to [^?\n]+\?)\s*$/i,
    reason: 'trailing: polite filler',
  },
];

function dropPreambles(text: string): RuleResult {
  // Lookbehind-anchored global scan. Each pattern's boundary is
  // zero-width, so the match starts at the actual preamble word — no
  // post-processing needed. Subsequent matches' boundaries are not
  // consumed by previous matches.
  const drops: RuleDrop[] = [];
  for (const pattern of PREAMBLE_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const start = match.index;
      const end = match.index + match[0].length;
      if (end <= start) {
        pattern.regex.lastIndex = match.index + 1;
        continue;
      }
      drops.push({
        start,
        end,
        text: text.slice(start, end),
        reason: pattern.reason,
      });
    }
  }
  // Note: we deliberately DO NOT compute the trimmed `output` here.
  // compactGap will merge our drops with drops from the other rules
  // and produce the final output in one pass. Returning the original
  // text as `output` is correct because no rule downstream consumes
  // it — they all read from the original gap.
  return { output: text, drops };
}

function dropTrailing(text: string): RuleResult {
  let working = text;
  const drops: RuleDrop[] = [];
  for (const pattern of TRAILING_PATTERNS) {
    const match = working.match(pattern.regex);
    if (match && typeof match.index === 'number') {
      drops.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        reason: pattern.reason,
      });
      working = working.slice(0, match.index) + working.slice(match.index + match[0].length);
    }
  }
  return { output: working, drops };
}

function collapseBlankLines(text: string): RuleResult {
  // Replace 3+ consecutive newlines with 2.
  const drops: RuleDrop[] = [];
  const regex = /\n{3,}/g;
  let match: RegExpExecArray | null;
  let cumulativeDelta = 0;
  let output = text;
  // Walk matches against the ORIGINAL text, not the rolling output, so
  // offsets stay aligned with the source the caller passed in.
  while ((match = regex.exec(text)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    const dropped = text.slice(start + 2, end); // keep the first two newlines
    if (dropped.length === 0) continue;
    drops.push({
      start: start + 2,
      end,
      text: dropped,
      reason: 'whitespace: collapsed blank lines',
    });
    // Patch output. Because we may have already trimmed earlier matches,
    // adjust the slice indices by cumulativeDelta.
    const adjStart = start + 2 - cumulativeDelta;
    const adjEnd = end - cumulativeDelta;
    output = output.slice(0, adjStart) + output.slice(adjEnd);
    cumulativeDelta += dropped.length;
  }
  return { output, drops };
}

function trimTrailingWhitespace(text: string): RuleResult {
  const drops: RuleDrop[] = [];
  // Find runs of trailing-whitespace-before-newline.
  const regex = /[ \t]+(?=\n)/g;
  let match: RegExpExecArray | null;
  let cumulativeDelta = 0;
  let output = text;
  while ((match = regex.exec(text)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    drops.push({
      start,
      end,
      text: match[0],
      reason: 'whitespace: trailing spaces',
    });
    const adjStart = start - cumulativeDelta;
    const adjEnd = end - cumulativeDelta;
    output = output.slice(0, adjStart) + output.slice(adjEnd);
    cumulativeDelta += match[0].length;
  }
  return { output, drops };
}

// ─── Per-message compaction ──────────────────────────────────────────

/**
 * Apply Sparkling to a single message body.
 *
 * Algorithm:
 *   1. Extract anchors from the body.
 *   2. Build the compactable ranges (text between anchors).
 *   3. For each compactable range, apply the Sparkling rules.
 *   4. Reassemble: anchor / compacted-gap / anchor / ...
 *   5. Track every drop with its offset in the ORIGINAL body.
 */
export function compactSparklingMessage(body: string): SparklingMessageResult {
  const extraction = extractAnchors(body);
  const ranges = getCompactableRanges(extraction);

  // Walk through the original body, copying anchors verbatim and
  // compacting the ranges between them. Build the output piece by
  // piece, tracking offsets.
  const outputParts: string[] = [];
  const drops: SparklingDrop[] = [];
  let originalCursor = 0;

  // Build a fast lookup: for each anchor, what's its original [start,end].
  for (const range of ranges) {
    // Copy any anchor text that sits between originalCursor and range.start
    if (range.start > originalCursor) {
      outputParts.push(body.slice(originalCursor, range.start));
    }

    const original = body.slice(range.start, range.end);
    const { compacted, gapDrops } = compactGap(original, range.start);
    outputParts.push(compacted);
    drops.push(...gapDrops);
    originalCursor = range.end;
  }
  // Tail anchor (if any).
  if (originalCursor < body.length) {
    outputParts.push(body.slice(originalCursor));
  }

  return {
    content: outputParts.join(''),
    preservedAnchors: extraction.anchors,
    drops,
  };
}

function compactGap(
  gap: string,
  gapStartInMessage: number
): { compacted: string; gapDrops: SparklingDrop[] } {
  // Run every rule against the ORIGINAL gap. Each rule emits drops
  // with gap-relative offsets. We then merge overlapping drops and
  // build the final compacted output by removing the merged set in
  // one pass. This avoids cascading offset rebases.
  const ruleResults: RuleDrop[][] = [
    dropPreambles(gap).drops,
    dropTrailing(gap).drops,
    collapseBlankLines(gap).drops,
    trimTrailingWhitespace(gap).drops,
  ];

  const allDrops: RuleDrop[] = [];
  for (const drops of ruleResults) allDrops.push(...drops);

  const merged = mergeOverlappingDrops(allDrops, gap);
  const compacted = removeDrops(gap, merged);

  const gapDrops: SparklingDrop[] = merged.map((d) => ({
    messageIndex: -1, // filled in by caller
    startInMessage: gapStartInMessage + d.start,
    endInMessage: gapStartInMessage + d.end,
    text: d.text,
    reason: d.reason,
  }));

  return { compacted, gapDrops };
}

/**
 * Merge overlapping drops into non-overlapping ranges. When two drops
 * overlap, the merged range covers both and uses the union's text.
 * This is required for the manifest verifier: if we recorded two drops
 * at the same start offset, the verifier would slice the same range
 * twice and see only the longer text on both lookups, mismatching the
 * shorter drop's hash.
 */
function mergeOverlappingDrops(drops: RuleDrop[], source: string): RuleDrop[] {
  if (drops.length === 0) return [];
  const sorted = [...drops].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: RuleDrop[] = [];
  for (const d of sorted) {
    if (d.end <= d.start) continue;
    const last = merged[merged.length - 1];
    if (last && d.start < last.end) {
      // Overlap. Extend the previous range if d reaches further.
      if (d.end > last.end) {
        last.end = d.end;
        last.text = source.slice(last.start, last.end);
      }
      continue;
    }
    merged.push({ start: d.start, end: d.end, text: d.text, reason: d.reason });
  }
  return merged;
}

/** Build the compacted output by removing the given (sorted, non-overlapping) drops. */
function removeDrops(source: string, drops: RuleDrop[]): string {
  if (drops.length === 0) return source;
  const parts: string[] = [];
  let cursor = 0;
  for (const d of drops) {
    if (d.start > cursor) parts.push(source.slice(cursor, d.start));
    cursor = d.end;
  }
  if (cursor < source.length) parts.push(source.slice(cursor));
  return parts.join('');
}

// ─── Whole-session compaction ────────────────────────────────────────

/**
 * Run Sparkling on every message in a session. Produces a result that
 * can be fed directly into `buildManifest`.
 */
export function compactSparklingSession(messages: SessionMessage[]): SparklingResult {
  const compactedMessages: SessionMessage[] = [];
  const allPreservedAnchors: Anchor[] = [];
  const allDroppedSpans: Array<
    Omit<DroppedSpan, 'id' | 'hash' | 'originalLength'> & { text: string }
  > = [];

  let originalTokens = 0;
  let compactedTokens = 0;

  // Track running offset in the FLAT serialized form so anchor/dropped
  // offsets in the manifest are flat-text offsets the verifier can use.
  let flatCursor = 0;

  for (const msg of messages) {
    const header = `\n[${msg.role}#${msg.index}]\n`;
    flatCursor += header.length;
    const messageStartInFlat = flatCursor;

    const result = compactSparklingMessage(msg.content);

    // Patch message-relative anchors and drops to flat-text offsets.
    for (const anchor of result.preservedAnchors) {
      allPreservedAnchors.push({
        ...anchor,
        start: anchor.start + messageStartInFlat,
        end: anchor.end + messageStartInFlat,
      });
    }
    for (const drop of result.drops) {
      allDroppedSpans.push({
        originalStart: drop.startInMessage + messageStartInFlat,
        originalEnd: drop.endInMessage + messageStartInFlat,
        approxTokens: countTokensApprox(drop.text),
        reason: drop.reason,
        recoveryHint: `Dropped from ${msg.role}#${msg.index}: ${drop.reason}`,
        text: drop.text,
      });
    }

    originalTokens += countTokensApprox(msg.content);
    compactedTokens += countTokensApprox(result.content);

    compactedMessages.push({
      ...msg,
      content: result.content,
    });

    // Advance flatCursor past the original message body length so the
    // next message's offsets line up with the SOURCE flat text the
    // verifier sees.
    flatCursor += msg.content.length;
  }

  // Sort preserved anchors by flat-text start offset (each message's
  // anchors are already sorted; concatenation may not be globally
  // sorted if a message had no anchors and we appended later ones).
  allPreservedAnchors.sort((a, b) => a.start - b.start);
  allDroppedSpans.sort((a, b) => a.originalStart - b.originalStart);

  return {
    messages: compactedMessages,
    preservedAnchors: allPreservedAnchors,
    droppedSpans: allDroppedSpans,
    originalTokens,
    compactedTokens,
  };
}

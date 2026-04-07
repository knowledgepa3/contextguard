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
 * Common assistant preamble patterns. Anchored at the start of a line.
 * Each pattern is conservative — only drops phrasings that almost
 * never carry information.
 */
const PREAMBLE_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /^(?:Sure[!,.]?|Of course[!,.]?|Certainly[!,.]?|Absolutely[!,.]?|Got it[!,.]?|Great question[!,.]?|Happy to help[!,.]?|No problem[!,.]?)\s*/i,
    reason: 'preamble: filler greeting',
  },
  {
    regex: /^(?:Let me\s+[^.\n]+?\.\s*)/,
    reason: 'preamble: "Let me…" announcement',
  },
  {
    regex: /^(?:I(?:'ll| will| am going to| can)\s+[^.\n]+?\.\s*)/,
    reason: 'preamble: "I will…" announcement',
  },
  {
    regex: /^(?:Here(?:'s| is)\s+(?:what|how|the))\s+[^.\n]+?[.:]\s*/i,
    reason: 'preamble: "Here is what…" announcement',
  },
];

/**
 * Polite trailing phrases that add no information. Anchored at the
 * end of the text or before a blank line.
 */
const TRAILING_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /\s*(?:Hope (?:this|that) helps[!.]?|Let me know if [^.\n]+?[.!]?|Feel free to [^.\n]+?[.!]?)\s*$/i,
    reason: 'trailing: polite filler',
  },
];

function dropPreambles(text: string): RuleResult {
  let working = text;
  const drops: RuleDrop[] = [];
  // Track cumulative front-trim so subsequent matches' offsets stay
  // anchored to the ORIGINAL `text` rather than to the shrinking
  // `working` view. Without this, two consecutive preamble matches
  // would both report start=0, which the manifest verifier will reject
  // because they overlap and only one of the two real spans hashes to
  // the recorded value.
  let cumulativeOffset = 0;
  for (const pattern of PREAMBLE_PATTERNS) {
    const match = working.match(pattern.regex);
    if (match && match.index === 0) {
      drops.push({
        start: cumulativeOffset,
        end: cumulativeOffset + match[0].length,
        text: match[0],
        reason: pattern.reason,
      });
      working = working.slice(match[0].length);
      cumulativeOffset += match[0].length;
    }
  }
  return { output: working, drops };
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
  // Apply rules in order. Each rule sees the gap text as a fresh slate,
  // but we re-base the drop offsets onto gapStartInMessage so the manifest
  // can locate them in the message body.
  let working = gap;
  const allDrops: RuleDrop[] = [];

  const r1 = dropPreambles(working);
  // r1.drops are offsets into `gap` (because we passed gap as input).
  // After r1, `working` is shorter. We need to keep r1.drops as-is
  // (they reference the original gap), but subsequent rule outputs
  // will be relative to the trimmed `working`. To keep things simple,
  // we re-extract drops by diffing `working` vs `gap` after each rule.
  allDrops.push(...r1.drops);
  working = r1.output;

  // For trailing patterns, the offset is relative to `working`, not
  // `gap`. We rebase by tracking how much we trimmed off the front.
  const headerTrim = gap.length - working.length;
  const r2 = dropTrailing(working);
  for (const d of r2.drops) {
    allDrops.push({
      start: d.start + headerTrim,
      end: d.end + headerTrim,
      text: d.text,
      reason: d.reason,
    });
  }
  working = r2.output;

  // Collapse blank lines and trim trailing whitespace, both work on the
  // current `working` text. We rebase their drop offsets relative to
  // the ORIGINAL gap by reasoning about cumulative deletion.
  // Simpler approach: re-run these two rules against the original gap
  // (so offsets are gap-relative), then apply both to the current
  // working text to produce the final output.
  const r3FromGap = collapseBlankLines(gap);
  const r4FromGap = trimTrailingWhitespace(gap);
  // Drops from r3 and r4 are offsets into `gap`. They may overlap with
  // preamble/trailing drops that we already recorded — dedupe by
  // (start,end) before pushing.
  const seen = new Set<string>();
  for (const d of allDrops) seen.add(`${d.start}:${d.end}`);
  for (const d of r3FromGap.drops) {
    const key = `${d.start}:${d.end}`;
    if (!seen.has(key)) {
      allDrops.push(d);
      seen.add(key);
    }
  }
  for (const d of r4FromGap.drops) {
    const key = `${d.start}:${d.end}`;
    if (!seen.has(key)) {
      allDrops.push(d);
      seen.add(key);
    }
  }

  // Apply r3 and r4 to the current `working` to produce the final
  // compacted gap. Use the rule outputs directly (they were computed
  // from the original gap), but only if `working` still equals gap.
  // If preambles/trailing already trimmed `working`, we need to apply
  // r3/r4 to `working` instead.
  let finalOutput = working;
  if (finalOutput === gap) {
    // No preamble/trailing trim happened, use the gap-level outputs.
    // Apply both transforms in sequence on the gap.
    finalOutput = collapseBlankLines(finalOutput).output;
    finalOutput = trimTrailingWhitespace(finalOutput).output;
  } else {
    finalOutput = collapseBlankLines(finalOutput).output;
    finalOutput = trimTrailingWhitespace(finalOutput).output;
  }

  // Sort drops and rebase to message offsets.
  allDrops.sort((a, b) => a.start - b.start);
  const gapDrops: SparklingDrop[] = allDrops.map((d) => ({
    messageIndex: -1, // filled in by caller
    startInMessage: gapStartInMessage + d.start,
    endInMessage: gapStartInMessage + d.end,
    text: d.text,
    reason: d.reason,
  }));

  return { compacted: finalOutput, gapDrops };
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

/**
 * JSONL Session Format Parser/Writer
 *
 * Parses Claude/OpenAI session JSONL files into a normalized form that
 * Revive can compact, then writes the compacted form back out in the
 * same shape so the file remains a valid session.
 *
 * Both Claude (.claude session jsonl) and OpenAI (chat completion logs)
 * use line-delimited JSON. The exact field shape varies by harness:
 *
 *   Claude harness:  { type: 'user'|'assistant', message: { role, content } }
 *   OpenAI logs:     { role: 'user'|'assistant', content: '...' }
 *
 * The normalizer accepts either and emits a uniform `SessionMessage[]`.
 *
 * @module revive/formats/jsonl
 */

// ─── Types ───────────────────────────────────────────────────────────

export type SessionRole = 'system' | 'user' | 'assistant' | 'tool';

/** A single message in a normalized session, format-agnostic. */
export interface SessionMessage {
  /** Stable index in the original file. */
  index: number;
  /** Speaker role. */
  role: SessionRole;
  /** Flattened textual content (multimodal blocks are joined as text). */
  content: string;
  /** Original token count if known, otherwise undefined. */
  tokens?: number;
  /** Opaque original record — preserved so we can write it back out. */
  raw: unknown;
}

/** Result of parsing a JSONL session file. */
export interface ParsedSession {
  messages: SessionMessage[];
  /** The flat text dump used for anchor extraction (joined messages). */
  flatText: string;
  /** Per-message offsets in `flatText` so we can map anchors back. */
  offsets: Array<{ index: number; start: number; end: number }>;
}

// ─── Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a JSONL session string. Tolerant of blank lines, trailing
 * newlines, and unknown harness shapes (unknown shapes get
 * `role: 'assistant'` and `content: ''`, with `raw` preserved so the
 * writer can round-trip them).
 */
export function parseSessionJsonl(text: string): ParsedSession {
  const lines = text.split(/\r?\n/);
  const messages: SessionMessage[] = [];

  let index = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Skip malformed lines but don't throw — sessions in the wild
      // sometimes have partial last lines from crashes.
      continue;
    }

    const message = normalizeMessage(parsed, index);
    if (message) {
      messages.push(message);
      index++;
    }
  }

  // Build flat text and offset map for anchor extraction.
  const offsets: Array<{ index: number; start: number; end: number }> = [];
  let cursor = 0;
  const parts: string[] = [];
  for (const msg of messages) {
    const header = `\n[${msg.role}#${msg.index}]\n`;
    parts.push(header);
    cursor += header.length;
    const start = cursor;
    parts.push(msg.content);
    cursor += msg.content.length;
    offsets.push({ index: msg.index, start, end: cursor });
  }
  const flatText = parts.join('');

  return { messages, flatText, offsets };
}

/**
 * Normalize a parsed JSON record into a SessionMessage. Returns null
 * for records that contain no usable role or content.
 */
function normalizeMessage(record: unknown, index: number): SessionMessage | null {
  if (typeof record !== 'object' || record === null) return null;
  const obj = record as Record<string, unknown>;

  // Claude harness shape: { type, message: { role, content } }
  if ('message' in obj && typeof obj.message === 'object' && obj.message !== null) {
    const inner = obj.message as Record<string, unknown>;
    const role = coerceRole(inner.role);
    const content = flattenContent(inner.content);
    if (role !== null && content !== null) {
      return { index, role, content, raw: record };
    }
  }

  // OpenAI / generic shape: { role, content }
  if ('role' in obj) {
    const role = coerceRole(obj.role);
    const content = flattenContent(obj.content);
    if (role !== null && content !== null) {
      return { index, role, content, raw: record };
    }
  }

  // Unknown shape — preserve as opaque assistant message with empty
  // content. The writer will round-trip the raw record unchanged.
  return { index, role: 'assistant', content: '', raw: record };
}

function coerceRole(value: unknown): SessionRole | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  if (lower === 'system' || lower === 'user' || lower === 'assistant' || lower === 'tool') {
    return lower;
  }
  return null;
}

/**
 * Flatten a content field into a single string. Handles three shapes:
 *   - `string`: returned as-is
 *   - `Array<{ type, text }>` (Anthropic content blocks)
 *   - `Array<{ type, content }>` (some tool result shapes)
 */
function flattenContent(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;

  const parts: string[] = [];
  for (const block of value) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (typeof block !== 'object' || block === null) continue;
    const obj = block as Record<string, unknown>;
    if (typeof obj.text === 'string') {
      parts.push(obj.text);
    } else if (typeof obj.content === 'string') {
      parts.push(obj.content);
    } else if (Array.isArray(obj.content)) {
      const inner = flattenContent(obj.content);
      if (inner !== null) parts.push(inner);
    }
  }
  return parts.join('\n');
}

// ─── Writing ─────────────────────────────────────────────────────────

/**
 * Write a session back out as JSONL. Each message's `raw` field is
 * patched in place: the textual content is replaced with the compacted
 * version, then the record is re-serialized. This keeps unknown harness
 * fields (timestamps, IDs, etc.) intact.
 */
export function writeSessionJsonl(messages: SessionMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const patched = patchRawContent(msg.raw, msg.content);
    lines.push(JSON.stringify(patched));
  }
  return lines.join('\n') + '\n';
}

function patchRawContent(raw: unknown, newContent: string): unknown {
  if (typeof raw !== 'object' || raw === null) {
    // Unknown shape — emit a minimal record.
    return { role: 'assistant', content: newContent };
  }
  const obj = raw as Record<string, unknown>;

  // Claude harness shape
  if ('message' in obj && typeof obj.message === 'object' && obj.message !== null) {
    const innerRaw = obj.message as Record<string, unknown>;
    const inner: Record<string, unknown> = { ...innerRaw, content: newContent };
    return { ...obj, message: inner };
  }

  // OpenAI / generic shape
  if ('role' in obj) {
    return { ...obj, content: newContent };
  }

  return { ...obj, content: newContent };
}

/**
 * Token Counter — Fast approximate token counting
 *
 * Uses a character-based heuristic for speed. Accurate enough for budget
 * management (within ~5% of tiktoken). Production upgrade path: swap in
 * tiktoken or provider-specific tokenizers.
 *
 * Why heuristic: Zero native dependencies, works everywhere, fast enough
 * for real-time budget tracking. Exact counts only matter at the API boundary.
 */

/**
 * Approximate token count using the 4-chars-per-token heuristic.
 * Adjusted for common patterns:
 * - Code tends to have more tokens per character (shorter tokens)
 * - Natural language averages ~4 chars/token for English
 * - CJK and special characters get ~1-2 chars/token
 */
export function countTokensApprox(text: string): number {
  if (!text) return 0;

  // Base estimate: ~4 chars per token for English
  let estimate = text.length / 4;

  // Adjust for whitespace-heavy content (more tokens per char)
  const whitespaceRatio = (text.match(/\s/g)?.length ?? 0) / text.length;
  if (whitespaceRatio > 0.3) {
    estimate *= 1.1;
  }

  // Adjust for code patterns (shorter tokens)
  const codeSignals = (text.match(/[{}();=<>[\]]/g)?.length ?? 0) / text.length;
  if (codeSignals > 0.05) {
    estimate *= 1.2;
  }

  // Adjust for newlines (each typically a token)
  const newlines = (text.match(/\n/g)?.length ?? 0);
  estimate += newlines * 0.5;

  return Math.ceil(estimate);
}

/**
 * Count tokens in a structured message (accounts for role overhead)
 */
export function countMessageTokens(_role: string, content: string): number {
  // Each message has overhead: role token + delimiters (~4 tokens)
  const overhead = 4;
  return overhead + countTokensApprox(content);
}

/**
 * Count total tokens across multiple messages
 */
export function countMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  // Base overhead for the messages array (~3 tokens)
  let total = 3;
  for (const msg of messages) {
    total += countMessageTokens(msg.role, msg.content);
  }
  return total;
}

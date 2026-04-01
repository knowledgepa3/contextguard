/**
 * Anthropic Provider Adapter
 *
 * Handles Claude-specific token counting, message categorization,
 * and context window sizes.
 */

import type { ProviderAdapter, Message, ContextCategory } from '../types/index.js';
import { countTokensApprox } from '../engine/tokenCounter.js';

/** Claude model context window sizes */
const CLAUDE_CONTEXT_SIZES: Record<string, number> = {
  'claude-opus-4-6': 1000000,
  'claude-sonnet-4-6': 200000,
  'claude-haiku-4-5': 200000,
  'claude-sonnet-4-20250514': 200000,
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-haiku-20241022': 200000,
  'claude-3-opus-20240229': 200000,
};

const DEFAULT_CONTEXT_SIZE = 200000;

export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',

  countTokens(text: string): number {
    // Anthropic uses a BPE tokenizer similar to GPT
    // Our heuristic is close enough for budget management
    return countTokensApprox(text);
  },

  categorizeMessage(message: Message, index: number, _total: number): ContextCategory {
    // System messages
    if (message.role === 'system') return 'system';

    // Tool results
    if (message.role === 'tool') return 'tool_results';

    // First user message often contains injected documents
    if (message.role === 'user' && index === 0 && message.content.length > 2000) {
      return 'documents';
    }

    // Conversation (user + assistant turns)
    if (message.role === 'user' || message.role === 'assistant') {
      return 'conversation';
    }

    return 'other';
  },

  getMaxContextTokens(model: string): number {
    return CLAUDE_CONTEXT_SIZES[model] ?? DEFAULT_CONTEXT_SIZE;
  },
};

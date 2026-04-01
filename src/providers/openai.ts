/**
 * OpenAI Provider Adapter
 *
 * Handles GPT-specific token counting, message categorization,
 * and context window sizes.
 */

import type { ProviderAdapter, Message, ContextCategory } from '../types/index.js';
import { countTokensApprox } from '../engine/tokenCounter.js';

/** OpenAI model context window sizes */
const OPENAI_CONTEXT_SIZES: Record<string, number> = {
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'o1-preview': 128000,
  'o1-mini': 128000,
  'o3-mini': 200000,
};

const DEFAULT_CONTEXT_SIZE = 128000;

export const openaiAdapter: ProviderAdapter = {
  name: 'openai',

  countTokens(text: string): number {
    // GPT uses cl100k_base tokenizer
    // Heuristic is within ~5% for English text
    return countTokensApprox(text);
  },

  categorizeMessage(message: Message, index: number, _total: number): ContextCategory {
    if (message.role === 'system') return 'system';
    if (message.role === 'tool') return 'tool_results';

    // First user message with large content likely has injected docs
    if (message.role === 'user' && index === 0 && message.content.length > 2000) {
      return 'documents';
    }

    if (message.role === 'user' || message.role === 'assistant') {
      return 'conversation';
    }

    return 'other';
  },

  getMaxContextTokens(model: string): number {
    return OPENAI_CONTEXT_SIZES[model] ?? DEFAULT_CONTEXT_SIZE;
  },
};

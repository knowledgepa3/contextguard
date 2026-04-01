/**
 * Provider Registry
 */

import type { Provider, ProviderAdapter } from '../types/index.js';
import { anthropicAdapter } from './anthropic.js';
import { openaiAdapter } from './openai.js';
import { countTokensApprox } from '../engine/tokenCounter.js';
import type { Message, ContextCategory } from '../types/index.js';

/** Generic fallback adapter */
const genericAdapter: ProviderAdapter = {
  name: 'generic',
  countTokens: countTokensApprox,
  categorizeMessage(message: Message, _index: number, _total: number): ContextCategory {
    if (message.role === 'system') return 'system';
    if (message.role === 'tool') return 'tool_results';
    if (message.role === 'user' || message.role === 'assistant') return 'conversation';
    return 'other';
  },
  getMaxContextTokens(): number {
    return 128000;
  },
};

const adapters: Record<Provider, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  generic: genericAdapter,
};

export function getAdapter(provider: Provider): ProviderAdapter {
  return adapters[provider] ?? genericAdapter;
}

/** Auto-detect provider from model name */
export function detectProvider(model: string): Provider {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  return 'generic';
}

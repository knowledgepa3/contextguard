/**
 * Anthropic SDK Middleware Wrapper
 *
 * Wraps the Anthropic Messages API to automatically track context
 * through ContextGuard. One import, zero friction.
 *
 * Usage:
 *   import { wrapAnthropic } from 'contextguard';
 *   const client = wrapAnthropic(new Anthropic(), { model: 'claude-sonnet-4-6' });
 *   // All messages.create() calls now tracked automatically
 */

import { ContextInspector } from '../inspector/index.js';
import { BudgetManager } from '../engine/budgetManager.js';
import type { Message, InspectionResult, BudgetConfig, ContextCategory } from '../types/index.js';

/** Events emitted by the wrapper */
export interface ContextGuardEvents {
  onInspection?: (result: InspectionResult) => void;
  onWarning?: (message: string, category: string) => void;
  onPrune?: (prunedCount: number, freedTokens: number) => void;
  onOverBudget?: (category: string, used: number, limit: number) => void;
}

/** Wrapper configuration */
export interface WrapperConfig {
  /** Model name for context window sizing */
  model?: string;

  /** Budget configuration overrides */
  budget?: Partial<BudgetConfig>;

  /** Auto-prune when budget exceeded */
  autoPrune?: boolean;

  /** Print inspection after each call */
  printInspection?: boolean;

  /** Print warnings to stderr */
  printWarnings?: boolean;

  /** Event callbacks */
  events?: ContextGuardEvents;
}

/** Tracked conversation state */
export interface TrackedConversation {
  /** The budget manager tracking this conversation */
  manager: BudgetManager;

  /** Current message count */
  messageCount: number;

  /** Run an inspection */
  inspect(): InspectionResult;

  /** Get current health grade */
  grade(): string;

  /** Get formatted display */
  display(): string;

  /** Reset tracking (new conversation) */
  reset(): void;
}

/**
 * Create a tracked conversation that monitors context budget.
 *
 * This is the provider-agnostic core. Use it with any LLM client:
 *
 * ```typescript
 * const conv = createTrackedConversation({ model: 'claude-sonnet-4-6' });
 *
 * // Track your system prompt
 * conv.trackSystem('You are a helpful assistant.');
 *
 * // Track each message exchange
 * conv.trackUser('Help me with...');
 * const response = await anthropic.messages.create({ ... });
 * conv.trackAssistant(response.content[0].text);
 *
 * // Check health anytime
 * console.log(conv.inspect().display);
 * ```
 */
export function createTrackedConversation(config?: WrapperConfig): TrackedConversation & {
  trackSystem: (content: string) => void;
  trackUser: (content: string) => void;
  trackAssistant: (content: string) => void;
  trackTool: (name: string, content: string) => void;
  trackDocument: (title: string, content: string) => void;
  trackMemory: (packId: string, content: string) => void;
} {
  const model = config?.model ?? 'claude-sonnet-4-6';
  const inspector = new ContextInspector({ model, provider: 'anthropic' });
  const manager = inspector.getBudgetManager();
  let messageCount = 0;

  function emitWarnings(): void {
    if (!config?.printWarnings && !config?.events?.onWarning) return;

    const status = manager.getStatus();
    for (const cat of status.categories) {
      if (cat.overBudget) {
        const msg = `[ContextGuard] OVER BUDGET: ${cat.category} using ${cat.tokensUsed}/${cat.tokensAllocated} tokens`;
        if (config?.printWarnings) process.stderr.write(msg + '\n');
        config?.events?.onWarning?.(msg, cat.category);
        config?.events?.onOverBudget?.(cat.category, cat.tokensUsed, cat.tokensAllocated);
      } else if (cat.warning) {
        const msg = `[ContextGuard] WARNING: ${cat.category} at ${Math.round(cat.percentage * 100)}% capacity`;
        if (config?.printWarnings) process.stderr.write(msg + '\n');
        config?.events?.onWarning?.(msg, cat.category);
      }
    }
  }

  function track(content: string, category: ContextCategory, source: string): void {
    manager.add(content, category, source);
    messageCount++;
    emitWarnings();

    if (config?.printInspection) {
      const result = doInspect();
      process.stderr.write(result.display + '\n');
    }

    if (config?.events?.onInspection) {
      config.events.onInspection(doInspect());
    }
  }

  function doInspect(): InspectionResult {
    const budget = manager.getStatus();
    const health = manager.getHealth();
    const items = manager.getItems();
    const session = manager.getAnalytics();

    // Build display inline (inspector's private method isn't accessible)
    const lines: string[] = [];
    lines.push('');
    lines.push(`  \x1b[36mContextGuard\x1b[0m | ${model} | ${health.grade} (${health.score}/100) | ${budget.totalTokensUsed.toLocaleString()}/${budget.totalTokensAvailable.toLocaleString()} tokens (${Math.round(budget.utilization * 100)}%)`);

    if (health.recommendations.length > 0 && health.score < 70) {
      for (const rec of health.recommendations) {
        lines.push(`  \x1b[33m>\x1b[0m ${rec}`);
      }
    }
    lines.push('');

    return { budget, health, items, session, display: lines.join('\n') };
  }

  return {
    manager,
    get messageCount() { return messageCount; },

    inspect: doInspect,
    grade: () => manager.getHealth().grade,
    display: () => doInspect().display,
    reset: () => { manager.clear(); messageCount = 0; },

    trackSystem: (content: string) => track(content, 'system', 'system_prompt'),
    trackUser: (content: string) => track(content, 'conversation', `user_msg_${messageCount}`),
    trackAssistant: (content: string) => track(content, 'conversation', `assistant_msg_${messageCount}`),
    trackTool: (name: string, content: string) => track(content, 'tool_results', `tool:${name}`),
    trackDocument: (title: string, content: string) => track(content, 'documents', `doc:${title}`),
    trackMemory: (packId: string, content: string) => track(content, 'memory', `pack:${packId}`),
  };
}

/**
 * Analyze a messages array without wrapping a client.
 * Useful for one-shot analysis of existing conversations.
 */
export function analyzeMessages(
  messages: Array<{ role: string; content: string }>,
  config?: WrapperConfig,
): InspectionResult {
  const inspector = new ContextInspector({
    model: config?.model ?? 'claude-sonnet-4-6',
    provider: 'anthropic',
  });

  const mapped: Message[] = messages.map(m => ({
    role: m.role as Message['role'],
    content: m.content,
  }));

  inspector.loadMessages(mapped);
  return inspector.inspect();
}

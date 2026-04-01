/**
 * Budget Manager — The core of ContextGuard
 *
 * Tracks all context items, enforces category budgets, triggers pruning,
 * and provides real-time budget status. This is the engine everything
 * else plugs into.
 *
 * Design: Stateful — maintains the current context window inventory.
 * Items are added as messages flow in, and budget is checked on every add.
 */

import type {
  ContextItem,
  ContextCategory,
  BudgetConfig,
  BudgetStatus,
  CategoryUsage,
  ContextHealth,
  SessionAnalytics,
} from '../types/index.js';
import { countTokensApprox } from './tokenCounter.js';
import { assessHealth } from './healthScorer.js';

let itemIdCounter = 0;
function nextId(): string {
  return `ctx-${Date.now()}-${++itemIdCounter}`;
}

/** Default budget config for a 200K context window */
export function defaultBudgetConfig(maxTokens: number = 200000): BudgetConfig {
  return {
    maxTotalTokens: maxTokens,
    globalWarningThreshold: 0.8,
    autoPrune: true,
    pruneStrategy: 'oldest',
    categories: [
      { category: 'system', maxTokens: Math.floor(maxTokens * 0.15), warningThreshold: 0.9, priority: 1 },
      { category: 'conversation', maxTokens: Math.floor(maxTokens * 0.40), warningThreshold: 0.8, priority: 3 },
      { category: 'tool_results', maxTokens: Math.floor(maxTokens * 0.20), warningThreshold: 0.8, priority: 4 },
      { category: 'documents', maxTokens: Math.floor(maxTokens * 0.15), warningThreshold: 0.8, priority: 2 },
      { category: 'memory', maxTokens: Math.floor(maxTokens * 0.05), warningThreshold: 0.9, priority: 1 },
      { category: 'examples', maxTokens: Math.floor(maxTokens * 0.05), warningThreshold: 0.9, priority: 5 },
      { category: 'other', maxTokens: Math.floor(maxTokens * 0.05), warningThreshold: 0.9, priority: 6 },
    ],
  };
}

export class BudgetManager {
  private items: ContextItem[] = [];
  private config: BudgetConfig;
  private prunedItems: ContextItem[] = [];
  private sessionStart: number;
  private peakTokens = 0;
  private totalAdded = 0;
  private totalPruned = 0;
  private violations = 0;
  private healthSamples: Array<{ timestamp: number; totalTokens: number; healthScore: number }> = [];

  constructor(config?: Partial<BudgetConfig>) {
    this.config = { ...defaultBudgetConfig(), ...config };
    this.sessionStart = Date.now();
  }

  /** Add a context item and enforce budget. Use tokenOverride to supply a pre-counted token value. */
  add(content: string, category: ContextCategory, source: string, metadata?: Record<string, unknown>, tokenOverride?: number): ContextItem {
    const tokens = tokenOverride ?? countTokensApprox(content);
    const item: ContextItem = {
      id: nextId(),
      category,
      content,
      tokens,
      addedAt: Date.now(),
      source,
      metadata,
    };

    this.items.push(item);
    this.totalAdded++;

    // Check and enforce budget
    if (this.config.autoPrune) {
      this.enforceBudget();
    }

    // Track peak
    const currentTotal = this.getTotalTokens();
    if (currentTotal > this.peakTokens) {
      this.peakTokens = currentTotal;
    }

    return item;
  }

  /** Remove a specific item by ID */
  remove(itemId: string): ContextItem | undefined {
    const index = this.items.findIndex(i => i.id === itemId);
    if (index === -1) return undefined;
    return this.items.splice(index, 1)[0];
  }

  /** Get current budget status */
  getStatus(): BudgetStatus {
    const totalTokensUsed = this.getTotalTokens();
    const categories = this.getCategoryUsages();

    return {
      totalTokensUsed,
      totalTokensAvailable: this.config.maxTotalTokens,
      utilization: totalTokensUsed / this.config.maxTotalTokens,
      categories,
      prunedItems: [...this.prunedItems],
      hasOverage: categories.some(c => c.overBudget),
      hasWarnings: categories.some(c => c.warning),
    };
  }

  /** Get health assessment */
  getHealth(): ContextHealth {
    const status = this.getStatus();
    const health = assessHealth(this.items, status);

    // Sample for timeline
    this.healthSamples.push({
      timestamp: Date.now(),
      totalTokens: status.totalTokensUsed,
      healthScore: health.score,
    });

    return health;
  }

  /** Get all tracked items */
  getItems(): ContextItem[] {
    return [...this.items];
  }

  /** Get items by category */
  getItemsByCategory(category: ContextCategory): ContextItem[] {
    return this.items.filter(i => i.category === category);
  }

  /** Get session analytics */
  getAnalytics(): SessionAnalytics {
    const health = this.getHealth();
    const avgHealth = this.healthSamples.length > 0
      ? this.healthSamples.reduce((s, h) => s + h.healthScore, 0) / this.healthSamples.length
      : health.score;

    return {
      sessionId: `cg-${this.sessionStart}`,
      startedAt: this.sessionStart,
      peakTokens: this.peakTokens,
      itemsAdded: this.totalAdded,
      itemsPruned: this.totalPruned,
      violations: this.violations,
      avgHealthScore: avgHealth,
      timeline: [...this.healthSamples],
    };
  }

  /** Update budget configuration */
  updateConfig(config: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...config };
    if (this.config.autoPrune) {
      this.enforceBudget();
    }
  }

  /** Clear all items */
  clear(): void {
    this.items = [];
    this.prunedItems = [];
  }

  // ─── Private ─────────────────────────────────────────────────────

  private getTotalTokens(): number {
    return this.items.reduce((sum, item) => sum + item.tokens, 0);
  }

  private getCategoryUsages(): CategoryUsage[] {
    return this.config.categories.map(catConfig => {
      const catItems = this.items.filter(i => i.category === catConfig.category);
      const tokensUsed = catItems.reduce((sum, i) => sum + i.tokens, 0);
      const percentage = tokensUsed / catConfig.maxTokens;

      return {
        category: catConfig.category,
        tokensUsed,
        tokensAllocated: catConfig.maxTokens,
        percentage,
        itemCount: catItems.length,
        overBudget: tokensUsed > catConfig.maxTokens,
        warning: percentage >= catConfig.warningThreshold,
      };
    });
  }

  private enforceBudget(): void {
    // Check total budget
    while (this.getTotalTokens() > this.config.maxTotalTokens) {
      const pruned = this.pruneOne();
      if (!pruned) break; // Safety: nothing left to prune
    }

    // Check per-category budgets
    for (const catConfig of this.config.categories) {
      while (this.getCategoryTokens(catConfig.category) > catConfig.maxTokens) {
        const pruned = this.pruneOneFromCategory(catConfig.category);
        if (!pruned) break;
      }
    }
  }

  private getCategoryTokens(category: ContextCategory): number {
    return this.items.filter(i => i.category === category).reduce((sum, i) => sum + i.tokens, 0);
  }

  private pruneOne(): boolean {
    // Find lowest priority category with items
    const sortedConfigs = [...this.config.categories].sort((a, b) => b.priority - a.priority);

    for (const catConfig of sortedConfigs) {
      if (this.pruneOneFromCategory(catConfig.category)) {
        return true;
      }
    }
    return false;
  }

  private pruneOneFromCategory(category: ContextCategory): boolean {
    const catItems = this.items.filter(i => i.category === category);
    if (catItems.length === 0) return false;

    let target: ContextItem;

    switch (this.config.pruneStrategy) {
      case 'oldest':
        target = catItems.reduce((oldest, item) =>
          item.addedAt < oldest.addedAt ? item : oldest
        );
        break;
      case 'largest-first':
        target = catItems.reduce((largest, item) =>
          item.tokens > largest.tokens ? item : largest
        );
        break;
      case 'lowest-relevance':
        // For v1, lowest-relevance falls back to oldest
        // Future: embedding-based relevance scoring
        target = catItems.reduce((oldest, item) =>
          item.addedAt < oldest.addedAt ? item : oldest
        );
        break;
      default:
        target = catItems[0]!;
    }

    const index = this.items.findIndex(i => i.id === target.id);
    if (index === -1) return false;

    this.items.splice(index, 1);
    this.prunedItems.push(target);
    this.totalPruned++;
    this.violations++;

    return true;
  }
}

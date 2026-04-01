/**
 * Context Inspector — Real-time context window analysis
 *
 * The inspector wraps a BudgetManager and provides formatted output
 * for both CLI and programmatic use. This is the primary user-facing
 * interface for understanding what's in your context window.
 */

import { BudgetManager, defaultBudgetConfig } from '../engine/budgetManager.js';
import { getAdapter } from '../providers/index.js';
import type {
  Message,
  ContextGuardConfig,
  InspectionResult,
  BudgetConfig,
  Provider,
} from '../types/index.js';

/** Format a number with commas */
function fmt(n: number): string {
  return n.toLocaleString();
}

/** Progress bar helper */
function progressBar(ratio: number, width: number = 30): string {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

  if (ratio > 0.9) return `\x1b[31m${bar}\x1b[0m`;      // Red
  if (ratio > 0.7) return `\x1b[33m${bar}\x1b[0m`;      // Yellow
  return `\x1b[32m${bar}\x1b[0m`;                         // Green
}

/** Grade color */
function gradeColor(grade: string): string {
  switch (grade) {
    case 'A': return `\x1b[32m${grade}\x1b[0m`;
    case 'B': return `\x1b[32m${grade}\x1b[0m`;
    case 'C': return `\x1b[33m${grade}\x1b[0m`;
    case 'D': return `\x1b[31m${grade}\x1b[0m`;
    case 'F': return `\x1b[31m${grade}\x1b[0m`;
    default: return grade;
  }
}

export class ContextInspector {
  private manager: BudgetManager;
  private adapter;
  private model: string;

  constructor(config?: Partial<ContextGuardConfig>) {
    const provider: Provider = config?.provider ?? 'anthropic';
    this.model = config?.model ?? 'claude-sonnet-4-6';
    this.adapter = getAdapter(provider);

    const maxTokens = this.adapter.getMaxContextTokens(this.model);
    const budgetConfig: Partial<BudgetConfig> = {
      ...defaultBudgetConfig(maxTokens),
      ...config?.budget,
    };

    this.manager = new BudgetManager(budgetConfig);
  }

  /** Load messages into the inspector for analysis */
  loadMessages(messages: Message[]): void {
    this.manager.clear();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      const category = this.adapter.categorizeMessage(msg, i, messages.length);
      const source = `${msg.role}_message_${i}`;
      this.manager.add(msg.content, category, source);
    }
  }

  /** Add a single message */
  addMessage(message: Message): void {
    const items = this.manager.getItems();
    const category = this.adapter.categorizeMessage(message, items.length, items.length + 1);
    const source = `${message.role}_message_${items.length}`;
    this.manager.add(message.content, category, source);
  }

  /** Run full inspection */
  inspect(): InspectionResult {
    const budget = this.manager.getStatus();
    const health = this.manager.getHealth();
    const items = this.manager.getItems();
    const session = this.manager.getAnalytics();

    const display = this.formatDisplay(budget, health);

    return { budget, health, items, session, display };
  }

  /** Get the budget manager for direct access */
  getBudgetManager(): BudgetManager {
    return this.manager;
  }

  /** Format display output for terminal */
  private formatDisplay(budget: ReturnType<BudgetManager['getStatus']>, health: ReturnType<BudgetManager['getHealth']>): string {
    const lines: string[] = [];

    lines.push('');
    lines.push('\x1b[1m\x1b[36m  ContextGuard \x1b[0m\x1b[90m- Context Budget Inspector\x1b[0m');
    lines.push('\x1b[90m  ' + '\u2500'.repeat(50) + '\x1b[0m');
    lines.push('');

    // Overall status
    lines.push(`  \x1b[1mModel:\x1b[0m ${this.model}`);
    lines.push(`  \x1b[1mTotal:\x1b[0m ${fmt(budget.totalTokensUsed)} / ${fmt(budget.totalTokensAvailable)} tokens (${Math.round(budget.utilization * 100)}%)`);
    lines.push(`  ${progressBar(budget.utilization)}`);
    lines.push('');

    // Health score
    lines.push(`  \x1b[1mHealth:\x1b[0m ${gradeColor(health.grade)} (${health.score}/100)`);
    for (const dim of health.dimensions) {
      const dimBar = progressBar(dim.score, 15);
      lines.push(`    ${dim.name.padEnd(16)} ${dimBar} ${Math.round(dim.score * 100)}%  \x1b[90m${dim.detail}\x1b[0m`);
    }
    lines.push('');

    // Category breakdown
    lines.push('  \x1b[1mCategory Breakdown:\x1b[0m');
    for (const cat of budget.categories) {
      if (cat.tokensUsed === 0 && cat.tokensAllocated === 0) continue;
      const pct = Math.round(cat.percentage * 100);
      const status = cat.overBudget ? ' \x1b[31mOVER\x1b[0m' : cat.warning ? ' \x1b[33mWARN\x1b[0m' : '';
      const bar = progressBar(cat.percentage, 20);
      lines.push(`    ${cat.category.padEnd(14)} ${bar} ${fmt(cat.tokensUsed).padStart(8)} / ${fmt(cat.tokensAllocated).padStart(8)} (${pct}%) [${cat.itemCount} items]${status}`);
    }
    lines.push('');

    // Recommendations
    if (health.recommendations.length > 0) {
      lines.push('  \x1b[1mRecommendations:\x1b[0m');
      for (const rec of health.recommendations) {
        lines.push(`    \x1b[33m\u25B6\x1b[0m ${rec}`);
      }
      lines.push('');
    }

    // Pruning info
    if (budget.prunedItems.length > 0) {
      lines.push(`  \x1b[1mAuto-pruned:\x1b[0m ${budget.prunedItems.length} items removed to stay within budget`);
      lines.push('');
    }

    return lines.join('\n');
  }
}

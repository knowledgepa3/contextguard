/**
 * Context Health Scorer — v1 Heuristic
 *
 * Computes a composite health score for the current context window.
 * Four dimensions: Utilization, Freshness, Diversity, Signal-to-Noise.
 *
 * "Unlimited context feels powerful, but controlled context is what
 * actually produces reliable results."
 */

import type { ContextItem, ContextHealth, HealthDimension, BudgetStatus } from '../types/index.js';

/** Score thresholds for letter grades */
function toGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Utilization health: Are we using context efficiently?
 * Best range: 40-80% utilization. Too low = wasted capacity. Too high = no room for responses.
 */
function scoreUtilization(budget: BudgetStatus): HealthDimension {
  const u = budget.utilization;
  let score: number;
  let detail: string;

  if (u < 0.1) {
    score = 0.5;
    detail = 'Context nearly empty — underutilized capacity';
  } else if (u < 0.4) {
    score = 0.7;
    detail = 'Light utilization — room for more context if needed';
  } else if (u <= 0.8) {
    score = 1.0;
    detail = 'Healthy utilization — good balance of content and headroom';
  } else if (u <= 0.9) {
    score = 0.6;
    detail = 'High utilization — limited room for model responses';
  } else {
    score = 0.2;
    detail = 'Critical — context nearly full, response quality will degrade';
  }

  return { name: 'Utilization', score, weight: 0.25, detail };
}

/**
 * Freshness: How recent is the content?
 * Stale content (old conversation turns, outdated tool results) degrades relevance.
 */
function scoreFreshness(items: ContextItem[]): HealthDimension {
  if (items.length === 0) {
    return { name: 'Freshness', score: 1.0, weight: 0.25, detail: 'No items to assess' };
  }

  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes considered "stale" for a session

  let freshCount = 0;
  for (const item of items) {
    const age = now - item.addedAt;
    if (age < maxAge) freshCount++;
  }

  const freshRatio = freshCount / items.length;
  let detail: string;

  if (freshRatio >= 0.8) {
    detail = 'Most context is recent and relevant';
  } else if (freshRatio >= 0.5) {
    detail = `${Math.round((1 - freshRatio) * 100)}% of context items are stale (>30min old)`;
  } else {
    detail = 'Majority of context is stale — consider pruning old items';
  }

  return { name: 'Freshness', score: freshRatio, weight: 0.25, detail };
}

/**
 * Diversity: Is context spread across categories or concentrated?
 * Healthy context has a mix of system, conversation, and tool results.
 * Unhealthy: 90% conversation history, 10% everything else.
 */
function scoreDiversity(budget: BudgetStatus): HealthDimension {
  const activeCategories = budget.categories.filter(c => c.tokensUsed > 0);
  const totalTokens = budget.totalTokensUsed || 1;

  if (activeCategories.length === 0) {
    return { name: 'Diversity', score: 1.0, weight: 0.2, detail: 'No items to assess' };
  }

  // Shannon entropy normalized to 0-1
  let entropy = 0;
  for (const cat of activeCategories) {
    const p = cat.tokensUsed / totalTokens;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }
  const maxEntropy = Math.log2(Math.max(activeCategories.length, 1));
  const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 1;

  // Also check for dominance: any single category > 70% is a red flag
  const dominant = activeCategories.find(c => c.tokensUsed / totalTokens > 0.7);
  let score = normalizedEntropy;
  let detail: string;

  if (dominant) {
    score = Math.min(score, 0.4);
    detail = `"${dominant.category}" dominates at ${Math.round(dominant.percentage * 100)}% — context is unbalanced`;
  } else if (normalizedEntropy >= 0.7) {
    detail = 'Good diversity across context categories';
  } else {
    detail = 'Context is concentrated in few categories — consider broadening';
  }

  return { name: 'Diversity', score, weight: 0.2, detail };
}

/**
 * Signal-to-Noise: Are we carrying dead weight?
 * Checks for common noise patterns: empty items, tiny fragments, duplicates.
 */
function scoreSignalToNoise(items: ContextItem[]): HealthDimension {
  if (items.length === 0) {
    return { name: 'Signal-to-Noise', score: 1.0, weight: 0.3, detail: 'No items to assess' };
  }

  let noiseCount = 0;
  const seenContent = new Set<string>();

  for (const item of items) {
    // Empty or near-empty items
    if (item.tokens < 5) {
      noiseCount++;
      continue;
    }

    // Duplicate detection (exact content match)
    const fingerprint = item.content.slice(0, 200);
    if (seenContent.has(fingerprint)) {
      noiseCount++;
      continue;
    }
    seenContent.add(fingerprint);
  }

  const signalRatio = 1 - (noiseCount / items.length);
  let detail: string;

  if (signalRatio >= 0.95) {
    detail = 'Very clean — minimal noise in context';
  } else if (signalRatio >= 0.8) {
    detail = `${noiseCount} low-value items detected — consider pruning`;
  } else {
    detail = `${noiseCount} noise items (${Math.round((1 - signalRatio) * 100)}%) — significant dead weight`;
  }

  return { name: 'Signal-to-Noise', score: signalRatio, weight: 0.3, detail };
}

/**
 * Compute the full context health assessment
 */
export function assessHealth(items: ContextItem[], budget: BudgetStatus): ContextHealth {
  const dimensions = [
    scoreUtilization(budget),
    scoreFreshness(items),
    scoreDiversity(budget),
    scoreSignalToNoise(items),
  ];

  // Weighted composite
  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);
  const composite = dimensions.reduce((sum, d) => sum + d.score * d.weight, 0) / totalWeight;
  const score = Math.round(composite * 100);

  // Generate recommendations
  const recommendations: string[] = [];
  for (const dim of dimensions) {
    if (dim.score < 0.6) {
      switch (dim.name) {
        case 'Utilization':
          if (dim.score < 0.4) {
            recommendations.push('Context window is nearly full. Prune old conversation turns or large tool results.');
          } else {
            recommendations.push('Context is underutilized. Consider loading relevant documents or examples.');
          }
          break;
        case 'Freshness':
          recommendations.push('Many context items are stale. Prune items older than 30 minutes or summarize them.');
          break;
        case 'Diversity':
          recommendations.push('Context is dominated by one category. Add system instructions or relevant documents for balance.');
          break;
        case 'Signal-to-Noise':
          recommendations.push('Context contains duplicate or near-empty items. Remove noise to improve focus.');
          break;
      }
    }
  }

  if (recommendations.length === 0) {
    recommendations.push('Context is healthy. No immediate action needed.');
  }

  return {
    score,
    grade: toGrade(score),
    dimensions,
    recommendations,
    assessedAt: Date.now(),
  };
}

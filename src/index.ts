/**
 * ContextGuard — Context budget management for AI applications
 *
 * "Token counters tell you how much you spent.
 *  ContextGuard tells you whether it was worth it."
 *
 * @module contextguard
 */

// Core types
export type {
  ContextCategory,
  ContextItem,
  CategoryBudget,
  BudgetConfig,
  ContextHealth,
  HealthDimension,
  BudgetStatus,
  CategoryUsage,
  SessionAnalytics,
  Message,
  Provider,
  ProviderAdapter,
  ContextGuardConfig,
  InspectionResult,
} from './types/index.js';

// Engine
export { BudgetManager, defaultBudgetConfig } from './engine/budgetManager.js';
export { countTokensApprox, countMessageTokens, countMessagesTokens } from './engine/tokenCounter.js';
export { assessHealth } from './engine/healthScorer.js';

// Inspector
export { ContextInspector } from './inspector/index.js';

// Providers
export { getAdapter, detectProvider } from './providers/index.js';
export { anthropicAdapter } from './providers/anthropic.js';
export { openaiAdapter } from './providers/openai.js';

// Middleware (Sprint 2)
export { createTrackedConversation, analyzeMessages } from './middleware/anthropicWrapper.js';
export type { WrapperConfig, TrackedConversation, ContextGuardEvents } from './middleware/anthropicWrapper.js';

// Dashboard (Sprint 2)
export { startDashboard } from './dashboard/server.js';

// Demo (Sprint 2)
export { runDemoScenario } from './demo/scenario.js';

// Analytics (Sprint 3)
export { AnalyticsStore } from './engine/analyticsStore.js';
export type { SessionSummary, SnapshotRow, AggregateStats } from './engine/analyticsStore.js';

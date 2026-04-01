/**
 * ContextGuard — Core Type Definitions
 *
 * Context is a budget, not a dump.
 * Every item in the context window is categorized, tracked, and scored.
 */

// ─── Context Categories ─────────────────────────────────────────────

/** Categories of content that occupy the context window */
export type ContextCategory =
  | 'system'        // System prompt / instructions
  | 'conversation'  // User + assistant message history
  | 'tool_results'  // Tool call outputs
  | 'documents'     // Injected documents, RAG results
  | 'memory'        // Memory packs, persistent knowledge
  | 'examples'      // Few-shot examples
  | 'other';        // Uncategorized

/** A single item tracked in the context window */
export interface ContextItem {
  id: string;
  category: ContextCategory;
  content: string;
  tokens: number;
  addedAt: number;         // Unix timestamp ms
  source: string;          // Where this came from (e.g., "system_prompt", "user_message_3", "tool:search")
  metadata?: Record<string, unknown>;
}

// ─── Budget Configuration ────────────────────────────────────────────

/** Budget allocation per category */
export interface CategoryBudget {
  category: ContextCategory;
  maxTokens: number;        // Hard ceiling
  warningThreshold: number; // Percentage (0-1) at which to warn
  priority: number;         // Lower = higher priority (won't be pruned first)
}

/** Full budget configuration */
export interface BudgetConfig {
  /** Total context window size in tokens */
  maxTotalTokens: number;

  /** Per-category budgets */
  categories: CategoryBudget[];

  /** Global warning threshold (percentage of total) */
  globalWarningThreshold: number;

  /** Auto-prune when budget exceeded */
  autoPrune: boolean;

  /** Pruning strategy */
  pruneStrategy: 'oldest' | 'lowest-relevance' | 'largest-first';
}

// ─── Health Scoring ──────────────────────────────────────────────────

/** Individual health dimension */
export interface HealthDimension {
  name: string;
  score: number;      // 0-1
  weight: number;     // Contribution to composite
  detail: string;     // Human-readable explanation
}

/** Composite context health assessment */
export interface ContextHealth {
  /** Composite score 0-100 */
  score: number;

  /** Letter grade */
  grade: 'A' | 'B' | 'C' | 'D' | 'F';

  /** Individual dimensions */
  dimensions: HealthDimension[];

  /** Actionable recommendations */
  recommendations: string[];

  /** Timestamp of assessment */
  assessedAt: number;
}

// ─── Budget State ────────────────────────────────────────────────────

/** Current usage for a category */
export interface CategoryUsage {
  category: ContextCategory;
  tokensUsed: number;
  tokensAllocated: number;
  percentage: number;       // 0-1
  itemCount: number;
  overBudget: boolean;
  warning: boolean;
}

/** Full budget status snapshot */
export interface BudgetStatus {
  /** Total tokens currently in context */
  totalTokensUsed: number;

  /** Total tokens available */
  totalTokensAvailable: number;

  /** Overall utilization percentage */
  utilization: number;

  /** Per-category breakdown */
  categories: CategoryUsage[];

  /** Items that were auto-pruned (if any) */
  prunedItems: ContextItem[];

  /** Whether any category is over budget */
  hasOverage: boolean;

  /** Whether any category hit warning threshold */
  hasWarnings: boolean;
}

// ─── Provider Abstraction ────────────────────────────────────────────

/** Supported LLM providers */
export type Provider = 'anthropic' | 'openai' | 'generic';

/** Message format (provider-agnostic) */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;            // Tool name for tool messages
  toolCallId?: string;      // Tool call ID for tool results
  tokens?: number;          // Pre-counted tokens (if known)
}

/** Provider adapter interface */
export interface ProviderAdapter {
  name: Provider;
  countTokens(text: string): number;
  categorizeMessage(message: Message, index: number, total: number): ContextCategory;
  getMaxContextTokens(model: string): number;
}

// ─── Session Analytics ───────────────────────────────────────────────

/** Analytics for a single context guard session */
export interface SessionAnalytics {
  sessionId: string;
  startedAt: number;
  endedAt?: number;

  /** Peak token usage */
  peakTokens: number;

  /** Number of items added */
  itemsAdded: number;

  /** Number of items pruned */
  itemsPruned: number;

  /** Budget violations */
  violations: number;

  /** Average health score */
  avgHealthScore: number;

  /** Token usage over time (sampled) */
  timeline: Array<{
    timestamp: number;
    totalTokens: number;
    healthScore: number;
  }>;
}

// ─── Inspector Output ────────────────────────────────────────────────

/** Output format for the context inspector */
export interface InspectionResult {
  /** Current budget status */
  budget: BudgetStatus;

  /** Current health assessment */
  health: ContextHealth;

  /** All tracked context items */
  items: ContextItem[];

  /** Session analytics (if tracking) */
  session?: SessionAnalytics;

  /** Formatted display string */
  display: string;
}

// ─── Configuration ───────────────────────────────────────────────────

/** Top-level ContextGuard configuration */
export interface ContextGuardConfig {
  /** LLM provider */
  provider: Provider;

  /** Model name (for determining context window size) */
  model: string;

  /** Budget configuration */
  budget: BudgetConfig;

  /** Enable auto-pruning */
  autoPrune: boolean;

  /** Enable health scoring */
  healthScoring: boolean;

  /** Enable session analytics */
  analytics: boolean;

  /** Verbose logging */
  verbose: boolean;
}

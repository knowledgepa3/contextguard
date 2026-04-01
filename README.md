# ContextGuard

> Token counters tell you how much you spent. ContextGuard tells you whether it was worth it.

Context budget management for AI applications. Visibility, governance, and health scoring for LLM context windows.

## The Problem

AI teams dump everything into context windows — massive system prompts, full conversation histories, raw tool outputs. Performance degrades, costs scale linearly, but nobody knows *why* or *what to cut*.

**ContextGuard proved it**: In a realistic security review agent workflow, unmanaged context overflows the window (111%), scores a C health grade, and buries final synthesis under stale search results. With ContextGuard: 52% utilization, A grade, 53% token reduction, zero violations.

## The Solution

Treat context as a **budget**, not a dump. Three capabilities:

- **Inspect** — Real-time breakdown of what's in your context window by category
- **Govern** — Set budgets per category, auto-prune when exceeded, enforce caps
- **Score** — Composite health across 4 dimensions (Utilization, Freshness, Diversity, Signal-to-Noise)

## Quick Start

```bash
# See the budget enforcement demo (before/after proof)
npx contextguard scenario

# Inspect with sample data
npx contextguard demo

# Analyze your own messages file
npx contextguard inspect conversation.json

# Quick health check
npx contextguard health messages.json

# Different model (auto-detects provider)
npx contextguard demo --model gpt-4o

# JSON output for piping
npx contextguard inspect messages.json --json

# Web dashboard
npx contextguard dashboard

# Session analytics
npx contextguard stats
```

## Programmatic Usage

### One-Shot Analysis

```typescript
import { analyzeMessages } from 'contextguard';

const result = analyzeMessages([
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Help me with...' },
  { role: 'assistant', content: 'Sure, here is...' },
]);

console.log(result.health.grade);        // "A"
console.log(result.health.score);        // 92
console.log(result.budget.utilization);  // 0.001
```

### Tracked Conversation (Middleware)

```typescript
import { createTrackedConversation } from 'contextguard';

// Create a tracked conversation
const conv = createTrackedConversation({
  model: 'claude-sonnet-4-6',
  printWarnings: true,  // Warns on stderr when budgets exceeded
});

// Track your system prompt
conv.trackSystem('You are a security analyst...');

// Track each message exchange
conv.trackUser('Review this code for vulnerabilities');
// ... call your LLM API ...
conv.trackAssistant('I found 3 issues: ...');

// Track tool results
conv.trackTool('code_search', 'Results from searching auth module...');

// Track injected documents
conv.trackDocument('architecture.md', 'Service mesh auth flow...');

// Track memory/knowledge packs
conv.trackMemory('security-patterns-v1', 'OWASP patterns...');

// Check health anytime
console.log(conv.grade());              // "B"
console.log(conv.inspect().display);    // Formatted output

// Reset for new conversation
conv.reset();
```

### Budget Manager (Low-Level)

```typescript
import { BudgetManager } from 'contextguard';

const manager = new BudgetManager({
  maxTotalTokens: 200000,
  autoPrune: true,
  pruneStrategy: 'oldest',    // 'oldest' | 'lowest-relevance' | 'largest-first'
});

// Add context items
manager.add('You are a helpful assistant.', 'system', 'system_prompt');
manager.add('Help me with my code', 'conversation', 'user_msg_1');
manager.add('Search results: ...', 'tool_results', 'tool:search');

// Budget automatically enforced — stale items pruned when over limit

const status = manager.getStatus();
console.log(status.utilization);      // 0.003
console.log(status.hasOverage);       // false
console.log(status.categories);       // Per-category breakdown

const health = manager.getHealth();
console.log(health.grade);            // "A"
console.log(health.recommendations);  // Actionable suggestions
```

### Web Dashboard

```typescript
import { startDashboard } from 'contextguard';

// Start the dashboard server
startDashboard(4200);

// Send inspection data from your app
await fetch('http://localhost:4200/update', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    budget: result.budget,
    health: result.health,
    itemCount: result.items.length,
  }),
});
```

### Session Analytics (SQLite)

```typescript
import { AnalyticsStore } from 'contextguard';

const store = new AnalyticsStore();  // ~/.contextguard/analytics.db

// Track sessions
store.startSession('session-1', 'claude-sonnet-4-6');
store.recordSnapshot('session-1', budget, health);
store.endSession('session-1', analytics, 'A');

// Query history
const recent = store.getRecentSessions(10);
const stats = store.getStats();  // { avgHealth, totalPruned, ... }

store.close();
```

## Context Categories

ContextGuard tracks 7 categories of context content:

| Category | What It Tracks | Default Budget |
|----------|---------------|---------------|
| `system` | System prompts, instructions | 15% |
| `conversation` | User + assistant message history | 40% |
| `tool_results` | Tool call outputs, search results | 20% |
| `documents` | Injected docs, RAG results | 15% |
| `memory` | Memory packs, persistent knowledge | 5% |
| `examples` | Few-shot examples | 5% |
| `other` | Uncategorized content | 5% |

## Health Dimensions

| Dimension | Weight | What It Measures |
|-----------|--------|-----------------|
| **Utilization** | 25% | Sweet spot: 40-80%. Too low = wasted. Too high = no room for responses. |
| **Freshness** | 25% | How recent is the content? Items >30min flagged as stale. |
| **Diversity** | 20% | Is context balanced? Any category >70% = red flag. |
| **Signal-to-Noise** | 30% | Duplicates, near-empty items, dead weight. |

## Supported Providers

| Provider | Models | Context Window |
|----------|--------|---------------|
| **Anthropic** | Claude Opus 4.6 (1M), Sonnet 4.6 (200K), Haiku 4.5 (200K) | Auto-detected |
| **OpenAI** | GPT-4o (128K), GPT-4 Turbo (128K), o1/o3 (128-200K) | Auto-detected |
| **Generic** | Any messages-based API | Defaults to 128K |

Provider is auto-detected from model name. Override with `--provider` flag or `provider` config option.

## CLI Reference

```
contextguard demo                  Sample data inspection
contextguard scenario              Budget enforcement before/after proof
contextguard inspect <file>        Analyze a messages JSON file
contextguard health <file>         Quick health grade
contextguard dashboard [--port N]  Web dashboard (default: 4200)
contextguard stats                 Session analytics summary
contextguard --help                Help

Options:
  --model <name>      Model name (default: claude-sonnet-4-6)
  --provider <name>   anthropic | openai | generic
  --json              JSON output instead of formatted text
  --port <number>     Dashboard port (default: 4200)
```

## Messages Format

Standard OpenAI/Anthropic messages array:

```json
[
  { "role": "system", "content": "You are a helpful assistant." },
  { "role": "user", "content": "Hello" },
  { "role": "assistant", "content": "Hi! How can I help?" },
  { "role": "tool", "content": "Search results: ..." }
]
```

## License

MIT

---

Built by [ACE](https://advancedconsultingexperts.com) — Advanced Consulting Experts

*Unlimited context feels powerful, but controlled context is what actually produces reliable results.*

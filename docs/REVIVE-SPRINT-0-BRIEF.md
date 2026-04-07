# ContextGuard 0.2 — Revive
## Sprint 0 Brief

**Author:** Claude Code (Forge Lead)
**Architect:** William J. Storey III
**Date:** 2026-04-07
**Status:** DRAFT — pending Architect approval to enter Sprint 1
**Parent:** Venture Forge Prototype #001 (ContextGuard) — extension, not new prototype
**Target release:** `contextguard-ai@0.2.0` (same npm package, semver minor)

---

## 1. One-line pitch

> **ContextGuard measures the thirst. Revive is the drink.**
> Lossless context compaction that gives a tired AI session its sharpness back, in one command.

## 2. The problem

ContextGuard 0.1.x answers *"how full is my context window?"* It does not answer *"and what do I do about it?"* Today, when a session hits Grade C → D → F, the only options are:

1. Start a new session and lose state
2. Manually copy/paste a summary into a fresh window
3. Live with a degraded, hedging, repetitive agent

All three are bad. (1) loses work. (2) is what users do, and they do it badly — they paraphrase code, drop file paths, forget decisions, then blame the model when continuity breaks. (3) is the silent killer: late-session agents go subtly dumber and most users don't notice until they've wasted an hour.

The pain is **felt, not measured**. Users describe it as "Claude got tired" or "it forgot what we just decided." That's the language we're going to meet them in.

## 3. The solution

A new ContextGuard subsystem — **Revive** — that performs *semantically lossless compaction* of a working context (conversation JSONL or markdown file), emits a signed manifest of what was preserved vs dropped, and lets the user (or an agent) re-expand any dropped span on demand.

Three tiers, marketed as drinks:

| Tier | CLI flag | Reduction target | What it does | What it preserves |
|---|---|---|---|---|
| **Sparkling** | `--sparkling` | 20–30% | Strip tool-call scaffolding, dedupe repeated reads, collapse preambles | 100% of facts, code, decisions, narrative |
| **Electrolyte** | `--electrolyte` | 40–55% | Convert long prose to bullet skeletons, replace full file reads with `path:lines + sha + 1-line summary`, fold completed todos | All decisions + current state, drops *narrative tone* |
| **IV** | `--iv` | 60–75% | Rewrites the working set as a structured state object: `{facts, decisions, open_questions, files_touched, next_steps}` | Only what is load-bearing for continuing the work |

Default tier: **Electrolyte**. It's the "real recovery, keeps you going" middle that maps to most user pain.

## 4. Non-negotiable design constraints

These are the things that, if violated, kill the product. They drive every implementation choice.

### 4.1 Span-level provenance ("lossless for things that matter")
**Anchors are never paraphrased.** An anchor is any of:
- Code block (any language, any length)
- File path or `path:line` reference
- Hash, commit SHA, ID, UUID, or numeric identifier
- Quoted decision ("we decided to…", "approved", "rejected", "blocked on…")
- Tool call name + arguments
- Error messages, stack traces

Revive may compress *prose around* anchors. It must never edit, paraphrase, or drop an anchor. This is what lets us claim "lossless." The anchor extractor is the most important piece of code in the build.

### 4.2 Manifest-backed reversibility
Every Revive run emits a **manifest** at `.contextguard/revive-{timestamp}.json` containing:
- SHA-256 of the original input
- SHA-256 of the compacted output
- For every dropped span: `{originalOffset, originalLength, originalHash, droppedReason, recoveryHint}`
- Tier used, version of Revive, timestamp, anchor count

`contextguard revive --verify {manifest}` re-reads the original (if available) and proves the compacted version preserved every anchor.

`contextguard revive --expand {spanId} {manifest}` returns the original prose for any dropped span. This is how an agent that hits a dropped span at runtime recovers — it asks Revive to rehydrate just that one span, not the whole session.

### 4.3 Round-trip eval scoring
Every released tier ships with a measured recall score. Methodology:
1. Take 50 representative session JSONLs (mix of coding, debugging, planning)
2. Generate 20 factual recall questions per session from the original
3. Run each tier's compacted output through a fresh model with the questions
4. Score: % of facts correctly recalled
5. Publish the score in the README and the CLI help text

If Sparkling doesn't hit ≥99%, Electrolyte ≥95%, IV ≥85% — we don't ship that tier. These numbers are the marketing claim; they need teeth.

### 4.4 Felt difference, not just a number
The post-Revive output must show **before/after grade** prominently. The user should *see* their session jump from D to A. The "felt difference" line in the CLI is not a joke, it's the product:

```
Before: Grade D  (847,231 / 1,000,000 tokens, 84%)
After:  Grade A  (312,118 / 1,000,000 tokens, 31%)
Reduction: 535,113 tokens (63%)
Preserved: 47 decisions · 23 file refs · 12 code blocks · 8 open todos
Dropped:   312 narrative spans → manifest .contextguard/revive-2026-04-07T19-44.json
Felt difference: ☕ → 🥤  Your AI just got a drink.
```

## 5. Surfaces

### 5.1 CLI (primary)
```
contextguard revive --sparkling   --in session.jsonl    --out session.compact.jsonl
contextguard revive --electrolyte --in current-work.md  --out current-work.compact.md
contextguard revive --iv          --in MEMORY.md
contextguard revive --verify   .contextguard/revive-2026-04-07T19-44.json
contextguard revive --expand 47 .contextguard/revive-2026-04-07T19-44.json
contextguard revive --dry-run --electrolyte --in session.jsonl   # show what would happen, no writes
```

`--in` accepts `.jsonl` (Claude/OpenAI session format) or `.md` (markdown files). Format detection is by extension + sniff.

### 5.2 Programmatic API
```typescript
import { revive, verify, expand, ReviveTier } from 'contextguard-ai';

const result = await revive({
  input: messagesArray,        // or string for markdown
  tier: 'electrolyte',
  preserveAnchors: ['code', 'file_refs', 'decisions', 'tool_calls'], // defaults to all
});

// result: { compacted, manifest, beforeGrade, afterGrade, reductionPct }

const ok = await verify(result.manifest);
const original = await expand(result.manifest, spanId);
```

### 5.3 MCP tool
Expose Revive as an MCP server (`contextguard-revive-mcp`) so agents can call it mid-session:

| Tool | Purpose |
|---|---|
| `cg_revive_session` | Compact the current session, return new context |
| `cg_revive_file` | Compact a markdown file in place (with manifest) |
| `cg_revive_verify` | Prove a manifest is intact |
| `cg_revive_expand` | Rehydrate a dropped span by ID |

This is what enables `/revive` style mid-conversation use inside Claude Code or any MCP-aware client.

### 5.4 Auto-trigger hook (opt-in)
ContextGuard already grades sessions. Add a `--auto-revive` mode:
- Grade B → no action
- Grade C → log a suggestion ("consider `contextguard revive --sparkling`")
- Grade D → auto-run Sparkling, write manifest, notify
- Grade F → auto-run Electrolyte, write manifest, notify

Off by default. Configurable via `.contextguard/config.json`.

## 6. Architecture (fits existing 0.1.x layout)

New files under `venture-forge/contextguard/src/`:

```
src/
  revive/
    index.ts                  # public API: revive(), verify(), expand()
    anchorExtractor.ts        # finds code/refs/hashes/decisions/tool calls
    tiers/
      sparkling.ts            # tier 1 compactor
      electrolyte.ts          # tier 2 compactor
      iv.ts                   # tier 3 compactor (state-object rewrite)
    manifest.ts               # manifest schema, sign, verify
    formats/
      jsonl.ts                # Claude/OpenAI session JSONL parser + writer
      markdown.ts             # markdown parser + writer (anchor-aware)
    eval/
      recallSuite.ts          # 50-session × 20-question recall harness
      fixtures/               # test sessions and expected anchors
  mcp/
    server.ts                 # contextguard-revive-mcp entrypoint
    tools.ts                  # cg_revive_* MCP tool definitions
  cli.ts                      # add `revive` subcommand to existing CLI
```

Reuses existing 0.1.x infrastructure:
- `engine/tokenCounter.ts` — for before/after token counts
- `engine/healthScorer.ts` — for before/after grade
- `engine/analyticsStore.ts` — log every Revive run for the dashboard
- `dashboard/` — add a Revive panel showing recent runs, recall scores, time saved

## 7. Free vs paid (matches 0.1.x model)

**Free tier (open source, MIT):**
- Sparkling and Electrolyte
- CLI + programmatic API
- Manifest + verify + expand
- Local SQLite analytics
- Self-hosted MCP server
- Round-trip recall scores published

**Paid tier (ContextGuard Pro — same as 0.1.x Pro license):**
- IV tier (the aggressive one — most R&D, most risk, most value)
- Hosted MCP server (no local install)
- Auto-revive hook with configurable thresholds
- Dashboard recall analytics + cost-saved tracking
- Team/org manifests with shared rehydration store
- Priority support + custom anchor rules

This mirrors the existing CG Pro split. Free gets the meter + the basic drink. Paid gets the IV drip + the operations layer.

## 8. Sprint plan

### Sprint 0 — this brief
**Token budget:** ~10K
**Deliverable:** This document, Architect review, ARB adversarial deliberation, ship/kill decision on entering Sprint 1.

### Sprint 1 — anchor extractor + Sparkling tier
**Token budget:** ~150K
**Deliverable:**
- `anchorExtractor.ts` with passing tests on 10 fixture sessions
- `tiers/sparkling.ts` hitting 20–30% reduction on fixtures
- `manifest.ts` with sign + verify
- `formats/jsonl.ts` for Claude session format
- CLI: `contextguard revive --sparkling --in <jsonl>`
- Recall eval harness skeleton (no scores yet)
**Stop condition:** Sparkling cannot achieve ≥99% recall on fixtures. Kill or pivot.

### Sprint 2 — Electrolyte + markdown + MCP
**Token budget:** ~250K
**Deliverable:**
- `tiers/electrolyte.ts` hitting 40–55% reduction
- `formats/markdown.ts` (anchor-aware md parser)
- `mcp/server.ts` with all four MCP tools
- `expand` command working end-to-end
- First real recall scores published
- **DEMO GATE (MANDATORY):** William sees a real session go from D to A and feels the difference
**Stop condition:** No buyer signal from demo + no felt difference = kill.

### Sprint 3 — IV tier + dashboard + ship
**Token budget:** ~400K
**Deliverable:**
- `tiers/iv.ts` (state-object rewrite — the hard one)
- Dashboard Revive panel
- Auto-revive hook
- Pro tier feature gating
- README + recall scores + tagline
- **SHIP GATE (MANDATORY):** Architect approval for `npm publish contextguard-ai@0.2.0`
**Stop condition:** IV recall <85% = ship 0.2.0 with Sparkling+Electrolyte only, defer IV to 0.2.1.

**Total token budget:** ~810K of the 1.35M Forge cap. ~40% headroom for the unexpected.

## 9. Kill conditions (hard)

- **No demo wow:** if Sprint 2 demo doesn't produce a visible grade jump *and* a felt sharpness difference, the metaphor is dead and so is the product.
- **Recall floor breach:** Sparkling <99% or Electrolyte <95% on fixtures = ship blocked.
- **Anchor extractor false negatives:** if the extractor drops a single code block or file ref in fixture testing, sprint stops until it's fixed. This is the "lossless" claim. It cannot regress.
- **Token burn >1.0M with no shippable Sparkling:** kill.

## 10. Open questions for Architect

1. **Brand on the box:** Do we put "Revive" on the npm package name (`contextguard-ai` stays, but README headline becomes "ContextGuard + Revive"), or keep Revive as a feature inside the existing brand? *My rec: feature inside the brand. One product, two halves.*
2. **Auto-revive default:** Off (user opts in) or on at Grade F only (safety net by default)? *My rec: off. Surprise compaction is scary; let users earn trust first.*
3. **MCP server distribution:** Bundled in `contextguard-ai` npm, or separate `contextguard-revive-mcp` package? *My rec: bundled. One install, one version, one mental model.*
4. **Hydration emoji in CLI:** keep the ☕ → 🥤 line, or treat it as cute-but-cuttable? *My rec: keep. It's the felt-difference signal in text form and people will screenshot it.*

## 11. What success looks like

- 0.2.0 ships within the Forge budget
- Published recall scores: Sparkling ≥99%, Electrolyte ≥95%, IV ≥85%
- A William demo where he runs `contextguard revive --electrolyte` on a real D-grade session and says "yeah, it's snappier" without prompting
- A Product Hunt / HN post titled something like *"ContextGuard — your AI is dehydrated. Give it a drink."* gets ≥100 upvotes
- ≥3 inbound "how do I get this in my IDE" requests within 14 days of launch
- Pro tier converts at the same or better rate than 0.1.x Pro

## 12. Architect decision

- [x] **APPROVED — enter Sprint 1** (William, 2026-04-07)
- [ ] APPROVED WITH CHANGES — see notes
- [ ] HOLD — see notes
- [ ] KILL — see notes

**Notes:** Architect granted Forge Lead full build judgment. Open questions in §10 resolved per Forge Lead recommendations:

1. **Brand on the box:** Feature inside the existing brand. `contextguard-ai` stays. README headline becomes "ContextGuard + Revive — measure the thirst, drink the drink." One product, two halves.
2. **Auto-revive default:** OFF. User opts in via `.contextguard/config.json`. Surprise compaction kills trust; trust comes first.
3. **MCP server distribution:** Bundled in `contextguard-ai`. One install, one version, one mental model. No second package to keep in lockstep.
4. **Hydration emoji in CLI:** KEEP. The ☕ → 🥤 line is the felt-difference signal in text form. People will screenshot it. That is marketing.

---

*Next action: ARB adversarial session on this brief, then Sprint 1 anchor extractor build.*

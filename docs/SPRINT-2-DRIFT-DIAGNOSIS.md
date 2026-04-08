# Sprint 2 Drift Diagnosis — Ghost Anchors in Real Sessions

**Status:** ROOT CAUSE IDENTIFIED
**Diagnosed:** 2026-04-07
**Owner:** William J. Storey III (Architect) / Claude Code (Lead Dev)
**Repro artifacts:**
- Session: `C:/Users/knowl/.claude/debug/revive-smoke-2026-04-07/session.jsonl` (17 MB, 3544 messages)
- Manifest: `venture-forge/contextguard/.contextguard/revive-2026-04-08T02-05-58-120Z.json`
- Diagnostic script: `venture-forge/contextguard/internal/diagnose-drift.mjs` (gitignored via `internal/`)

---

## TL;DR

The "10 lost high-weight anchors" the ECV chain validator reports on real Claude sessions are not drift. They are **ghost anchors** the chain validator's re-extraction pass fabricates from fence-like structures that never existed as real code blocks in any single message. The Sparkling compactor's per-message extraction correctly ignores them. The validator's flat-text re-extraction is where they come from.

**It is NOT a regression in the recall suite.** Recall stays 100% on fixtures because fixtures are well-formed, small, and have no unclosed code fences. Real sessions have all three failure modes.

## The evidence

Ran `diagnose-drift.mjs` against the 17 MB smoke-test manifest. Of the 10 lost HIGH-weight anchors:

| # | Kind     | Position              | Length    | Reality |
|---|----------|-----------------------|-----------|---------|
| 1 | code_block | `3581`→`609694`     | **606,113 chars** | Ghost — spans ~1500 messages |
| 2 | decision   | `609776`→`609790`   | 14 chars | Real, trapped between ghosts |
| 3 | code_block | `609884`→`679547`   | **69,663 chars** | Ghost |
| 4 | code_block | `679690`→`895999`   | **216,309 chars** | Ghost |
| 5 | code_block | `896116`→`1002111`  | **105,995 chars** | Ghost |
| 6 | code_block | `1003191`→`1003240` | 49 chars | Not a code block — fence-framing artifact |
| 7 | code_block | `1003544`→`1003834` | 290 chars | Not a code block — fence-framing artifact |
| 8 | code_block | `1005543`→`1005606` | 63 chars | Not a code block — fence-framing artifact |
| 9 | code_block | `1006181`→`1346245` | **340,064 chars** | Ghost — 25% of the flat file as one "block" |
| 10 | code_block | `1346563`→`1347535` | 972 chars | Possibly real, boundary-crossing |

Half of the "code blocks" are 60 KB–340 KB in length. Real code blocks in a Claude session are typically 50–2000 characters. The largest ghost (#9) spans 340,064 chars — roughly 25% of the flat-text view, containing dozens of messages, multiple assistant turns, and several *actual* code blocks inside it.

Critically, **none of the 10 lost anchors are inside any dropped span**. The Sparkling compactor never touched them. They are purely a validator-side re-extraction artifact.

## Root cause

**Extraction strategy asymmetry between Sparkling and chainValidator, compounded by a brittle code-block regex.**

### Layer 1 — Sparkling runs per-message, validator runs on flat text

From `src/revive/tiers/sparkling.ts` (per Session 34 notes): Sparkling iterates messages, extracts anchors from each message's text in isolation, then compacts prose between anchors within that message. The anchor extractor only sees one message at a time.

From `src/revive/chainValidator.ts:444`:

```ts
const originalExtraction = extractAnchors(originalSource);
```

`originalSource` here is `flatText` — all messages concatenated with `[role#N]` headers between them. The validator's anchor extractor sees ONE big blob of text spanning the entire session. Whatever ghosts emerge from the global view never existed in any per-message view, so they cannot possibly be in `manifest.preserved`. They always get reported as "lost."

This is the primary cause. It is a validator design mistake, not an extractor bug.

### Layer 2 — The code-block regex is greedy across unclosed fences

`src/revive/anchorExtractor.ts:66`:

```ts
const RE_CODE_BLOCK = /```[a-zA-Z0-9_+\-.]*\n[\s\S]*?\n```/g;
```

The lazy quantifier (`*?`) makes this safe **within well-formed text**. But real Claude sessions contain:

1. **Unclosed fences** — an assistant message that opened a code block but was truncated, or used triple-backticks inside a markdown quote (```` ``` ```` framing a code example without actually fencing code).
2. **Fence-framing of non-code** — patterns like `` ```\n\n**Usage Event Logging (lines 351-353):**\n``` `` where two triple-backticks on separate lines frame a bold label. The regex matches the whole thing as one "code_block" even though it's prose.
3. **Consecutive messages with only-half fences** — message A ends with an opening ` ``` `; the next message starts with some content; eventually some later message has another ` ``` `. The lazy regex matches from A's opener to whichever closer comes first in the flat text, swallowing everything between.

When the flat text is the concatenation of 3,544 messages, any unclosed fence anywhere becomes a ghost anchor reaching to the next ` ``` ` no matter how far away.

Sparkling's per-message extraction never sees this because each regex pass only gets one message. An unclosed fence in a single message produces zero anchors from that message.

### Why the fixtures don't catch this

The 6 fixture sessions total ~2000 tokens. They are well-formed: every fence is opened and closed within the same message, no fence-framing-of-prose, no consecutive half-fences. Fixture 005 (narrative-heavy) has only prose and zero code blocks. The fixture suite simply doesn't contain the failure modes real sessions produce.

## Fix

### Primary fix — symmetric extraction (Sprint 2, high priority)

Change `chainValidator.ts` Level 2 and Level 3 to extract anchors **per message**, the same way Sparkling does. Use `parseSessionJsonl(originalSource)` first, iterate messages, run `extractAnchors` on each message's content in isolation, and union the results.

One-file change, no new tests blocked on it, no changes to extractor or manifest schema. Expected effect on the 17 MB smoke test: 10 → 0 lost high-weight anchors, Chain Grade F → A, APPROVED.

This fix also kills 3 of the 4 "small" lost anchors (#6, #7, #8) because they're fence-framing artifacts that only appear in the flat-text view.

### Secondary fix — bound the code-block regex (Sprint 2, lower priority)

The extractor is still brittle for non-JSONL inputs (markdown files the future markdown format adapter will feed in). Two options:

1. **Hard cap on body length** — add a `{0,8000}` upper bound to the body match. Any real code block over 8 KB is an outlier and probably worth treating specially anyway. Pragmatic, simple.
2. **Require balanced fence languages** — only match `` ```<lang>...```<lang> `` where the opening and closing are both plain ` ``` ` (no language) OR match the same language. More complex, more accurate.

Recommendation: hard cap at 8 KB for Sparkling tier. Electrolyte tier (Sprint 2) can revisit.

### Test hardening (Sprint 2, required before shipping either tier)

Add these fixtures to the recall suite:

- **fixture-007-unclosed-fences.jsonl** — real-feeling session with multiple messages, one or two unclosed code fences, natural prose around them. Should produce `0` ghost anchors from per-message extraction and prove that Level 2/3 in the chainValidator passes after the fix.
- **fixture-008-fence-framing.jsonl** — messages that use triple-backticks to frame bold labels, blockquotes, and section dividers (exactly the `` ```\n\n**Label:**\n``` `` pattern seen in the smoke test). Proves the fence-framing edge case is covered.
- **fixture-009-realistic-50k.jsonl** — a 50K-token session scraped from a real project directory (sanitized). Proves the "reduction target 20–30%" holds on realistic input. Session 34's handoff already called this out as needed before declaring Sprint 1 complete.

The 17 MB smoke-test session should NOT be committed as a fixture — it's too big and may contain sensitive content. Use it only as the local repro artifact for this diagnosis.

## Sprint 2 work order (suggested)

1. Write the 3 new fixtures. Verify recall suite still passes on all 9 (old 6 + new 3) fixtures.
2. Fix `chainValidator.ts` to extract per-message. Expect the new fixtures to show Grade A.
3. Re-run the 17 MB smoke test. Expect Grade F → Grade A (or a clear answer about the residual 1 small anchor at position 1346563).
4. Hard-cap the code-block regex body at 8 KB. Re-run recall suite and smoke test. Confirm no regressions.
5. Separately: write the Revive CLI `--out` parser fix (one line, `venture-forge/contextguard/src/cli.ts:239`). Small PR. Unblocks operators writing compacted output to explicit paths.

## What this diagnosis does NOT cover

- The `src/cli.ts` `--out` flag parser bug (Bug 1 from the smoke test). Separately queued. One-line fix.
- ContextGuard `package.json` version bump 0.1.0 → 0.1.2 decision. CEO call.
- Electrolyte (40–55% reduction tier). Not yet built.
- Markdown format adapter. Not yet built.
- MCP server for the four `cg_revive_*` tools. Not yet built.

## Verification

Before marking Sprint 2 complete, the 17 MB smoke test must re-run with these results:

- [ ] Chain Grade: A
- [ ] lost high-weight anchors: 0
- [ ] lost moderate anchors: 0
- [ ] All 1172 dropped spans still re-hash clean (Level 1)
- [ ] revive-verify still returns `Original intact: true`
- [ ] revive-expand still rehydrates any span byte-for-byte
- [ ] Recall suite: 100% on old 6 + new 3 fixtures
- [ ] Reduction on the 17 MB smoke test: report actual number, set Sprint 3 target based on it

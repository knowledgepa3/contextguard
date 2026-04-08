# Changelog

All notable changes to `contextguard-ai` are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-release identifiers (`-sprintN`) mark sprint milestones inside a minor line;
the final `0.2.0` tag will ship once all Sprint 2 work lands.

## [0.2.0-sprint1] — 2026-04-07

First release that actually ships **Revive** — ContextGuard's lossless
context compaction engine. "ContextGuard measures the thirst. Revive is
the drink."

### Added

- **Revive — Sparkling tier, JSONL format.** Lossless compaction of
  Claude / OpenAI session JSONL files with a 20–30% reduction target on
  narrative-heavy content and a 99% anchor-recall floor on fixtures.
  Drops preambles (`"Let me…"`-style announcements), trailing whitespace,
  and consecutive blank lines. Never touches code blocks, file paths,
  hashes, UUIDs, tool calls, decisions, errors, identifiers, or URLs.
- **Anchor extractor** — integrity-critical foundation that identifies
  code blocks, inline code, file references, file paths, SHA hashes,
  UUIDs, tool calls, decision markers, error lines, ticket identifiers,
  and URLs. Classifies each anchor by probative weight (high / moderate
  / low) so the proof layer can enforce evidence preservation.
- **Manifest** — hash-chained provenance record for every revive run.
  Captures original hash, compacted hash, preserved spans, dropped
  spans with recovery hints, token counts, and reduction percentage.
  Schema v1.
- **ECV proof layer (`chainValidator`)** — four-level Evidence Chain
  Validation adapted from the GIA forensic audit framework:
  - Level 1: Structural integrity (schema, hash-chain, span re-hash)
  - Level 2: Evidence preservation (HIGH anchors must survive)
  - Level 3: Drift / addition check (no ungrounded new anchors)
  - Level 4: Recovery sufficiency (every dropped span rehydrates)
  Produces a Chain Grade (A–F) with an explicit `approved` decision.
- **Ledger envelope (`buildLedgerEntry` / `sealLedgerEntry`)** —
  GIA-compatible self-sealed run record suitable for ingestion into
  any hash-chained forensic ledger.
- **CLI subcommands** — `contextguard revive <file>`,
  `contextguard revive-verify <manifest> <original>`,
  `contextguard revive-expand <manifest> <spanId> <original>`. Supports
  `--sparkling` tier flag, `--out <path>` for explicit output location,
  and `--json` for structured machine-readable output.
- **Recall regression suite** — `dist/revive/eval/recallSuite.js`
  runs anchor-preservation checks against six fixture sessions
  (debugging, planning, error trace, adversarial, narrative-heavy,
  pure filler). Exits non-zero on any recall miss.

### Fixed

- **Ghost anchors on real sessions** (chainValidator per-message
  extraction). The validator was extracting anchors from the
  concatenated flat-text view while Sparkling extracted per message.
  On real Claude sessions (thousands of messages, megabytes of flat
  text), the lazy code-block regex greedily spanned hundreds of
  kilobytes between any unclosed opening fence and the next ```` ``` ````
  anywhere in the file, producing ghost code_block anchors up to
  340,064 chars long (25% of a 17 MB smoke-test session as one
  "block"). Those ghosts never existed in any per-message view so
  they always failed the preserved-hash lookup, and every real
  session was reported as Chain Grade F with phantom "lost high
  anchors" even when the compaction was actually lossless.

  Fix: `validateChain` now accepts optional `parsedOriginal` /
  `parsedCompacted` parameters. When provided (the `revive()` happy
  path), Level 2 and Level 3 extract anchors per-message via a new
  `extractAnchorsPerMessage` helper, matching Sparkling's extraction
  strategy exactly. When omitted (future markdown format adapter,
  direct library callers), falls back to the legacy flat-text
  behavior with synthetic-header stripping.

  Smoke test on a real 17 MB / 3,544-message / 355K-token session:
  Grade F → Grade A; lost HIGH anchors 10 → 0; preserved total
  62 → **6,965** (the old extraction was hiding ~99% of the real
  anchor set inside ghost regions).

  Recall suite still passes 100% on all 6 fixtures with zero regression.
  Full analysis in `docs/SPRINT-2-DRIFT-DIAGNOSIS.md`.

- **CLI `--out` flag parser ate its own value.** `parseArgs` handled
  `--model` / `--provider` / `--json` explicitly but not `--out`, so
  the path that followed `--out` was picked up as the positional
  `file` argument, ENOENT-ing on the nonexistent "input". Added an
  explicit `--out` case plus catches for tier flags (`--sparkling`,
  `--electrolyte`, `--iv`, `--tier <value>`) so they route cleanly.

### Known

- **Electrolyte tier** (40–55% reduction, 95% recall floor) ships in
  Sprint 2. Passing `--electrolyte` today throws a clear "not yet
  shipped" error.
- **IV tier** (60–75% reduction, paid-only) ships in Sprint 3.
- **Markdown format adapter** ships in Sprint 2. Passing a `.md` file
  today throws a clear "not yet shipped" error.
- **Fixture suite is intentionally small** (~2,000 tokens total across
  6 fixtures) and will expand in Sprint 2 to include a 50 KB realistic
  session, an unclosed-fences fixture, and a fence-framing fixture.
  These will exercise failure modes that the current fixtures do not.
- **Secondary extractor hardening** (hard-cap code-block regex body at
  8 KB to protect the future markdown adapter) is a Sprint 2 residual
  item. The primary ghost-anchor symptom is fully addressed by the
  per-message fix above.

## [0.1.1] — earlier

Pre-Revive ContextGuard: context budget visibility, health scoring,
dashboard, inspector, engine. Ships the foundation Revive builds on.

## [0.1.0] — earlier

Initial release.

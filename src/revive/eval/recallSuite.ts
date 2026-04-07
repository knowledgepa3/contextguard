/**
 * Revive Recall Suite — anchor-preservation regression test
 *
 * The first line of defense for the lossless guarantee. For every
 * fixture, this suite:
 *
 *   1. Reads the original session
 *   2. Extracts the anchor set from the original (truth)
 *   3. Runs `revive` with the configured tier
 *   4. Extracts the anchor set from the compacted output
 *   5. Verifies that every original anchor's hash still appears in the
 *      compacted set (same content survived verbatim)
 *   6. Reports per-fixture and aggregate pass/fail
 *
 * Exit codes:
 *   0 — all fixtures pass (100% anchor preservation, recall >= floor)
 *   2 — at least one fixture failed (sprint stops)
 *
 * Sprint 1 only checks anchor preservation, which is the integrity
 * floor. Sprint 2 adds the LLM-based 20-question factual recall test
 * on top of this.
 *
 * Usage:
 *   npm run build
 *   node dist/revive/eval/recallSuite.js [--tier sparkling]
 *
 * @module revive/eval/recallSuite
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { revive } from '../index.js';
import {
  extractAnchors,
  countByKind,
  type Anchor,
  type AnchorKind,
} from '../anchorExtractor.js';
import { parseSessionJsonl } from '../formats/jsonl.js';
import type { ReviveTier } from '../manifest.js';

// ─── Path resolution ────────────────────────────────────────────────
//
// CommonJS provides __dirname natively. The fixtures live in
// `src/revive/eval/fixtures`. After tsc, this file ends up at
// `dist/revive/eval/recallSuite.js`. The fixtures are not copied to
// dist (tsc doesn't copy non-.ts files), so we resolve back to source.

function resolveFixturesDir(): string {
  // After tsc build, this file is at dist/revive/eval/recallSuite.js.
  // Fixtures live in src/revive/eval/fixtures (not copied by tsc).
  return join(__dirname, '..', '..', '..', 'src', 'revive', 'eval', 'fixtures');
}

// ─── Fixture loading ────────────────────────────────────────────────

interface Fixture {
  name: string;
  path: string;
  source: string;
}

function loadFixtures(): Fixture[] {
  const dir = resolveFixturesDir();
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    // Exclude smoke-test artifacts emitted by the CLI when run inside
    // the fixtures directory.
    .filter((f) => !f.endsWith('.compact.jsonl'));
  entries.sort();
  return entries.map((name) => ({
    name,
    path: join(dir, name),
    source: readFileSync(join(dir, name), 'utf-8'),
  }));
}

// ─── Recall check ───────────────────────────────────────────────────

interface FixtureReport {
  fixture: string;
  originalAnchors: number;
  compactedAnchors: number;
  preserved: number;
  missing: Array<{ kind: AnchorKind; text: string }>;
  originalTokens: number;
  compactedTokens: number;
  reductionPct: number;
  chainGrade: string;
  chainApproved: boolean;
  pass: boolean;
}

function checkRecall(fixture: Fixture, tier: ReviveTier): FixtureReport {
  // Extract anchors from the flat-text view of the original.
  const parsedOriginal = parseSessionJsonl(fixture.source);
  const originalExtraction = extractAnchors(parsedOriginal.flatText);

  // Run revive.
  const result = revive(fixture.source, { tier, format: 'jsonl' });

  // Extract anchors from the compacted output's flat-text view.
  const parsedCompacted = parseSessionJsonl(result.compacted);
  const compactedExtraction = extractAnchors(parsedCompacted.flatText);

  // For each anchor in the original, check that its hash appears in
  // the compacted set. If not, it's a regression.
  const compactedHashes = new Set(compactedExtraction.anchors.map((a) => a.hash));
  const missing: Array<{ kind: AnchorKind; text: string }> = [];
  let preserved = 0;
  for (const anchor of originalExtraction.anchors) {
    if (compactedHashes.has(anchor.hash)) {
      preserved++;
    } else {
      missing.push({ kind: anchor.kind, text: truncate(anchor.text, 80) });
    }
  }

  // Sprint 1 ECV enforcement: Chain Grade must be A and approved.
  // Any missing anchor OR any grade below A is a fixture failure.
  const chainOk = result.chain.grade === 'A' && result.chain.approved;

  return {
    fixture: fixture.name,
    originalAnchors: originalExtraction.anchors.length,
    compactedAnchors: compactedExtraction.anchors.length,
    preserved,
    missing,
    originalTokens: result.originalTokens,
    compactedTokens: result.compactedTokens,
    reductionPct: result.reductionPct,
    chainGrade: result.chain.grade,
    chainApproved: result.chain.approved,
    pass: missing.length === 0 && chainOk,
  };
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? flat.slice(0, max - 3) + '...' : flat;
}

// ─── Reporting ──────────────────────────────────────────────────────

function printReport(report: FixtureReport): void {
  const icon = report.pass ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
  const reductionPctDisplay = (report.reductionPct * 100).toFixed(1);
  const gradeColor = report.chainGrade === 'A' ? '\x1b[32m' : '\x1b[31m';
  const approval = report.chainApproved ? 'APPROVED' : 'NOT APPROVED';
  console.log(`${icon} ${report.fixture}`);
  console.log(`    anchors: ${report.preserved}/${report.originalAnchors} preserved`);
  console.log(`    tokens:  ${report.originalTokens} -> ${report.compactedTokens} (${reductionPctDisplay}% reduction)`);
  console.log(`    chain:   ${gradeColor}Grade ${report.chainGrade}\x1b[0m  ${approval}`);
  if (report.missing.length > 0) {
    console.log(`    \x1b[31mMISSING ANCHORS:\x1b[0m`);
    for (const m of report.missing) {
      console.log(`      [${m.kind}] ${m.text}`);
    }
  }
}

function parseTier(args: string[]): ReviveTier {
  const idx = args.indexOf('--tier');
  if (idx !== -1 && args[idx + 1]) {
    const t = args[idx + 1];
    if (t === 'sparkling' || t === 'electrolyte' || t === 'iv') return t;
  }
  return 'sparkling';
}

// ─── Main ───────────────────────────────────────────────────────────

function main(): void {
  const tier = parseTier(process.argv.slice(2));
  console.log('');
  console.log(`\x1b[1m\x1b[36mContextGuard Revive — Recall Suite\x1b[0m`);
  console.log(`tier: ${tier}`);
  console.log('-'.repeat(50));

  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    console.error('No fixtures found. Expected .jsonl files in src/revive/eval/fixtures/');
    process.exit(1);
  }

  const reports: FixtureReport[] = [];
  for (const fixture of fixtures) {
    const report = checkRecall(fixture, tier);
    printReport(report);
    reports.push(report);
  }

  // Aggregate
  const totalAnchors = reports.reduce((sum, r) => sum + r.originalAnchors, 0);
  const totalPreserved = reports.reduce((sum, r) => sum + r.preserved, 0);
  const recallPct = totalAnchors > 0 ? totalPreserved / totalAnchors : 1;
  const avgReduction = reports.length > 0
    ? reports.reduce((sum, r) => sum + r.reductionPct, 0) / reports.length
    : 0;
  const failedCount = reports.filter((r) => !r.pass).length;

  console.log('-'.repeat(50));
  console.log(`Fixtures:        ${reports.length}`);
  console.log(`Anchor recall:   ${totalPreserved}/${totalAnchors} (${(recallPct * 100).toFixed(2)}%)`);
  console.log(`Avg reduction:   ${(avgReduction * 100).toFixed(1)}%`);
  console.log(`Failed:          ${failedCount}`);
  console.log('');

  // Sprint 1 floor: 100% anchor preservation. Anything less is a halt.
  if (failedCount > 0) {
    console.log('\x1b[31mSPRINT 1 STOP CONDITION HIT: anchor recall below 100%.\x1b[0m');
    console.log('Fix the anchor extractor or the tier compactor before continuing.');
    process.exit(2);
  }

  // Show kind distribution from the first fixture for visibility.
  const firstFixture = fixtures[0];
  if (firstFixture) {
    const firstParsed = parseSessionJsonl(firstFixture.source);
    const firstExtraction = extractAnchors(firstParsed.flatText);
    const distribution = countByKind(firstExtraction);
    console.log(`First fixture anchor distribution (${firstFixture.name}):`);
    for (const [kind, count] of Object.entries(distribution)) {
      if (count > 0) {
        console.log(`  ${kind.padEnd(15)} ${count}`);
      }
    }
    console.log('');
  }

  console.log('\x1b[32mAll fixtures passed.\x1b[0m');
}

// Helper used implicitly to silence unused-import warnings if the
// caller imports from this file directly. The recall harness exports
// `checkRecall` so other tests can call it programmatically.
export { checkRecall };
export type { FixtureReport, Anchor };

main();

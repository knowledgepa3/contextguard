/**
 * Revive Round-Trip Torture Test
 *
 * For every fixture and every dropped span, this test:
 *
 *   1. Runs `revive` to produce the compacted output + manifest
 *   2. Runs `verify` against the original — must return ok
 *   3. For EVERY dropped span ID, calls `expand` and confirms:
 *      - the expand returns `verified: true`
 *      - the returned text re-hashes to the manifest's stored hash
 *      - the offset bounds match a real slice of the original
 *   4. Reports per-fixture and aggregate results
 *
 * Exit codes:
 *   0 — all expand operations succeeded for every span on every fixture
 *   2 — at least one expand failed (Sprint 1 stops)
 *
 * This is the harder integrity test. The recall suite checks anchor
 * preservation. Torture checks that EVERY single thing we claimed to
 * drop can be rehydrated, byte-for-byte, with no exceptions.
 *
 * Usage (from contextguard root):
 *   npm run build
 *   node dist/revive/eval/torture.js
 *
 * @module revive/eval/torture
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { revive } from '../index.js';
import { verifyManifest, expandSpan } from '../manifest.js';
import { parseSessionJsonl } from '../formats/jsonl.js';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function resolveFixturesDir(): string {
  return join(__dirname, '..', '..', '..', 'src', 'revive', 'eval', 'fixtures');
}

interface TortureReport {
  fixture: string;
  spans: number;
  expandsOk: number;
  expandsFailed: number;
  verifyOk: boolean;
  failures: Array<{ spanId: number; reason: string }>;
}

function tortureFixture(name: string, source: string): TortureReport {
  const result = revive(source, { tier: 'sparkling', format: 'jsonl' });
  // The flat-text the manifest references is the parseSessionJsonl flat
  // text of the original source — that's what `revive` passed to
  // buildManifest internally as `originalSource`.
  const flatText = parseSessionJsonl(source).flatText;

  // 1. Verify
  const verifyResult = verifyManifest(result.manifest, flatText);

  // 2. Expand every dropped span and verify byte-for-byte equality
  const failures: Array<{ spanId: number; reason: string }> = [];
  let expandsOk = 0;
  for (const span of result.manifest.dropped) {
    const expansion = expandSpan(result.manifest, span.id, flatText);
    if (!expansion.verified) {
      failures.push({ spanId: span.id, reason: expansion.reason });
      continue;
    }
    // Cross-check: the expanded text must hash to the manifest's recorded hash.
    const rehash = sha256(expansion.text);
    if (rehash !== span.hash) {
      failures.push({
        spanId: span.id,
        reason: `Expanded text hash ${rehash.slice(0, 12)} != manifest hash ${span.hash.slice(0, 12)}`,
      });
      continue;
    }
    // Cross-check: the offsets must point to the same text in the original.
    const sliced = flatText.slice(span.originalStart, span.originalEnd);
    if (sliced !== expansion.text) {
      failures.push({
        spanId: span.id,
        reason: `Slice [${span.originalStart},${span.originalEnd}] does not match expansion`,
      });
      continue;
    }
    expandsOk++;
  }

  return {
    fixture: name,
    spans: result.manifest.dropped.length,
    expandsOk,
    expandsFailed: failures.length,
    verifyOk: verifyResult.ok,
    failures,
  };
}

function main(): void {
  console.log('');
  console.log('\x1b[1m\x1b[36mContextGuard Revive — Torture Test\x1b[0m');
  console.log('expand every dropped span, byte-for-byte, no exceptions');
  console.log('-'.repeat(60));

  const dir = resolveFixturesDir();
  const fixtures = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .filter((f) => !f.endsWith('.compact.jsonl'));
  fixtures.sort();

  let totalSpans = 0;
  let totalOk = 0;
  let totalFailed = 0;
  let allVerifyOk = true;

  for (const name of fixtures) {
    const source = readFileSync(join(dir, name), 'utf-8');
    const report = tortureFixture(name, source);
    totalSpans += report.spans;
    totalOk += report.expandsOk;
    totalFailed += report.expandsFailed;
    if (!report.verifyOk) allVerifyOk = false;

    const verifyIcon = report.verifyOk ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
    const expandsIcon = report.expandsFailed === 0 ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
    console.log(`${verifyIcon}${expandsIcon} ${report.fixture}`);
    console.log(`     verify: ${report.verifyOk}  spans: ${report.expandsOk}/${report.spans} round-tripped`);
    if (report.failures.length > 0) {
      for (const f of report.failures) {
        console.log(`     \x1b[31mFAIL span ${f.spanId}:\x1b[0m ${f.reason}`);
      }
    }
  }

  console.log('-'.repeat(60));
  console.log(`Fixtures:        ${fixtures.length}`);
  console.log(`Total spans:     ${totalSpans}`);
  console.log(`Round-tripped:   ${totalOk}`);
  console.log(`Failed:          ${totalFailed}`);
  console.log(`All verify ok:   ${allVerifyOk}`);
  console.log('');

  if (totalFailed > 0 || !allVerifyOk) {
    console.log('\x1b[31mTORTURE TEST FAILED.\x1b[0m');
    process.exit(2);
  }
  console.log('\x1b[32mEvery dropped span rehydrated byte-for-byte.\x1b[0m');
}

main();

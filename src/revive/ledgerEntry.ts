/**
 * Ledger Entry Envelope — GIA-compatible governance record
 *
 * Every Revive run produces a hash-sealed evidence chain. This module
 * shapes that chain into a canonical envelope that any hash-chained
 * forensic ledger (including GIA's `forensic_ledger` table) can ingest
 * as a governance event — with zero runtime dependency on GIA.
 *
 * Design intent:
 *   - Pure function — no I/O, no network, no imports beyond types
 *   - Deterministic — same inputs produce byte-identical output
 *   - Self-describing — the envelope carries enough metadata for a
 *     ledger to record, chain, and later audit the event
 *   - Versioned — schemaVersion lets GIA evolve the ingestion format
 *
 * Usage (caller is responsible for actually POSTing or writing it):
 *
 *     const entry = buildLedgerEntry(reviveResult);
 *     await gia.ledger.append(entry);              // if GIA is available
 *     fs.writeFileSync('revive-ledger-entry.json', // or write to disk
 *                      JSON.stringify(entry));
 *
 * ContextGuard never calls GIA directly. The envelope is the contract;
 * the caller decides the transport.
 *
 * @module revive/ledgerEntry
 */

import type { ReviveManifest, ReviveTier } from './manifest.js';
import type { ChainValidationReport, ChainGrade } from './chainValidator.js';
import type { ProbativeWeight } from './probativeWeight.js';

/** Canonical ledger envelope. Stable shape, versioned. */
export interface ReviveLedgerEntry {
  /** Schema version of this envelope format. */
  schemaVersion: 1;
  /** Event type for ledger routing. GIA uses this for forensic_ledger.operation. */
  eventType: 'contextguard.revive';
  /** ISO 8601 timestamp the chain was validated. */
  occurredAt: string;
  /** Framework identification — lets ledger consumers attribute the methodology. */
  framework: {
    name: 'ACE Evidence Chain Validation';
    short: 'ECV';
    origin: 'William J. Storey III';
  };
  /** Revive package version that produced the entry. */
  reviveVersion: string;
  /** Revive tier used (sparkling / electrolyte / iv). */
  tier: ReviveTier;
  /** Hashes that chain this entry to its source artifacts. */
  hashes: {
    /** SHA-256 of the original flat text. */
    original: string;
    /** SHA-256 of the compacted flat text. */
    compacted: string;
  };
  /** Size + reduction metrics. */
  metrics: {
    originalTokens: number;
    compactedTokens: number;
    reductionPct: number;
    preservedSpans: number;
    droppedSpans: number;
  };
  /** The chain validation verdict — the part a compliance auditor cares about. */
  chainGrade: {
    grade: ChainGrade;
    approved: boolean;
    level1_structuralIntegrity: boolean;
    level2_evidencePreservation: boolean;
    level3_driftCheck: boolean;
    level4_recoverySufficiency: boolean;
  };
  /** Evidence distribution by probative weight. */
  evidence: {
    preservedByWeight: Record<ProbativeWeight, number>;
    lostByWeight: Record<ProbativeWeight, number>;
  };
  /** One-line human-readable summary. */
  summary: string;
  /**
   * Hash of this entry's canonical JSON (minus this field). Lets a
   * ledger chain multiple entries by linking each entry's `entryHash`
   * to the next entry's `previousHash` field. Computed by
   * `sealLedgerEntry` — the raw `buildLedgerEntry` output has
   * `entryHash: null`.
   */
  entryHash: string | null;
}

/**
 * Build the canonical ledger envelope from a Revive run.
 *
 * Pure function — does not touch disk, network, or any external state.
 * Returns an unsealed entry (entryHash = null). Call `sealLedgerEntry`
 * if you want the self-hash added.
 */
export function buildLedgerEntry(params: {
  manifest: ReviveManifest;
  chain: ChainValidationReport;
  originalTokens: number;
  compactedTokens: number;
}): ReviveLedgerEntry {
  const { manifest, chain, originalTokens, compactedTokens } = params;

  return {
    schemaVersion: 1,
    eventType: 'contextguard.revive',
    occurredAt: manifest.createdAt,
    framework: {
      name: 'ACE Evidence Chain Validation',
      short: 'ECV',
      origin: 'William J. Storey III',
    },
    reviveVersion: manifest.reviveVersion,
    tier: manifest.tier,
    hashes: {
      original: manifest.originalHash,
      compacted: manifest.compactedHash,
    },
    metrics: {
      originalTokens,
      compactedTokens,
      reductionPct: manifest.reductionPct,
      preservedSpans: manifest.preserved.length,
      droppedSpans: manifest.dropped.length,
    },
    chainGrade: {
      grade: chain.grade,
      approved: chain.approved,
      level1_structuralIntegrity: chain.level1.passed,
      level2_evidencePreservation: chain.level2.passed,
      level3_driftCheck: chain.level3.passed,
      level4_recoverySufficiency: chain.level4.passed,
    },
    evidence: {
      preservedByWeight: chain.preservedByWeight,
      lostByWeight: chain.lostByWeight,
    },
    summary: chain.summary,
    entryHash: null,
  };
}

/**
 * Compute the canonical self-hash of a ledger entry and return a new
 * entry with `entryHash` populated. The canonical form is stable JSON
 * (sorted keys) with `entryHash` set to `null` during hashing, so the
 * hash is deterministic and reproducible.
 *
 * GIA's ledger chain links entries by placing the previous entry's
 * `entryHash` in the new entry's `previousHash` — which would be added
 * by the GIA ingestion layer, not here.
 */
export function sealLedgerEntry(
  entry: ReviveLedgerEntry,
  sha256Fn: (s: string) => string
): ReviveLedgerEntry {
  const withNullHash: ReviveLedgerEntry = { ...entry, entryHash: null };
  const canonical = canonicalJson(withNullHash);
  const hash = sha256Fn(canonical);
  return { ...entry, entryHash: hash };
}

/**
 * Stable JSON serialization with sorted keys. This is what gets
 * hashed. Matches the canonicalization GIA's ledger uses.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

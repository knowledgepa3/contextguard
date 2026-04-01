/**
 * Analytics Store — SQLite persistence for session analytics
 *
 * Stores session history, health scores over time, and budget snapshots
 * so developers can track context health trends across sessions.
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { SessionAnalytics, BudgetStatus, ContextHealth } from '../types/index.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    peak_tokens INTEGER DEFAULT 0,
    items_added INTEGER DEFAULT 0,
    items_pruned INTEGER DEFAULT 0,
    violations INTEGER DEFAULT 0,
    avg_health_score REAL DEFAULT 0,
    final_grade TEXT,
    total_tokens_used INTEGER DEFAULT 0,
    total_tokens_available INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    health_score INTEGER NOT NULL,
    health_grade TEXT NOT NULL,
    utilization REAL NOT NULL,
    category_data TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id);
  CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(timestamp);
  CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
`;

export class AnalyticsStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? this.defaultDbPath();
    const dir = resolvedPath.substring(0, resolvedPath.lastIndexOf('/'));
    if (dir) {
      try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    }

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  /** Start tracking a new session */
  startSession(sessionId: string, model: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO sessions (session_id, model, started_at)
      VALUES (?, ?, ?)
    `).run(sessionId, model, Date.now());
  }

  /** Record a point-in-time snapshot */
  recordSnapshot(
    sessionId: string,
    budget: BudgetStatus,
    health: ContextHealth,
  ): void {
    this.db.prepare(`
      INSERT INTO snapshots (session_id, timestamp, total_tokens, health_score, health_grade, utilization, category_data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      Date.now(),
      budget.totalTokensUsed,
      health.score,
      health.grade,
      budget.utilization,
      JSON.stringify(budget.categories),
    );
  }

  /** Finalize a session with analytics summary */
  endSession(sessionId: string, analytics: SessionAnalytics, finalGrade: string): void {
    this.db.prepare(`
      UPDATE sessions SET
        ended_at = ?,
        peak_tokens = ?,
        items_added = ?,
        items_pruned = ?,
        violations = ?,
        avg_health_score = ?,
        final_grade = ?
      WHERE session_id = ?
    `).run(
      Date.now(),
      analytics.peakTokens,
      analytics.itemsAdded,
      analytics.itemsPruned,
      analytics.violations,
      analytics.avgHealthScore,
      finalGrade,
      sessionId,
    );
  }

  /** Get recent sessions */
  getRecentSessions(limit: number = 20): SessionSummary[] {
    return this.db.prepare(`
      SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?
    `).all(limit) as SessionSummary[];
  }

  /** Get snapshots for a session */
  getSessionSnapshots(sessionId: string): SnapshotRow[] {
    return this.db.prepare(`
      SELECT * FROM snapshots WHERE session_id = ? ORDER BY timestamp ASC
    `).all(sessionId) as SnapshotRow[];
  }

  /** Get aggregate stats */
  getStats(): AggregateStats {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_sessions,
        AVG(avg_health_score) as avg_health,
        SUM(items_pruned) as total_pruned,
        SUM(violations) as total_violations,
        AVG(peak_tokens) as avg_peak_tokens
      FROM sessions
      WHERE ended_at IS NOT NULL
    `).get() as AggregateStatsRow | undefined;

    return {
      totalSessions: row?.total_sessions ?? 0,
      avgHealth: Math.round(row?.avg_health ?? 0),
      totalPruned: row?.total_pruned ?? 0,
      totalViolations: row?.total_violations ?? 0,
      avgPeakTokens: Math.round(row?.avg_peak_tokens ?? 0),
    };
  }

  /** Close the database */
  close(): void {
    this.db.close();
  }

  private defaultDbPath(): string {
    return join(homedir(), '.contextguard', 'analytics.db');
  }
}

/** Row types */
export interface SessionSummary {
  session_id: string;
  model: string;
  started_at: number;
  ended_at: number | null;
  peak_tokens: number;
  items_added: number;
  items_pruned: number;
  violations: number;
  avg_health_score: number;
  final_grade: string | null;
  total_tokens_used: number;
  total_tokens_available: number;
}

export interface SnapshotRow {
  id: number;
  session_id: string;
  timestamp: number;
  total_tokens: number;
  health_score: number;
  health_grade: string;
  utilization: number;
  category_data: string;
}

export interface AggregateStats {
  totalSessions: number;
  avgHealth: number;
  totalPruned: number;
  totalViolations: number;
  avgPeakTokens: number;
}

interface AggregateStatsRow {
  total_sessions: number;
  avg_health: number;
  total_pruned: number;
  total_violations: number;
  avg_peak_tokens: number;
}

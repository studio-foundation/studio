// Persistence layer for pipeline runs
// Two implementations: InMemoryRunStore (tests) + SQLiteRunStore (production)

import { createRequire } from 'node:module';
import type { PipelineRun } from '@studio/contracts';

export interface RunStore {
  savePipelineRun(run: PipelineRun): void;
  getPipelineRun(id: string): PipelineRun | null;
  listPipelineRuns(options?: { limit?: number; status?: string }): PipelineRun[];
  getLatestRun(pipelineName?: string): PipelineRun | null;
  saveLogPath(runId: string, logPath: string): void;
  getLogPath(runId: string): string | null;
}

// In-memory store for tests and simple usage
export class InMemoryRunStore implements RunStore {
  private runs: Map<string, PipelineRun> = new Map();
  private logPaths: Map<string, string> = new Map();

  savePipelineRun(run: PipelineRun): void {
    this.runs.set(run.id, structuredClone(run));
  }

  getPipelineRun(id: string): PipelineRun | null {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : null;
  }

  listPipelineRuns(options?: { limit?: number; status?: string }): PipelineRun[] {
    let runs = Array.from(this.runs.values());

    if (options?.status) {
      runs = runs.filter(r => r.status === options.status);
    }

    // Sort by started_at descending
    runs.sort((a, b) => b.started_at.localeCompare(a.started_at));

    if (options?.limit) {
      runs = runs.slice(0, options.limit);
    }

    return runs.map(r => structuredClone(r));
  }

  getLatestRun(pipelineName?: string): PipelineRun | null {
    let runs = Array.from(this.runs.values());

    if (pipelineName) {
      runs = runs.filter(r => r.pipeline_name === pipelineName);
    }

    if (runs.length === 0) return null;

    runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
    return structuredClone(runs[0]);
  }

  saveLogPath(runId: string, logPath: string): void {
    this.logPaths.set(runId, logPath);
  }

  getLogPath(runId: string): string | null {
    return this.logPaths.get(runId) ?? null;
  }
}

// SQLite store for production persistence
// Uses better-sqlite3 (synchronous, simple, no migrations)
// Stores the entire PipelineRun as JSON in a single column — simple, queryable by status
export class SQLiteRunStore implements RunStore {
  private db: import('better-sqlite3').Database;

  constructor(dbPath: string) {
    const _require = createRequire(import.meta.url);
    const Database = _require('better-sqlite3') as new (path: string) => import('better-sqlite3').Database;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id TEXT PRIMARY KEY,
        pipeline_name TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        log_path TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status
        ON pipeline_runs(status);
      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_created
        ON pipeline_runs(created_at DESC);
    `);

    // Migration: add log_path column to existing databases
    try {
      this.db.exec('ALTER TABLE pipeline_runs ADD COLUMN log_path TEXT');
    } catch {
      // Column already exists — ignore
    }
  }

  savePipelineRun(run: PipelineRun): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO pipeline_runs (id, pipeline_name, status, result, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      run.id,
      run.pipeline_name,
      run.status,
      JSON.stringify(run),
      run.started_at,
      run.completed_at ?? null,
    );
  }

  getPipelineRun(id: string): PipelineRun | null {
    const row = this.db.prepare('SELECT result FROM pipeline_runs WHERE id = ?').get(id) as
      | { result: string }
      | undefined;

    if (!row) return null;
    return JSON.parse(row.result) as PipelineRun;
  }

  listPipelineRuns(options?: { limit?: number; status?: string }): PipelineRun[] {
    let sql = 'SELECT result FROM pipeline_runs';
    const params: unknown[] = [];

    if (options?.status) {
      sql += ' WHERE status = ?';
      params.push(options.status);
    }

    sql += ' ORDER BY created_at DESC';

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{ result: string }>;
    return rows.map(row => JSON.parse(row.result) as PipelineRun);
  }

  getLatestRun(pipelineName?: string): PipelineRun | null {
    let sql = 'SELECT result FROM pipeline_runs';
    const params: unknown[] = [];

    if (pipelineName) {
      sql += ' WHERE pipeline_name = ?';
      params.push(pipelineName);
    }

    sql += ' ORDER BY created_at DESC LIMIT 1';

    const row = this.db.prepare(sql).get(...params) as { result: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.result) as PipelineRun;
  }

  saveLogPath(runId: string, logPath: string): void {
    this.db.prepare('UPDATE pipeline_runs SET log_path = ? WHERE id = ?').run(logPath, runId);
  }

  getLogPath(runId: string): string | null {
    const row = this.db.prepare('SELECT log_path FROM pipeline_runs WHERE id = ?').get(runId) as
      | { log_path: string | null }
      | undefined;
    return row?.log_path ?? null;
  }

  close(): void {
    this.db.close();
  }
}

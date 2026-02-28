// LinearStore — SQLite persistence for Linear integration config and trigger log
// Uses the same DB file as the run store (.studio/runs/runs.db)

import { createRequire } from 'node:module';

export interface LinearConfig {
  pipeline?: string;
  active: boolean;
}

export interface LinearTriggerRecord {
  id: string;
  received_at: string;
  issue_id?: string;
  issue_title?: string;
  issue_url?: string;
  pipeline: string;
  run_id?: string;
  status: 'success' | 'failed';
}

export class LinearStore {
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
      CREATE TABLE IF NOT EXISTS linear_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pipeline TEXT,
        active INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS linear_triggers (
        id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        issue_id TEXT,
        issue_title TEXT,
        issue_url TEXT,
        pipeline TEXT NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL
      );
    `);
  }

  getConfig(): LinearConfig {
    const row = this.db.prepare(
      'SELECT pipeline, active FROM linear_config WHERE id = 1'
    ).get() as { pipeline: string | null; active: number } | undefined;

    if (!row) return { active: false };
    return {
      ...(row.pipeline != null ? { pipeline: row.pipeline } : {}),
      active: row.active === 1,
    };
  }

  patchConfig(data: Partial<LinearConfig>): void {
    const current = this.getConfig();
    const pipeline = 'pipeline' in data ? (data.pipeline ?? null) : (current.pipeline ?? null);
    const active = 'active' in data ? (data.active ? 1 : 0) : (current.active ? 1 : 0);
    this.db.prepare(`
      INSERT INTO linear_config (id, pipeline, active) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pipeline = excluded.pipeline, active = excluded.active
    `).run(pipeline, active);
  }

  insertTrigger(trigger: LinearTriggerRecord): void {
    this.db.prepare(`
      INSERT INTO linear_triggers (id, received_at, issue_id, issue_title, issue_url, pipeline, run_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trigger.id,
      trigger.received_at,
      trigger.issue_id ?? null,
      trigger.issue_title ?? null,
      trigger.issue_url ?? null,
      trigger.pipeline,
      trigger.run_id ?? null,
      trigger.status,
    );
  }

  listTriggers(limit = 50): LinearTriggerRecord[] {
    const rows = this.db.prepare(
      'SELECT id, received_at, issue_id, issue_title, issue_url, pipeline, run_id, status FROM linear_triggers ORDER BY received_at DESC LIMIT ?'
    ).all(limit) as Array<{
      id: string;
      received_at: string;
      issue_id: string | null;
      issue_title: string | null;
      issue_url: string | null;
      pipeline: string;
      run_id: string | null;
      status: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      received_at: row.received_at,
      ...(row.issue_id != null ? { issue_id: row.issue_id } : {}),
      ...(row.issue_title != null ? { issue_title: row.issue_title } : {}),
      ...(row.issue_url != null ? { issue_url: row.issue_url } : {}),
      pipeline: row.pipeline,
      ...(row.run_id != null ? { run_id: row.run_id } : {}),
      status: row.status as 'success' | 'failed',
    }));
  }

  close(): void {
    this.db.close();
  }
}

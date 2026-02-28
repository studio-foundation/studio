// IntegrationStore — generic SQLite persistence for integration configs and trigger logs
// Partitioned by integration_name — supports any integration (linear, slack, github, etc.)
// Uses the same DB file as the run store (.studio/runs/runs.db)

import { createRequire } from 'node:module';

export interface IntegrationConfig {
  pipeline?: string;
  active: boolean;
}

export interface IntegrationTriggerRecord {
  id: string;
  integration_name: string;
  received_at: string;
  external_id?: string;
  external_label?: string;
  external_url?: string;
  pipeline: string;
  run_id?: string;
  status: 'success' | 'failed';
}

export class IntegrationStore {
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
      CREATE TABLE IF NOT EXISTS integration_config (
        integration_name TEXT NOT NULL,
        pipeline TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (integration_name)
      );

      CREATE TABLE IF NOT EXISTS integration_triggers (
        id TEXT PRIMARY KEY,
        integration_name TEXT NOT NULL,
        received_at TEXT NOT NULL,
        external_id TEXT,
        external_label TEXT,
        external_url TEXT,
        pipeline TEXT NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL
      );
    `);
  }

  getConfig(integrationName: string): IntegrationConfig {
    const row = this.db.prepare(
      'SELECT pipeline, active FROM integration_config WHERE integration_name = ?'
    ).get(integrationName) as { pipeline: string | null; active: number } | undefined;

    if (!row) return { active: false };
    return {
      ...(row.pipeline != null ? { pipeline: row.pipeline } : {}),
      active: row.active === 1,
    };
  }

  patchConfig(integrationName: string, data: Partial<IntegrationConfig>): void {
    const current = this.getConfig(integrationName);
    const pipeline = 'pipeline' in data ? (data.pipeline ?? null) : (current.pipeline ?? null);
    const active = 'active' in data ? (data.active ? 1 : 0) : (current.active ? 1 : 0);
    this.db.prepare(`
      INSERT INTO integration_config (integration_name, pipeline, active) VALUES (?, ?, ?)
      ON CONFLICT(integration_name) DO UPDATE SET pipeline = excluded.pipeline, active = excluded.active
    `).run(integrationName, pipeline, active);
  }

  insertTrigger(trigger: IntegrationTriggerRecord): void {
    this.db.prepare(`
      INSERT INTO integration_triggers
        (id, integration_name, received_at, external_id, external_label, external_url, pipeline, run_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trigger.id,
      trigger.integration_name,
      trigger.received_at,
      trigger.external_id ?? null,
      trigger.external_label ?? null,
      trigger.external_url ?? null,
      trigger.pipeline,
      trigger.run_id ?? null,
      trigger.status,
    );
  }

  listTriggers(integrationName: string, limit = 50): IntegrationTriggerRecord[] {
    type Row = {
      id: string; integration_name: string; received_at: string;
      external_id: string | null; external_label: string | null; external_url: string | null;
      pipeline: string; run_id: string | null; status: string;
    };
    const rows = this.db.prepare(
      `SELECT id, integration_name, received_at, external_id, external_label, external_url, pipeline, run_id, status
       FROM integration_triggers WHERE integration_name = ? ORDER BY received_at DESC LIMIT ?`
    ).all(integrationName, limit) as Row[];

    return rows.map(row => ({
      id: row.id,
      integration_name: row.integration_name,
      received_at: row.received_at,
      ...(row.external_id != null ? { external_id: row.external_id } : {}),
      ...(row.external_label != null ? { external_label: row.external_label } : {}),
      ...(row.external_url != null ? { external_url: row.external_url } : {}),
      pipeline: row.pipeline,
      ...(row.run_id != null ? { run_id: row.run_id } : {}),
      status: row.status as 'success' | 'failed',
    }));
  }

  close(): void {
    this.db.close();
  }
}

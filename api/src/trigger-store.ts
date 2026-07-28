// TriggerStore — SQLite log of inbound webhook deliveries that launched a run.
// Partitioned by trigger_name. Uses the same DB file as the run store
// (.studio/runs/runs.db).

import { openDatabase, type SyncDatabase } from '@studio-foundation/engine';

export interface TriggerRecord {
  id: string;
  trigger_name: string;
  received_at: string;
  external_id?: string;
  external_label?: string;
  external_url?: string;
  pipeline: string;
  run_id?: string;
  status: 'success' | 'failed';
}

export class TriggerStore {
  private db: SyncDatabase;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_log (
        id TEXT PRIMARY KEY,
        trigger_name TEXT NOT NULL,
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

  insert(record: TriggerRecord): void {
    this.db.prepare(`
      INSERT INTO trigger_log
        (id, trigger_name, received_at, external_id, external_label, external_url, pipeline, run_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.trigger_name,
      record.received_at,
      record.external_id ?? null,
      record.external_label ?? null,
      record.external_url ?? null,
      record.pipeline,
      record.run_id ?? null,
      record.status,
    );
  }

  list(triggerName: string, limit = 50): TriggerRecord[] {
    type Row = {
      id: string; trigger_name: string; received_at: string;
      external_id: string | null; external_label: string | null; external_url: string | null;
      pipeline: string; run_id: string | null; status: string;
    };
    const rows = this.db.prepare(
      `SELECT id, trigger_name, received_at, external_id, external_label, external_url, pipeline, run_id, status
       FROM trigger_log WHERE trigger_name = ? ORDER BY received_at DESC LIMIT ?`
    ).all(triggerName, limit) as Row[];

    return rows.map(row => ({
      id: row.id,
      trigger_name: row.trigger_name,
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

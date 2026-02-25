// WebhookStore — SQLite persistence for webhook registrations and deliveries
// Uses the same DB file as the run store (.studio/runs/runs.db)

import { createRequire } from 'node:module';

export interface WebhookRegistration {
  id: string;
  url: string;
  events: string[];
  secret?: string;
  status: 'active' | 'failed';
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event: string;
  run_id: string;
  status: 'pending' | 'retrying' | 'success' | 'failed';
  attempt: number;
  created_at: string;
}

export class WebhookStore {
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
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        events TEXT NOT NULL,
        secret TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        event TEXT NOT NULL,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (webhook_id) REFERENCES webhooks(id)
      );
    `);
  }

  saveWebhook(webhook: WebhookRegistration): void {
    this.db.prepare(`
      INSERT INTO webhooks (id, url, events, secret, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        url = excluded.url,
        events = excluded.events,
        secret = excluded.secret,
        status = excluded.status
    `).run(
      webhook.id,
      webhook.url,
      JSON.stringify(webhook.events),
      webhook.secret ?? null,
      webhook.status,
      webhook.created_at,
    );
  }

  getWebhook(id: string): WebhookRegistration | null {
    const row = this.db.prepare(
      'SELECT id, url, events, secret, status, created_at FROM webhooks WHERE id = ?'
    ).get(id) as { id: string; url: string; events: string; secret: string | null; status: string; created_at: string } | undefined;

    if (!row) return null;
    return {
      id: row.id,
      url: row.url,
      events: JSON.parse(row.events) as string[],
      ...(row.secret != null ? { secret: row.secret } : {}),
      status: row.status as 'active' | 'failed',
      created_at: row.created_at,
    };
  }

  listWebhooks(): WebhookRegistration[] {
    const rows = this.db.prepare(
      'SELECT id, url, events, secret, status, created_at FROM webhooks ORDER BY created_at DESC'
    ).all() as Array<{ id: string; url: string; events: string; secret: string | null; status: string; created_at: string }>;

    return rows.map(row => ({
      id: row.id,
      url: row.url,
      events: JSON.parse(row.events) as string[],
      ...(row.secret != null ? { secret: row.secret } : {}),
      status: row.status as 'active' | 'failed',
      created_at: row.created_at,
    }));
  }

  deleteWebhook(id: string): boolean {
    const result = this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  markWebhookFailed(id: string): void {
    this.db.prepare("UPDATE webhooks SET status = 'failed' WHERE id = ?").run(id);
  }

  saveDelivery(delivery: WebhookDelivery): void {
    this.db.prepare(`
      INSERT INTO webhook_deliveries (id, webhook_id, event, run_id, status, attempt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      delivery.id,
      delivery.webhook_id,
      delivery.event,
      delivery.run_id,
      delivery.status,
      delivery.attempt,
      delivery.created_at,
    );
  }

  updateDelivery(id: string, status: WebhookDelivery['status']): void {
    this.db.prepare('UPDATE webhook_deliveries SET status = ? WHERE id = ?').run(status, id);
  }

  close(): void {
    this.db.close();
  }
}

// api/src/user-store.ts
// UserStore — SQLite persistence for users and daily usage
// Follows same pattern as WebhookStore and IntegrationStore
// Uses the same DB file as the run store (.studio/runs/runs.db)

import { createRequire } from 'node:module';

export interface User {
  id: string;
  email: string;
  plan: string;
  api_key: string;
  created_at: string;
}

export interface DailyUsage {
  user_id: string;
  date: string;      // YYYY-MM-DD
  runs_count: number;
  tokens_used: number;
}

export class UserStore {
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
      CREATE TABLE IF NOT EXISTS users (
        id         TEXT PRIMARY KEY,
        email      TEXT UNIQUE NOT NULL,
        plan       TEXT NOT NULL DEFAULT 'free',
        api_key    TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage (
        user_id    TEXT NOT NULL,
        date       TEXT NOT NULL,
        runs_count INTEGER NOT NULL DEFAULT 0,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, date)
      );
    `);
  }

  getUserByApiKey(apiKey: string): User | null {
    const row = this.db
      .prepare('SELECT id, email, plan, api_key, created_at FROM users WHERE api_key = ?')
      .get(apiKey) as User | undefined;
    return row ?? null;
  }

  getUserById(id: string): User | null {
    const row = this.db
      .prepare('SELECT id, email, plan, api_key, created_at FROM users WHERE id = ?')
      .get(id) as User | undefined;
    return row ?? null;
  }

  listUsers(): User[] {
    return this.db
      .prepare('SELECT id, email, plan, api_key, created_at FROM users ORDER BY created_at ASC')
      .all() as User[];
  }

  saveUser(user: User): void {
    this.db.prepare(`
      INSERT INTO users (id, email, plan, api_key, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email      = excluded.email,
        plan       = excluded.plan,
        api_key    = excluded.api_key,
        created_at = excluded.created_at
    `).run(user.id, user.email, user.plan, user.api_key, user.created_at);
  }

  deleteUser(id: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  getDailyUsage(userId: string, date: string): DailyUsage {
    const row = this.db
      .prepare('SELECT user_id, date, runs_count, tokens_used FROM usage WHERE user_id = ? AND date = ?')
      .get(userId, date) as DailyUsage | undefined;
    return row ?? { user_id: userId, date, runs_count: 0, tokens_used: 0 };
  }

  incrementRuns(userId: string, date: string): void {
    this.db.prepare(`
      INSERT INTO usage (user_id, date, runs_count, tokens_used)
      VALUES (?, ?, 1, 0)
      ON CONFLICT (user_id, date) DO UPDATE SET
        runs_count = runs_count + 1
    `).run(userId, date);
  }

  incrementTokens(userId: string, date: string, tokens: number): void {
    this.db.prepare(`
      INSERT INTO usage (user_id, date, runs_count, tokens_used)
      VALUES (?, ?, 0, ?)
      ON CONFLICT (user_id, date) DO UPDATE SET
        tokens_used = tokens_used + excluded.tokens_used
    `).run(userId, date, tokens);
  }

  close(): void {
    this.db.close();
  }
}

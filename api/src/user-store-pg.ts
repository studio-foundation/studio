// api/src/user-store-pg.ts
// PgUserStore — PostgreSQL async variant of UserStore
// Follows same pattern as PgRunStore in @studio/engine
// Table prefix studio_ to avoid conflicts with user app tables

import { createRequire } from 'node:module';
import type { User, DailyUsage } from './user-store.js';
export type { User, DailyUsage } from './user-store.js';

export class PgUserStore {
  private pool: import('pg').Pool;
  private schemaReady: Promise<void> | null = null;

  constructor(connectionString: string) {
    const _require = createRequire(import.meta.url);
    const { Pool } = _require('pg') as typeof import('pg');
    this.pool = new Pool({ connectionString });
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.initSchema();
    }
    return this.schemaReady;
  }

  private async initSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS studio_users (
        id         TEXT PRIMARY KEY,
        email      TEXT UNIQUE NOT NULL,
        plan       TEXT NOT NULL DEFAULT 'free',
        api_key    TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS studio_usage (
        user_id     TEXT NOT NULL,
        date        TEXT NOT NULL,
        runs_count  INTEGER NOT NULL DEFAULT 0,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, date)
      )
    `);
  }

  async getUserByApiKey(apiKey: string): Promise<User | null> {
    await this.ensureSchema();
    const res = await this.pool.query<User>(
      'SELECT id, email, plan, api_key, created_at FROM studio_users WHERE api_key = $1',
      [apiKey]
    );
    return res.rows[0] ?? null;
  }

  async getUserById(id: string): Promise<User | null> {
    await this.ensureSchema();
    const res = await this.pool.query<User>(
      'SELECT id, email, plan, api_key, created_at FROM studio_users WHERE id = $1',
      [id]
    );
    return res.rows[0] ?? null;
  }

  async listUsers(): Promise<User[]> {
    await this.ensureSchema();
    const res = await this.pool.query<User>(
      'SELECT id, email, plan, api_key, created_at FROM studio_users ORDER BY created_at ASC'
    );
    return res.rows;
  }

  async saveUser(user: User): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO studio_users (id, email, plan, api_key, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         email      = EXCLUDED.email,
         plan       = EXCLUDED.plan,
         api_key    = EXCLUDED.api_key,
         created_at = EXCLUDED.created_at`,
      [user.id, user.email, user.plan, user.api_key, user.created_at]
    );
  }

  async deleteUser(id: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query('DELETE FROM studio_users WHERE id = $1', [id]);
  }

  async getDailyUsage(userId: string, date: string): Promise<DailyUsage> {
    await this.ensureSchema();
    const res = await this.pool.query<DailyUsage>(
      'SELECT user_id, date, runs_count, tokens_used FROM studio_usage WHERE user_id = $1 AND date = $2',
      [userId, date]
    );
    return res.rows[0] ?? { user_id: userId, date, runs_count: 0, tokens_used: 0 };
  }

  async incrementRuns(userId: string, date: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO studio_usage (user_id, date, runs_count, tokens_used)
       VALUES ($1, $2, 1, 0)
       ON CONFLICT (user_id, date) DO UPDATE SET
         runs_count = studio_usage.runs_count + 1`,
      [userId, date]
    );
  }

  async incrementTokens(userId: string, date: string, tokens: number): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO studio_usage (user_id, date, runs_count, tokens_used)
       VALUES ($1, $2, 0, $3)
       ON CONFLICT (user_id, date) DO UPDATE SET
         tokens_used = studio_usage.tokens_used + EXCLUDED.tokens_used`,
      [userId, date, tokens]
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export type AnyUserStore = import('./user-store.js').UserStore | PgUserStore;

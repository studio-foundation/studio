# STU-26 Auth Multi-User Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the single global API key with per-user API keys, quotas per plan (runs/day, max_concurrent), and in-memory rate limiting — backward-compatible with the existing single-key setup.

**Architecture:** `UserStore` (SQLite) and `PgUserStore` (PG) in `@studio/api`, following the exact same pattern as `WebhookStore` and `IntegrationStore`. Auth hook updated to support multi-user mode (user lookup) + legacy mode (single key fallback). Quota enforcement added to `InProcessLauncher` as optional deps.

**Tech Stack:** `better-sqlite3` (already installed), `pg` (already installed), `@fastify/rate-limit` (new), Fastify 5, Vitest, Commander.js

---

## Task 1: `plans.ts` — Plan config types and defaults

**Files:**
- Create: `api/src/plans.ts`

### Step 1: Create `plans.ts` with types and defaults

```typescript
// api/src/plans.ts
// Plan configuration types and default plans

export interface PlanLimits {
  runs_per_day: number;          // -1 = unlimited
  max_concurrent: number;
  max_tokens_per_run: number;    // -1 = unlimited
  rate_limit_per_minute: number;
}

export type PlansConfig = Record<string, PlanLimits>;

export const DEFAULT_PLANS: PlansConfig = {
  free: {
    runs_per_day: 5,
    max_concurrent: 1,
    max_tokens_per_run: 50_000,
    rate_limit_per_minute: 10,
  },
  pro: {
    runs_per_day: 100,
    max_concurrent: 5,
    max_tokens_per_run: 500_000,
    rate_limit_per_minute: 60,
  },
  unlimited: {
    runs_per_day: -1,
    max_concurrent: 20,
    max_tokens_per_run: -1,
    rate_limit_per_minute: 300,
  },
};

/** Merge user-supplied partial plans with defaults. Unknown plans fall back to 'free'. */
export function resolvePlans(configPlans?: Partial<PlansConfig>): PlansConfig {
  if (!configPlans) return DEFAULT_PLANS;
  return { ...DEFAULT_PLANS, ...configPlans };
}

/** Get plan limits for a user, defaulting to 'free' if plan is unknown. */
export function getPlanLimits(plans: PlansConfig, planName: string): PlanLimits {
  return plans[planName] ?? plans['free'] ?? DEFAULT_PLANS['free'];
}
```

### Step 2: Commit

```bash
git add api/src/plans.ts
git commit -m "feat(api): add PlanConfig types and defaults"
```

---

## Task 2: `UserStore` (SQLite) — interface + implementation

**Files:**
- Create: `api/src/user-store.ts`
- Create: `api/tests/user-store.test.ts`

### Step 1: Write the failing tests

```typescript
// api/tests/user-store.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { UserStore, type User } from '../src/user-store.js';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'alice@example.com',
    plan: 'free',
    api_key: 'sk-test-abc123',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('UserStore', () => {
  let store: UserStore;

  beforeEach(() => {
    const dbDir = resolve('/tmp', `.studio-user-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dbDir, { recursive: true });
    store = new UserStore(resolve(dbDir, 'runs.db'));
  });

  afterEach(() => {
    store.close();
  });

  // CRUD
  test('saves and retrieves a user by id', () => {
    const user = makeUser();
    store.saveUser(user);
    expect(store.getUserById('user-1')).toEqual(user);
  });

  test('retrieves a user by api_key', () => {
    const user = makeUser();
    store.saveUser(user);
    expect(store.getUserByApiKey('sk-test-abc123')).toEqual(user);
  });

  test('returns null for unknown id', () => {
    expect(store.getUserById('nonexistent')).toBeNull();
  });

  test('returns null for unknown api_key', () => {
    expect(store.getUserByApiKey('sk-unknown')).toBeNull();
  });

  test('lists all users', () => {
    store.saveUser(makeUser({ id: 'u1', email: 'a@a.com', api_key: 'key-1' }));
    store.saveUser(makeUser({ id: 'u2', email: 'b@b.com', api_key: 'key-2' }));
    expect(store.listUsers()).toHaveLength(2);
  });

  test('deletes a user', () => {
    store.saveUser(makeUser());
    store.deleteUser('user-1');
    expect(store.getUserById('user-1')).toBeNull();
  });

  // Usage tracking
  test('getDailyUsage returns zeros for new entry', () => {
    const usage = store.getDailyUsage('user-1', '2026-01-01');
    expect(usage.runs_count).toBe(0);
    expect(usage.tokens_used).toBe(0);
  });

  test('incrementRuns increases runs_count by 1', () => {
    store.incrementRuns('user-1', '2026-01-01');
    store.incrementRuns('user-1', '2026-01-01');
    expect(store.getDailyUsage('user-1', '2026-01-01').runs_count).toBe(2);
  });

  test('incrementTokens increases tokens_used', () => {
    store.incrementTokens('user-1', '2026-01-01', 1000);
    store.incrementTokens('user-1', '2026-01-01', 500);
    expect(store.getDailyUsage('user-1', '2026-01-01').tokens_used).toBe(1500);
  });

  test('usage is scoped by date — different dates are independent', () => {
    store.incrementRuns('user-1', '2026-01-01');
    store.incrementRuns('user-1', '2026-01-02');
    expect(store.getDailyUsage('user-1', '2026-01-01').runs_count).toBe(1);
    expect(store.getDailyUsage('user-1', '2026-01-02').runs_count).toBe(1);
  });

  test('usage is scoped by user — different users are independent', () => {
    store.incrementRuns('user-1', '2026-01-01');
    expect(store.getDailyUsage('user-2', '2026-01-01').runs_count).toBe(0);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
cd api && pnpm test -- --reporter=verbose tests/user-store.test.ts
```
Expected: FAIL with "Cannot find module '../src/user-store.js'"

### Step 3: Implement `UserStore`

```typescript
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
```

### Step 4: Run tests to verify they pass

```bash
cd api && pnpm test -- --reporter=verbose tests/user-store.test.ts
```
Expected: all tests PASS

### Step 5: Commit

```bash
git add api/src/user-store.ts api/tests/user-store.test.ts
git commit -m "feat(api): UserStore — SQLite per-user auth and daily usage tracking"
```

---

## Task 3: `PgUserStore` (PostgreSQL async variant)

**Files:**
- Create: `api/src/user-store-pg.ts`

No unit tests for PgUserStore (requires a live PG instance). Covered by integration contract.

### Step 1: Implement `PgUserStore`

```typescript
// api/src/user-store-pg.ts
// PgUserStore — PostgreSQL async variant of UserStore
// Same interface as UserStore but async, using the pg pool

import { createRequire } from 'node:module';
import type { User, DailyUsage } from './user-store.js';

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
       ON CONFLICT (user_id, date) DO UPDATE SET runs_count = studio_usage.runs_count + 1`,
      [userId, date]
    );
  }

  async incrementTokens(userId: string, date: string, tokens: number): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO studio_usage (user_id, date, runs_count, tokens_used)
       VALUES ($1, $2, 0, $3)
       ON CONFLICT (user_id, date) DO UPDATE SET tokens_used = studio_usage.tokens_used + EXCLUDED.tokens_used`,
      [userId, date, tokens]
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export type AnyUserStore = UserStore | PgUserStore;

// Re-export UserStore for convenience
export type { User, DailyUsage } from './user-store.js';

import type { UserStore } from './user-store.js';
```

### Step 2: Run typecheck

```bash
cd api && pnpm typecheck
```
Expected: passes with no errors

### Step 3: Commit

```bash
git add api/src/user-store-pg.ts
git commit -m "feat(api): PgUserStore — async PostgreSQL variant of UserStore"
```

---

## Task 4: Bootstrap — add `plans` config + init `UserStore` + inject into `ServerDeps`

**Files:**
- Modify: `api/src/bootstrap.ts`
- Modify: `api/src/server.ts`

### Step 1: Update `StudioApiConfig` and `BootstrapResult` in `bootstrap.ts`

In `api/src/bootstrap.ts`:

**Add import** near the top (after existing imports):
```typescript
import { resolvePlans, type PlansConfig } from './plans.js';
import { UserStore } from './user-store.js';
import { PgUserStore } from './user-store-pg.js';
```

**Update `StudioApiConfig`** — add `plans?` field:
```typescript
export interface StudioApiConfig {
  // ... existing fields ...
  plans?: Record<string, {
    runs_per_day?: number;
    max_concurrent?: number;
    max_tokens_per_run?: number;
    rate_limit_per_minute?: number;
  }>;
}
```

**Update `BootstrapResult`** — add `userStore` and `plans`:
```typescript
export interface BootstrapResult {
  // ... existing fields ...
  userStore: UserStore | PgUserStore;
  plans: PlansConfig;
}
```

**In `bootstrap()` function**, after the store is created (after the `let store: AnyRunStore` block), add:
```typescript
// UserStore — same DB as run store, same path or URL
let userStore: UserStore | PgUserStore;
if (dbType === 'postgres') {
  const url = config.db?.url;
  if (!url) throw new Error('db.url is required when db.type is postgres');
  userStore = new PgUserStore(url);
} else {
  userStore = new UserStore(dbPath);
}

const plans = resolvePlans(config.plans as Record<string, import('./plans.js').PlanLimits> | undefined);
```

**In the `cleanup` function**, add:
```typescript
if ('close' in userStore && typeof userStore.close === 'function') {
  await userStore.close();
}
```

**In the returned object**, add:
```typescript
return {
  // ... existing fields ...
  userStore,
  plans,
};
```

### Step 2: Update `ServerDeps` in `server.ts`

**Add imports** at top of `server.ts`:
```typescript
import type { UserStore } from './user-store.js';
import type { PgUserStore } from './user-store-pg.js';
import type { PlansConfig } from './plans.js';
```

**Update `ServerDeps`**:
```typescript
export interface ServerDeps {
  // ... existing fields ...
  userStore?: UserStore | PgUserStore;
  plans?: PlansConfig;
}
```

### Step 3: Update `api.ts` (the composition root) to pass new fields

Find where `buildServer(deps)` is called in `api/src/api.ts` and pass the new fields from the bootstrap result. Open `api/src/api.ts` and check how it calls `buildServer`. Pass `userStore` and `plans` from the bootstrap result.

### Step 4: Run build

```bash
cd /path/to/Studio && pnpm build
```
Expected: builds without errors

### Step 5: Commit

```bash
git add api/src/bootstrap.ts api/src/server.ts api/src/api.ts
git commit -m "feat(api): bootstrap — init UserStore and plans config, inject into ServerDeps"
```

---

## Task 5: Auth hook update — multi-user mode + request.user

**Files:**
- Modify: `api/src/server.ts`
- Modify: `api/tests/server.test.ts`

### Step 1: Write failing tests for multi-user auth

Add to `api/tests/server.test.ts`:

```typescript
import { UserStore, type User } from '../src/user-store.js';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PLANS } from '../src/plans.js';

function makeTempUserStore(): UserStore {
  const dir = resolve('/tmp', `.studio-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return new UserStore(resolve(dir, 'runs.db'));
}

const proUser: User = {
  id: 'user-pro-1',
  email: 'pro@example.com',
  plan: 'pro',
  api_key: 'sk-pro-key',
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('buildServer — multi-user auth', () => {
  it('user api_key → 200', async () => {
    const userStore = makeTempUserStore();
    userStore.saveUser(proUser);

    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: makeMockLauncher(),
      configsDir: '/tmp/.studio',
      projectName: 'test',
      apiConfig: {},
      integrationRuntime: nullIntegrationRuntime,
      integrationStore: nullIntegrationStore,
      userStore,
      plans: DEFAULT_PLANS,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { Authorization: 'Bearer sk-pro-key' },
    });
    userStore.close();
    expect(res.statusCode).not.toBe(401);
  });

  it('unknown api_key → 401 when users exist', async () => {
    const userStore = makeTempUserStore();
    userStore.saveUser(proUser);

    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: makeMockLauncher(),
      configsDir: '/tmp/.studio',
      projectName: 'test',
      apiConfig: {},
      integrationRuntime: nullIntegrationRuntime,
      integrationStore: nullIntegrationStore,
      userStore,
      plans: DEFAULT_PLANS,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { Authorization: 'Bearer sk-unknown' },
    });
    userStore.close();
    expect(res.statusCode).toBe(401);
  });

  it('legacy api.key still works when no users in DB', async () => {
    const userStore = makeTempUserStore(); // empty

    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: makeMockLauncher(),
      configsDir: '/tmp/.studio',
      projectName: 'test',
      apiConfig: { key: 'sk-legacy-key' },
      integrationRuntime: nullIntegrationRuntime,
      integrationStore: nullIntegrationStore,
      userStore,
      plans: DEFAULT_PLANS,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { Authorization: 'Bearer sk-legacy-key' },
    });
    userStore.close();
    expect(res.statusCode).not.toBe(401);
  });

  it('no users, no api.key → open (dev mode)', async () => {
    const userStore = makeTempUserStore(); // empty, no api.key

    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: makeMockLauncher(),
      configsDir: '/tmp/.studio',
      projectName: 'test',
      apiConfig: {},
      integrationRuntime: nullIntegrationRuntime,
      integrationStore: nullIntegrationStore,
      userStore,
      plans: DEFAULT_PLANS,
    });

    const res = await server.inject({ method: 'GET', url: '/api/projects' });
    userStore.close();
    expect(res.statusCode).not.toBe(401);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
cd api && pnpm test -- tests/server.test.ts
```
Expected: FAIL — auth tests fail because hook doesn't use userStore yet

### Step 3: Update auth hook in `server.ts`

Replace the existing auth hook block (the `if (deps.apiConfig.key)` block) with:

```typescript
// Fastify request type augmentation for request.user
declare module 'fastify' {
  interface FastifyRequest {
    user?: import('./user-store.js').User;
  }
}

// Determine auth mode at startup (not per-request)
// Multi-user mode: if userStore is provided; otherwise legacy single-key or open
fastify.addHook('onRequest', async (request, reply) => {
  const path = request.url.split('?')[0];
  if (path.startsWith('/api/integrations/')) return;

  const auth = request.headers['authorization'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

  // Multi-user mode: userStore present
  if (deps.userStore) {
    // Try to find user by api_key
    const user = token ? await deps.userStore.getUserByApiKey(token) : null;
    if (user) {
      request.user = user;
      return;
    }

    // Legacy fallback: if no users in DB and api.key matches, allow as anonymous unlimited
    const userCount = (await deps.userStore.listUsers()).length;
    if (userCount === 0 && deps.apiConfig.key) {
      if (token === deps.apiConfig.key) return; // open with legacy key
      await reply.status(401).send({ error: 'Unauthorized' });
      return;
    }

    // No users in DB and no api.key → dev mode (open)
    if (userCount === 0 && !deps.apiConfig.key) return;

    // Users exist but token didn't match → 401
    await reply.status(401).send({ error: 'Unauthorized' });
    return;
  }

  // Legacy single-key mode (no userStore)
  if (deps.apiConfig.key) {
    if (!auth || auth !== `Bearer ${deps.apiConfig.key}`) {
      await reply.status(401).send({ error: 'Unauthorized' });
    }
  }
  // No key, no userStore → open
});
```

**Note:** The `listUsers()` call in the hook is synchronous for SQLite (`UserStore`) and async for `PgUserStore`. Since both are supported, and `listUsers()` could be async, we need to handle this. A simpler approach: cache the user count at startup. OR, skip the listUsers call — instead use a boolean `hasUsers` computed in bootstrap.

**Simpler version** — add `hasUsers` to `ServerDeps`:

In `ServerDeps`:
```typescript
/** true if the userStore has at least one user — computed at bootstrap time */
hasUsers?: boolean;
```

In bootstrap, after creating userStore:
```typescript
const userList = await (userStore as UserStore).listUsers?.() ?? [];
const hasUsers = userList.length > 0;
```

And update the hook to use `deps.hasUsers` instead of calling `listUsers()`.

Update the tests to pass `hasUsers: false` for empty store tests and `hasUsers: true` for multi-user tests.

### Step 4: Run tests to verify they pass

```bash
cd api && pnpm test -- tests/server.test.ts
```
Expected: all auth tests PASS

### Step 5: Commit

```bash
git add api/src/server.ts api/tests/server.test.ts
git commit -m "feat(api): auth hook — multi-user mode with per-user API keys + legacy fallback"
```

---

## Task 6: Rate limiting with `@fastify/rate-limit`

**Files:**
- Modify: `api/package.json`
- Modify: `api/src/server.ts`

### Step 1: Install `@fastify/rate-limit`

```bash
cd api && pnpm add @fastify/rate-limit
```

### Step 2: Add rate limiting to `server.ts`

Add import:
```typescript
import rateLimit from '@fastify/rate-limit';
import { getPlanLimits, DEFAULT_PLANS } from './plans.js';
```

After the CORS registration (before swagger), add:
```typescript
void fastify.register(rateLimit, {
  global: true,
  max: (req) => {
    const planName = req.user?.plan ?? 'free';
    const plans = deps.plans ?? DEFAULT_PLANS;
    return getPlanLimits(plans, planName).rate_limit_per_minute;
  },
  timeWindow: '1 minute',
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anonymous',
  addHeaders: {
    'x-ratelimit-limit': true,
    'x-ratelimit-remaining': true,
    'x-ratelimit-reset': true,
  },
  // Don't apply to integration webhook routes (they have own auth)
  skipOnError: false,
});
```

### Step 3: Run existing tests to verify no regression

```bash
cd api && pnpm test
```
Expected: all tests PASS (rate limiter won't fire in tests since counts are < limits)

### Step 4: Commit

```bash
git add api/package.json api/src/server.ts
git commit -m "feat(api): rate limiting per user plan via @fastify/rate-limit"
```

---

## Task 7: Quota enforcement in `InProcessLauncher`

**Files:**
- Modify: `api/src/launcher.ts`
- Modify: `api/tests/launcher.test.ts`

### Step 1: Write failing tests for quota enforcement

Add to `api/tests/launcher.test.ts`:

```typescript
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { UserStore } from '../src/user-store.js';
import type { PlansConfig } from '../src/plans.js';

function makeTempUserStore(): UserStore {
  const dir = resolve('/tmp', `.studio-launcher-quota-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return new UserStore(resolve(dir, 'runs.db'));
}

const strictPlan: PlansConfig = {
  strict: { runs_per_day: 2, max_concurrent: 1, max_tokens_per_run: 1000, rate_limit_per_minute: 10 },
};

describe('InProcessLauncher — quota enforcement', () => {
  it('increments runs_count when a run is launched with userId', async () => {
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    const userStore = makeTempUserStore();
    const { factory } = makeMockFactory();
    factory.mockImplementation(() => ({
      run: vi.fn().mockResolvedValue({ id: 'r1', pipeline_name: 'p', status: 'success', started_at: '', stages: [] }),
    }));

    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory, userStore, strictPlan);
    await launcher.launch({ runId: 'r1', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR, userId: 'user-1' });

    const today = new Date().toISOString().slice(0, 10);
    expect(userStore.getDailyUsage('user-1', today).runs_count).toBe(1);
    userStore.close();
  });

  it('throws QuotaExceededError when daily limit is reached', async () => {
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    const userStore = makeTempUserStore();
    const { factory } = makeMockFactory();
    factory.mockImplementation(() => ({
      run: vi.fn().mockResolvedValue({ id: 'r1', pipeline_name: 'p', status: 'success', started_at: '', stages: [] }),
    }));

    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory, userStore, strictPlan);

    // Launch 2 runs to hit the limit
    await launcher.launch({ runId: 'r1', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR, userId: 'user-1' });
    await launcher.launch({ runId: 'r2', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR, userId: 'user-1' });

    // 3rd run should throw
    await expect(
      launcher.launch({ runId: 'r3', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR, userId: 'user-1' })
    ).rejects.toThrow('Daily run limit exceeded');

    userStore.close();
  });

  it('does not enforce quota when no userId provided', async () => {
    const store = new InMemoryRunStore();
    const bus = new RunEventBus();
    const userStore = makeTempUserStore();
    const { factory } = makeMockFactory();
    factory.mockImplementation(() => ({
      run: vi.fn().mockResolvedValue({ id: 'r1', pipeline_name: 'p', status: 'success', started_at: '', stages: [] }),
    }));

    const launcher = new InProcessLauncher(stubConfig, store, TMP_RUNS_DIR, bus, factory, userStore, strictPlan);

    // Should not throw even at limit when no userId
    await launcher.launch({ runId: 'r1', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR });
    await launcher.launch({ runId: 'r2', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR });
    await expect(
      launcher.launch({ runId: 'r3', pipeline: 'p', input: {}, configsDir: TMP_RUNS_DIR })
    ).resolves.toBeDefined();

    userStore.close();
  });
});
```

### Step 2: Run tests to verify they fail

```bash
cd api && pnpm test -- tests/launcher.test.ts
```
Expected: FAIL — "userId is not a valid property" or similar

### Step 3: Update `LaunchConfig` and `InProcessLauncher`

In `api/src/launcher.ts`:

**Add imports**:
```typescript
import type { UserStore } from './user-store.js';
import type { PgUserStore } from './user-store-pg.js';
import type { PlansConfig } from './plans.js';
import { getPlanLimits, DEFAULT_PLANS } from './plans.js';
```

**Update `LaunchConfig`** — add `userId?`:
```typescript
export interface LaunchConfig {
  // ... existing fields ...
  userId?: string;
}
```

**Update `InProcessLauncher` constructor** — add optional `userStore` and `plans`:
```typescript
export class InProcessLauncher implements RunLauncher {
  private active = new Map<string, AbortController>();
  private activePerUser = new Map<string, Set<string>>(); // userId → Set<runId>

  constructor(
    private engineConfig: EngineConfig,
    private store: AnyRunStore,
    private runsDir: string,
    private bus: RunEventBus,
    private engineFactory: EngineFactory = (cfg, evts) => new PipelineEngine(cfg, evts),
    private userStore?: UserStore | PgUserStore,
    private plans: PlansConfig = DEFAULT_PLANS,
  ) {}
```

**Update `launch()` method** — add quota check at the top, before creating the engine:

```typescript
async launch(config: LaunchConfig): Promise<{ run_id: string }> {
  const { runId, pipeline, input, meta, parentRunId, userId } = config;

  // Quota enforcement (only if userId provided and userStore available)
  if (userId && this.userStore) {
    const user = await this.userStore.getUserById(userId);
    if (user) {
      const today = new Date().toISOString().slice(0, 10);
      const limits = getPlanLimits(this.plans, user.plan);

      // Check runs_per_day
      if (limits.runs_per_day !== -1) {
        const usage = await this.userStore.getDailyUsage(userId, today);
        if (usage.runs_count >= limits.runs_per_day) {
          throw Object.assign(
            new Error('Daily run limit exceeded'),
            { code: 'QUOTA_EXCEEDED', limit: limits.runs_per_day, used: usage.runs_count }
          );
        }
      }

      // Check max_concurrent
      const activeForUser = this.activePerUser.get(userId)?.size ?? 0;
      if (activeForUser >= limits.max_concurrent) {
        throw Object.assign(
          new Error('Concurrent run limit exceeded'),
          { code: 'QUOTA_EXCEEDED', limit: limits.max_concurrent, used: activeForUser }
        );
      }

      // Increment runs_count
      await this.userStore.incrementRuns(userId, today);
    }
  }

  // Track active run for user
  if (userId) {
    if (!this.activePerUser.has(userId)) this.activePerUser.set(userId, new Set());
    this.activePerUser.get(userId)!.add(runId);
  }

  const controller = new AbortController();
  this.active.set(runId, controller);
  // ... rest of existing launch code ...
```

**In the `.finally()` block** of the engine run, clean up `activePerUser`:
```typescript
.finally(() => {
  this.active.delete(runId);
  if (userId) {
    this.activePerUser.get(userId)?.delete(runId);
  }
});
```

### Step 4: Update POST /api/runs to pass userId

In `api/src/routes/runs.ts`, in the handler for `POST /api/runs`, update the `launcher.launch()` call:
```typescript
const { run_id } = await launcher.launch({
  runId,
  pipeline,
  input,
  configsDir: options.deps.configsDir,
  repoPath,
  providerOverride: provider,
  depth,
  parentRunId,
  userId: request.user?.id,  // ← add this
});
```

### Step 5: Handle quota error in runs route

In the `POST /api/runs` handler, wrap the launch call in a try/catch:
```typescript
try {
  const { run_id } = await launcher.launch({ ... });
  return reply.status(201).send({ run_id, ... });
} catch (err) {
  if (err instanceof Error && (err as NodeJS.ErrnoException & { code?: string }).code === 'QUOTA_EXCEEDED') {
    return reply.status(429).send({ error: err.message });
  }
  return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
}
```

Add `429` to the route response schema:
```typescript
response: {
  201: { ... },
  400: errorSchema,
  429: errorSchema,  // ← add
},
```

### Step 6: Run tests to verify they pass

```bash
cd api && pnpm test -- tests/launcher.test.ts
```
Expected: all quota tests PASS

### Step 7: Run full test suite

```bash
cd /path/to/Studio && pnpm test
```
Expected: all tests PASS

### Step 8: Commit

```bash
git add api/src/launcher.ts api/src/routes/runs.ts api/tests/launcher.test.ts
git commit -m "feat(api): quota enforcement in InProcessLauncher — runs_per_day and max_concurrent"
```

---

## Task 8: REST routes `/api/users`

**Files:**
- Create: `api/src/routes/users.ts`
- Create: `api/tests/users.test.ts`
- Modify: `api/src/server.ts`

### Step 1: Write failing tests

```typescript
// api/tests/users.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';
import type { RunLauncher } from '../src/launcher.js';
import type { IntegrationRuntime } from '../src/integration-runtime.js';
import type { IntegrationStore } from '../src/integration-store.js';
import { UserStore } from '../src/user-store.js';
import { DEFAULT_PLANS } from '../src/plans.js';

function makeMockLauncher(): RunLauncher {
  return { launch: async () => ({ run_id: 'mock-run-id' }), cancel: async () => {} };
}
const nullIntegrationRuntime = { registerRoutes: () => {} } as unknown as IntegrationRuntime;
const nullIntegrationStore = {} as unknown as IntegrationStore;

function makeTempUserStore() {
  const dir = resolve('/tmp', `.studio-users-route-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return new UserStore(resolve(dir, 'runs.db'));
}

function buildTestServer(userStore: UserStore, apiKey?: string) {
  return buildServer({
    store: new InMemoryRunStore(),
    launcher: makeMockLauncher(),
    configsDir: '/tmp/.studio',
    projectName: 'test',
    apiConfig: apiKey ? { key: apiKey } : {},
    integrationRuntime: nullIntegrationRuntime,
    integrationStore: nullIntegrationStore,
    userStore,
    plans: DEFAULT_PLANS,
    hasUsers: userStore.listUsers().length > 0,
  });
}

describe('POST /api/users', () => {
  let userStore: UserStore;

  beforeEach(() => { userStore = makeTempUserStore(); });
  afterEach(() => { userStore.close(); });

  it('creates a user and returns api_key', async () => {
    const server = buildTestServer(userStore, 'admin-key');
    const res = await server.inject({
      method: 'POST',
      url: '/api/users',
      headers: { Authorization: 'Bearer admin-key' },
      payload: { email: 'alice@example.com', plan: 'pro' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.email).toBe('alice@example.com');
    expect(body.plan).toBe('pro');
    expect(body.api_key).toBeTruthy();
    expect(body.id).toBeTruthy();
  });

  it('rejects duplicate email with 409', async () => {
    const server = buildTestServer(userStore, 'admin-key');
    await server.inject({
      method: 'POST',
      url: '/api/users',
      headers: { Authorization: 'Bearer admin-key' },
      payload: { email: 'alice@example.com' },
    });
    const res = await server.inject({
      method: 'POST',
      url: '/api/users',
      headers: { Authorization: 'Bearer admin-key' },
      payload: { email: 'alice@example.com' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('GET /api/users/me', () => {
  let userStore: UserStore;

  beforeEach(() => { userStore = makeTempUserStore(); });
  afterEach(() => { userStore.close(); });

  it('returns current user info', async () => {
    userStore.saveUser({ id: 'u1', email: 'me@example.com', plan: 'pro', api_key: 'my-key', created_at: '2026-01-01T00:00:00.000Z' });
    const server = buildTestServer(userStore);
    const res = await server.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { Authorization: 'Bearer my-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('me@example.com');
  });

  it('returns 401 when not authenticated', async () => {
    userStore.saveUser({ id: 'u1', email: 'me@example.com', plan: 'pro', api_key: 'my-key', created_at: '2026-01-01T00:00:00.000Z' });
    const server = buildTestServer(userStore);
    const res = await server.inject({ method: 'GET', url: '/api/users/me' });
    expect(res.statusCode).toBe(401);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
cd api && pnpm test -- tests/users.test.ts
```
Expected: FAIL with "route not registered"

### Step 3: Implement `users.ts` routes

```typescript
// api/src/routes/users.ts
import { randomUUID } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };

const userSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    plan: { type: 'string' },
    created_at: { type: 'string' },
  },
};

const userWithKeySchema = {
  ...userSchema,
  properties: { ...userSchema.properties, api_key: { type: 'string' } },
};

export async function usersRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps },
): Promise<void> {
  const { userStore, plans } = options.deps;
  if (!userStore) return; // no-op if userStore not configured

  // POST /api/users — create a user (admin: unlimited plan or legacy key user)
  fastify.post<{ Body: { email: string; plan?: string } }>('/users', {
    schema: {
      tags: ['users'],
      summary: 'Create a new user',
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
          plan: { type: 'string', default: 'free' },
        },
      },
      response: {
        201: userWithKeySchema,
        400: errorSchema,
        409: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { email, plan = 'free' } = request.body;

    const existing = await userStore.listUsers();
    if (existing.some((u) => u.email === email)) {
      return reply.status(409).send({ error: `User with email ${email} already exists` });
    }

    const apiKey = randomBytes(32).toString('hex');
    const user = {
      id: randomUUID(),
      email,
      plan,
      api_key: apiKey,
      created_at: new Date().toISOString(),
    };

    await userStore.saveUser(user);
    return reply.status(201).send(user);
  });

  // GET /api/users — list users (admin)
  fastify.get('/users', {
    schema: {
      tags: ['users'],
      summary: 'List all users',
      response: {
        200: { type: 'array', items: userSchema },
      },
    },
  }, async (_request, reply) => {
    const users = await userStore.listUsers();
    // Never expose api_key in list
    return reply.send(users.map(({ api_key: _k, ...u }) => u));
  });

  // GET /api/users/me — current user
  fastify.get('/users/me', {
    schema: {
      tags: ['users'],
      summary: 'Get current authenticated user',
      response: {
        200: {
          type: 'object',
          properties: {
            ...userSchema.properties,
            today_usage: {
              type: 'object',
              properties: {
                runs_count: { type: 'number' },
                tokens_used: { type: 'number' },
              },
            },
          },
        },
        401: errorSchema,
      },
    },
  }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    const today = new Date().toISOString().slice(0, 10);
    const usage = await userStore.getDailyUsage(request.user.id, today);
    const { api_key: _k, ...userWithoutKey } = request.user;

    return reply.send({
      ...userWithoutKey,
      today_usage: { runs_count: usage.runs_count, tokens_used: usage.tokens_used },
    });
  });

  // GET /api/users/:id — user detail + usage
  fastify.get<{ Params: { id: string } }>('/users/:id', {
    schema: {
      tags: ['users'],
      summary: 'Get a user by ID',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: {
        200: {
          type: 'object',
          properties: {
            ...userSchema.properties,
            today_usage: {
              type: 'object',
              properties: {
                runs_count: { type: 'number' },
                tokens_used: { type: 'number' },
              },
            },
          },
        },
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const user = await userStore.getUserById(request.params.id);
    if (!user) return reply.status(404).send({ error: 'User not found' });

    const today = new Date().toISOString().slice(0, 10);
    const usage = await userStore.getDailyUsage(user.id, today);
    const { api_key: _k, ...userWithoutKey } = user;

    return reply.send({
      ...userWithoutKey,
      today_usage: { runs_count: usage.runs_count, tokens_used: usage.tokens_used },
    });
  });

  // DELETE /api/users/:id
  fastify.delete<{ Params: { id: string } }>('/users/:id', {
    schema: {
      tags: ['users'],
      summary: 'Delete a user',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: {
        204: { type: 'null', description: 'No content' },
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const user = await userStore.getUserById(request.params.id);
    if (!user) return reply.status(404).send({ error: 'User not found' });

    await userStore.deleteUser(request.params.id);
    return reply.status(204).send();
  });
}
```

### Step 4: Register routes in `server.ts`

Add import:
```typescript
import { usersRoutes } from './routes/users.js';
```

Add registration after other routes:
```typescript
void fastify.register(usersRoutes, { prefix: '/api', deps });
```

### Step 5: Run tests to verify they pass

```bash
cd api && pnpm test -- tests/users.test.ts
```
Expected: all tests PASS

### Step 6: Run full test suite

```bash
cd /path/to/Studio && pnpm test
```
Expected: all tests PASS

### Step 7: Commit

```bash
git add api/src/routes/users.ts api/src/server.ts api/tests/users.test.ts
git commit -m "feat(api): REST routes /api/users — CRUD + GET /users/me with daily usage"
```

---

## Task 9: CLI command `studio users`

**Files:**
- Create: `cli/src/commands/users.ts`
- Modify: `cli/src/index.ts`

### Step 1: Implement `cli/src/commands/users.ts`

```typescript
// cli/src/commands/users.ts
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { findStudioDir } from '../studio-dir.js';
import { UserStore } from '@studio/api/user-store';

// Note: import UserStore directly from the api package.
// This requires @studio/api to export user-store from its exports map.
// See "update exports" step below.

async function getStore(): Promise<{ store: UserStore; close: () => void }> {
  const studioDir = await findStudioDir(process.cwd());
  if (!studioDir) throw new Error('No .studio/ directory found. Run studio init first.');

  const dbPath = join(studioDir, 'runs', 'runs.db');
  mkdirSync(join(studioDir, 'runs'), { recursive: true });
  const store = new UserStore(dbPath);
  return { store, close: () => store.close() };
}

export async function usersCommand(
  subcommand: string,
  args: string[],
  options: { plan?: string },
): Promise<void> {
  switch (subcommand) {
    case 'list': {
      const { store, close } = await getStore();
      try {
        const users = store.listUsers();
        if (users.length === 0) {
          console.log(chalk.gray('No users found.'));
        } else {
          console.log(chalk.bold('Users:'));
          for (const u of users) {
            console.log(`  ${chalk.cyan(u.email)} — plan: ${chalk.yellow(u.plan)} — id: ${chalk.gray(u.id)}`);
          }
        }
      } finally {
        close();
      }
      break;
    }

    case 'add': {
      const email = args[0];
      if (!email) {
        console.error(chalk.red('Usage: studio users add <email> [--plan pro]'));
        process.exit(1);
      }
      const { store, close } = await getStore();
      try {
        const existing = store.listUsers();
        if (existing.some((u) => u.email === email)) {
          console.error(chalk.red(`User ${email} already exists.`));
          process.exit(1);
        }
        const apiKey = randomBytes(32).toString('hex');
        const user = {
          id: randomUUID(),
          email,
          plan: options.plan ?? 'free',
          api_key: apiKey,
          created_at: new Date().toISOString(),
        };
        store.saveUser(user);
        console.log(chalk.green(`✓ User created: ${email} (plan: ${user.plan})`));
        console.log(chalk.bold('API Key (shown only once):'));
        console.log(chalk.yellow(apiKey));
      } finally {
        close();
      }
      break;
    }

    case 'remove': {
      const email = args[0];
      if (!email) {
        console.error(chalk.red('Usage: studio users remove <email>'));
        process.exit(1);
      }
      const { store, close } = await getStore();
      try {
        const users = store.listUsers();
        const user = users.find((u) => u.email === email);
        if (!user) {
          console.error(chalk.red(`User ${email} not found.`));
          process.exit(1);
        }
        store.deleteUser(user.id);
        console.log(chalk.green(`✓ User ${email} deleted.`));
      } finally {
        close();
      }
      break;
    }

    case 'info': {
      const email = args[0];
      if (!email) {
        console.error(chalk.red('Usage: studio users info <email>'));
        process.exit(1);
      }
      const { store, close } = await getStore();
      try {
        const users = store.listUsers();
        const user = users.find((u) => u.email === email);
        if (!user) {
          console.error(chalk.red(`User ${email} not found.`));
          process.exit(1);
        }
        const today = new Date().toISOString().slice(0, 10);
        const usage = store.getDailyUsage(user.id, today);
        console.log(chalk.bold(`User: ${user.email}`));
        console.log(`  Plan:       ${chalk.yellow(user.plan)}`);
        console.log(`  ID:         ${chalk.gray(user.id)}`);
        console.log(`  Created:    ${user.created_at}`);
        console.log(chalk.bold(`Today (${today}):`));
        console.log(`  Runs:       ${usage.runs_count}`);
        console.log(`  Tokens:     ${usage.tokens_used}`);
      } finally {
        close();
      }
      break;
    }

    default:
      console.error(chalk.red(`Unknown subcommand: ${subcommand}`));
      console.error('Usage: studio users <list|add|remove|info>');
      process.exit(1);
  }
}
```

### Step 2: Update `@studio/api` exports map to expose `user-store`

In `api/package.json`, add to `exports`:
```json
"./user-store": {
  "import": "./dist/user-store.js",
  "types": "./dist/user-store.d.ts"
}
```

### Step 3: Register the command in `cli/src/index.ts`

Add import:
```typescript
import { usersCommand } from './commands/users.js';
```

Add command registration (after the existing commands):
```typescript
const usersCmd = program.command('users').description('Manage users');

usersCmd
  .command('list')
  .description('List all users')
  .action(() => usersCommand('list', [], {}));

usersCmd
  .command('add <email>')
  .description('Create a new user')
  .option('--plan <plan>', 'User plan (free|pro|unlimited)', 'free')
  .action((email: string, opts: { plan?: string }) => usersCommand('add', [email], opts));

usersCmd
  .command('remove <email>')
  .description('Remove a user')
  .action((email: string) => usersCommand('remove', [email], {}));

usersCmd
  .command('info <email>')
  .description('Show user details and today usage')
  .action((email: string) => usersCommand('info', [email], {}));
```

### Step 4: Build the full monorepo

```bash
cd /path/to/Studio && pnpm build
```
Expected: builds without errors

### Step 5: Manual smoke test

In a project with `.studio/`:
```bash
studio users list                       # → No users found.
studio users add test@example.com --plan pro   # → ✓ User created + API key
studio users list                       # → test@example.com (plan: pro)
studio users info test@example.com      # → details + today usage
studio users remove test@example.com    # → ✓ deleted
```

### Step 6: Run full test suite

```bash
cd /path/to/Studio && pnpm test
```
Expected: all tests PASS

### Step 7: Commit

```bash
git add cli/src/commands/users.ts cli/src/index.ts api/package.json
git commit -m "feat(cli): studio users — list/add/remove/info subcommands"
```

---

## Final Steps

### Build verification

```bash
pnpm build
```
Expected: PASS

### Full test suite

```bash
pnpm test
```
Expected: all packages PASS

### Final commit message template

```bash
git commit -m "feat(api,cli): STU-26 auth multi-user — per-user API keys, quotas, rate limiting

- UserStore (SQLite) + PgUserStore (PostgreSQL) in @studio/api
- Per-user API keys replacing global api.key (backward compatible)
- Quota enforcement: runs_per_day and max_concurrent per plan
- Rate limiting via @fastify/rate-limit keyed on user.id
- REST routes: POST/GET /api/users, GET /api/users/me, DELETE /api/users/:id
- CLI: studio users list/add/remove/info
- Plans config in config.yaml (free/pro/unlimited defaults)
"
```

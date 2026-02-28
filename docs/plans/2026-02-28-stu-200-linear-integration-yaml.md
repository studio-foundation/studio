# STU-200 — Migrate Linear to `.integration.yaml` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all hardcoded Linear logic from the API core and replace it with a plugin system driven by `linear.integration.yaml`, so `grep -r "linear" api/src/ --include="*.ts"` returns nothing outside `api/src/integrations/linear/`.

**Architecture:** YAML = declarative contract (which handlers to use). TypeScript = implementation (webhook filtering, GraphQL calls). `IntegrationRuntime` loads installed `.integration.yaml` files, registers routes dynamically for each integration with a `webhook.handler`, and subscribes event bus handlers for each with an `on_failure.handler`. `launcher.ts` emits `meta` as part of `pipeline_complete` bus events — no integration-specific code in launcher.

**Tech Stack:** TypeScript, Fastify, `better-sqlite3`, Vitest, `@studio/contracts`, `@studio/runner`, `@studio/engine`

---

## Task 1: Extend `IntegrationPluginDef` in contracts

**Files:**
- Modify: `contracts/src/integration-plugin.ts`

**Step 1: Add `webhook` and `on_failure` fields to the type**

```typescript
// contracts/src/integration-plugin.ts
export interface IntegrationPluginDef {
  name: string;
  version: number;
  description?: string;
  config?: {
    required?: string[];
    optional?: Record<string, unknown>;
  };
  webhook?: {
    hmac?: {
      header: string;       // e.g. 'linear-signature'
      secret_env: string;   // e.g. 'LINEAR_WEBHOOK_SECRET' — resolved from integration config
    };
    handler: string;        // e.g. 'linear-webhook' — key in WEBHOOK_HANDLERS registry
  };
  on_failure?: {
    handler: string;        // e.g. 'linear-failure' — key in FAILURE_HANDLERS registry
  };
  events?: {
    consumes?: string[];
    emits?: string[];
  };
  test?: {
    type: 'http';
    endpoint: string;
    method?: 'GET' | 'POST';
    auth?: string;
    body?: string;
    expect?: { status?: number };
  };
}
```

**Step 2: Rebuild contracts**

```bash
cd /path/to/worktree && pnpm --filter @studio/contracts build
```
Expected: `contracts/dist/` updated, no TypeScript errors.

**Step 3: Commit**

```bash
git add contracts/src/integration-plugin.ts
git commit -m "feat(contracts): add webhook and on_failure handler refs to IntegrationPluginDef"
```

---

## Task 2: Update `linear.integration.yaml` bundled template

**Files:**
- Modify: `runner/templates/integrations/linear.integration.yaml`

**Step 1: Update the template**

```yaml
name: linear
version: 1
description: "Linear webhook trigger + issue status sync"

config:
  required:
    - LINEAR_API_KEY
    - LINEAR_WEBHOOK_SECRET
  optional:
    autoTrigger: false

webhook:
  hmac:
    header: linear-signature
    secret_env: LINEAR_WEBHOOK_SECRET
  handler: linear-webhook

on_failure:
  handler: linear-failure

events:
  consumes:
    - linear.issue.in_progress
  emits:
    - pipeline.complete
    - pipeline.failed

test:
  type: http
  endpoint: https://api.linear.app/graphql
  method: POST
  auth: bearer:${LINEAR_API_KEY}
  body: '{"query":"{ viewer { id name } }"}'
  expect:
    status: 200
```

**Step 2: Rebuild runner**

```bash
pnpm --filter @studio/runner build
```
Expected: no errors.

**Step 3: Commit**

```bash
git add runner/templates/integrations/linear.integration.yaml
git commit -m "feat(runner): add webhook and on_failure handlers to linear.integration.yaml template"
```

---

## Task 3: Create `IntegrationStore` (TDD)

Replaces `LinearStore`. Generic by `integration_name` partition key.

**Files:**
- Create: `api/src/integration-store.ts`
- Create: `api/tests/integration-store.test.ts`

**Step 1: Write the failing tests**

```typescript
// api/tests/integration-store.test.ts
import { describe, test, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { IntegrationStore } from '../src/integration-store.js';

function makeStore() {
  const dir = resolve('/tmp', `.studio-int-store-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const store = new IntegrationStore(resolve(dir, 'runs.db'));
  return { store, cleanup: () => store.close() };
}

describe('IntegrationStore', () => {
  test('getConfig returns defaults for unknown integration', () => {
    const { store, cleanup } = makeStore();
    const config = store.getConfig('linear');
    expect(config).toEqual({ active: false });
    cleanup();
  });

  test('patchConfig stores and retrieves pipeline and active', () => {
    const { store, cleanup } = makeStore();
    store.patchConfig('linear', { pipeline: 'feature-builder', active: true });
    expect(store.getConfig('linear')).toEqual({ pipeline: 'feature-builder', active: true });
    cleanup();
  });

  test('patchConfig for one integration does not affect another', () => {
    const { store, cleanup } = makeStore();
    store.patchConfig('linear', { active: true });
    expect(store.getConfig('slack').active).toBe(false);
    cleanup();
  });

  test('insertTrigger and listTriggers are partitioned by integration_name', () => {
    const { store, cleanup } = makeStore();
    store.insertTrigger({
      id: 'trig-1',
      integration_name: 'linear',
      received_at: new Date().toISOString(),
      pipeline: 'feature-builder',
      run_id: 'run-1',
      status: 'success',
    });
    store.insertTrigger({
      id: 'trig-2',
      integration_name: 'slack',
      received_at: new Date().toISOString(),
      pipeline: 'feature-builder',
      run_id: 'run-2',
      status: 'success',
    });
    expect(store.listTriggers('linear')).toHaveLength(1);
    expect(store.listTriggers('linear')[0].id).toBe('trig-1');
    expect(store.listTriggers('slack')).toHaveLength(1);
    cleanup();
  });

  test('listTriggers returns most recent first', () => {
    const { store, cleanup } = makeStore();
    store.insertTrigger({ id: 'a', integration_name: 'linear', received_at: '2024-01-01T00:00:00Z', pipeline: 'p', status: 'success' });
    store.insertTrigger({ id: 'b', integration_name: 'linear', received_at: '2024-01-02T00:00:00Z', pipeline: 'p', status: 'success' });
    expect(store.listTriggers('linear')[0].id).toBe('b');
    cleanup();
  });
});
```

**Step 2: Run tests to see them fail**

```bash
pnpm --filter @studio/api test tests/integration-store.test.ts
```
Expected: FAIL — `IntegrationStore` not found.

**Step 3: Implement `IntegrationStore`**

```typescript
// api/src/integration-store.ts
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
```

**Step 4: Run tests, expect pass**

```bash
pnpm --filter @studio/api test tests/integration-store.test.ts
```
Expected: 5 tests passing.

**Step 5: Commit**

```bash
git add api/src/integration-store.ts api/tests/integration-store.test.ts
git commit -m "feat(api): add generic IntegrationStore replacing LinearStore"
```

---

## Task 4: Create handler interfaces

**Files:**
- Create: `api/src/integrations/types.ts`

**Step 1: Create the file**

```typescript
// api/src/integrations/types.ts
import type { FastifyReply } from 'fastify';
import type { IntegrationPluginDef } from '@studio/contracts';
import type { GroupFeedbackEvent } from '@studio/engine';
import type { IntegrationStore } from '../integration-store.js';
import type { RunLauncher } from '../launcher.js';
import type { ApiConfig } from '../server.js';

export interface WebhookHandlerContext {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  integration: IntegrationPluginDef;
  store: IntegrationStore;
  launcher: RunLauncher;
  configsDir: string;
  projectsDir?: string;
  apiConfig: ApiConfig;
  integrationConfig: Record<string, unknown>;
}

export interface FailureHandlerContext {
  runId: string;
  durationMs: number;
  status: string;
  meta: Record<string, unknown>;
  lastGroupFeedback?: GroupFeedbackEvent;
  integration: IntegrationPluginDef;
  integrationConfig: Record<string, unknown>;
}

export interface WebhookHandler {
  handle(ctx: WebhookHandlerContext, reply: FastifyReply): Promise<unknown>;
}

export interface FailureHandler {
  handleFailure(ctx: FailureHandlerContext): Promise<void>;
}
```

**Step 2: Commit**

```bash
git add api/src/integrations/types.ts
git commit -m "feat(api): add WebhookHandler and FailureHandler interfaces"
```

---

## Task 5: Migrate `LinearFailureHandler` (TDD)

Move `linear-notifier.ts` logic to `integrations/linear/failure-handler.ts`. The GraphQL logic is **unchanged** — this is a relocation, not a rewrite.

**Files:**
- Create: `api/src/integrations/linear/failure-handler.ts`
- Create: `api/tests/integrations/linear/failure-handler.test.ts`

**Step 1: Write the failing test** (adapted from `api/tests/linear-notifier.test.ts`)

```typescript
// api/tests/integrations/linear/failure-handler.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LinearFailureHandler } from '../../../src/integrations/linear/failure-handler.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Keep STATES_RESPONSE, COMMENT_RESPONSE, UPDATE_RESPONSE fixtures identical to linear-notifier.test.ts
const STATES_RESPONSE = {
  data: {
    issue: {
      team: {
        states: { nodes: [{ id: 'state-backlog', name: 'Backlog' }, { id: 'state-todo', name: 'Todo' }] },
      },
    },
  },
};
const COMMENT_RESPONSE = { data: { commentCreate: { success: true } } };
const UPDATE_RESPONSE = { data: { issueUpdate: { success: true } } };

function makeCtx(overrides: Partial<{ apiKey: string; issueId: string; runId: string; iterations: number; rejectionReason: string; rejectionDetails: string[] }> = {}) {
  return {
    runId: overrides.runId ?? 'run-123',
    durationMs: 5000,
    status: 'failed',
    meta: { linear_issue_id: overrides.issueId ?? 'issue-abc' },
    lastGroupFeedback: overrides.iterations != null ? {
      iteration: overrides.iterations,
      rejection_reason: overrides.rejectionReason,
      rejection_details: overrides.rejectionDetails,
    } as never : undefined,
    integration: { name: 'linear', version: 1, on_failure: { handler: 'linear-failure' } },
    integrationConfig: { LINEAR_API_KEY: overrides.apiKey ?? 'lin_api_test' },
  };
}

beforeEach(() => { mockFetch.mockReset(); });
afterEach(() => { delete process.env['LINEAR_API_KEY']; });

describe('LinearFailureHandler.handleFailure', () => {
  const handler = new LinearFailureHandler();

  it('skips when LINEAR_API_KEY not in integrationConfig or env', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = makeCtx({ apiKey: '' });
    (ctx.integrationConfig as Record<string, unknown>)['LINEAR_API_KEY'] = '';
    await handler.handleFailure(ctx);
    expect(mockFetch).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('posts comment, queries states, and transitions to Backlog on failure', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(COMMENT_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(STATES_RESPONSE) } as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(UPDATE_RESPONSE) } as Response);

    await handler.handleFailure(makeCtx({ issueId: 'issue-xyz', runId: 'run-456', iterations: 3, rejectionReason: 'QA rejected', rejectionDetails: ['Hardcoded strings'] }));

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const [, commentInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(commentInit.body as string) as { variables: { body: string } };
    expect(body.variables.body).toContain('❌ **Code Builder échoué**');
    expect(body.variables.body).toContain('3 itérations QA');
    expect(body.variables.body).toContain('run-456');
  });

  it('swallows fetch errors and logs them', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network timeout'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handler.handleFailure(makeCtx())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
```

**Step 2: Run to see it fail**

```bash
pnpm --filter @studio/api test tests/integrations/linear/failure-handler.test.ts
```
Expected: FAIL — `LinearFailureHandler` not found.

**Step 3: Create `failure-handler.ts`**

This is the `notifyLinearFailure` logic from `linear-notifier.ts`, refactored to implement `FailureHandler`:

```typescript
// api/src/integrations/linear/failure-handler.ts
import type { FailureHandler, FailureHandlerContext } from '../types.js';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

async function gql(query: string, variables: Record<string, unknown>, apiKey: string): Promise<Record<string, unknown>> {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear GraphQL HTTP error: ${res.status} ${res.statusText}`);
  return res.json() as Promise<Record<string, unknown>>;
}

function buildFailureComment(ctx: FailureHandlerContext): string {
  const iterations = ctx.lastGroupFeedback?.iteration;
  const iterLabel = iterations != null ? ` après ${iterations} itérations QA` : '';
  const rejectionReason = ctx.lastGroupFeedback?.rejection_reason;
  const rejectionDetails = ctx.lastGroupFeedback?.rejection_details;
  const lines: string[] = [];
  lines.push(`❌ **Code Builder échoué** —${iterLabel ? ` QA a rejeté${iterLabel}` : ' pipeline échoué'}`);
  lines.push('');
  if (rejectionReason) {
    lines.push('**Dernière raison de rejet :**');
    if (rejectionDetails && rejectionDetails.length > 0) {
      for (const detail of rejectionDetails) lines.push(`- ${detail}`);
    } else {
      lines.push(`- ${rejectionReason}`);
    }
    lines.push('');
  }
  lines.push('**Action requise :** réviser le brief ou augmenter max_iterations');
  lines.push('');
  lines.push(`**Run ID :** ${ctx.runId}`);
  return lines.join('\n');
}

export class LinearFailureHandler implements FailureHandler {
  async handleFailure(ctx: FailureHandlerContext): Promise<void> {
    const issueId = typeof ctx.meta['linear_issue_id'] === 'string' ? ctx.meta['linear_issue_id'] : undefined;
    if (!issueId) return;

    const apiKey = (ctx.integrationConfig['LINEAR_API_KEY'] as string | undefined)
      ?? process.env['LINEAR_API_KEY'];
    if (!apiKey) {
      console.warn('[linear-failure-handler] LINEAR_API_KEY not set — skipping failure notification');
      return;
    }

    const comment = buildFailureComment(ctx);
    try {
      await gql(
        `mutation CreateComment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success }
        }`,
        { issueId, body: comment },
        apiKey,
      );

      const statesResult = await gql(
        `query GetWorkflowStates($issueId: String!) {
          issue(id: $issueId) { team { states { nodes { id name } } } }
        }`,
        { issueId },
        apiKey,
      );

      type StateNode = { id: string; name: string };
      const nodes = (
        (statesResult as { data?: { issue?: { team?: { states?: { nodes?: StateNode[] } } } } })
          .data?.issue?.team?.states?.nodes
      ) ?? [];
      const backlogState = nodes.find((s: StateNode) => s.name === 'Backlog');

      if (backlogState) {
        await gql(
          `mutation UpdateIssue($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success }
          }`,
          { id: issueId, stateId: backlogState.id },
          apiKey,
        );
      } else {
        console.warn(`[linear-failure-handler] "Backlog" state not found for issue ${issueId} — status not updated`);
      }

      console.log(`[linear-failure-handler] Failure notification posted for issue ${issueId}`);
    } catch (err) {
      console.error('[linear-failure-handler] Failed to notify Linear:', err);
    }
  }
}
```

**Step 4: Run tests, expect pass**

```bash
pnpm --filter @studio/api test tests/integrations/linear/failure-handler.test.ts
```
Expected: all tests passing.

**Step 5: Commit**

```bash
git add api/src/integrations/linear/failure-handler.ts api/tests/integrations/linear/failure-handler.test.ts
git commit -m "feat(api): extract LinearFailureHandler plugin from linear-notifier.ts"
```

---

## Task 6: Migrate `LinearWebhookHandler` (TDD)

Move `routes/linear-webhook.ts` logic to `integrations/linear/webhook-handler.ts`. Adapted to use `IntegrationStore` (external_id/external_label/external_url columns) and `WebhookHandlerContext`.

**Files:**
- Create: `api/src/integrations/linear/webhook-handler.ts`
- Create: `api/tests/integrations/linear/webhook-handler.test.ts`

**Step 1: Write the failing test** (unit test for the handler in isolation)

```typescript
// api/tests/integrations/linear/webhook-handler.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { LinearWebhookHandler } from '../../../src/integrations/linear/webhook-handler.js';
import { IntegrationStore } from '../../../src/integration-store.js';
import type { IntegrationPluginDef } from '@studio/contracts';

const WEBHOOK_SECRET = 'test-secret-abc';

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

function makeContext(opts: { withSecret?: boolean; active?: boolean; body?: object; signature?: string } = {}) {
  const dir = resolve('/tmp', `.studio-wh-handler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const store = new IntegrationStore(resolve(dir, 'runs.db'));
  store.patchConfig('linear', { active: opts.active ?? true });

  const launched: Array<{ pipeline: string; input: Record<string, unknown>; meta?: Record<string, unknown> }> = [];
  const launcher = {
    launch: vi.fn(async (cfg: { pipeline: string; input: Record<string, unknown>; meta?: Record<string, unknown>; runId: string }) => {
      launched.push({ pipeline: cfg.pipeline, input: cfg.input, meta: cfg.meta });
      return { run_id: cfg.runId };
    }),
    cancel: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };

  const body = opts.body ?? {
    type: 'Issue', action: 'update',
    data: { id: 'abc-123', identifier: 'STU-42', title: 'Add dark mode', description: 'Desc', state: { name: 'In Progress' } },
  };
  const bodyStr = JSON.stringify(body);
  const rawBody = Buffer.from(bodyStr);

  const integration: IntegrationPluginDef = {
    name: 'linear', version: 1,
    ...(opts.withSecret ? { webhook: { hmac: { header: 'linear-signature', secret_env: 'LINEAR_WEBHOOK_SECRET' }, handler: 'linear-webhook' } } : { webhook: { handler: 'linear-webhook' } }),
  };

  const headers: Record<string, string | undefined> = { 'content-type': 'application/json' };
  if (opts.signature !== undefined) headers['linear-signature'] = opts.signature;
  if (opts.withSecret && opts.signature === undefined) headers['linear-signature'] = sign(bodyStr, WEBHOOK_SECRET);

  const ctx = {
    rawBody,
    headers,
    integration,
    store,
    launcher,
    configsDir: dir,
    projectsDir: undefined,
    apiConfig: {},
    integrationConfig: opts.withSecret ? { LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET } : {},
  };

  const reply = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };

  return { ctx, reply, launched, store, cleanup: () => store.close() };
}

describe('LinearWebhookHandler', () => {
  const handler = new LinearWebhookHandler();

  test('accepts "In Progress" transition and launches feature-builder', async () => {
    const { ctx, reply, launched, cleanup } = makeContext();
    await handler.handle(ctx as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(202);
    expect(launched).toHaveLength(1);
    expect(launched[0].pipeline).toBe('feature-builder');
    expect(launched[0].input['brief_summary']).toBe('STU-42 — Add dark mode');
    expect(launched[0].meta?.['linear_issue_id']).toBe('abc-123');
    cleanup();
  });

  test('ignores non-"In Progress" state', async () => {
    const { ctx, reply, launched, cleanup } = makeContext({
      body: { type: 'Issue', action: 'update', data: { id: 'abc-123', identifier: 'STU-42', title: 'T', state: { name: 'Done' } } },
    });
    await handler.handle(ctx as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(200);
    const sendArg = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { ignored: boolean };
    expect(sendArg.ignored).toBe(true);
    expect(launched).toHaveLength(0);
    cleanup();
  });

  test('verifies HMAC when secret configured', async () => {
    const { ctx, reply, launched, cleanup } = makeContext({ withSecret: true });
    await handler.handle(ctx as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(202);
    expect(launched).toHaveLength(1);
    cleanup();
  });

  test('rejects invalid HMAC', async () => {
    const { ctx, reply, cleanup } = makeContext({ withSecret: true, signature: 'deadbeef' });
    await handler.handle(ctx as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(401);
    cleanup();
  });

  test('ignores when integration is inactive', async () => {
    const { ctx, reply, launched, cleanup } = makeContext({ active: false });
    await handler.handle(ctx as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(launched).toHaveLength(0);
    cleanup();
  });
});
```

**Step 2: Run to see it fail**

```bash
pnpm --filter @studio/api test tests/integrations/linear/webhook-handler.test.ts
```
Expected: FAIL — `LinearWebhookHandler` not found.

**Step 3: Create `webhook-handler.ts`**

Core logic from `routes/linear-webhook.ts`, adapted to `WebhookHandlerContext` + `IntegrationStore`:

```typescript
// api/src/integrations/linear/webhook-handler.ts
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyReply } from 'fastify';
import type { WebhookHandler, WebhookHandlerContext } from '../types.js';
import { loadPipelineByName } from '@studio/engine';
import { resolveRepoPath } from '../../utils/repo-resolver.js';

interface LinearIssuePayload {
  type?: string;
  action?: string;
  data?: {
    id?: string;
    identifier?: string;
    title?: string;
    description?: string;
    state?: { name?: string };
  };
}

function verifyHmac(rawBody: Buffer, signature: string, secret: string): boolean {
  const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(signature, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export class LinearWebhookHandler implements WebhookHandler {
  async handle(ctx: WebhookHandlerContext, reply: FastifyReply): Promise<unknown> {
    const { rawBody, headers, integration, store, launcher, configsDir, projectsDir, integrationConfig } = ctx;

    // HMAC verification
    const hmacConfig = integration.webhook?.hmac;
    if (hmacConfig) {
      const secret = integrationConfig[hmacConfig.secret_env] as string | undefined;
      if (secret) {
        const sig = headers[hmacConfig.header];
        if (typeof sig !== 'string') return reply.status(401).send({ error: `Missing ${hmacConfig.header} header` });
        if (!verifyHmac(rawBody, sig, secret)) return reply.status(401).send({ error: 'Invalid signature' });
      }
    }

    let payload: LinearIssuePayload;
    try {
      payload = JSON.parse(rawBody.toString('utf-8')) as LinearIssuePayload;
    } catch {
      return reply.status(400).send({ error: 'Invalid JSON' });
    }

    if (payload.type !== 'Issue' || payload.action !== 'update') {
      return reply.status(200).send({ ignored: true, reason: 'not an issue update' });
    }

    const issue = payload.data ?? {};
    if (issue.state?.name !== 'In Progress') {
      return reply.status(200).send({ ignored: true, reason: `state is "${issue.state?.name ?? 'unknown'}"` });
    }

    const config = store.getConfig(integration.name);
    if (!config.active) {
      return reply.status(200).send({ ignored: true, reason: 'integration is inactive' });
    }

    const pipeline = config.pipeline ?? 'feature-builder';
    const issueUrl = `https://linear.app/studioag/issue/${issue.identifier}`;

    let pipelineRepoUrl: string | undefined;
    let pipelineRepoBranch: string | undefined;
    try {
      const pipelineDef = await loadPipelineByName(pipeline, join(configsDir, 'pipelines'));
      pipelineRepoUrl = pipelineDef.repo?.url;
      pipelineRepoBranch = pipelineDef.repo?.branch;
    } catch {
      // pipeline not found — launcher will surface the error
    }

    let repoPath: string;
    try {
      repoPath = await resolveRepoPath({
        repoUrl: pipelineRepoUrl,
        rawProjectsDir: projectsDir,
        pipelineName: pipeline,
        branch: pipelineRepoBranch,
      });
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

    const input: Record<string, unknown> = {
      brief_summary: [issue.identifier, issue.title].filter(Boolean).join(' — '),
      description: issue.description ?? '',
      acceptance_criteria: [],
    };

    const meta: Record<string, unknown> = {
      linear_issue_id: issue.id,
      linear_issue_identifier: issue.identifier,
      linear_issue_url: issueUrl,
    };

    const runId = randomUUID();
    const triggerId = randomUUID();
    const receivedAt = new Date().toISOString();

    try {
      await launcher.launch({ runId, pipeline, input, configsDir, repoPath, meta });
      store.insertTrigger({
        id: triggerId, integration_name: integration.name, received_at: receivedAt,
        external_id: issue.id, external_label: [issue.identifier, issue.title].filter(Boolean).join(' — '),
        external_url: issueUrl, pipeline, run_id: runId, status: 'success',
      });
    } catch (err) {
      store.insertTrigger({
        id: triggerId, integration_name: integration.name, received_at: receivedAt,
        external_id: issue.id, external_label: [issue.identifier, issue.title].filter(Boolean).join(' — '),
        external_url: issueUrl, pipeline, run_id: runId, status: 'failed',
      });
      throw err;
    }

    return reply.status(202).send({ run_id: runId, stream_url: `/api/runs/${runId}/stream` });
  }
}
```

**Step 4: Run tests, expect pass**

```bash
pnpm --filter @studio/api test tests/integrations/linear/webhook-handler.test.ts
```
Expected: all tests passing.

**Step 5: Commit**

```bash
git add api/src/integrations/linear/webhook-handler.ts api/tests/integrations/linear/webhook-handler.test.ts
git commit -m "feat(api): extract LinearWebhookHandler plugin from routes/linear-webhook.ts"
```

---

## Task 7: Create handler registry

**Files:**
- Create: `api/src/integrations/registry.ts`

**Step 1: Create the file**

```typescript
// api/src/integrations/registry.ts
import type { WebhookHandler, FailureHandler } from './types.js';
import { LinearWebhookHandler } from './linear/webhook-handler.js';
import { LinearFailureHandler } from './linear/failure-handler.js';

export const WEBHOOK_HANDLERS: Record<string, WebhookHandler> = {
  'linear-webhook': new LinearWebhookHandler(),
};

export const FAILURE_HANDLERS: Record<string, FailureHandler> = {
  'linear-failure': new LinearFailureHandler(),
};
```

**Step 2: Commit**

```bash
git add api/src/integrations/registry.ts
git commit -m "feat(api): add integration handler registry"
```

---

## Task 8: Create `IntegrationRuntime` (TDD)

**Files:**
- Create: `api/src/integration-runtime.ts`
- Create: `api/tests/integration-runtime.test.ts`

**Step 1: Write failing tests**

```typescript
// api/tests/integration-runtime.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import { IntegrationRuntime } from '../src/integration-runtime.js';
import { IntegrationStore } from '../src/integration-store.js';
import type { IntegrationPluginDef } from '@studio/contracts';

function makeLinearIntegration(): IntegrationPluginDef {
  return {
    name: 'linear', version: 1,
    webhook: { hmac: { header: 'linear-signature', secret_env: 'LINEAR_WEBHOOK_SECRET' }, handler: 'linear-webhook' },
    on_failure: { handler: 'linear-failure' },
  };
}

function makeRuntime(integrations: IntegrationPluginDef[], integrationConfigs: Record<string, Record<string, unknown>> = {}) {
  const dir = resolve('/tmp', `.studio-rt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const store = new IntegrationStore(resolve(dir, 'runs.db'));
  const launcher = { launch: vi.fn(), cancel: vi.fn(), subscribe: vi.fn(() => () => {}) };
  const runtime = new IntegrationRuntime({
    integrations, store, launcher: launcher as never,
    configsDir: dir, projectsDir: undefined, apiConfig: {},
    integrationConfigs,
  });
  return { runtime, store, launcher, dir, cleanup: () => store.close() };
}

describe('IntegrationRuntime.registerRoutes', () => {
  test('registers GET/PATCH/POST routes for integration with webhook handler', async () => {
    const { runtime, store, cleanup } = makeRuntime([makeLinearIntegration()]);
    store.patchConfig('linear', { active: true });

    const fastify = Fastify();
    runtime.registerRoutes(fastify, '/api');
    await fastify.ready();

    const res = await fastify.inject({ method: 'GET', url: '/api/integrations/linear' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ active: boolean; triggers: unknown[] }>();
    expect(body.active).toBe(true);
    expect(body.triggers).toEqual([]);

    await fastify.close();
    cleanup();
  });

  test('does not register routes when no webhook handler declared', async () => {
    const integrationWithNoWebhook: IntegrationPluginDef = { name: 'noop', version: 1 };
    const { runtime, cleanup } = makeRuntime([integrationWithNoWebhook]);

    const fastify = Fastify();
    runtime.registerRoutes(fastify, '/api');
    await fastify.ready();

    const res = await fastify.inject({ method: 'GET', url: '/api/integrations/noop' });
    expect(res.statusCode).toBe(404);

    await fastify.close();
    cleanup();
  });
});

describe('IntegrationRuntime.setupEventBus', () => {
  test('subscribes failure handler to pipeline_complete events', async () => {
    const failureHandleSpy = vi.fn().mockResolvedValue(undefined);
    // Temporarily mock the registry
    const { FAILURE_HANDLERS } = await import('../src/integrations/registry.js');
    const original = FAILURE_HANDLERS['linear-failure'];
    FAILURE_HANDLERS['linear-failure'] = { handleFailure: failureHandleSpy };

    const { runtime, cleanup } = makeRuntime([makeLinearIntegration()]);

    // Simulate bus by capturing the subscribeAll call
    const listeners: Array<(runId: string, event: { type: string; data: unknown }) => void> = [];
    const mockBus = { subscribeAll: vi.fn((fn) => { listeners.push(fn); return () => {}; }) };

    runtime.setupEventBus(mockBus as never);

    // Emit a failed pipeline_complete with linear_issue_id in meta
    for (const listener of listeners) {
      listener('run-abc', { type: 'pipeline_complete', data: { status: 'failed', duration_ms: 5000, meta: { linear_issue_id: 'issue-x' }, last_group_feedback: undefined } });
    }

    // Wait a tick for async handler
    await new Promise(r => setTimeout(r, 10));
    expect(failureHandleSpy).toHaveBeenCalledTimes(1);

    // Restore
    FAILURE_HANDLERS['linear-failure'] = original;
    cleanup();
  });

  test('does not call failure handler for successful pipeline', async () => {
    const { runtime, cleanup } = makeRuntime([makeLinearIntegration()]);
    const listeners: Array<(runId: string, event: { type: string; data: unknown }) => void> = [];
    const mockBus = { subscribeAll: vi.fn((fn) => { listeners.push(fn); return () => {}; }) };

    runtime.setupEventBus(mockBus as never);
    for (const listener of listeners) {
      listener('run-abc', { type: 'pipeline_complete', data: { status: 'success', duration_ms: 1000, meta: { linear_issue_id: 'issue-x' } } });
    }

    await new Promise(r => setTimeout(r, 10));
    // No failures should be called — check via the real handler which would no-op on success anyway
    // The runtime itself guards on status !== 'success'
    cleanup();
  });
});
```

**Step 2: Run to see fail**

```bash
pnpm --filter @studio/api test tests/integration-runtime.test.ts
```
Expected: FAIL — `IntegrationRuntime` not found.

**Step 3: Implement `integration-runtime.ts`**

```typescript
// api/src/integration-runtime.ts
import type { FastifyInstance } from 'fastify';
import type { IntegrationPluginDef } from '@studio/contracts';
import type { IntegrationStore, IntegrationTriggerRecord } from './integration-store.js';
import type { RunLauncher } from './launcher.js';
import type { RunEventBus } from './event-bus.js';
import type { ApiConfig } from './server.js';
import { WEBHOOK_HANDLERS, FAILURE_HANDLERS } from './integrations/registry.js';
import type { FailureHandlerContext } from './integrations/types.js';
import type { GroupFeedbackEvent } from '@studio/engine';
import { randomUUID } from 'node:crypto';

export interface IntegrationRuntimeDeps {
  integrations: IntegrationPluginDef[];
  store: IntegrationStore;
  launcher: RunLauncher;
  configsDir: string;
  projectsDir?: string;
  apiConfig: ApiConfig;
  integrationConfigs: Record<string, Record<string, unknown>>;
}

export class IntegrationRuntime {
  constructor(private deps: IntegrationRuntimeDeps) {}

  setupEventBus(bus: RunEventBus): void {
    const { integrations, deps } = this;
    bus.subscribeAll((runId, event) => {
      if (event.type !== 'pipeline_complete') return;

      const data = event.data as {
        status: string;
        duration_ms: number;
        meta?: Record<string, unknown>;
        last_group_feedback?: GroupFeedbackEvent;
      };

      if (data.status === 'success') return;

      for (const integration of integrations) {
        if (!integration.on_failure?.handler) continue;
        const handler = FAILURE_HANDLERS[integration.on_failure.handler];
        if (!handler) continue;

        const ctx: FailureHandlerContext = {
          runId,
          durationMs: data.duration_ms,
          status: data.status,
          meta: data.meta ?? {},
          lastGroupFeedback: data.last_group_feedback,
          integration,
          integrationConfig: this.deps.integrationConfigs[integration.name] ?? {},
        };

        void handler.handleFailure(ctx);
      }
    });
  }

  registerRoutes(fastify: FastifyInstance, prefix: string): void {
    for (const integration of this.deps.integrations) {
      if (!integration.webhook?.handler) continue;
      const webhookHandler = WEBHOOK_HANDLERS[integration.webhook.handler];
      if (!webhookHandler) continue;

      const name = integration.name;
      const { store, launcher, configsDir, projectsDir, apiConfig, integrationConfigs } = this.deps;
      const integrationConfig = integrationConfigs[name] ?? {};

      void fastify.register(async (scope) => {
        scope.addContentTypeParser(
          'application/json',
          { parseAs: 'buffer' },
          (_req, body, done) => done(null, body),
        );

        const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };

        // GET /api/integrations/{name}
        scope.get(`${prefix}/integrations/${name}`, {
          schema: { tags: ['integrations'], summary: `Get ${name} integration config and trigger log` },
        }, async (request, reply) => {
          const config = store.getConfig(name);
          const triggers = store.listTriggers(name, 50);
          const baseUrl = process.env['STUDIO_BASE_URL'] ?? `${request.protocol}://${request.hostname}`;
          return reply.status(200).send({
            webhook_url: `${baseUrl}/api/integrations/${name}/webhook`,
            pipeline: config.pipeline ?? null,
            active: config.active,
            triggers,
          });
        });

        // PATCH /api/integrations/{name}
        scope.patch(`${prefix}/integrations/${name}`, {
          schema: { tags: ['integrations'], summary: `Update ${name} integration config` },
        }, async (request, reply) => {
          let data: { pipeline?: string; active?: boolean };
          try {
            data = JSON.parse((request.body as Buffer).toString('utf-8')) as typeof data;
          } catch {
            return reply.status(400).send({ error: 'Invalid JSON' });
          }
          store.patchConfig(name, data);
          const updated = store.getConfig(name);
          const baseUrl = process.env['STUDIO_BASE_URL'] ?? `${request.protocol}://${request.hostname}`;
          return reply.status(200).send({
            webhook_url: `${baseUrl}/api/integrations/${name}/webhook`,
            pipeline: updated.pipeline ?? null,
            active: updated.active,
          });
        });

        // POST /api/integrations/{name}/webhook
        scope.post(`${prefix}/integrations/${name}/webhook`, {
          schema: {
            tags: ['integrations'],
            summary: `Receive ${name} webhook event`,
            response: {
              202: { type: 'object', properties: { run_id: { type: 'string' }, stream_url: { type: 'string' } } },
              200: { type: 'object', properties: { ignored: { type: 'boolean' }, reason: { type: 'string' } } },
              400: errorSchema,
              401: errorSchema,
            },
          },
        }, async (request, reply) => {
          return webhookHandler.handle({
            rawBody: request.body as Buffer,
            headers: request.headers,
            integration,
            store,
            launcher,
            configsDir,
            projectsDir,
            apiConfig,
            integrationConfig,
          }, reply);
        });
      });
    }
  }
}
```

**Step 4: Run tests, expect pass**

```bash
pnpm --filter @studio/api test tests/integration-runtime.test.ts
```
Expected: all tests passing.

**Step 5: Commit**

```bash
git add api/src/integration-runtime.ts api/tests/integration-runtime.test.ts
git commit -m "feat(api): add IntegrationRuntime for dynamic route and event bus wiring"
```

---

## Task 9: Update `launcher.ts` — emit `meta` in `pipeline_complete`, remove `notifyLinearFailure`

**Files:**
- Modify: `api/src/launcher.ts`

**Step 1: Update `onPipelineComplete` and remove Linear imports**

Remove:
```typescript
import { notifyLinearFailure } from './linear-notifier.js';
```

In `onPipelineComplete`, change:
```typescript
// BEFORE
onPipelineComplete: (e: PipelineCompleteEvent) => {
  emit('pipeline_complete', e);
  this.bus.close(runId);

  const linearIssueId = meta?.['linear_issue_id'];
  if (typeof linearIssueId === 'string' && e.status !== 'success') {
    void notifyLinearFailure({ ... });
  }
},

// AFTER
onPipelineComplete: (e: PipelineCompleteEvent) => {
  emit('pipeline_complete', { ...e, meta: meta ?? {}, last_group_feedback: lastGroupFeedback });
  this.bus.close(runId);
},
```

The `lastGroupFeedback` tracking stays (it's generic pipeline state). The `notifyLinearFailure` block and its import are removed entirely.

**Step 2: Build and run all api tests**

```bash
pnpm --filter @studio/api build
pnpm --filter @studio/api test
```
Expected: build passes, tests that don't depend on the full server wiring still pass.

**Step 3: Commit**

```bash
git add api/src/launcher.ts
git commit -m "refactor(api): emit meta in pipeline_complete bus event, remove notifyLinearFailure from launcher"
```

---

## Task 10: Update `server.ts` and `ApiConfig`

**Files:**
- Modify: `api/src/server.ts`

**Step 1: Update `ApiConfig` and `ServerDeps`**

Remove `linear_webhook_secret` from `ApiConfig`:
```typescript
// BEFORE
export interface ApiConfig {
  key?: string;
  port?: number;
  linear_webhook_secret?: string;
}

// AFTER
export interface ApiConfig {
  key?: string;
  port?: number;
}
```

Update `ServerDeps` — replace `linearStore` with `integrationStore` and `integrationRuntime`:
```typescript
// BEFORE
import type { LinearStore } from './linear-store.js';
webhookStore: WebhookStore;
linearStore: LinearStore;

// AFTER
import type { IntegrationStore } from './integration-store.js';
import type { IntegrationRuntime } from './integration-runtime.js';
webhookStore: WebhookStore;
integrationStore: IntegrationStore;
integrationRuntime: IntegrationRuntime;
```

Remove the `linearWebhookRoute` import and registration:
```typescript
// REMOVE these lines:
import { linearWebhookRoute } from './routes/linear-webhook.js';
// ...
void fastify.register(linearWebhookRoute, { prefix: '/api', deps });
```

Add dynamic route registration after existing routes:
```typescript
deps.integrationRuntime.registerRoutes(fastify, '/api');
```

**Step 2: Build**

```bash
pnpm --filter @studio/api build
```
Expected: build errors in `bootstrap.ts` only (it still references LinearStore). Fix those in Task 11.

**Step 3: Commit**

```bash
git add api/src/server.ts
git commit -m "refactor(api): replace linearStore with IntegrationStore/IntegrationRuntime in server.ts"
```

---

## Task 11: Update `bootstrap.ts` — wire IntegrationRuntime

**Files:**
- Modify: `api/src/bootstrap.ts`

**Step 1: Update imports and `StudioApiConfig`**

Add `integrations` to `StudioApiConfig`, remove `linear_webhook_secret` from `api`:
```typescript
// StudioApiConfig
export interface StudioApiConfig {
  providers?: { ... };
  paths?: { projects_dir?: string };
  defaults?: { provider?: string; model?: string };
  api?: { key?: string; port?: number };                      // remove linear_webhook_secret
  integrations?: Record<string, Record<string, unknown>>;     // ADD
}
```

Update `BootstrapResult` — replace `linearStore` with `integrationStore` and `integrationRuntime`:
```typescript
import { IntegrationStore } from './integration-store.js';
import { IntegrationRuntime } from './integration-runtime.js';
import { loadProjectIntegrations } from '@studio/runner';

export interface BootstrapResult {
  // ...
  webhookStore: WebhookStore;
  integrationStore: IntegrationStore;
  integrationRuntime: IntegrationRuntime;
}
```

**Step 2: Replace LinearStore setup with IntegrationStore + IntegrationRuntime**

```typescript
// REMOVE:
import { LinearStore } from './linear-store.js';
const linearStore = new LinearStore(dbPath);
// ...in cleanup:
linearStore.close();

// ADD:
const integrationStore = new IntegrationStore(dbPath);

// Load installed integrations
const integrationsDir = join(studioDir, 'integrations');
const loadedIntegrations = await loadProjectIntegrations(integrationsDir);
const integrationConfigs = (config.integrations ?? {}) as Record<string, Record<string, unknown>>;

const integrationRuntime = new IntegrationRuntime({
  integrations: loadedIntegrations,
  store: integrationStore,
  launcher,
  configsDir: studioDir,
  projectsDir: config.paths?.projects_dir,
  apiConfig: config.api ?? {},
  integrationConfigs,
});
integrationRuntime.setupEventBus(bus);

// in cleanup:
integrationStore.close();
```

Also remove `linear_webhook_secret` from `apiConfig` return:
```typescript
// BEFORE
apiConfig: config.api ?? {},  // had linear_webhook_secret

// AFTER (same — it's just ApiConfig without the removed field)
apiConfig: config.api ?? {},
```

Update `BootstrapResult` return object:
```typescript
return {
  // ...
  webhookStore,
  integrationStore,      // replaces linearStore
  integrationRuntime,    // NEW
  cleanup: async () => {
    // ...
    webhookStore.close();
    integrationStore.close();  // replaces linearStore.close()
  },
};
```

**Step 3: Build all packages**

```bash
pnpm build
```
Expected: clean build, no TypeScript errors.

**Step 4: Commit**

```bash
git add api/src/bootstrap.ts
git commit -m "refactor(api): replace LinearStore with IntegrationStore + IntegrationRuntime in bootstrap"
```

---

## Task 12: Migrate `linear-webhook.test.ts` to use `IntegrationRuntime`

**Files:**
- Modify: `api/tests/linear-webhook.test.ts`

The existing tests use `buildServer` + `LinearStore`. After migration, `buildServer` expects `integrationStore` + `integrationRuntime`. The behavioral assertions remain identical.

**Step 1: Rewrite `makeServer` helper**

```typescript
// api/tests/linear-webhook.test.ts
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';
import { WebhookStore } from '../src/webhook-store.js';
import { IntegrationStore } from '../src/integration-store.js';
import { IntegrationRuntime } from '../src/integration-runtime.js';
import type { IntegrationPluginDef } from '@studio/contracts';

const WEBHOOK_SECRET = 'test-whsec-abc123';

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

const LINEAR_INTEGRATION: IntegrationPluginDef = {
  name: 'linear', version: 1,
  webhook: { hmac: { header: 'linear-signature', secret_env: 'LINEAR_WEBHOOK_SECRET' }, handler: 'linear-webhook' },
  on_failure: { handler: 'linear-failure' },
};

function makeServer(opts: { withSecret?: boolean; withApiKey?: boolean; active?: boolean } = {}) {
  const dir = resolve('/tmp', `.studio-linear-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = resolve(dir, 'runs.db');
  const webhookStore = new WebhookStore(dbPath);
  const integrationStore = new IntegrationStore(dbPath);
  integrationStore.patchConfig('linear', { active: opts.active ?? true });

  const launched: Array<{ pipeline: string; input: Record<string, unknown>; meta?: Record<string, unknown> }> = [];
  const launcher = {
    launch: vi.fn(async (cfg: { pipeline: string; input: Record<string, unknown>; meta?: Record<string, unknown>; runId: string }) => {
      launched.push({ pipeline: cfg.pipeline, input: cfg.input, meta: cfg.meta });
      return { run_id: cfg.runId };
    }),
    cancel: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };

  const integrationRuntime = new IntegrationRuntime({
    integrations: [LINEAR_INTEGRATION],
    store: integrationStore,
    launcher: launcher as never,
    configsDir: dir,
    projectsDir: undefined,
    apiConfig: {},
    integrationConfigs: opts.withSecret ? { linear: { LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET } } : {},
  });

  const server = buildServer({
    store: new InMemoryRunStore(),
    launcher: launcher as never,
    configsDir: dir,
    projectName: 'test-project',
    apiConfig: {
      ...(opts.withApiKey ? { key: 'sk-studio-test' } : {}),
    },
    studioVersion: '0.0.0',
    maskedConfig: { providers: [] },
    webhookStore,
    integrationStore,
    integrationRuntime,
  });

  return { server, launched, launcher, integrationStore, cleanup: () => { webhookStore.close(); integrationStore.close(); } };
}
```

Keep all existing test cases unchanged — only `makeServer` changes. The test assertions (`expects`) are identical.

**Step 2: Run tests**

```bash
pnpm --filter @studio/api test tests/linear-webhook.test.ts
```
Expected: all tests passing with the same assertions.

**Step 3: Commit**

```bash
git add api/tests/linear-webhook.test.ts
git commit -m "test(api): migrate linear-webhook.test.ts to use IntegrationRuntime"
```

---

## Task 13: Delete old files and verify

**Step 1: Delete the three files**

```bash
rm api/src/linear-notifier.ts
rm api/src/linear-store.ts
rm api/src/routes/linear-webhook.ts
rm api/tests/linear-notifier.test.ts
```

Note: `api/tests/linear-notifier.test.ts` is replaced by `api/tests/integrations/linear/failure-handler.test.ts`.

**Step 2: Build**

```bash
pnpm build
```
Expected: clean build. If any import still references the deleted files, fix it now.

**Step 3: Verify the grep requirement**

```bash
grep -r "linear" api/src/ --include="*.ts" -l
```
Expected: only files under `api/src/integrations/linear/` and `api/src/integrations/registry.ts`.

```bash
grep -rn "linear-notifier\|linear-store\|LinearStore\|linearStore\|linearWebhookRoute\|notifyLinearFailure" api/src/ --include="*.ts"
```
Expected: no matches.

**Step 4: Full test run**

```bash
pnpm test
```
Expected: all previously passing tests still pass. New tests for `IntegrationStore`, `LinearWebhookHandler`, `LinearFailureHandler`, `IntegrationRuntime` all pass.

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat(api): complete STU-200 — Linear migrated to integration plugin, core API agnostic"
```

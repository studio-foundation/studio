import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';
import { WebhookStore } from '../src/webhook-store.js';

const WEBHOOK_SECRET = 'test-whsec-abc123';

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

function makeServer(opts: { withSecret?: boolean; withApiKey?: boolean } = {}) {
  const dir = resolve('/tmp', `.studio-linear-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const webhookStore = new WebhookStore(resolve(dir, 'runs.db'));

  const launched: Array<{ pipeline: string; input: Record<string, unknown>; meta?: Record<string, unknown> }> = [];
  const launcher = {
    launch: vi.fn(async (cfg: { pipeline: string; input: Record<string, unknown>; meta?: Record<string, unknown>; runId: string }) => {
      launched.push({ pipeline: cfg.pipeline, input: cfg.input, meta: cfg.meta });
      return { run_id: cfg.runId };
    }),
    cancel: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };

  const server = buildServer({
    store: new InMemoryRunStore(),
    launcher,
    configsDir: dir,
    projectName: 'test-project',
    apiConfig: {
      ...(opts.withSecret ? { linear_webhook_secret: WEBHOOK_SECRET } : {}),
      ...(opts.withApiKey ? { key: 'sk-studio-test' } : {}),
    },
    studioVersion: '0.0.0',
    maskedConfig: { providers: [] },
    webhookStore,
  });

  return { server, launched, launcher, cleanup: () => webhookStore.close() };
}

function inProgressPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'Issue',
    action: 'update',
    data: {
      id: 'abc-123',
      identifier: 'STU-42',
      title: 'Add dark mode toggle',
      description: 'Users want a dark mode option in the settings.',
      state: { name: 'In Progress' },
      ...overrides,
    },
  };
}

describe('POST /api/integrations/linear/webhook — no secret configured', () => {
  let server: ReturnType<typeof makeServer>['server'];
  let launched: ReturnType<typeof makeServer>['launched'];
  let cleanup: () => void;

  beforeEach(() => {
    ({ server, launched, cleanup } = makeServer());
  });

  afterEach(() => {
    cleanup();
  });

  test('accepts "In Progress" transition and launches feature-builder', async () => {
    const payload = inProgressPayload();
    const res = await server.inject({
      method: 'POST',
      url: '/api/integrations/linear/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

    expect(res.statusCode).toBe(202);
    const body = res.json<{ run_id: string; stream_url: string }>();
    expect(body.run_id).toBeDefined();
    expect(body.stream_url).toMatch(/\/api\/runs\/.+\/stream/);

    expect(launched).toHaveLength(1);
    expect(launched[0].pipeline).toBe('feature-builder');
    expect(launched[0].input['brief_summary']).toBe('STU-42 — Add dark mode toggle');
    expect(launched[0].meta?.['linear_issue_id']).toBe('abc-123');
    expect(launched[0].meta?.['linear_issue_identifier']).toBe('STU-42');
    expect(launched[0].meta?.['linear_issue_url']).toBe('https://linear.app/studioag/issue/STU-42');
  });

  test('ignores non-"In Progress" state transitions', async () => {
    const payload = inProgressPayload({ state: { name: 'Done' } });
    const res = await server.inject({
      method: 'POST',
      url: '/api/integrations/linear/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ignored: boolean; reason: string }>();
    expect(body.ignored).toBe(true);
    expect(body.reason).toContain('Done');
    expect(launched).toHaveLength(0);
  });

  test('ignores non-update actions', async () => {
    const payload = { ...inProgressPayload(), action: 'create' };
    const res = await server.inject({
      method: 'POST',
      url: '/api/integrations/linear/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ignored: boolean }>();
    expect(body.ignored).toBe(true);
    expect(launched).toHaveLength(0);
  });

  test('ignores non-Issue types', async () => {
    const payload = { ...inProgressPayload(), type: 'Comment' };
    const res = await server.inject({
      method: 'POST',
      url: '/api/integrations/linear/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ignored: boolean }>();
    expect(body.ignored).toBe(true);
    expect(launched).toHaveLength(0);
  });

  test('returns 400 for invalid JSON body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/integrations/linear/webhook',
      headers: { 'content-type': 'application/json' },
      payload: 'not-json{',
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/integrations/linear/webhook — with HMAC secret', () => {
  let server: ReturnType<typeof makeServer>['server'];
  let launched: ReturnType<typeof makeServer>['launched'];
  let cleanup: () => void;

  beforeEach(() => {
    ({ server, launched, cleanup } = makeServer({ withSecret: true }));
  });

  afterEach(() => {
    cleanup();
  });

  test('accepts request with valid signature', async () => {
    const body = JSON.stringify(inProgressPayload());
    const sig = sign(body, WEBHOOK_SECRET);

    const res = await server.inject({
      method: 'POST',
      url: '/api/integrations/linear/webhook',
      headers: { 'content-type': 'application/json', 'linear-signature': sig },
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    expect(launched).toHaveLength(1);
  });

  test('rejects request with invalid signature', async () => {
    const body = JSON.stringify(inProgressPayload());

    const res = await server.inject({
      method: 'POST',
      url: '/api/integrations/linear/webhook',
      headers: { 'content-type': 'application/json', 'linear-signature': 'deadbeef' },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    expect(launched).toHaveLength(0);
  });

  test('rejects request with missing signature header', async () => {
    const body = JSON.stringify(inProgressPayload());

    const res = await server.inject({
      method: 'POST',
      url: '/api/integrations/linear/webhook',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    expect(launched).toHaveLength(0);
  });

  test('returns 401 not 500 for tampered body', async () => {
    const originalBody = JSON.stringify(inProgressPayload());
    const sig = sign(originalBody, WEBHOOK_SECRET);
    const tamperedBody = originalBody + ' ';

    const res = await server.inject({
      method: 'POST',
      url: '/api/integrations/linear/webhook',
      headers: { 'content-type': 'application/json', 'linear-signature': sig },
      payload: tamperedBody,
    });

    expect(res.statusCode).toBe(401);
    expect(launched).toHaveLength(0);
  });
});

describe('POST /api/integrations/linear/webhook — with API key auth enabled', () => {
  let server: ReturnType<typeof makeServer>['server'];
  let launched: ReturnType<typeof makeServer>['launched'];
  let cleanup: () => void;

  beforeEach(() => {
    ({ server, launched, cleanup } = makeServer({ withApiKey: true }));
  });

  afterEach(() => {
    cleanup();
  });

  test('webhook endpoint is exempt from Bearer token auth', async () => {
    // No Authorization header — should not get 401 from the API key check
    const payload = inProgressPayload();
    const res = await server.inject({
      method: 'POST',
      url: '/api/integrations/linear/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

    expect(res.statusCode).toBe(202);
    expect(launched).toHaveLength(1);
  });

  test('other API routes still require Bearer token', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/runs',
    });

    expect(res.statusCode).toBe(401);
  });
});

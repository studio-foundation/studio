import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio-foundation/engine';
import { WebhookStore } from '../src/webhook-store.js';
import type { IntegrationRuntime } from '../src/integration-runtime.js';
import type { IntegrationStore } from '../src/integration-store.js';

const nullIntegrationRuntime = { registerRoutes: () => {} } as unknown as IntegrationRuntime;
const nullIntegrationStore = {} as unknown as IntegrationStore;

function makeServer() {
  const dir = resolve('/tmp', `.studio-webhooks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const webhookStore = new WebhookStore(resolve(dir, 'runs.db'));

  const server = buildServer({
    store: new InMemoryRunStore(),
    launcher: {
      launch: async () => ({ run_id: 'test' }),
      cancel: async () => {},
      subscribe: () => () => {},
    },
    configsDir: dir,
    projectName: 'test-project',
    apiConfig: {},
    studioVersion: '0.0.0',
    maskedConfig: { providers: [] },
    webhookStore,
    integrationRuntime: nullIntegrationRuntime,
    integrationStore: nullIntegrationStore,
  });

  return { server, webhookStore, cleanup: () => webhookStore.close() };
}

describe('POST /api/webhooks', () => {
  let server: ReturnType<typeof makeServer>['server'];
  let cleanup: () => void;

  beforeEach(() => {
    ({ server, cleanup } = makeServer());
  });

  afterEach(() => {
    cleanup();
  });

  test('registers a webhook and returns 201 with id', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/webhooks',
      payload: {
        url: 'https://example.com/hook',
        events: ['pipeline_complete', 'stage_failed'],
        secret: 'mysecret',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; url: string; events: string[]; status: string }>();
    expect(body.id).toBeDefined();
    expect(body.url).toBe('https://example.com/hook');
    expect(body.events).toEqual(['pipeline_complete', 'stage_failed']);
    expect(body.status).toBe('active');
  });

  test('registers a webhook without a secret', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/webhooks',
      payload: {
        url: 'https://example.com/hook',
        events: ['pipeline_complete'],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string }>();
    expect(body.id).toBeDefined();
  });

  test('returns 400 when url is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/webhooks',
      payload: { events: ['pipeline_complete'] },
    });
    expect(res.statusCode).toBe(400);
  });

  test('returns 400 when events is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/webhooks',
      payload: { url: 'https://example.com/hook' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('returns 400 when events is empty', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/webhooks',
      payload: { url: 'https://example.com/hook', events: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/webhooks', () => {
  let server: ReturnType<typeof makeServer>['server'];
  let webhookStore: WebhookStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ server, webhookStore, cleanup } = makeServer());
  });

  afterEach(() => {
    cleanup();
  });

  test('returns empty list when no webhooks registered', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/webhooks' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ webhooks: unknown[] }>();
    expect(body.webhooks).toHaveLength(0);
  });

  test('returns list of registered webhooks', async () => {
    webhookStore.saveWebhook({ id: 'wh-1', url: 'https://a.com/hook', events: ['pipeline_complete'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });
    webhookStore.saveWebhook({ id: 'wh-2', url: 'https://b.com/hook', events: ['stage_failed'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });

    const res = await server.inject({ method: 'GET', url: '/api/webhooks' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ webhooks: Array<{ id: string }> }>();
    expect(body.webhooks).toHaveLength(2);
    expect(body.webhooks.map(w => w.id)).toContain('wh-1');
    expect(body.webhooks.map(w => w.id)).toContain('wh-2');
  });

  test('does not expose secret in response', async () => {
    webhookStore.saveWebhook({ id: 'wh-1', url: 'https://a.com/hook', events: ['pipeline_complete'], secret: 'topsecret', status: 'active', created_at: '2026-01-01T00:00:00.000Z' });

    const res = await server.inject({ method: 'GET', url: '/api/webhooks' });
    const body = res.json<{ webhooks: Array<Record<string, unknown>> }>();
    expect(body.webhooks[0]['secret']).toBeUndefined();
  });
});

describe('DELETE /api/webhooks/:id', () => {
  let server: ReturnType<typeof makeServer>['server'];
  let webhookStore: WebhookStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ server, webhookStore, cleanup } = makeServer());
  });

  afterEach(() => {
    cleanup();
  });

  test('deletes an existing webhook and returns 204', async () => {
    webhookStore.saveWebhook({ id: 'wh-1', url: 'https://a.com/hook', events: ['pipeline_complete'], status: 'active', created_at: '2026-01-01T00:00:00.000Z' });

    const res = await server.inject({ method: 'DELETE', url: '/api/webhooks/wh-1' });
    expect(res.statusCode).toBe(204);
    expect(webhookStore.getWebhook('wh-1')).toBeNull();
  });

  test('returns 404 for unknown webhook id', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/api/webhooks/nonexistent' });
    expect(res.statusCode).toBe(404);
  });
});

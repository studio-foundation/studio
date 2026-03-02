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
  return { launch: async () => ({ run_id: 'mock-run-id' }), cancel: async () => {}, subscribe: () => () => {} };
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

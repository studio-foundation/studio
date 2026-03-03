import { describe, it, expect } from 'vitest';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';
import type { RunLauncher } from '../src/launcher.js';
import type { IntegrationRuntime } from '../src/integration-runtime.js';
import type { IntegrationStore } from '../src/integration-store.js';
import { UserStore, type User } from '../src/user-store.js';
import { DEFAULT_PLANS } from '../src/plans.js';
import type { WebhookStore } from '../src/webhook-store.js';

function makeMockLauncher(): RunLauncher {
  return {
    launch: async () => ({ run_id: 'mock-run-id' }),
    cancel: async () => {},
  };
}

const nullIntegrationRuntime = { registerRoutes: () => {} } as unknown as IntegrationRuntime;
const nullIntegrationStore = {} as unknown as IntegrationStore;

function makeTempUserStore(): UserStore {
  const dir = resolve('/tmp', `.studio-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return new UserStore(resolve(dir, 'runs.db'));
}

const nullWebhookStore = {} as unknown as WebhookStore;

const proUser: User = {
  id: 'user-pro-1',
  email: 'pro@example.com',
  plan: 'pro',
  api_key: 'sk-pro-key',
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('buildServer — auth', () => {
  it('no api key configured → requests pass without Authorization', async () => {
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: makeMockLauncher(),
      configsDir: '/tmp/.studio',
      projectName: 'test-project',
      apiConfig: {},   // no key
      integrationRuntime: nullIntegrationRuntime,
      integrationStore: nullIntegrationStore,
    });

    const res = await server.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).not.toBe(401);
  });

  it('api key configured → missing Authorization → 401', async () => {
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: makeMockLauncher(),
      configsDir: '/tmp/.studio',
      projectName: 'test-project',
      apiConfig: { key: 'sk-studio-secret' },
      integrationRuntime: nullIntegrationRuntime,
      integrationStore: nullIntegrationStore,
    });

    const res = await server.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('api key configured → wrong key → 401', async () => {
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: makeMockLauncher(),
      configsDir: '/tmp/.studio',
      projectName: 'test-project',
      apiConfig: { key: 'sk-studio-secret' },
      integrationRuntime: nullIntegrationRuntime,
      integrationStore: nullIntegrationStore,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { Authorization: 'Bearer sk-studio-wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('api key configured → correct key → passes', async () => {
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: makeMockLauncher(),
      configsDir: '/tmp/.studio',
      projectName: 'test-project',
      apiConfig: { key: 'sk-studio-secret' },
      integrationRuntime: nullIntegrationRuntime,
      integrationStore: nullIntegrationStore,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { Authorization: 'Bearer sk-studio-secret' },
    });
    expect(res.statusCode).not.toBe(401);
  });
});

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
      hasUsers: true,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { Authorization: 'Bearer sk-pro-key' },
    });
    userStore.close();
    expect(res.statusCode).not.toBe(401);
  });

  it('unknown api_key when users exist → 401', async () => {
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
      hasUsers: true,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { Authorization: 'Bearer sk-unknown' },
    });
    userStore.close();
    expect(res.statusCode).toBe(401);
  });

  it('legacy api.key works when no users in DB (hasUsers=false)', async () => {
    const userStore = makeTempUserStore();

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
      hasUsers: false,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { Authorization: 'Bearer sk-legacy-key' },
    });
    userStore.close();
    expect(res.statusCode).not.toBe(401);
  });

  it('no users, no api.key → open dev mode', async () => {
    const userStore = makeTempUserStore();

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
      hasUsers: false,
    });

    const res = await server.inject({ method: 'GET', url: '/api/projects' });
    userStore.close();
    expect(res.statusCode).not.toBe(401);
  });
});

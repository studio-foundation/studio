import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio-foundation/engine';
import type { IntegrationRuntime } from '../src/integration-runtime.js';
import type { IntegrationStore } from '../src/integration-store.js';

const TMP = resolve('/tmp', `.studio-agents-test-${Date.now()}`);
const AGENTS_DIR = resolve(TMP, 'agents');

const nullIntegrationRuntime = { registerRoutes: () => {} } as unknown as IntegrationRuntime;
const nullIntegrationStore = {} as unknown as IntegrationStore;

function makeServer() {
  return buildServer({
    store: new InMemoryRunStore(),
    launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
    configsDir: TMP,
    projectName: 'test-project',
    apiConfig: {},
    studioVersion: '0.0.0-test',
    maskedConfig: { providers: [] },
    integrationRuntime: nullIntegrationRuntime,
    integrationStore: nullIntegrationStore,
  });
}

beforeAll(() => {
  mkdirSync(AGENTS_DIR, { recursive: true });
  writeFileSync(
    resolve(AGENTS_DIR, 'analyst.agent.yaml'),
    'name: analyst\nprovider: anthropic\nmodel: claude-sonnet-4-20250514\n'
  );
  writeFileSync(
    resolve(AGENTS_DIR, 'coder.agent.yaml'),
    'name: coder\nprovider: anthropic\nmodel: claude-sonnet-4-20250514\ntemperature: 0.2\n'
  );
  writeFileSync(resolve(AGENTS_DIR, 'ignored.yaml'), ''); // must be ignored
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('GET /api/agents', () => {
  it('returns only *.agent.yaml files as agent names', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/agents' });
    expect(res.statusCode).toBe(200);
    const { agents } = res.json() as { agents: string[] };
    expect(agents).toContain('analyst');
    expect(agents).toContain('coder');
    expect(agents).not.toContain('ignored');
    expect(agents).not.toContain('analyst.agent.yaml');
  });

  it('returns empty array when agents dir is missing', async () => {
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
      configsDir: resolve('/tmp', `.studio-no-agents-${Date.now()}`),
      projectName: 'test-project',
      apiConfig: {},
      studioVersion: '0.0.0-test',
      maskedConfig: { providers: [] },
      integrationRuntime: nullIntegrationRuntime,
      integrationStore: nullIntegrationStore,
    });
    const res = await server.inject({ method: 'GET', url: '/api/agents' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { agents: string[] }).agents).toEqual([]);
  });
});

describe('GET /api/agents/:name', () => {
  it('returns parsed agent content as JSON', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/agents/analyst' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; provider: string; model: string };
    expect(body.name).toBe('analyst');
    expect(body.provider).toBe('anthropic');
    expect(body.model).toBe('claude-sonnet-4-20250514');
  });

  it('returns nested fields from YAML', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/agents/coder' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { temperature: number };
    expect(body.temperature).toBe(0.2);
  });

  it('returns 404 for unknown agent', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/agents/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('Agent not found');
  });
});

describe('PUT /api/agents/:name', () => {
  it('creates a new agent file', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/agents/new-agent',
      payload: { name: 'new-agent', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    });
    expect(res.statusCode).toBe(200);
    // Verify it can be read back
    const getRes = await server.inject({ method: 'GET', url: '/api/agents/new-agent' });
    expect(getRes.statusCode).toBe(200);
    expect((getRes.json() as { model: string }).model).toBe('claude-haiku-4-5-20251001');
  });

  it('updates an existing agent', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/agents/analyst',
      payload: { name: 'analyst', provider: 'anthropic', model: 'claude-opus-4-6' },
    });
    expect(res.statusCode).toBe(200);
    // Verify model updated
    const getRes = await server.inject({ method: 'GET', url: '/api/agents/analyst' });
    expect((getRes.json() as { model: string }).model).toBe('claude-opus-4-6');
  });

  it('returns 400 when name field is missing', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/agents/foo',
      payload: { provider: 'anthropic' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/agents/:name', () => {
  it('deletes an agent and returns 204', async () => {
    const server = makeServer();
    // Create it first via PUT
    await server.inject({
      method: 'PUT',
      url: '/api/agents/to-delete',
      payload: { name: 'to-delete', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    });
    const res = await server.inject({ method: 'DELETE', url: '/api/agents/to-delete' });
    expect(res.statusCode).toBe(204);
    // Verify it's gone
    const getRes = await server.inject({ method: 'GET', url: '/api/agents/to-delete' });
    expect(getRes.statusCode).toBe(404);
  });

  it('returns 404 for nonexistent agent', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'DELETE', url: '/api/agents/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('Agent not found');
  });
});

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio-foundation/engine';
import type { IntegrationRuntime } from '../src/integration-runtime.js';
import type { IntegrationStore } from '../src/integration-store.js';

const BASE_CONFIG_YAML = `providers:
  anthropic:
    apiKey: \${ANTHROPIC_API_KEY}
  openai:
    apiKey: \${OPENAI_API_KEY}
defaults:
  provider: anthropic
  model: claude-sonnet-4-20250514
`;

// Each describe block uses its own dir to avoid cross-test mutation
const GET_TMP = resolve('/tmp', `.studio-config-get-test-${Date.now()}`);
const PATCH_TMP = resolve('/tmp', `.studio-config-patch-test-${Date.now()}`);
const POST_TMP = resolve('/tmp', `.studio-config-post-test-${Date.now()}`);

const nullIntegrationRuntime = { registerRoutes: () => {} } as unknown as IntegrationRuntime;
const nullIntegrationStore = {} as unknown as IntegrationStore;

function makeServer(configsDir: string) {
  return buildServer({
    store: new InMemoryRunStore(),
    launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
    configsDir,
    projectName: 'test-project',
    apiConfig: {},
    studioVersion: '0.0.0-test',
    maskedConfig: { providers: [] },
    integrationRuntime: nullIntegrationRuntime,
    integrationStore: nullIntegrationStore,
  });
}

function writeConfig(dir: string, content = BASE_CONFIG_YAML) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'config.yaml'), content);
}

afterAll(() => {
  for (const dir of [GET_TMP, PATCH_TMP, POST_TMP]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('GET /api/config', () => {
  beforeEach(() => writeConfig(GET_TMP));

  it('returns providers with API keys masked as ***', async () => {
    const server = makeServer(GET_TMP);
    const res = await server.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: Record<string, { apiKey: string }> };
    expect(body.providers['anthropic'].apiKey).toBe('***');
    expect(body.providers['openai'].apiKey).toBe('***');
  });

  it('returns defaults from config', async () => {
    const server = makeServer(GET_TMP);
    const res = await server.inject({ method: 'GET', url: '/api/config' });
    const body = res.json() as { defaults: { provider: string; model: string } };
    expect(body.defaults.provider).toBe('anthropic');
    expect(body.defaults.model).toBe('claude-sonnet-4-20250514');
  });

  it('never exposes raw API key values in the response', async () => {
    const server = makeServer(GET_TMP);
    const res = await server.inject({ method: 'GET', url: '/api/config' });
    // The env var reference itself must not appear — only *** is returned
    expect(res.payload).not.toContain('ANTHROPIC_API_KEY');
    expect(res.payload).not.toContain('OPENAI_API_KEY');
  });

  it('returns empty providers when config.yaml does not exist', async () => {
    const emptyDir = resolve('/tmp', `.studio-no-config-${Date.now()}`);
    const server = makeServer(emptyDir);
    const res = await server.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: Record<string, unknown> };
    expect(body.providers).toEqual({});
  });
});

describe('PATCH /api/config', () => {
  beforeEach(() => writeConfig(PATCH_TMP));

  it('updates defaults and returns masked config', async () => {
    const server = makeServer(PATCH_TMP);
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { defaults: { provider: 'openai', model: 'gpt-4o' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { defaults: { provider: string; model: string } };
    expect(body.defaults.provider).toBe('openai');
    expect(body.defaults.model).toBe('gpt-4o');
  });

  it('preserves providers when patching only defaults', async () => {
    const server = makeServer(PATCH_TMP);
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { defaults: { provider: 'openai', model: 'gpt-4o' } },
    });
    const body = res.json() as { providers: Record<string, { apiKey: string }> };
    expect(body.providers['anthropic'].apiKey).toBe('***');
    expect(body.providers['openai'].apiKey).toBe('***');
  });

  it('preserves unpatched fields within defaults', async () => {
    const server = makeServer(PATCH_TMP);
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { defaults: { model: 'claude-opus-4-6' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { defaults: { provider: string; model: string } };
    // model updated
    expect(body.defaults.model).toBe('claude-opus-4-6');
    // provider preserved
    expect(body.defaults.provider).toBe('anthropic');
  });

  it('persists changes so a subsequent GET reflects them', async () => {
    const server = makeServer(PATCH_TMP);
    await server.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { defaults: { provider: 'openai', model: 'gpt-4o' } },
    });
    const getRes = await server.inject({ method: 'GET', url: '/api/config' });
    const body = getRes.json() as { defaults: { provider: string } };
    expect(body.defaults.provider).toBe('openai');
  });
});

describe('POST /api/config/providers', () => {
  beforeEach(() => writeConfig(POST_TMP));

  it('adds a provider with apiKey stored as env var reference', async () => {
    const server = makeServer(POST_TMP);
    const res = await server.inject({
      method: 'POST',
      url: '/api/config/providers',
      payload: { provider: 'anthropic', apiKeyEnvVar: 'MY_ANTHROPIC_KEY' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: Record<string, { apiKey: string }> };
    expect(body.providers['anthropic'].apiKey).toBe('***');
  });

  it('never stores the env var name in plain text in the response', async () => {
    const server = makeServer(POST_TMP);
    const res = await server.inject({
      method: 'POST',
      url: '/api/config/providers',
      payload: { provider: 'anthropic', apiKeyEnvVar: 'MY_ANTHROPIC_KEY' },
    });
    expect(res.payload).not.toContain('MY_ANTHROPIC_KEY');
  });

  it('updates an existing provider', async () => {
    const server = makeServer(POST_TMP);
    const res = await server.inject({
      method: 'POST',
      url: '/api/config/providers',
      payload: { provider: 'openai', apiKeyEnvVar: 'OPENAI_NEW_KEY' },
    });
    expect(res.statusCode).toBe(200);
    // GET should show openai still masked
    const getRes = await server.inject({ method: 'GET', url: '/api/config' });
    const body = getRes.json() as { providers: Record<string, { apiKey: string }> };
    expect(body.providers['openai'].apiKey).toBe('***');
  });

  it('returns 400 for unknown provider', async () => {
    const server = makeServer(POST_TMP);
    const res = await server.inject({
      method: 'POST',
      url: '/api/config/providers',
      payload: { provider: 'unknown-llm', apiKeyEnvVar: 'SOME_KEY' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBeTruthy();
  });
});

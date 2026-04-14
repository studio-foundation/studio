import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio-foundation/engine';
import type { IntegrationRuntime } from '../src/integration-runtime.js';
import type { IntegrationStore } from '../src/integration-store.js';

const TMP = resolve('/tmp', `.studio-api-tools-test-${Date.now()}`);
const TOOLS_DIR = resolve(TMP, 'tools');

const CUSTOM_TOOL_YAML = `name: my-custom-tool
description: A custom tool for testing
version: 1
commands:
  - name: my-custom-tool-do_something
    description: Does something useful
    parameters: {}
    execute:
      type: shell
      command: echo hello
`;

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
  mkdirSync(TOOLS_DIR, { recursive: true });
  writeFileSync(resolve(TOOLS_DIR, 'my-custom-tool.tool.yaml'), CUSTOM_TOOL_YAML);
  writeFileSync(resolve(TOOLS_DIR, 'ignored.yaml'), ''); // must be ignored
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('GET /api/tools', () => {
  it('returns builtin tools with is_builtin: true', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/tools' });
    expect(res.statusCode).toBe(200);
    const { tools } = res.json() as { tools: { name: string; is_builtin: boolean }[] };
    const builtins = tools.filter(t => t.is_builtin);
    expect(builtins.map(t => t.name)).toContain('shell');
    expect(builtins.map(t => t.name)).toContain('repo-manager');
  });

  it('returns custom tools with is_builtin: false', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/tools' });
    expect(res.statusCode).toBe(200);
    const { tools } = res.json() as { tools: { name: string; is_builtin: boolean }[] };
    const custom = tools.find(t => t.name === 'my-custom-tool');
    expect(custom).toBeDefined();
    expect(custom!.is_builtin).toBe(false);
  });

  it('does not include non-.tool.yaml files', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/tools' });
    const { tools } = res.json() as { tools: { name: string }[] };
    expect(tools.map(t => t.name)).not.toContain('ignored');
  });

  it('returns builtins even when tools dir is missing', async () => {
    const emptyServer = buildServer({
      store: new InMemoryRunStore(),
      launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
      configsDir: resolve('/tmp', `.studio-api-no-tools-${Date.now()}`),
      projectName: 'empty',
      apiConfig: {},
      studioVersion: '0.0.0-test',
      maskedConfig: { providers: [] },
      integrationRuntime: nullIntegrationRuntime,
      integrationStore: nullIntegrationStore,
    });
    const res = await emptyServer.inject({ method: 'GET', url: '/api/tools' });
    expect(res.statusCode).toBe(200);
    const { tools } = res.json() as { tools: { name: string; is_builtin: boolean }[] };
    expect(tools.some(t => t.is_builtin)).toBe(true);
    expect(tools.every(t => t.name !== 'my-custom-tool')).toBe(true);
  });
});

describe('GET /api/tools/:name', () => {
  it('returns parsed YAML for a custom tool', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/tools/my-custom-tool' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; version: number; is_builtin: boolean };
    expect(body.name).toBe('my-custom-tool');
    expect(body.version).toBe(1);
    expect(body.is_builtin).toBe(false);
  });

  it('returns builtin definition for a known builtin', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/tools/shell' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; is_builtin: boolean; prompt_snippet?: string };
    expect(body.name).toBe('shell');
    expect(body.is_builtin).toBe(true);
    expect(body.prompt_snippet).toBeTruthy();
  });

  it('returns 404 for unknown tool', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/tools/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });
});

describe('PUT /api/tools/:name', () => {
  it('creates a new custom tool from YAML body', async () => {
    const server = makeServer();
    const yamlBody = `name: new-tool\ndescription: test\nversion: 1\ncommands: []\n`;
    const res = await server.inject({
      method: 'PUT',
      url: '/api/tools/new-tool',
      headers: { 'content-type': 'text/plain' },
      payload: yamlBody,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe('new-tool');
    const getRes = await server.inject({ method: 'GET', url: '/api/tools/new-tool' });
    expect(getRes.statusCode).toBe(200);
  });

  it('creates a new custom tool from JSON body', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/tools/json-tool',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'json-tool', version: 1, commands: [] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 for invalid YAML body', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/tools/bad-tool',
      headers: { 'content-type': 'text/plain' },
      payload: 'key: [unclosed\n  - item',
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });
});

describe('DELETE /api/tools/:name', () => {
  it('deletes an existing custom tool', async () => {
    const server = makeServer();
    await server.inject({
      method: 'PUT',
      url: '/api/tools/to-delete',
      headers: { 'content-type': 'text/plain' },
      payload: 'name: to-delete\nversion: 1\ncommands: []\n',
    });
    const res = await server.inject({ method: 'DELETE', url: '/api/tools/to-delete' });
    expect(res.statusCode).toBe(200);
    const getRes = await server.inject({ method: 'GET', url: '/api/tools/to-delete' });
    expect(getRes.statusCode).toBe(404);
  });

  it('returns 403 when trying to delete a builtin tool', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'DELETE', url: '/api/tools/shell' });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/builtin/i);
  });

  it('returns 404 for nonexistent custom tool', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'DELETE', url: '/api/tools/ghost-tool' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });
});

describe('POST /api/tools/install', () => {
  it('installs a bundled tool by name', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/tools/install',
      payload: { name: 'shell' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { installed: string }).installed).toBe('shell');
    const getRes = await server.inject({ method: 'GET', url: '/api/tools/shell' });
    expect(getRes.statusCode).toBe(200);
  });

  it('returns 409 if tool is already installed', async () => {
    const server = makeServer();
    await server.inject({ method: 'POST', url: '/api/tools/install', payload: { name: 'git' } });
    const res = await server.inject({
      method: 'POST',
      url: '/api/tools/install',
      payload: { name: 'git' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 404 for unknown tool name', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/tools/install',
      payload: { name: 'nonexistent-tool' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });
});

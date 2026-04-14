import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio-foundation/engine';
import type { IntegrationRuntime } from '../src/integration-runtime.js';
import type { IntegrationStore } from '../src/integration-store.js';

const TMP_DIR = resolve('/tmp', `.studio-api-pipelines-test-${Date.now()}`);
const PIPELINES_DIR = resolve(TMP_DIR, 'pipelines');

const FEATURE_BUILDER_YAML = `name: feature-builder
stages:
  - name: analysis
    agent: analyst
`;

beforeAll(() => {
  mkdirSync(PIPELINES_DIR, { recursive: true });
  writeFileSync(resolve(PIPELINES_DIR, 'feature-builder.pipeline.yaml'), FEATURE_BUILDER_YAML);
  writeFileSync(resolve(PIPELINES_DIR, 'code-review.pipeline.yaml'), 'name: code-review\nstages: []\n');
  writeFileSync(resolve(PIPELINES_DIR, 'not-a-pipeline.yaml'), ''); // should be ignored
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

const nullIntegrationRuntime = { registerRoutes: () => {} } as unknown as IntegrationRuntime;
const nullIntegrationStore = {} as unknown as IntegrationStore;

function makeServer() {
  return buildServer({
    store: new InMemoryRunStore(),
    launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
    configsDir: TMP_DIR,
    projectName: 'test-project',
    apiConfig: {},
    integrationRuntime: nullIntegrationRuntime,
    integrationStore: nullIntegrationStore,
  });
}

describe('GET /api/pipelines', () => {
  it('returns all .pipeline.yaml names', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/pipelines' });
    expect(res.statusCode).toBe(200);
    const { pipelines } = res.json() as { pipelines: string[] };
    expect(pipelines).toContain('feature-builder');
    expect(pipelines).toContain('code-review');
    expect(pipelines).not.toContain('not-a-pipeline');
    expect(pipelines).not.toContain('feature-builder.pipeline.yaml');
  });

  it('returns empty list when no pipelines exist', async () => {
    const emptyDir = resolve('/tmp', `.studio-api-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
      configsDir: emptyDir,
      projectName: 'empty',
      apiConfig: {},
      integrationRuntime: nullIntegrationRuntime,
      integrationStore: nullIntegrationStore,
    });
    const res = await server.inject({ method: 'GET', url: '/api/pipelines' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { pipelines: string[] }).pipelines).toEqual([]);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

describe('GET /api/pipelines/:name', () => {
  it('returns the parsed pipeline YAML as JSON', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/pipelines/feature-builder' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; stages: unknown[] };
    expect(body.name).toBe('feature-builder');
    expect(body.stages).toHaveLength(1);
  });

  it('returns 404 for unknown pipeline', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/pipelines/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });
});

describe('PUT /api/pipelines/:name', () => {
  it('creates a new pipeline from YAML body', async () => {
    const server = makeServer();
    const yaml = 'name: new-pipeline\nstages: []\n';
    const res = await server.inject({
      method: 'PUT',
      url: '/api/pipelines/new-pipeline',
      headers: { 'content-type': 'text/plain' },
      payload: yaml,
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(resolve(PIPELINES_DIR, 'new-pipeline.pipeline.yaml'))).toBe(true);
  });

  it('updates an existing pipeline from YAML body', async () => {
    const server = makeServer();
    const yaml = 'name: feature-builder\nstages: []\n';
    const res = await server.inject({
      method: 'PUT',
      url: '/api/pipelines/feature-builder',
      headers: { 'content-type': 'text/plain' },
      payload: yaml,
    });
    expect(res.statusCode).toBe(200);

    // Verify content updated
    const get = await server.inject({ method: 'GET', url: '/api/pipelines/feature-builder' });
    const body = get.json() as { stages: unknown[] };
    expect(body.stages).toHaveLength(0);
  });

  it('creates a pipeline from JSON body', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/pipelines/json-pipeline',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'json-pipeline', stages: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(resolve(PIPELINES_DIR, 'json-pipeline.pipeline.yaml'))).toBe(true);
  });

  it('returns 400 for invalid YAML', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/pipelines/bad-pipeline',
      headers: { 'content-type': 'text/plain' },
      payload: 'key: [unclosed\n  - item',
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });
});

describe('DELETE /api/pipelines/:name', () => {
  it('deletes an existing pipeline', async () => {
    const server = makeServer();
    // Create a file to delete
    writeFileSync(resolve(PIPELINES_DIR, 'to-delete.pipeline.yaml'), 'name: to-delete\n');

    const res = await server.inject({ method: 'DELETE', url: '/api/pipelines/to-delete' });
    expect(res.statusCode).toBe(200);
    expect(existsSync(resolve(PIPELINES_DIR, 'to-delete.pipeline.yaml'))).toBe(false);
  });

  it('returns 404 for non-existent pipeline', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'DELETE', url: '/api/pipelines/ghost-pipeline' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });
});

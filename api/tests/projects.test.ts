import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';

const TMP_DIR = resolve('/tmp', `.studio-api-test-${Date.now()}`);
const PIPELINES_DIR = resolve(TMP_DIR, 'pipelines');

beforeAll(() => {
  mkdirSync(PIPELINES_DIR, { recursive: true });
  writeFileSync(resolve(PIPELINES_DIR, 'feature-builder.pipeline.yaml'), 'name: feature-builder\n');
  writeFileSync(resolve(PIPELINES_DIR, 'code-review.pipeline.yaml'), 'name: code-review\n');
  writeFileSync(resolve(PIPELINES_DIR, 'not-a-pipeline.yaml'), ''); // doit être ignoré
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

function makeServer() {
  return buildServer({
    store: new InMemoryRunStore(),
    launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
    configsDir: TMP_DIR,
    projectName: 'my-project',
    apiConfig: {},
  });
}

describe('GET /api/projects', () => {
  it('returns the single project', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);

    const { projects } = res.json() as { projects: Array<{ id: string; name: string }> };
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('my-project');
    expect(projects[0].id).toBeTruthy();
  });
});

describe('GET /api/projects/:id/pipelines', () => {
  it('returns only .pipeline.yaml files as pipeline names', async () => {
    const server = makeServer();
    const { projects } = (await server.inject({ method: 'GET', url: '/api/projects' })).json() as {
      projects: Array<{ id: string }>;
    };
    const projectId = projects[0].id;

    const res = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/pipelines`,
    });
    expect(res.statusCode).toBe(200);

    const { pipelines } = res.json() as { pipelines: string[] };
    expect(pipelines).toContain('feature-builder');
    expect(pipelines).toContain('code-review');
    expect(pipelines).not.toContain('not-a-pipeline');
    expect(pipelines).not.toContain('feature-builder.pipeline.yaml');
  });

  it('returns 404 for unknown project id', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/projects/unknown-project/pipelines',
    });
    expect(res.statusCode).toBe(404);
  });
});

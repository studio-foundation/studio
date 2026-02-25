import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';

const TMP_DIR = resolve('/tmp', `.studio-api-test-${Date.now()}`);
const PIPELINES_DIR = resolve(TMP_DIR, 'pipelines');

const PROJECT_TMP = resolve('/tmp', `.studio-project-introspection-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(PIPELINES_DIR, { recursive: true });
  writeFileSync(resolve(PIPELINES_DIR, 'feature-builder.pipeline.yaml'), 'name: feature-builder\n');
  writeFileSync(resolve(PIPELINES_DIR, 'code-review.pipeline.yaml'), 'name: code-review\n');
  writeFileSync(resolve(PIPELINES_DIR, 'not-a-pipeline.yaml'), ''); // doit être ignoré
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

beforeAll(() => {
  // pipelines
  mkdirSync(resolve(PROJECT_TMP, 'pipelines'), { recursive: true });
  writeFileSync(resolve(PROJECT_TMP, 'pipelines', 'feature-builder.pipeline.yaml'), '');
  writeFileSync(resolve(PROJECT_TMP, 'pipelines', 'bug-fixer.pipeline.yaml'), '');
  writeFileSync(resolve(PROJECT_TMP, 'pipelines', 'ignored.yaml'), ''); // must be ignored

  // contracts
  mkdirSync(resolve(PROJECT_TMP, 'contracts'), { recursive: true });
  writeFileSync(resolve(PROJECT_TMP, 'contracts', 'brief-analysis.contract.yaml'), '');
  writeFileSync(resolve(PROJECT_TMP, 'contracts', 'code-generation.contract.yaml'), '');

  // agents
  mkdirSync(resolve(PROJECT_TMP, 'agents'), { recursive: true });
  writeFileSync(resolve(PROJECT_TMP, 'agents', 'analyst.agent.yaml'), '');
  writeFileSync(resolve(PROJECT_TMP, 'agents', 'coder.agent.yaml'), '');

  // tools
  mkdirSync(resolve(PROJECT_TMP, 'tools'), { recursive: true });
  writeFileSync(resolve(PROJECT_TMP, 'tools', 'repo_manager-read_file.tool.yaml'), '');

  // inputs
  mkdirSync(resolve(PROJECT_TMP, 'inputs'), { recursive: true });
  writeFileSync(resolve(PROJECT_TMP, 'inputs', 'faq-about.input.yaml'), '');

  // skills — positive test to verify suffix stripping
  mkdirSync(resolve(PROJECT_TMP, 'skills'), { recursive: true });
  writeFileSync(resolve(PROJECT_TMP, 'skills', 'commit-conventions.skill.md'), '');
});

afterAll(() => {
  rmSync(PROJECT_TMP, { recursive: true, force: true });
});

function makeServer() {
  return buildServer({
    store: new InMemoryRunStore(),
    launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
    configsDir: TMP_DIR,
    projectName: 'my-project',
    apiConfig: {},
    studioVersion: '0.0.0-test',
    maskedConfig: { providers: [] },
  });
}

function makeProjectServer(opts: { withConfig?: boolean } = {}) {
  return buildServer({
    store: new InMemoryRunStore(),
    launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
    configsDir: PROJECT_TMP,
    projectName: 'my-project',
    apiConfig: {},
    studioVersion: '1.2.3',
    maskedConfig: opts.withConfig
      ? { defaults: { provider: 'anthropic', model: 'claude-haiku' }, providers: ['anthropic'] }
      : { providers: [] },
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

describe('GET /api/project', () => {
  it('returns all resource lists and metadata', async () => {
    const server = makeProjectServer({ withConfig: true });
    const res = await server.inject({ method: 'GET', url: '/api/project' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    expect(body.studio_version).toBe('1.2.3');
    expect(body.studio_dir).toBe(PROJECT_TMP);
    expect(body.pipelines).toEqual(expect.arrayContaining(['feature-builder', 'bug-fixer']));
    expect((body.pipelines as string[])).not.toContain('ignored');
    expect(body.contracts).toEqual(expect.arrayContaining(['brief-analysis', 'code-generation']));
    expect(body.agents).toEqual(expect.arrayContaining(['analyst', 'coder']));
    expect(body.tools).toEqual(expect.arrayContaining(['repo_manager-read_file']));
    expect(body.inputs).toEqual(expect.arrayContaining(['faq-about']));
    expect(body.skills).toEqual(expect.arrayContaining(['commit-conventions']));
  });

  it('returns empty array for missing skills/ directory', async () => {
    // Use TMP_DIR which has no skills/ directory
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
      configsDir: TMP_DIR,
      projectName: 'my-project',
      apiConfig: {},
      studioVersion: '0.0.0-test',
      maskedConfig: { providers: [] },
    });
    const res = await server.inject({ method: 'GET', url: '/api/project' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { skills: string[] }).skills).toEqual([]);
  });

  it('includes masked config with provider names only', async () => {
    const server = makeProjectServer({ withConfig: true });
    const res = await server.inject({ method: 'GET', url: '/api/project' });
    const body = res.json() as { config: { providers: string[]; defaults: Record<string, string> } };
    expect(body.config.providers).toEqual(['anthropic']);
    expect(body.config.defaults?.provider).toBe('anthropic');
  });

  it('returns empty providers when no config', async () => {
    const server = makeProjectServer({ withConfig: false });
    const res = await server.inject({ method: 'GET', url: '/api/project' });
    const body = res.json() as { config: { providers: string[] } };
    expect(body.config.providers).toEqual([]);
  });
});

describe('GET /api/projects/:id/inputs', () => {
  it('returns only *.input.yaml files as input names', async () => {
    const server = makeProjectServer();
    const { projects } = (await server.inject({ method: 'GET', url: '/api/projects' })).json() as {
      projects: Array<{ id: string }>;
    };
    const projectId = projects[0].id;

    const res = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/inputs`,
    });
    expect(res.statusCode).toBe(200);

    const { inputs } = res.json() as { inputs: string[] };
    expect(inputs).toContain('faq-about');
    expect(inputs).not.toContain('faq-about.input.yaml');
  });

  it('returns 404 for unknown project id', async () => {
    const server = makeProjectServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/projects/unknown-project/inputs',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns empty array when inputs dir is missing', async () => {
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
      configsDir: resolve('/tmp', `.studio-no-inputs-${Date.now()}`),
      projectName: 'test-project',
      apiConfig: {},
      studioVersion: '0.0.0-test',
      maskedConfig: { providers: [] },
    });
    const { projects } = (await server.inject({ method: 'GET', url: '/api/projects' })).json() as {
      projects: Array<{ id: string }>;
    };
    const projectId = projects[0].id;
    const res = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/inputs`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { inputs: string[] }).inputs).toEqual([]);
  });
});

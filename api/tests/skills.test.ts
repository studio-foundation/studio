import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio-foundation/engine';
import type { IntegrationRuntime } from '../src/integration-runtime.js';
import type { IntegrationStore } from '../src/integration-store.js';

const TMP = resolve('/tmp', `.studio-skills-test-${Date.now()}`);
const SKILLS_DIR = resolve(TMP, 'skills');

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
  mkdirSync(SKILLS_DIR, { recursive: true });
  writeFileSync(resolve(SKILLS_DIR, 'commit-conventions.skill.md'), '# Commit Conventions\nUse conventional commits.');
  writeFileSync(resolve(SKILLS_DIR, 'react-patterns.skill.md'), '# React Patterns\nPrefer hooks over HOCs.');
  writeFileSync(resolve(SKILLS_DIR, 'ignored.md'), ''); // must be ignored
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('GET /api/skills', () => {
  it('returns only *.skill.md files as skill names', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/skills' });
    expect(res.statusCode).toBe(200);
    const { skills } = res.json() as { skills: string[] };
    expect(skills).toContain('commit-conventions');
    expect(skills).toContain('react-patterns');
    expect(skills).not.toContain('ignored');
    expect(skills).not.toContain('commit-conventions.skill.md');
  });

  it('returns empty array when skills dir is missing', async () => {
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
      configsDir: resolve('/tmp', `.studio-no-skills-${Date.now()}`),
      projectName: 'test-project',
      apiConfig: {},
      studioVersion: '0.0.0-test',
      maskedConfig: { providers: [] },
      integrationRuntime: nullIntegrationRuntime,
      integrationStore: nullIntegrationStore,
    });
    const res = await server.inject({ method: 'GET', url: '/api/skills' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { skills: string[] }).skills).toEqual([]);
  });
});

describe('GET /api/skills/:name', () => {
  it('returns skill content as JSON', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/skills/commit-conventions' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; content: string };
    expect(body.name).toBe('commit-conventions');
    expect(body.content).toContain('conventional commits');
  });

  it('returns 404 for unknown skill', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/skills/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('Skill not found');
  });
});

describe('PUT /api/skills/:name', () => {
  it('creates a new skill file', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/skills/new-skill',
      payload: { content: '# New Skill\nSome instructions.' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; content: string };
    expect(body.name).toBe('new-skill');
    expect(body.content).toContain('New Skill');
    // Verify it can be read back
    const getRes = await server.inject({ method: 'GET', url: '/api/skills/new-skill' });
    expect(getRes.statusCode).toBe(200);
    expect((getRes.json() as { content: string }).content).toContain('New Skill');
  });

  it('updates an existing skill', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/skills/react-patterns',
      payload: { content: '# React Patterns\nUpdated content.' },
    });
    expect(res.statusCode).toBe(200);
    const getRes = await server.inject({ method: 'GET', url: '/api/skills/react-patterns' });
    expect((getRes.json() as { content: string }).content).toContain('Updated content');
  });

  it('returns 400 when content field is missing', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/skills/foo',
      payload: { name: 'foo' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/skills/:name', () => {
  it('deletes a skill and returns 204', async () => {
    const server = makeServer();
    await server.inject({
      method: 'PUT',
      url: '/api/skills/to-delete',
      payload: { content: '# To Delete' },
    });
    const res = await server.inject({ method: 'DELETE', url: '/api/skills/to-delete' });
    expect(res.statusCode).toBe(204);
    const getRes = await server.inject({ method: 'GET', url: '/api/skills/to-delete' });
    expect(getRes.statusCode).toBe(404);
  });

  it('returns 404 for nonexistent skill', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'DELETE', url: '/api/skills/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('Skill not found');
  });
});

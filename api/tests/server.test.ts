import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';
import type { RunLauncher } from '../src/launcher.js';

function makeMockLauncher(): RunLauncher {
  return {
    launch: async () => ({ run_id: 'mock-run-id' }),
    cancel: async () => {},
  };
}

describe('buildServer — auth', () => {
  it('no api key configured → requests pass without Authorization', async () => {
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: makeMockLauncher(),
      configsDir: '/tmp/.studio',
      projectName: 'test-project',
      apiConfig: {},   // no key
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
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { Authorization: 'Bearer sk-studio-secret' },
    });
    expect(res.statusCode).not.toBe(401);
  });
});

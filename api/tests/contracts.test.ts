import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';

const TMP = resolve('/tmp', `.studio-contracts-test-${Date.now()}`);
const CONTRACTS_DIR = resolve(TMP, 'contracts');

function makeServer() {
  return buildServer({
    store: new InMemoryRunStore(),
    launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
    configsDir: TMP,
    projectName: 'test-project',
    apiConfig: {},
    studioVersion: '0.0.0-test',
    maskedConfig: { providers: [] },
  });
}

beforeAll(() => {
  mkdirSync(CONTRACTS_DIR, { recursive: true });
  writeFileSync(
    resolve(CONTRACTS_DIR, 'brief-analysis.contract.yaml'),
    'name: brief-analysis\nversion: 1\n'
  );
  writeFileSync(
    resolve(CONTRACTS_DIR, 'code-generation.contract.yaml'),
    'name: code-generation\nversion: 1\ntool_calls:\n  minimum: 1\n'
  );
  writeFileSync(resolve(CONTRACTS_DIR, 'ignored.yaml'), ''); // must be ignored
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('GET /api/contracts', () => {
  it('returns only *.contract.yaml files as contract names', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/contracts' });
    expect(res.statusCode).toBe(200);
    const { contracts } = res.json() as { contracts: string[] };
    expect(contracts).toContain('brief-analysis');
    expect(contracts).toContain('code-generation');
    expect(contracts).not.toContain('ignored');
    expect(contracts).not.toContain('brief-analysis.contract.yaml');
  });

  it('returns empty array when contracts dir is missing', async () => {
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
      configsDir: resolve('/tmp', `.studio-no-contracts-${Date.now()}`),
      projectName: 'test-project',
      apiConfig: {},
      studioVersion: '0.0.0-test',
      maskedConfig: { providers: [] },
    });
    const res = await server.inject({ method: 'GET', url: '/api/contracts' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { contracts: string[] }).contracts).toEqual([]);
  });
});

describe('GET /api/contracts/:name', () => {
  it('returns parsed contract content as JSON', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/contracts/brief-analysis' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; version: number };
    expect(body.name).toBe('brief-analysis');
    expect(body.version).toBe(1);
  });

  it('returns nested fields from YAML', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/contracts/code-generation' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tool_calls: { minimum: number } };
    expect(body.tool_calls.minimum).toBe(1);
  });

  it('returns 404 for unknown contract', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/contracts/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('Contract not found');
  });
});

describe('PUT /api/contracts/:name', () => {
  it('creates a new contract file', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/contracts/new-contract',
      payload: { name: 'new-contract', version: 1, schema: { required_fields: ['summary'] } },
    });
    expect(res.statusCode).toBe(200);
    // Verify it can be read back
    const getRes = await server.inject({ method: 'GET', url: '/api/contracts/new-contract' });
    expect(getRes.statusCode).toBe(200);
    expect((getRes.json() as { version: number }).version).toBe(1);
  });

  it('updates an existing contract', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/contracts/brief-analysis',
      payload: { name: 'brief-analysis', version: 2 },
    });
    expect(res.statusCode).toBe(200);
    // Verify version updated
    const getRes = await server.inject({ method: 'GET', url: '/api/contracts/brief-analysis' });
    expect((getRes.json() as { version: number }).version).toBe(2);
  });

  it('returns 400 when name field is missing', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/contracts/foo',
      payload: { version: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when version field is missing', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/contracts/foo',
      payload: { name: 'foo' },
    });
    expect(res.statusCode).toBe(400);
  });
});

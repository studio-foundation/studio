import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio-foundation/engine';
import { WebhookStore } from '../src/webhook-store.js';
import type { IntegrationRuntime } from '../src/integration-runtime.js';
import type { IntegrationStore } from '../src/integration-store.js';

const TMP = resolve('/tmp', `.studio-contracts-test-${Date.now()}`);
const CONTRACTS_DIR = resolve(TMP, 'contracts');

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
    webhookStore: new WebhookStore(resolve(TMP, 'runs.db')),
    integrationRuntime: nullIntegrationRuntime,
    integrationStore: nullIntegrationStore,
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

  writeFileSync(
    resolve(CONTRACTS_DIR, 'with-tool-calls.contract.yaml'),
    [
      'name: with-tool-calls',
      'version: 1',
      'schema:',
      '  required_fields:',
      '    - summary',
      'tool_calls:',
      '  minimum: 1',
    ].join('\n')
  );

  writeFileSync(
    resolve(CONTRACTS_DIR, 'with-post-validation.contract.yaml'),
    [
      'name: with-post-validation',
      'version: 1',
      'schema:',
      '  required_fields:',
      '    - status',
      'post_validation:',
      '  rejection_detection:',
      '    field: status',
      '    approved_values:',
      '      - approved',
      '    rejected_values:',
      '      - rejected',
    ].join('\n')
  );
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
    const emptyDir = resolve('/tmp', `.studio-no-contracts-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
      configsDir: emptyDir,
      projectName: 'test-project',
      apiConfig: {},
      studioVersion: '0.0.0-test',
      maskedConfig: { providers: [] },
      webhookStore: new WebhookStore(resolve(emptyDir, 'runs.db')),
      integrationRuntime: nullIntegrationRuntime,
      integrationStore: nullIntegrationStore,
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

describe('DELETE /api/contracts/:name', () => {
  it('deletes a contract and returns 204', async () => {
    const server = makeServer();
    // Create it first via PUT
    await server.inject({
      method: 'PUT',
      url: '/api/contracts/to-delete',
      payload: { name: 'to-delete', version: 1 },
    });
    const res = await server.inject({ method: 'DELETE', url: '/api/contracts/to-delete' });
    expect(res.statusCode).toBe(204);
    // Verify it's gone
    const getRes = await server.inject({ method: 'GET', url: '/api/contracts/to-delete' });
    expect(getRes.statusCode).toBe(404);
  });

  it('returns 404 for nonexistent contract', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'DELETE', url: '/api/contracts/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('Contract not found');
  });
});

describe('POST /api/contracts/:name/validate', () => {
  it('returns valid: true for output that satisfies schema-only contract', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/brief-analysis/validate',
      payload: { output: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { valid: boolean; errors: string[]; warnings: string[] };
    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
  });

  it('returns valid: false with error when tool_calls minimum not met', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/with-tool-calls/validate',
      payload: { output: { summary: 'ok' }, tool_calls: [] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { valid: boolean; errors: string[] };
    expect(body.valid).toBe(false);
    expect(body.errors.some((e: string) => e.includes('at least 1 successful tool call'))).toBe(true);
  });

  it('returns valid: true when tool_calls requirement met', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/with-tool-calls/validate',
      payload: {
        output: { summary: 'ok' },
        tool_calls: [{ id: 'call-1', name: 'repo_manager-write_file', arguments: { path: 'a.ts' }, result: 'ok' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  it('returns post_validation.accepted: false when output has rejected value', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/with-post-validation/validate',
      payload: { output: { status: 'rejected' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      valid: boolean;
      post_validation: { accepted: boolean; rejection_reason: string };
    };
    expect(body.valid).toBe(true);
    expect(body.post_validation.accepted).toBe(false);
    expect(body.post_validation.rejection_reason).toBeTruthy();
  });

  it('returns post_validation.accepted: true when output has approved value', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/with-post-validation/validate',
      payload: { output: { status: 'approved' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { post_validation: { accepted: boolean } };
    expect(body.post_validation.accepted).toBe(true);
  });

  it('returns 404 for unknown contract', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/nonexistent/validate',
      payload: { output: {} },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('Contract not found');
  });

  it('returns 400 when output field is missing from body', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/brief-analysis/validate',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

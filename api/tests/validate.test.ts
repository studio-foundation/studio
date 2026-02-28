import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';

const TMP = resolve('/tmp', `.studio-validate-test-${Date.now()}`);

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
  mkdirSync(resolve(TMP, 'agents'), { recursive: true });
  mkdirSync(resolve(TMP, 'contracts'), { recursive: true });
  mkdirSync(resolve(TMP, 'tools'), { recursive: true });

  writeFileSync(resolve(TMP, 'agents', 'analyst.agent.yaml'), 'name: analyst\nmodel: claude-sonnet-4-20250514\n');
  writeFileSync(resolve(TMP, 'contracts', 'brief-analysis.contract.yaml'), 'name: brief-analysis\nversion: 1\n');
  writeFileSync(resolve(TMP, 'tools', 'my-tool.tool.yaml'), 'name: my-tool\n');
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('POST /api/validate', () => {
  it('returns valid=true for a pipeline with existing agent and contract', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/validate',
      payload: {
        type: 'pipeline',
        name: 'feature-builder',
        content: 'stages:\n  - name: analysis\n    agent: analyst\n    contract: brief-analysis\n',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { valid: boolean; errors: string[] };
    expect(body.valid).toBe(true);
    expect(body.errors).toHaveLength(0);
  });

  it('returns errors for a pipeline referencing a missing agent', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/validate',
      payload: {
        type: 'pipeline',
        name: 'bad-pipeline',
        content: 'stages:\n  - name: s1\n    agent: missing-agent\n    contract: brief-analysis\n',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { valid: boolean; errors: string[] };
    expect(body.valid).toBe(false);
    expect(body.errors).toContain("Agent 'missing-agent' not found");
  });

  it('returns errors for a pipeline referencing a missing contract', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/validate',
      payload: {
        type: 'pipeline',
        name: 'bad-pipeline',
        content: 'stages:\n  - name: s1\n    agent: analyst\n    contract: missing-contract\n',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { valid: boolean; errors: string[] };
    expect(body.valid).toBe(false);
    expect(body.errors).toContain("Contract 'missing-contract' not found");
  });

  it('validates group stages recursively', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/validate',
      payload: {
        type: 'pipeline',
        name: 'grouped',
        content: `stages:\n  - group: impl\n    max_iterations: 3\n    stages:\n      - name: code\n        agent: analyst\n        contract: missing-contract\n`,
      },
    });
    expect(res.statusCode).toBe(200);
    const { valid, errors } = res.json() as { valid: boolean; errors: string[] };
    expect(valid).toBe(false);
    expect(errors).toContain("Contract 'missing-contract' not found");
  });

  it('returns errors for agent with unknown tool', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/validate',
      payload: {
        type: 'agent',
        name: 'coder',
        content: 'name: coder\ntools:\n  - repo_manager-write_file\n  - ghost-tool\n',
      },
    });
    expect(res.statusCode).toBe(200);
    const { valid, errors } = res.json() as { valid: boolean; errors: string[] };
    expect(valid).toBe(false);
    expect(errors).toContain("Tool 'ghost-tool' not found");
  });

  it('accepts agent with builtin tools', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/validate',
      payload: {
        type: 'agent',
        name: 'coder',
        content: 'name: coder\ntools:\n  - repo_manager-write_file\n  - shell-run_command\n',
      },
    });
    const { valid } = res.json() as { valid: boolean; errors: string[] };
    expect(valid).toBe(true);
  });

  it('accepts agent with custom tools', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/validate',
      payload: {
        type: 'agent',
        name: 'coder',
        content: 'name: coder\ntools:\n  - my-tool\n',
      },
    });
    const { valid } = res.json() as { valid: boolean; errors: string[] };
    expect(valid).toBe(true);
  });

  it('returns parse error for invalid YAML', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/validate',
      payload: { type: 'contract', name: 'x', content: 'key: [unclosed' },
    });
    const { valid, errors } = res.json() as { valid: boolean; errors: string[] };
    expect(valid).toBe(false);
    expect(errors[0]).toMatch(/YAML parse error/);
  });

  it('validates skill as valid when non-empty', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/validate',
      payload: { type: 'skill', name: 'my-skill', content: '# My skill\nDo this thing.' },
    });
    const { valid } = res.json() as { valid: boolean; errors: string[] };
    expect(valid).toBe(true);
  });

  it('validates empty skill as invalid', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/validate',
      payload: { type: 'skill', name: 'my-skill', content: '   ' },
    });
    const { valid } = res.json() as { valid: boolean; errors: string[] };
    expect(valid).toBe(false);
  });

  it('returns error when pipeline has no stages array', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/validate',
      payload: { type: 'pipeline', name: 'p', content: 'name: my-pipeline\n' },
    });
    const { valid, errors } = res.json() as { valid: boolean; errors: string[] };
    expect(valid).toBe(false);
    expect(errors).toContain('Pipeline must have a "stages" array');
  });

  it('returns valid=true for a well-formed contract', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/validate',
      payload: {
        type: 'contract',
        name: 'c',
        content: 'name: my-contract\nversion: 1\nschema:\n  required_fields:\n    - summary\n',
      },
    });
    const { valid } = res.json() as { valid: boolean; errors: string[] };
    expect(valid).toBe(true);
  });
});

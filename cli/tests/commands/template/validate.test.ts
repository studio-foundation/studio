import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { validateTemplateDir } from '../../../src/commands/template/validate.js';

// Use /tmp — never a subdirectory of the Studio repo
const TMP = resolve('/tmp', '.studio-template-validate-test');

async function makeTemplate(overrides: {
  metadata?: Record<string, unknown> | null;
  pipelines?: Record<string, string>;
  agents?: Record<string, string>;
  contracts?: Record<string, string>;
} = {}): Promise<string> {
  const dir = join(TMP, String(Date.now()));
  const projectDir = join(dir, 'project');
  await mkdir(join(projectDir, 'pipelines'), { recursive: true });
  await mkdir(join(projectDir, 'agents'), { recursive: true });
  await mkdir(join(projectDir, 'contracts'), { recursive: true });
  await mkdir(join(projectDir, 'tools'), { recursive: true });
  await mkdir(join(projectDir, 'inputs'), { recursive: true });

  // metadata.json
  if (overrides.metadata !== null) {
    const meta = overrides.metadata ?? { name: 'test', version: '1.0.0', description: 'Test template' };
    await writeFile(join(dir, 'metadata.json'), JSON.stringify(meta));
  }

  // pipelines — default: 2 valid pipelines
  const pipelines = overrides.pipelines ?? {
    'pipe-one': 'name: pipe-one\nstages:\n  - name: s1\n    kind: analysis\n    agent: analyst\n    contract: output\n',
    'pipe-two': 'name: pipe-two\nstages:\n  - name: s2\n    kind: analysis\n    agent: analyst\n    contract: output\n',
  };
  for (const [name, content] of Object.entries(pipelines)) {
    await writeFile(join(projectDir, 'pipelines', `${name}.pipeline.yaml`), content);
  }

  // agents — default: 1 valid agent
  const agents = overrides.agents ?? {
    analyst: 'name: analyst\nprovider: anthropic\nmodel: claude-haiku-4-20250514\n',
  };
  for (const [name, content] of Object.entries(agents)) {
    await writeFile(join(projectDir, 'agents', `${name}.agent.yaml`), content);
  }

  // contracts — default: 1 valid contract
  const contracts = overrides.contracts ?? {
    output: 'name: output\nversion: 1\nschema:\n  required_fields:\n    - summary\n',
  };
  for (const [name, content] of Object.entries(contracts)) {
    await writeFile(join(projectDir, 'contracts', `${name}.contract.yaml`), content);
  }

  return dir;
}

beforeEach(async () => { await mkdir(TMP, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('validateTemplateDir — Level 1: Structural', () => {
  it('returns valid for a well-formed minimal template', async () => {
    const dir = await makeTemplate();
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(true);
    expect(result.structuralErrors).toHaveLength(0);
  });

  it('errors when directory does not exist', async () => {
    const result = await validateTemplateDir('/tmp/does-not-exist-xyz');
    expect(result.valid).toBe(false);
    expect(result.structuralErrors.some(e => e.includes('not found') || e.includes('does not exist'))).toBe(true);
  });

  it('errors when metadata.json is missing', async () => {
    const dir = await makeTemplate({ metadata: null });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.structuralErrors.some(e => e.includes('metadata.json'))).toBe(true);
  });

  it('errors when metadata.json is missing required field', async () => {
    const dir = await makeTemplate({ metadata: { name: 'test' } });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.structuralErrors.some(e => e.includes('version') || e.includes('description'))).toBe(true);
  });

  it('errors when fewer than 2 pipelines exist', async () => {
    const dir = await makeTemplate({
      pipelines: { 'only-one': 'name: only-one\nstages:\n  - name: s1\n    kind: analysis\n    agent: analyst\n    contract: output\n' },
    });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.structuralErrors.some(e => e.includes('pipeline') && e.includes('2'))).toBe(true);
  });

  it('errors when no agents exist', async () => {
    const dir = await makeTemplate({ agents: {} });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.structuralErrors.some(e => e.includes('agent'))).toBe(true);
  });
});

describe('validateTemplateDir — Level 2: Semantic', () => {
  it('errors on invalid YAML in a pipeline file', async () => {
    const dir = await makeTemplate({
      pipelines: {
        'pipe-one': 'name: pipe-one\nstages:\n  - name: s1\n    kind: analysis\n    agent: analyst\n    contract: output\n',
        'pipe-bad': ': invalid: yaml: [\n',
      },
    });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.semanticErrors.some(e => e.includes('pipe-bad'))).toBe(true);
  });

  it('errors when pipeline stage references a contract that does not exist', async () => {
    const dir = await makeTemplate({
      pipelines: {
        'pipe-one': 'name: pipe-one\nstages:\n  - name: s1\n    kind: analysis\n    agent: analyst\n    contract: output\n',
        'pipe-two': 'name: pipe-two\nstages:\n  - name: s2\n    kind: analysis\n    agent: analyst\n    contract: missing-contract\n',
      },
    });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.semanticErrors.some(e => e.includes('missing-contract'))).toBe(true);
  });

  it('errors when pipeline stage references an agent that does not exist', async () => {
    const dir = await makeTemplate({
      pipelines: {
        'pipe-one': 'name: pipe-one\nstages:\n  - name: s1\n    kind: analysis\n    agent: analyst\n    contract: output\n',
        'pipe-two': 'name: pipe-two\nstages:\n  - name: s2\n    kind: analysis\n    agent: missing-agent\n    contract: output\n',
      },
    });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.semanticErrors.some(e => e.includes('missing-agent'))).toBe(true);
  });

  it('validates stages inside groups', async () => {
    const dir = await makeTemplate({
      pipelines: {
        'pipe-one': 'name: pipe-one\nstages:\n  - name: s1\n    kind: analysis\n    agent: analyst\n    contract: output\n',
        'pipe-group': `name: pipe-group\nstages:\n  - group: my-group\n    max_iterations: 3\n    stages:\n      - name: s1\n        kind: analysis\n        agent: analyst\n        contract: output\n      - name: s2\n        kind: qa\n        agent: analyst\n        contract: ghost-contract\n`,
      },
    });
    const result = await validateTemplateDir(dir);
    expect(result.valid).toBe(false);
    expect(result.semanticErrors.some(e => e.includes('ghost-contract'))).toBe(true);
  });
});

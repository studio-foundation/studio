import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineEngine } from '../../src/engine.js';
import type { ProviderRegistry } from '@studio-foundation/runner';
import { InMemoryRunStore } from '../../src/state/run-store.js';
import { parsePipelineYaml } from '../../src/pipeline/loader.js';
import type { PipelineDefinition, RunSpawner, SpawnConfig, SpawnResult } from '@studio-foundation/contracts';

class FakeSpawner implements RunSpawner {
  calls: SpawnConfig[] = [];
  async spawnAndWait(config: SpawnConfig): Promise<SpawnResult> {
    this.calls.push(config);
    return { run_id: 'r', status: 'success', output: { page: (config.input as { entity: string }).entity } };
  }
}

const AGENT = (prompt: string, comment = '') => `${comment}name: writer
system_prompt: ${prompt}
skills: [style]
provider: mock
model: m
`;
const CONTRACT = (field: string, comment = '') => `${comment}name: page
version: 1
schema:
  required_fields:
    - ${field}
`;
const CHILD = `name: child
description: child
version: 1
stages:
  - name: write
    kind: generate
    agent: writer
    contract: page
`;

function parent(resume: unknown): PipelineDefinition {
  return {
    name: 'parent',
    description: 'p',
    version: 1,
    stages: [{ map: 'gen', over: 'input.items', pipeline: 'child', as: 'entity', resume } as unknown as PipelineDefinition["stages"][number]],
  };
}

describe('map resume.key_on', () => {
  let dir: string;
  const write = (rel: string, content: string) => writeFile(join(dir, rel), content);
  const run = async (resume: unknown) => {
    const spawner = new FakeSpawner();
    const engine = new PipelineEngine({
      configsDir: dir,
      providerRegistry: { get: vi.fn(), register: vi.fn() } as unknown as ProviderRegistry,
      db: new InMemoryRunStore(),
      spawner,
    });
    await engine.run({ pipelineDef: parent(resume), input: { items: ["a", "b"] } });
    return spawner.calls.length;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'map-resume-key-'));
    for (const d of ['pipelines', 'agents', 'contracts', 'skills']) await mkdir(join(dir, d));
    await write('pipelines/child.pipeline.yaml', CHILD);
    await write('agents/writer.agent.yaml', AGENT('be terse'));
    await write('contracts/page.contract.yaml', CONTRACT('title'));
    await write('skills/style.skill.md', 'Use short sentences.');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const both = { key_on: ['input', 'agent', 'contract'] };

  it('a comment-only or key-order edit of the agent and contract is a cache hit', async () => {
    expect(await run(both)).toBe(2);
    await write('agents/writer.agent.yaml', `model: m\nprovider: mock\nskills: [style]\nsystem_prompt: be terse\nname: writer\n# tuned\n`);
    await write('contracts/page.contract.yaml', CONTRACT('title', '# note\n'));
    expect(await run(both)).toBe(0);
  });

  it('changing the system prompt re-runs the items', async () => {
    expect(await run(both)).toBe(2);
    await write('agents/writer.agent.yaml', AGENT('be verbose'));
    expect(await run(both)).toBe(2);
  });

  it('changing a resolved skill re-runs the items', async () => {
    expect(await run(both)).toBe(2);
    await write('skills/style.skill.md', 'Use long sentences.');
    expect(await run(both)).toBe(2);
  });

  it('changing a contract field re-runs the items', async () => {
    expect(await run(both)).toBe(2);
    await write('contracts/page.contract.yaml', CONTRACT('body'));
    expect(await run(both)).toBe(2);
  });

  it('default key ignores agent and contract edits, and true equals key_on: [input]', async () => {
    expect(await run(true)).toBe(2);
    await write('agents/writer.agent.yaml', AGENT('be verbose'));
    await write('contracts/page.contract.yaml', CONTRACT('body'));
    expect(await run(true)).toBe(0);
    expect(await run({ key_on: ['input'] })).toBe(0);
    expect(await run({})).toBe(0);
  });


  it('a key_on contract-only key ignores agent edits', async () => {
    expect(await run({ key_on: ['input', 'contract'] })).toBe(2);
    await write('agents/writer.agent.yaml', AGENT('be verbose'));
    expect(await run({ key_on: ['input', 'contract'] })).toBe(0);
  });
});

describe('map resume loader validation', () => {
  const yamlWith = (resume: string) => `name: p
description: p
version: 1
stages:
  - map: gen
    over: input.items
    pipeline: child
    resume: ${resume}
`;
  it('accepts the object form', () => {
    const def = parsePipelineYaml(yamlWith('{ key_on: [input, agent] }'));
    expect((def.stages[0] as { resume: unknown }).resume).toEqual({ key_on: ['input', 'agent'] });
  });
  it('rejects an unknown key_on value, an unknown field, and a scalar', () => {
    expect(() => parsePipelineYaml(yamlWith('{ key_on: [prompt] }'))).toThrow(/key_on/);
    expect(() => parsePipelineYaml(yamlWith('{ keyon: [input] }'))).toThrow(/keyon/);
    expect(() => parsePipelineYaml(yamlWith('yes please'))).toThrow(/resume/);
  });
});

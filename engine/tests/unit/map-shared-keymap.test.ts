import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { PipelineEngine } from '../../src/engine.js';
import { DirectEngineSpawner } from '../../src/spawners/direct-engine-spawner.js';
import { ToolRegistry } from '@studio-foundation/runner';
import { InMemoryRunStore } from '../../src/state/run-store.js';

const PROJECT_DIR = join(import.meta.dirname, '..', 'fixtures', 'test-project-map-shared-keymap');
mkdirSync(join(PROJECT_DIR, 'pipelines'), { recursive: true });
mkdirSync(join(PROJECT_DIR, 'agents'), { recursive: true });
writeFileSync(join(PROJECT_DIR, 'agents', 'a.agent.yaml'), `
name: a
provider: anthropic
model: claude-sonnet-4-20250514
`);
writeFileSync(join(PROJECT_DIR, 'pipelines', 'child.pipeline.yaml'), `
name: child
description: child
version: 1
stages:
  - name: only
    kind: analysis
    agent: a
    ralph:
      max_attempts: 1
      retry_strategy: none
`);

async function runMap(keymap: 'shared' | 'per-run') {
  const provider = {
    name: 'anthropic',
    call: vi.fn(async () => ({
      content: '{}', tool_calls: [], finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })),
  };
  const config = {
    configsDir: PROJECT_DIR,
    providerRegistry: { get: vi.fn().mockReturnValue(provider), register: vi.fn() } as never,
    toolRegistry: new ToolRegistry(),
    db: new InMemoryRunStore(),
  };
  const engine = new PipelineEngine({ ...config, spawner: new DirectEngineSpawner(config) });
  const result = await engine.run({
    pipelineDef: {
      name: 'parent', description: 'parent', version: 1,
      stages: [{ map: 'fan', over: 'input.items', pipeline: 'child', input: { email: '{{item}}' }, anonymize: { keymap } }],
    } as never,
    input: { items: ['jane@example.com', 'bob@example.org', 'jane@example.com'] },
    anonymize: true,
  });
  const prompts = provider.call.mock.calls.map((c) => JSON.stringify(c).split('## Task')[1]);
  return { result, prompts };
}

describe('map anonymize.keymap', () => {
  it('shared: the same value gets the same token in every child, one parent keymap', async () => {
    const { result, prompts } = await runMap('shared');
    expect(result.status).toBe('success');
    expect(prompts.join('')).not.toContain('jane@example.com');
    const tokens = prompts.map((p) => p.match(/EMAIL_\d+/)?.[0]);
    expect(tokens[0]).toBe(tokens[2]);
    expect(tokens[0]).not.toBe(tokens[1]);
    const file = readdirSync(join(PROJECT_DIR, 'runs', 'anonymization')).find((f) => f.startsWith(result.id));
    expect(Object.values(JSON.parse(readFileSync(join(PROJECT_DIR, 'runs', 'anonymization', file!), 'utf-8'))).sort())
      .toEqual(['bob@example.org', 'jane@example.com']);
  });

  it('per-run (default): children are not handed the parent middleware', async () => {
    const { prompts } = await runMap('per-run');
    // today's behaviour: children are not handed the middleware, so they are not tokenized
    expect(prompts.join('')).toContain('jane@example.com');
    expect(prompts.join('')).not.toContain('EMAIL_');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PipelineEngine } from '../../src/engine.js';
import { InMemoryRunStore } from '../../src/state/run-store.js';

const PROJECT_DIR = join(import.meta.dirname, '..', 'fixtures', 'test-project-stage-anonymize-scope');
mkdirSync(join(PROJECT_DIR, 'pipelines'), { recursive: true });
mkdirSync(join(PROJECT_DIR, 'agents'), { recursive: true });

writeFileSync(join(PROJECT_DIR, 'agents', 'anon-agent.agent.yaml'), `
name: anon-agent
provider: anthropic
model: claude-sonnet-4-20250514
anonymize: true
`);
writeFileSync(join(PROJECT_DIR, 'pipelines', 'anon.pipeline.yaml'), `
name: anon
description: Agent-level anonymize with a run field scope
version: 1
stages:
  - name: only
    kind: analysis
    agent: anon-agent
    ralph:
      max_attempts: 1
      retry_strategy: none
`);

function runWith(anonymizeFields: string[] | undefined) {
  const provider = {
    name: 'anthropic',
    call: vi.fn(async () => ({
      content: '{}',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })),
  };
  const engine = new PipelineEngine({
    configsDir: PROJECT_DIR,
    providerRegistry: { get: vi.fn().mockReturnValue(provider), register: vi.fn() } as never,
    toolRegistry: {
      register: vi.fn(), get: vi.fn(), has: vi.fn().mockReturnValue(false), list: vi.fn().mockReturnValue([]),
      toToolDefinitions: vi.fn().mockReturnValue([]), filter: vi.fn().mockReturnThis(),
      getActiveSnippets: vi.fn().mockReturnValue([]),
    } as never,
    db: new InMemoryRunStore(),
  });
  return engine
    .run({ pipeline: 'anon', input: { email: 'jane@example.com', note: 'contact bob@example.org' } as never, anonymizeFields })
    .then(() => JSON.stringify(provider.call.mock.calls).split('## Task')[1]);
}

describe('agent-level anonymize honours the run field scope', () => {
  it('tokenizes only the scoped field', async () => {
    const prompt = await runWith(['email']);
    expect(prompt).not.toContain('jane@example.com');
    expect(prompt).toContain('bob@example.org');
  });

  it('tokenizes every field without a scope', async () => {
    const prompt = await runWith(undefined);
    expect(prompt).not.toContain('jane@example.com');
    expect(prompt).not.toContain('bob@example.org');
  });
});

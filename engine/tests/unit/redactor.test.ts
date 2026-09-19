import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PipelineEngine } from '../../src/engine.js';
import { InMemoryRunStore } from '../../src/state/run-store.js';

const PROJECT_DIR = join(import.meta.dirname, '..', 'fixtures', 'test-project-redactor');
mkdirSync(join(PROJECT_DIR, 'pipelines'), { recursive: true });
mkdirSync(join(PROJECT_DIR, 'agents'), { recursive: true });
writeFileSync(join(PROJECT_DIR, 'agents', 'a.agent.yaml'), `
name: a
provider: anthropic
model: claude-sonnet-4-20250514
`);
writeFileSync(join(PROJECT_DIR, 'pipelines', 'p.pipeline.yaml'), `
name: p
description: redactor
version: 1
stages:
  - name: only
    kind: analysis
    agent: a
    ralph:
      max_attempts: 1
      retry_strategy: none
`);

async function run(input: string | Record<string, unknown>, anonymizeFields?: string[]) {
  const provider = {
    name: 'anthropic',
    call: vi.fn(async () => ({
      content: '{}', tool_calls: [], finish_reason: 'stop',
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
  let redact: ((text: string) => string) | undefined;
  const result = await engine.run({
    pipeline: 'p', input, anonymize: true, anonymizeFields,
    onRedactor: (fn) => { redact = fn; },
  });
  return { raw: JSON.stringify(result), redact };
}

describe('run redactor', () => {
  it('replaces a scoped field value with its token and leaves out-of-scope values alone', async () => {
    const { raw, redact } = await run({ email: 'jane@example.com', note: 'contact bob@example.org' }, ['email']);
    expect(raw).toContain('jane@example.com');
    const redacted = redact!(raw);
    expect(redacted).not.toContain('jane@example.com');
    expect(redacted).toContain('EMAIL_1');
    expect(redacted).toContain('bob@example.org');
  });

  it('redacts a string input', async () => {
    const { raw, redact } = await run('write to jane@example.com');
    expect(redact!(raw)).not.toContain('jane@example.com');
  });
});

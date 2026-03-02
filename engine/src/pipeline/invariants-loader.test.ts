import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadInvariantsFile } from './invariants-loader.js';

const TMP = join('/tmp', '.studio-invariants-loader-test-' + Date.now());
const INVARIANTS_PATH = join(TMP, 'invariants.md');

describe('loadInvariantsFile', () => {
  beforeAll(async () => {
    await mkdir(TMP, { recursive: true });
    await writeFile(INVARIANTS_PATH, '# Domain Invariants\n\nNever reproduce verbatim passages.');
  });

  afterAll(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('returns file content when invariants.md exists', async () => {
    const content = await loadInvariantsFile(TMP);
    expect(content).toBe('# Domain Invariants\n\nNever reproduce verbatim passages.');
  });

  it('returns undefined when invariants.md does not exist', async () => {
    const content = await loadInvariantsFile('/tmp/no-such-studio-dir-xyz');
    expect(content).toBeUndefined();
  });
});

describe('invariants content is suitable for system_prompt injection', () => {
  it('non-empty content can be concatenated into a system_prompt string', async () => {
    const dir = join('/tmp', '.studio-invariants-integration-' + Date.now());
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'invariants.md'),
      '## Invariants\n\n- Never hallucinate entity names\n- Cite sources'
    );

    const content = await loadInvariantsFile(dir);

    expect(content).toBeDefined();
    expect(typeof content).toBe('string');
    expect(content!.length).toBeGreaterThan(0);

    const systemPrompt = `You are an agent.\n\n---\n\n## Project Invariants\n\n${content}`;
    expect(systemPrompt).toContain('Never hallucinate entity names');
    expect(systemPrompt).toContain('## Project Invariants');

    await rm(dir, { recursive: true, force: true });
  });
});

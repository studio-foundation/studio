import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

// Feature-builder E2E test
// "Add FAQ to About page" — this is THE test that must pass 10/10
//
// Requires:
// - API key (ANTHROPIC_API_KEY)
// - A test repo to modify
// - All pipeline infrastructure running
//
// Unskip when everything is fully connected

describe.skip('feature-builder E2E', () => {
  const ROOT = join(import.meta.dirname, '..', '..');

  it('should add FAQ section to About page', async () => {
    const { PipelineEngine } = await import('../../src/engine.js');
    const { InMemoryRunStore } = await import('../../src/state/run-store.js');
    const { ToolRegistry, createRepoManagerTools, createShellTools, createSearchTools } = await import('@studio-foundation/runner');
    const { createDefaultRegistry } = await import('@studio-foundation/runner');

    // Setup tools
    const toolRegistry = new ToolRegistry();
    const testRepoPath = '/tmp/studio-test-repo'; // TODO: create temp repo
    for (const tool of createRepoManagerTools(testRepoPath)) {
      toolRegistry.register(tool);
    }
    for (const tool of createShellTools(testRepoPath)) {
      toolRegistry.register(tool);
    }
    for (const tool of createSearchTools(testRepoPath)) {
      toolRegistry.register(tool);
    }

    const providerRegistry = createDefaultRegistry({
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    });

    const engine = new PipelineEngine({
      configsDir: join(ROOT, 'configs'),
      repoPath: testRepoPath,
      providerRegistry,
      toolRegistry,
      db: new InMemoryRunStore(),
    });

    const result = await engine.run({
      pipeline: 'software/feature-builder',
      input: 'Add a FAQ section to the About page',
    });

    expect(result.status).toBe('success');
    expect(result.stages).toHaveLength(4);
    expect(result.stages.every(s => s.status === 'success')).toBe(true);
  });
});

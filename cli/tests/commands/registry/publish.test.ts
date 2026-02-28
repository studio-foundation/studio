import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const TMP = resolve(import.meta.dirname, '.tmp-publish');

const VALID_METADATA = JSON.stringify({
  name: 'my-tool',
  version: '1.0.0',
  description: 'My custom tool',
  author: 'test-user',
  license: 'MIT',
  type: 'tool',
  tags: ['test'],
  studio_version: '>=7.0.0',
}, null, 2);

beforeEach(async () => { await mkdir(TMP, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('validatePublishPayload', () => {
  it('accepts valid single-file package with metadata.json in same dir', async () => {
    const toolPath = join(TMP, 'my-tool.tool.yaml');
    await writeFile(toolPath, 'name: my-tool\n');
    await writeFile(join(TMP, 'metadata.json'), VALID_METADATA);

    const { validatePublishPayload } = await import('../../../src/commands/registry/publish.js');
    const result = await validatePublishPayload(toolPath);
    expect(result.name).toBe('my-tool');
    expect(result.type).toBe('tool');
  });

  it('rejects when metadata.json is missing', async () => {
    const toolPath = join(TMP, 'sub', 'my-tool.tool.yaml');
    await mkdir(join(TMP, 'sub'), { recursive: true });
    await writeFile(toolPath, 'name: my-tool\n');
    // No metadata.json

    const { validatePublishPayload } = await import('../../../src/commands/registry/publish.js');
    await expect(validatePublishPayload(toolPath)).rejects.toThrow('metadata.json');
  });

  it('rejects when metadata is missing required fields', async () => {
    const toolPath = join(TMP, 'my-tool.tool.yaml');
    await writeFile(toolPath, 'name: my-tool\n');
    await writeFile(join(TMP, 'metadata.json'), JSON.stringify({ name: 'my-tool' }));

    const { validatePublishPayload } = await import('../../../src/commands/registry/publish.js');
    await expect(validatePublishPayload(toolPath)).rejects.toThrow('Missing required');
  });

  it('rejects when package file does not exist', async () => {
    const { validatePublishPayload } = await import('../../../src/commands/registry/publish.js');
    await expect(validatePublishPayload(join(TMP, 'nonexistent.tool.yaml'))).rejects.toThrow('does not exist');
  });
});

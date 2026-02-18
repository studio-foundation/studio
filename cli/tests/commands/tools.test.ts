import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { listTools, getToolsDir } from '../../src/commands/tools.js';

const TMP = resolve(import.meta.dirname, '.tmp-tools-test');
const STUDIO_DIR = resolve(TMP, '.studio');

beforeEach(async () => { await mkdir(STUDIO_DIR, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('listTools', () => {
  it('returns empty array when no tools dir', async () => {
    const result = await listTools(resolve(STUDIO_DIR, 'projects', 'myproject', 'tools'));
    expect(result).toEqual([]);
  });

  it('finds .tool.yaml files', async () => {
    const toolsDir = resolve(STUDIO_DIR, 'projects', 'myproject', 'tools');
    await mkdir(toolsDir, { recursive: true });
    await writeFile(resolve(toolsDir, 'git.tool.yaml'), 'name: git\n');
    await writeFile(resolve(toolsDir, 'other.txt'), 'ignored\n');
    const result = await listTools(toolsDir);
    expect(result).toEqual(['git']);
  });
});

describe('getToolsDir', () => {
  it('resolves tools dir from studioDir and project', () => {
    const dir = getToolsDir(STUDIO_DIR, 'software');
    expect(dir).toBe(resolve(STUDIO_DIR, 'projects', 'software', 'tools'));
  });
});

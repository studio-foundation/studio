import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { listTools, getToolsDir, listAvailableTools } from '../../src/commands/tools.js';

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

describe('listAvailableTools', () => {
  it('returns all available tool templates', async () => {
    const tools = await listAvailableTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('git');
    expect(names).toContain('repo-manager');
    expect(names).toContain('shell');
    expect(names).toContain('search');
  });

  it('returns description for each tool', async () => {
    const tools = await listAvailableTools();
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it('returns tools sorted by name', async () => {
    const tools = await listAvailableTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });
});

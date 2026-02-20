import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { listTools, getToolsDir, listAvailableTools, toolsAddDirect } from '../../src/commands/tools.js';

const TMP = resolve(import.meta.dirname, '.tmp-tools-test');
const STUDIO_DIR = resolve(TMP, '.studio');

beforeEach(async () => { await mkdir(STUDIO_DIR, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('listTools', () => {
  it('returns empty array when no tools dir', async () => {
    const result = await listTools(resolve(STUDIO_DIR, 'tools'));
    expect(result).toEqual([]);
  });

  it('finds .tool.yaml files', async () => {
    const toolsDir = resolve(STUDIO_DIR, 'tools');
    await mkdir(toolsDir, { recursive: true });
    await writeFile(resolve(toolsDir, 'git.tool.yaml'), 'name: git\n');
    await writeFile(resolve(toolsDir, 'other.txt'), 'ignored\n');
    const result = await listTools(toolsDir);
    expect(result).toEqual(['git']);
  });
});

describe('getToolsDir', () => {
  it('resolves tools dir from studioDir', () => {
    const dir = getToolsDir(STUDIO_DIR);
    expect(dir).toBe(resolve(STUDIO_DIR, 'tools'));
  });
});

const TOOLS_TMP = resolve('/tmp', '.studio-tools-add-test-' + Math.floor(Date.now() / 1000));
const TOOLS_STUDIO_DIR = resolve(TOOLS_TMP, '.studio');

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe('toolsAddDirect', () => {
  beforeEach(async () => {
    await mkdir(TOOLS_STUDIO_DIR, { recursive: true });
  });
  afterEach(async () => {
    await rm(TOOLS_TMP, { recursive: true, force: true });
  });

  it('installs a single valid tool', async () => {
    const result = await toolsAddDirect(TOOLS_STUDIO_DIR, ['git']);
    expect(result.installed).toEqual(['git']);
    expect(result.skipped).toEqual([]);
    const toolPath = resolve(TOOLS_STUDIO_DIR, 'tools', 'git.tool.yaml');
    expect(await fileExists(toolPath)).toBe(true);
  });

  it('installs multiple tools in one call', async () => {
    const result = await toolsAddDirect(TOOLS_STUDIO_DIR, ['git', 'shell']);
    expect(result.installed).toContain('git');
    expect(result.installed).toContain('shell');
    expect(result.skipped).toEqual([]);
  });

  it('skips already-installed tool and returns it in skipped list', async () => {
    await toolsAddDirect(TOOLS_STUDIO_DIR, ['git']);
    const result = await toolsAddDirect(TOOLS_STUDIO_DIR, ['git', 'shell']);
    expect(result.installed).toEqual(['shell']);
    expect(result.skipped).toEqual(['git']);
  });

  it('throws on unknown tool name', async () => {
    await expect(toolsAddDirect(TOOLS_STUDIO_DIR, ['nonexistent'])).rejects.toThrow("Unknown tool 'nonexistent'");
  });

  it('creates tools dir if it does not exist', async () => {
    const result = await toolsAddDirect(TOOLS_STUDIO_DIR, ['search']);
    expect(result.installed).toEqual(['search']);
    expect(await fileExists(resolve(TOOLS_STUDIO_DIR, 'tools', 'search.tool.yaml'))).toBe(true);
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

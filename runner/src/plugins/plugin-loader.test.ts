import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlugins } from './plugin-loader.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'studio-plugin-test-'));

  // Plugin 1: code-review — has .mcp.json + skills
  const plugin1 = join(tmpDir, 'code-review');
  await mkdir(join(plugin1, 'skills'), { recursive: true });
  await writeFile(
    join(plugin1, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@mcp/server-github'] },
      },
    })
  );
  await writeFile(
    join(plugin1, 'skills', 'review-guidelines.skill.md'),
    '# Review Guidelines\n\nAlways check for security issues.'
  );
  await writeFile(
    join(plugin1, 'skills', 'security-checklist.skill.md'),
    '# Security Checklist\n\n- Check SQL injection\n- Check XSS'
  );

  // Plugin 2: analysis — skills only, no .mcp.json
  const plugin2 = join(tmpDir, 'analysis');
  await mkdir(join(plugin2, 'skills'), { recursive: true });
  await writeFile(
    join(plugin2, 'skills', 'analysis-tips.skill.md'),
    '# Analysis Tips\n\nBe thorough.'
  );

  // Plugin 3: empty — no .mcp.json, no skills
  await mkdir(join(tmpDir, 'empty-plugin'));

  // Plugin 4: flat-plugin — flat .mcp.json (Claude Code format, no mcpServers wrapper)
  const plugin4 = join(tmpDir, 'flat-plugin');
  await mkdir(plugin4, { recursive: true });
  await writeFile(
    join(plugin4, '.mcp.json'),
    JSON.stringify({
      context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    })
  );
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('loadPlugins', () => {
  it('returns empty array when plugins dir does not exist', async () => {
    const result = await loadPlugins('/nonexistent/path/to/plugins');
    expect(result).toEqual([]);
  });

  it('loads all plugin directories', async () => {
    const result = await loadPlugins(tmpDir);
    expect(result).toHaveLength(4);
    const names = result.map((p) => p.name).sort();
    expect(names).toEqual(['analysis', 'code-review', 'empty-plugin', 'flat-plugin']);
  });

  it('parses .mcp.json into mcpServers', async () => {
    const result = await loadPlugins(tmpDir);
    const codeReview = result.find((p) => p.name === 'code-review')!;
    expect(codeReview.mcpServers).toEqual({
      github: { command: 'npx', args: ['-y', '@mcp/server-github'] },
    });
  });

  it('sets mcpServers to empty object when no .mcp.json', async () => {
    const result = await loadPlugins(tmpDir);
    const analysis = result.find((p) => p.name === 'analysis')!;
    expect(analysis.mcpServers).toEqual({});
  });

  it('loads skill files sorted by name', async () => {
    const result = await loadPlugins(tmpDir);
    const codeReview = result.find((p) => p.name === 'code-review')!;
    expect(codeReview.skills).toHaveLength(2);
    expect(codeReview.skills[0].name).toBe('review-guidelines');
    expect(codeReview.skills[0].content).toContain('Review Guidelines');
    expect(codeReview.skills[1].name).toBe('security-checklist');
  });

  it('returns empty skills array when no skills dir', async () => {
    const result = await loadPlugins(tmpDir);
    const empty = result.find((p) => p.name === 'empty-plugin')!;
    expect(empty.skills).toEqual([]);
    expect(empty.mcpServers).toEqual({});
  });

  it('sets path to absolute path of plugin directory', async () => {
    const result = await loadPlugins(tmpDir);
    const codeReview = result.find((p) => p.name === 'code-review')!;
    expect(codeReview.path).toBe(join(tmpDir, 'code-review'));
  });

  it('parses flat .mcp.json without mcpServers wrapper — Claude Code format', async () => {
    const result = await loadPlugins(tmpDir);
    const flatPlugin = result.find((p) => p.name === 'flat-plugin')!;
    expect(flatPlugin.mcpServers).toEqual({
      context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    });
  });
});

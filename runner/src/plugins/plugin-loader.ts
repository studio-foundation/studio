import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';

export type MCPServerDef =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      auth?: { type: 'oauth'; client_id?: string; client_secret?: string; scope?: string };
    };

export interface SkillContent {
  name: string;    // filename without .skill.md
  content: string; // markdown content
}

export interface PluginManifest {
  name: string;
  path: string;
  mcpServers: Record<string, MCPServerDef>;
  skills: SkillContent[];
}

export async function loadPlugins(pluginsDir: string): Promise<PluginManifest[]> {
  if (!existsSync(pluginsDir)) return [];

  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const manifests: PluginManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginPath = join(pluginsDir, entry.name);
    manifests.push(await loadPlugin(entry.name, pluginPath));
  }
  return manifests;
}

async function loadPlugin(name: string, pluginPath: string): Promise<PluginManifest> {
  const mcpPath = join(pluginPath, '.mcp.json');
  let mcpServers: Record<string, MCPServerDef> = {};
  if (existsSync(mcpPath)) {
    try {
      const raw = await readFile(mcpPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Support both .mcp.json formats:
      // 1. Wrapped Studio format: { "mcpServers": { "serverName": { ... } } }
      // 2. Flat Claude Code format: { "serverName": { ... } }
      // This ensures compatibility with both Studio MCP configurations and
      // plugins from the Claude Code sandbox that use the flat format.
      // Fixes STU-122: Plugin loader should support both .mcp.json formats
      if ('mcpServers' in parsed && parsed.mcpServers !== null && typeof parsed.mcpServers === 'object') {
        mcpServers = parsed.mcpServers as Record<string, MCPServerDef>;
      } else {
        mcpServers = parsed as Record<string, MCPServerDef>;
      }
    } catch {
      // Malformed .mcp.json — skip silently
    }
  }

  const skills = await loadSkillFiles(join(pluginPath, 'skills'));
  return { name, path: pluginPath, mcpServers, skills };
}

async function loadSkillFiles(skillsDir: string): Promise<SkillContent[]> {
  if (!existsSync(skillsDir)) return [];

  let files: string[];
  try {
    files = await readdir(skillsDir);
  } catch {
    return [];
  }

  const skillFiles = files.filter((f) => f.endsWith('.skill.md')).sort();
  const skills: SkillContent[] = [];
  for (const file of skillFiles) {
    const content = await readFile(join(skillsDir, file), 'utf-8');
    skills.push({ name: basename(file, '.skill.md'), content });
  }
  return skills;
}

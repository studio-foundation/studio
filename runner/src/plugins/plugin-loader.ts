import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
      // Support both wrapped format { mcpServers: { ... } } and flat Claude Code format { serverName: { ... } }
      mcpServers = ('mcpServers' in parsed && parsed.mcpServers !== null && typeof parsed.mcpServers === 'object')
        ? (parsed.mcpServers as Record<string, MCPServerDef>)
        : (parsed as Record<string, MCPServerDef>);
    } catch {
      // handle parsing error
    }
  }
  return { name, path: pluginPath, mcpServers, skills: [] };
}
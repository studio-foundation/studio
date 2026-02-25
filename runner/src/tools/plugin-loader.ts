// runner/src/tools/plugin-loader.ts
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { ToolPluginDef, ToolCommandDef } from '@studio/contracts';
import type { Tool } from './tool-registry.js';
import { renderTemplate, executeShellCommand } from './yaml-executor.js';
import { createRepoManagerTools } from './builtin/repo-manager.js';
import { createShellTools } from './builtin/shell.js';
import { createSearchTools } from './builtin/search.js';
import { createPatchTools } from './builtin/patch.js';
import { createGitTools } from './builtin/git.js';
import { ToolYamlError } from './errors.js';

export interface LoadedPlugin {
  name: string;
  tools: Tool[];
  promptSnippet?: string;
}

/** Build a map of tool name → Tool from all builtin factories. */
function buildBuiltinMap(repoPath: string): Map<string, Tool> {
  const map = new Map<string, Tool>();
  const add = (tools: Tool[]) => tools.forEach(t => map.set(t.name, t));
  add(createRepoManagerTools(repoPath));
  add(createShellTools(repoPath));
  add(createSearchTools(repoPath));
  add(createPatchTools(repoPath));
  add(createGitTools(repoPath));
  return map;
}

/** Convert a ParameterDef map to a JSON Schema object for the LLM. */
function buildJsonSchema(
  parameters: ToolCommandDef['parameters']
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, def] of Object.entries(parameters ?? {})) {
    properties[key] = {
      type: def.type,
      ...(def.description ? { description: def.description } : {}),
      ...(def.type === 'array' && def.items ? { items: def.items } : {}),
    };
    if (def.required) required.push(key);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** Template keywords that appear as {{word}} but are not parameter names.
 *  Note: block tags like {{#if}} and {{/if}} are already excluded because
 *  '#' and '/' are not matched by [\w-]+. */
const TEMPLATE_KEYWORDS = new Set(['else']);

/**
 * Validate that every {{placeholder}} in a shell command template
 * is declared in the command's parameters.
 * Throws ToolYamlError if any undeclared placeholder is found.
 */
function validateShellTemplate(fileName: string, cmd: ToolCommandDef): void {
  const exec = cmd.execute as { type: string; command?: string };
  if (exec.type !== 'shell' || !exec.command) return;

  const declared = new Set(Object.keys(cmd.parameters ?? {}));
  const used = new Set<string>();

  for (const match of exec.command.matchAll(/\{\{([\w-]+)\}\}/g)) {
    const name = match[1];
    if (!TEMPLATE_KEYWORDS.has(name)) used.add(name);
  }

  const unknown = [...used].filter(p => !declared.has(p));
  if (unknown.length > 0) {
    throw new ToolYamlError(
      `${fileName} › command '${cmd.name}':\n` +
      `  template uses ${unknown.map(p => `{{${p}}}`).join(', ')} but no such parameter is declared.\n` +
      `  Declared parameters: ${[...declared].join(', ') || '(none)'}`
    );
  }
}

/** Create a Tool that renders the command template and runs it in a shell. */
function createShellTool(cmd: ToolCommandDef, repoPath: string, configsDir: string): Tool {
  const exec = cmd.execute as { type: 'shell'; command: string; parse_output?: 'text' | 'json'; timeout_ms?: number };
  return {
    name: cmd.name,
    description: cmd.description,
    parameters: buildJsonSchema(cmd.parameters),
    async execute(args) {
      const rendered = renderTemplate(exec.command, args);
      return executeShellCommand(rendered, exec.parse_output ?? 'text', repoPath, exec.timeout_ms, { STUDIO_CONFIG_DIR: configsDir });
    },
  };
}

/**
 * Load all `.tool.yaml` files from a project's tools directory.
 * Returns an empty array if the directory does not exist.
 */
export async function loadProjectTools(
  toolsDir: string,
  repoPath: string
): Promise<LoadedPlugin[]> {
  if (!existsSync(toolsDir)) return [];

  let files: string[];
  try {
    files = (await readdir(toolsDir)).filter(f => f.endsWith('.tool.yaml'));
  } catch {
    return [];
  }

  if (files.length === 0) return [];

  const configsDir = resolve(dirname(toolsDir));
  const builtinMap = buildBuiltinMap(repoPath);
  const plugins: LoadedPlugin[] = [];

  for (const file of files.sort()) {
    const content = await readFile(resolve(toolsDir, file), 'utf-8');
    const def = yaml.load(content) as ToolPluginDef;

    const tools: Tool[] = [];
    for (const cmd of def.commands ?? []) {
      if (cmd.execute.type === 'builtin') {
        const tool = builtinMap.get(cmd.name);
        if (tool) tools.push(tool);
        // If unknown builtin name, skip silently (no crash)
      } else {
        validateShellTemplate(file, cmd);
        tools.push(createShellTool(cmd, repoPath, configsDir));
      }
    }

    plugins.push({
      name: def.name,
      tools,
      promptSnippet: def.prompt_snippet,
    });
  }

  return plugins;
}

const BUNDLED_TOOL_TEMPLATES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../templates/tools'
);

/** Names of built-in tool plugins (ship with Studio). */
export const BUILTIN_TOOL_NAMES = new Set([
  'repo-manager',
  'shell',
  'search',
  'git',
]);

/**
 * List all tool plugins available for installation from the bundled registry.
 * Returns an array of { name, description } objects.
 */
export async function listAvailableToolTemplates(): Promise<{ name: string; description: string }[]> {
  let files: string[];
  try {
    files = (await readdir(BUNDLED_TOOL_TEMPLATES_DIR)).filter(f => f.endsWith('.tool.yaml')).sort();
  } catch {
    return [];
  }
  const result: { name: string; description: string }[] = [];
  for (const file of files) {
    const content = await readFile(resolve(BUNDLED_TOOL_TEMPLATES_DIR, file), 'utf-8');
    const def = yaml.load(content) as ToolPluginDef;
    result.push({ name: file.replace('.tool.yaml', ''), description: def.description ?? '' });
  }
  return result;
}

/**
 * Return the raw YAML content of a bundled tool template by name.
 * Returns null if the tool does not exist in the bundled registry.
 */
export async function getBundledToolTemplate(name: string): Promise<string | null> {
  const filePath = resolve(BUNDLED_TOOL_TEMPLATES_DIR, `${name}.tool.yaml`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

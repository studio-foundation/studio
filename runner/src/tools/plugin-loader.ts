// runner/src/tools/plugin-loader.ts
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import yaml from 'js-yaml';
import type { ToolPluginDef, ToolCommandDef } from '@studio-foundation/contracts';
import type { Tool } from './tool-registry.js';
import { renderTemplate, executeShellCommand } from './yaml-executor.js';
import { createRepoManagerTools } from './builtin/repo-manager.js';
import { createShellTools } from './builtin/shell.js';
import { createPatchTools } from './builtin/patch.js';
import { ToolYamlError } from './errors.js';
import { BUNDLED_ASSETS } from '../generated/bundled-assets.js';

export interface LoadedPlugin {
  name: string;
  tools: Tool[];
  promptSnippet?: string;
  requiresBinaries?: string[];
}

/** Build a map of tool name → Tool from all builtin factories. */
function buildBuiltinMap(repoPath: string): Map<string, Tool> {
  const map = new Map<string, Tool>();
  const add = (tools: Tool[]) => tools.forEach(t => map.set(t.name, t));
  add(createRepoManagerTools(repoPath));
  add(createShellTools(repoPath));
  add(createPatchTools(repoPath));
  return map;
}

/** Convert a ParameterDef map to a JSON Schema object for the LLM.
 *
 * A `from_context` parameter is omitted entirely — the model never sees it,
 * so it cannot supply one (STU-762).
 */
function buildJsonSchema(
  parameters: ToolCommandDef['parameters']
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, def] of Object.entries(parameters ?? {})) {
    if (def.from_context) continue;
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

/** Walk a dot-path (e.g. `input.book_dir`) into a resolved context object. */
function resolveContextPath(context: unknown, path: string): unknown {
  let current: unknown = context;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
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
  const contextParams = Object.entries(cmd.parameters ?? {}).filter(([, def]) => def.from_context);
  return {
    name: cmd.name,
    description: cmd.description,
    parameters: buildJsonSchema(cmd.parameters),
    async execute(args, resolvedContext) {
      const merged = { ...args };
      for (const [key, def] of contextParams) {
        const value = resolveContextPath(resolvedContext, def.from_context!);
        if (value === undefined) {
          throw new Error(
            `Tool ${cmd.name}: parameter '${key}' declares from_context: ${def.from_context}, ` +
            `which did not resolve against this stage's context`
          );
        }
        merged[key] = value;
      }
      const rendered = renderTemplate(exec.command, merged);
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
      requiresBinaries: def.constraints?.requires_binaries,
    });
  }

  return plugins;
}

const TOOL_TEMPLATE_PREFIX = 'tools/';
const TOOL_TEMPLATE_SUFFIX = '.tool.yaml';

/**
 * The tool plugins the kernel owns. A tool stays here only if it is primitive,
 * carries no domain choice, and `studio run` cannot work without it — everything
 * else is a marketplace plugin (INV-11). Mirrors runner/templates/tools/*.tool.yaml.
 * `patch` ships inside repo-manager; `studio_run` is wired by the engine.
 */
export const BUILTIN_TOOL_NAMES = new Set([
  'repo-manager',
  'shell',
]);

/**
 * List all tool plugins available for installation from the bundled registry.
 * Returns an array of { name, description } objects.
 */
export function listAvailableToolTemplates(): { name: string; description: string }[] {
  return Object.keys(BUNDLED_ASSETS)
    .filter(key => key.startsWith(TOOL_TEMPLATE_PREFIX) && key.endsWith(TOOL_TEMPLATE_SUFFIX))
    .sort()
    .map(key => ({
      name: key.slice(TOOL_TEMPLATE_PREFIX.length, -TOOL_TEMPLATE_SUFFIX.length),
      description: (yaml.load(BUNDLED_ASSETS[key]) as ToolPluginDef).description ?? '',
    }));
}

/**
 * Return the raw YAML content of a bundled tool template by name.
 * Returns null if the tool does not exist in the bundled registry.
 */
export function getBundledToolTemplate(name: string): string | null {
  return BUNDLED_ASSETS[`${TOOL_TEMPLATE_PREFIX}${name}${TOOL_TEMPLATE_SUFFIX}`] ?? null;
}

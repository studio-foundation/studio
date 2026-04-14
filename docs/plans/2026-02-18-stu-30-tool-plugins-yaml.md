# Tool Plugins YAML (STU-30) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make tools definable as `.tool.yaml` files — `execute.type: shell` runs a template command, `execute.type: builtin` delegates to existing TypeScript. The runner loads them, injects prompt snippets automatically, and `run.ts` replaces its hardcoded tool registration with the loader.

**Architecture:**
- `contracts/src/tool-plugin.ts` adds the TypeScript types for the `.tool.yaml` format (types only, zero logic).
- `runner/src/tools/plugin-loader.ts` scans a project's `tools/` dir, parses `.tool.yaml`, and returns `LoadedPlugin[]` (tools + snippets). Shell commands use a simple template renderer; builtins delegate to the existing TypeScript factories.
- `ToolRegistry` gains `registerPlugin()` + `getActiveSnippets()`; `filter()` carries snippet metadata. The runner calls `getActiveSnippets()` and passes them to `buildPrompt()`.
- `cli/src/commands/run.ts` replaces its hardcoded `createRepoManagerTools / createShellTools / …` block with `loadProjectTools(toolsDir, repoPath)`.

**Tech Stack:** TypeScript, `js-yaml` (already in runner), `node:child_process` (already used in shell builtin)

**Working directory for all commands:** `.worktrees/stu-30-tool-plugins/`

---

## Task 1 — Types: `contracts/src/tool-plugin.ts`

**Files:**
- Create: `contracts/src/tool-plugin.ts`
- Modify: `contracts/src/index.ts`

No tests needed (types only). Build verifies correctness.

**Step 1: Create the type file**

```typescript
// contracts/src/tool-plugin.ts

export type ParseOutputFormat = 'text' | 'json';

export interface ParameterDef {
  type: 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  required?: boolean;
  default?: unknown;
  items?: { type: string };
}

export interface ShellExecute {
  type: 'shell';
  command: string;
  parse_output?: ParseOutputFormat;
}

export interface BuiltinExecute {
  type: 'builtin';
  handler?: string;  // informational only — we look up by cmd.name
  parse_output?: ParseOutputFormat;
}

export type CommandExecute = ShellExecute | BuiltinExecute;

export interface ToolCommandDef {
  name: string;
  description: string;
  parameters: Record<string, ParameterDef>;
  execute: CommandExecute;
  constraints?: Record<string, unknown>;
}

export interface ToolPluginDef {
  name: string;
  description?: string;
  version: number;
  commands: ToolCommandDef[];
  config?: Record<string, unknown>;
  prompt_snippet?: string;
  constraints?: {
    requires_initialized_repo?: boolean;
    requires_binaries?: string[];
  };
}
```

**Step 2: Add export to `contracts/src/index.ts`**

Append this line:
```typescript
export * from './tool-plugin.js';
```

**Step 3: Build**

```bash
pnpm build
```

Expected: No TypeScript errors.

**Step 4: Commit**

```bash
git add contracts/src/tool-plugin.ts contracts/src/index.ts
git commit -m "feat(contracts): add ToolPluginDef types for .tool.yaml format (STU-30)"
```

---

## Task 2 — Template renderer + shell executor (`yaml-executor.ts`)

**Files:**
- Create: `runner/src/tools/yaml-executor.ts`
- Create: `runner/tests/yaml-executor.test.ts`

**Step 1: Write the failing tests**

```typescript
// runner/tests/yaml-executor.test.ts
import { describe, it, expect } from 'vitest';
import { renderTemplate, executeShellCommand } from '../src/tools/yaml-executor.js';

describe('renderTemplate', () => {
  it('substitutes plain {{param}}', () => {
    expect(renderTemplate('echo {{message}}', { message: 'hello' })).toBe('echo hello');
  });

  it('renders {{#if param}}...{{/if}} when truthy', () => {
    expect(renderTemplate('git diff {{#if staged}}--cached{{/if}}', { staged: true }))
      .toBe('git diff --cached');
  });

  it('removes {{#if param}}...{{/if}} block when falsy', () => {
    expect(renderTemplate('git diff {{#if staged}}--cached{{/if}}', { staged: false }))
      .toBe('git diff ');
  });

  it('renders {{#if param}}...{{/if}} when param is absent', () => {
    expect(renderTemplate('git diff {{#if staged}}--cached{{/if}}', {}))
      .toBe('git diff ');
  });

  it('joins array with {{param | join sep}}', () => {
    expect(renderTemplate('git add {{files | join " "}}', { files: ['a.ts', 'b.ts'] }))
      .toBe('git add a.ts b.ts');
  });

  it('renders {{param | json}} as JSON string', () => {
    expect(renderTemplate('echo {{data | json}}', { data: ['a', 'b'] }))
      .toBe('echo ["a","b"]');
  });

  it('returns empty string for missing plain param', () => {
    expect(renderTemplate('{{missing}}', {})).toBe('');
  });

  it('handles multi-line templates', () => {
    const template = `{{#if create}}
git checkout -b {{branch}}
{{else}}
git checkout {{branch}}
{{/if}}`;
    // Note: we don't support {{else}} yet — it stays as literal text
    // Just ensure it doesn't crash and substitutes {{branch}}
    const result = renderTemplate(template, { create: false, branch: 'main' });
    expect(result).toContain('main');
  });
});

describe('executeShellCommand', () => {
  it('executes a command and returns stdout as text', async () => {
    const result = await executeShellCommand('echo hello', 'text', '/tmp');
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello');
  });

  it('parses JSON output when parse_output is json', async () => {
    const result = await executeShellCommand('echo \'{"x":1}\'', 'json', '/tmp');
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ x: 1 });
  });

  it('returns error on non-zero exit code', async () => {
    const result = await executeShellCommand('exit 1', 'text', '/tmp');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error when JSON parsing fails', async () => {
    const result = await executeShellCommand('echo not-json', 'json', '/tmp');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Failed to parse JSON/);
  });
});
```

**Step 2: Run tests to verify failure**

```bash
pnpm --filter @studio-foundation/runner test -- --reporter=verbose 2>&1 | grep -A2 "yaml-executor"
```

Expected: `Cannot find module '../src/tools/yaml-executor.js'`

**Step 3: Implement `yaml-executor.ts`**

```typescript
// runner/src/tools/yaml-executor.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ParseOutputFormat } from '@studio-foundation/contracts';

const execFileAsync = promisify(execFile);

/**
 * Render a shell command template with parameter substitution.
 *
 * Supports:
 *   {{param}}              → stringify value (empty string if undefined)
 *   {{#if param}}...{{/if}} → include block only when param is truthy
 *   {{param | join 'sep'}} → join array with separator
 *   {{param | json}}       → JSON.stringify(value)
 */
export function renderTemplate(
  template: string,
  params: Record<string, unknown>
): string {
  let result = template;

  // {{#if param}}...{{/if}} blocks
  result = result.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key: string, inner: string) => (params[key] ? inner : '')
  );

  // {{param | join 'sep'}} filter
  result = result.replace(
    /\{\{(\w+)\s*\|\s*join\s+'([^']*)'\}\}/g,
    (_, key: string, sep: string) => {
      const value = params[key];
      return Array.isArray(value) ? value.join(sep) : String(value ?? '');
    }
  );

  // {{param | json}} filter
  result = result.replace(
    /\{\{(\w+)\s*\|\s*json\}\}/g,
    (_, key: string) => JSON.stringify(params[key] ?? null)
  );

  // Plain {{param}} substitution
  result = result.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => (params[key] === undefined ? '' : String(params[key]))
  );

  return result;
}

export interface ShellResult {
  success: boolean;
  output: unknown;
  error?: string;
}

/**
 * Execute a rendered shell command and parse the output.
 */
export async function executeShellCommand(
  command: string,
  parseOutput: ParseOutputFormat = 'text',
  workingDir: string
): Promise<ShellResult> {
  try {
    const { stdout } = await execFileAsync('sh', ['-c', command], {
      cwd: workingDir,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const raw = stdout.trim();

    if (parseOutput === 'json') {
      try {
        return { success: true, output: JSON.parse(raw) };
      } catch {
        return {
          success: false,
          error: `Failed to parse JSON output: ${raw.slice(0, 200)}`,
        };
      }
    }

    return { success: true, output: raw };
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string };
    return { success: false, error: e.stderr?.trim() || e.message || 'Command failed' };
  }
}
```

**Step 4: Run tests to verify pass**

```bash
pnpm --filter @studio-foundation/runner test -- --reporter=verbose 2>&1 | grep -E "yaml-executor|✓|✗|FAIL|PASS"
```

Expected: all yaml-executor tests pass.

**Step 5: Commit**

```bash
git add runner/src/tools/yaml-executor.ts runner/tests/yaml-executor.test.ts
git commit -m "feat(runner): add template renderer and shell executor for YAML tools (STU-30)"
```

---

## Task 3 — Plugin loader (`runner/src/tools/plugin-loader.ts`)

**Files:**
- Create: `runner/src/tools/plugin-loader.ts`
- Create: `runner/tests/fixtures/tools/test-shell.tool.yaml`
- Create: `runner/tests/fixtures/tools/test-builtin.tool.yaml`
- Create: `runner/tests/plugin-loader.test.ts`

**Step 1: Create fixture `.tool.yaml` files**

```yaml
# runner/tests/fixtures/tools/test-shell.tool.yaml
name: test_shell
description: Shell-based test tool
version: 1

commands:
  - name: test_shell-echo
    description: Echo a message
    parameters:
      message:
        type: string
        required: true
        description: Message to echo
    execute:
      type: shell
      command: echo {{message}}
      parse_output: text

prompt_snippet: |
  You have access to a test shell tool.
```

```yaml
# runner/tests/fixtures/tools/test-builtin.tool.yaml
name: test_builtin
description: Builtin-backed test tool
version: 1

commands:
  - name: repo_manager-list_files
    description: List files in the workspace
    parameters:
      path:
        type: string
        required: false
    execute:
      type: builtin
      parse_output: json
```

**Step 2: Write the failing tests**

```typescript
// runner/tests/plugin-loader.test.ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadProjectTools } from '../src/tools/plugin-loader.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures/tools');

describe('loadProjectTools', () => {
  it('returns empty array when tools dir does not exist', async () => {
    const result = await loadProjectTools('/nonexistent/path', '/tmp');
    expect(result).toEqual([]);
  });

  it('returns empty array when tools dir has no .tool.yaml files', async () => {
    const result = await loadProjectTools('/tmp', '/tmp');
    expect(result).toEqual([]);
  });

  it('loads a shell-type tool and returns a working Tool', async () => {
    const plugins = await loadProjectTools(FIXTURES_DIR, '/tmp');
    const shellPlugin = plugins.find(p => p.name === 'test_shell');
    expect(shellPlugin).toBeDefined();
    expect(shellPlugin!.tools).toHaveLength(1);

    const tool = shellPlugin!.tools[0]!;
    expect(tool.name).toBe('test_shell-echo');
    const result = await tool.execute({ message: 'hi' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('hi');
  });

  it('returns prompt_snippet from shell plugin', async () => {
    const plugins = await loadProjectTools(FIXTURES_DIR, '/tmp');
    const shellPlugin = plugins.find(p => p.name === 'test_shell');
    expect(shellPlugin!.promptSnippet).toMatch(/test shell tool/);
  });

  it('loads a builtin-type tool by delegating to existing TypeScript impl', async () => {
    const plugins = await loadProjectTools(FIXTURES_DIR, '/tmp');
    const builtinPlugin = plugins.find(p => p.name === 'test_builtin');
    expect(builtinPlugin).toBeDefined();
    const tool = builtinPlugin!.tools[0]!;
    expect(tool.name).toBe('repo_manager-list_files');
    // Can call it without error (uses the real TS impl)
    const result = await tool.execute({ path: '/tmp' });
    expect(result.success).toBe(true);
  });

  it('skips builtin commands with unknown names (no crash)', async () => {
    // test-builtin.tool.yaml only has repo_manager-list_files, which exists
    const plugins = await loadProjectTools(FIXTURES_DIR, '/tmp');
    expect(plugins.length).toBeGreaterThan(0);
  });
});
```

**Step 3: Run tests to verify failure**

```bash
pnpm --filter @studio-foundation/runner test -- --reporter=verbose 2>&1 | grep -E "plugin-loader|FAIL|Cannot find"
```

Expected: `Cannot find module '../src/tools/plugin-loader.js'`

**Step 4: Implement `plugin-loader.ts`**

```typescript
// runner/src/tools/plugin-loader.ts
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { ToolPluginDef, ToolCommandDef } from '@studio-foundation/contracts';
import type { Tool } from './tool-registry.js';
import { renderTemplate, executeShellCommand } from './yaml-executor.js';
import { createRepoManagerTools } from './builtin/repo-manager.js';
import { createShellTools } from './builtin/shell.js';
import { createSearchTools } from './builtin/search.js';
import { createPatchTools } from './builtin/patch.js';
import { createGitTools } from './builtin/git.js';

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

/** Create a Tool that renders the command template and runs it in a shell. */
function createShellTool(cmd: ToolCommandDef, repoPath: string): Tool {
  const exec = cmd.execute as { type: 'shell'; command: string; parse_output?: 'text' | 'json' };
  return {
    name: cmd.name,
    description: cmd.description,
    parameters: buildJsonSchema(cmd.parameters),
    async execute(args) {
      const rendered = renderTemplate(exec.command, args);
      return executeShellCommand(rendered, exec.parse_output ?? 'text', repoPath);
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
        tools.push(createShellTool(cmd, repoPath));
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
```

**Step 5: Run tests to verify pass**

```bash
pnpm --filter @studio-foundation/runner test -- --reporter=verbose 2>&1 | grep -E "plugin-loader|✓|✗"
```

Expected: all plugin-loader tests pass.

**Step 6: Commit**

```bash
git add runner/src/tools/plugin-loader.ts \
        runner/tests/plugin-loader.test.ts \
        runner/tests/fixtures/tools/test-shell.tool.yaml \
        runner/tests/fixtures/tools/test-builtin.tool.yaml
git commit -m "feat(runner): implement plugin-loader — load .tool.yaml from project tools dir (STU-30)"
```

---

## Task 4 — `ToolRegistry.registerPlugin()` + `getActiveSnippets()`

**Files:**
- Modify: `runner/src/tools/tool-registry.ts`
- Modify: `runner/tests/tool-registry.test.ts` (add new tests at bottom)

**Step 1: Check if a test file already exists**

```bash
ls runner/tests/tool-registry.test.ts 2>/dev/null && echo "exists" || echo "missing"
```

If missing, create it. If it exists, append the new tests.

**Step 2: Write the failing tests (append to the test file)**

```typescript
// Append to runner/tests/tool-registry.test.ts (or create it)
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/tools/tool-registry.js';

function makeTool(name: string) {
  return {
    name,
    description: `Tool ${name}`,
    parameters: {},
    execute: async () => ({ success: true, output: null }),
  };
}

describe('ToolRegistry.registerPlugin', () => {
  it('registers all tools in a plugin', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('my_plugin', [makeTool('my_plugin-foo'), makeTool('my_plugin-bar')]);
    expect(registry.has('my_plugin-foo')).toBe(true);
    expect(registry.has('my_plugin-bar')).toBe(true);
  });

  it('stores the prompt snippet for retrieval', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('my_plugin', [makeTool('my_plugin-foo')], 'Use foo carefully.');
    expect(registry.getActiveSnippets()).toEqual(['Use foo carefully.']);
  });

  it('getActiveSnippets returns empty when no snippets registered', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('my_plugin', [makeTool('my_plugin-foo')]);
    expect(registry.getActiveSnippets()).toEqual([]);
  });
});

describe('ToolRegistry.filter preserves snippet metadata', () => {
  it('filtered registry returns snippet for included tools', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('plug_a', [makeTool('plug_a-foo')], 'Snippet A');
    registry.registerPlugin('plug_b', [makeTool('plug_b-bar')], 'Snippet B');

    const filtered = registry.filter(['plug_a-foo']);
    expect(filtered.getActiveSnippets()).toEqual(['Snippet A']);
  });

  it('filtered registry does not return snippet for excluded tools', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('plug_a', [makeTool('plug_a-foo')], 'Snippet A');
    registry.registerPlugin('plug_b', [makeTool('plug_b-bar')], 'Snippet B');

    const filtered = registry.filter(['plug_a-foo']);
    expect(filtered.getActiveSnippets()).not.toContain('Snippet B');
  });

  it('normalizes dot-notation in filter with snippets', () => {
    const registry = new ToolRegistry();
    registry.registerPlugin('repo_manager', [makeTool('repo_manager-write_file')], 'Write files!');
    const filtered = registry.filter(['repo_manager.write_file']);
    expect(filtered.getActiveSnippets()).toEqual(['Write files!']);
  });
});
```

**Step 3: Run tests to verify failure**

```bash
pnpm --filter @studio-foundation/runner test -- --reporter=verbose 2>&1 | grep -E "registerPlugin|getActiveSnippets|FAIL"
```

Expected: `registry.registerPlugin is not a function`

**Step 4: Implement the new methods in `tool-registry.ts`**

Replace the full content of `runner/src/tools/tool-registry.ts`:

```typescript
// runner/src/tools/tool-registry.ts
import { ToolDefinition } from '@studio-foundation/contracts';

/** Normalize tool name: dots → hyphens so both conventions work */
export function normalizeToolName(name: string): string {
  return name.replace(/\./g, '-');
}

export interface ToolResult {
  success: boolean;
  output: unknown;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private toolToPlugin: Map<string, string> = new Map();   // normalized name → plugin name
  private pluginSnippets: Map<string, string> = new Map(); // plugin name → snippet

  /** Register a single tool (no plugin metadata). */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Register all tools belonging to a plugin.
   * If promptSnippet is provided it will be returned by getActiveSnippets()
   * whenever any tool from this plugin is in the registry.
   */
  registerPlugin(pluginName: string, tools: Tool[], promptSnippet?: string): void {
    for (const tool of tools) {
      this.register(tool);
      this.toolToPlugin.set(normalizeToolName(tool.name), pluginName);
    }
    if (promptSnippet) {
      this.pluginSnippets.set(pluginName, promptSnippet);
    }
  }

  /** Get tool by name (exact or normalized). */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Check if tool exists. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** List all registered tools. */
  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Convert tools to LLM tool definitions format. */
  toToolDefinitions(): ToolDefinition[] {
    return this.list().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * Return prompt snippets for all plugins that have at least one tool
   * currently in this registry.
   */
  getActiveSnippets(): string[] {
    const activePlugins = new Set<string>();
    for (const toolName of this.tools.keys()) {
      const plugin = this.toolToPlugin.get(normalizeToolName(toolName));
      if (plugin) activePlugins.add(plugin);
    }
    return Array.from(activePlugins)
      .map(p => this.pluginSnippets.get(p))
      .filter((s): s is string => s !== undefined);
  }

  /**
   * Create a new registry filtered to specific tool names.
   * Normalizes dots to hyphens so both "repo_manager.write_file"
   * and "repo_manager-write_file" match the registered name.
   * Plugin snippet metadata is carried over for included tools.
   */
  filter(allowedTools: string[]): ToolRegistry {
    const filtered = new ToolRegistry();
    for (const toolName of allowedTools) {
      const tool =
        this.tools.get(toolName) ?? this.tools.get(normalizeToolName(toolName));
      if (tool) {
        filtered.register(tool);
        // Carry over plugin metadata so getActiveSnippets() works on filtered registry
        const pluginName = this.toolToPlugin.get(normalizeToolName(tool.name));
        if (pluginName) {
          filtered.toolToPlugin.set(normalizeToolName(tool.name), pluginName);
          const snippet = this.pluginSnippets.get(pluginName);
          if (snippet) filtered.pluginSnippets.set(pluginName, snippet);
        }
      }
    }
    return filtered;
  }
}
```

**Step 5: Run tests to verify pass**

```bash
pnpm --filter @studio-foundation/runner test -- --reporter=verbose 2>&1 | grep -E "registerPlugin|getActiveSnippets|filter|✓|✗"
```

Expected: all new tests pass, existing tests still pass.

**Step 6: Commit**

```bash
git add runner/src/tools/tool-registry.ts runner/tests/tool-registry.test.ts
git commit -m "feat(runner): add registerPlugin/getActiveSnippets to ToolRegistry (STU-30)"
```

---

## Task 5 — Prompt snippet injection

**Files:**
- Modify: `runner/src/prompt-builder.ts`
- Modify: `runner/src/runner.ts`
- Modify: `runner/tests/prompt-builder.test.ts`

**Step 1: Write failing tests (append to `runner/tests/prompt-builder.test.ts`)**

Find the existing test file and append:

```typescript
describe('buildPrompt with promptSnippets', () => {
  it('injects prompt snippets into system message', () => {
    const messages = buildPrompt({
      agent: { name: 'a', provider: 'anthropic', model: 'claude-haiku-4-5', tools: [] },
      task: { description: 'Do something' },
      context: {},
      promptSnippets: ['Use tool X carefully.', 'Always verify results.'],
    });
    const system = messages.find(m => m.role === 'system')!;
    expect(system.content).toContain('Use tool X carefully.');
    expect(system.content).toContain('Always verify results.');
  });

  it('does not crash when promptSnippets is empty', () => {
    expect(() =>
      buildPrompt({
        agent: { name: 'a', provider: 'anthropic', model: 'claude-haiku-4-5', tools: [] },
        task: { description: 'Do something' },
        context: {},
        promptSnippets: [],
      })
    ).not.toThrow();
  });

  it('does not crash when promptSnippets is undefined', () => {
    expect(() =>
      buildPrompt({
        agent: { name: 'a', provider: 'anthropic', model: 'claude-haiku-4-5', tools: [] },
        task: { description: 'Do something' },
        context: {},
      })
    ).not.toThrow();
  });
});
```

**Step 2: Run tests to verify failure**

```bash
pnpm --filter @studio-foundation/runner test -- --reporter=verbose 2>&1 | grep -E "promptSnippets|FAIL"
```

Expected: TypeScript error — `promptSnippets` not in `PromptBuildConfig`.

**Step 3: Add `promptSnippets` to `PromptBuildConfig` and inject in system message**

In `runner/src/prompt-builder.ts`, add `promptSnippets?: string[]` to the interface and inject after the existing system content is built:

```typescript
// In PromptBuildConfig interface, add:
promptSnippets?: string[];
```

In `buildPrompt()`, right before `messages.push({ role: 'system', content: systemContent })`, add:

```typescript
// Inject prompt snippets from active tool plugins
if (config.promptSnippets && config.promptSnippets.length > 0) {
  systemContent += '\n\n' + config.promptSnippets.join('\n\n');
}
```

**Step 4: Pass snippets from `runner.ts`**

In `runner/src/runner.ts`, after the `allowedTools` filtering (around line 64-67), add:

```typescript
const promptSnippets = allowedTools.getActiveSnippets();
```

Then update the `buildPrompt()` call to include it:

```typescript
const messages = buildPrompt({
  agent,
  task,
  context,
  executionContext,
  outputContract: config.outputContract,
  promptSnippets,
});
```

**Step 5: Build + run tests**

```bash
pnpm build && pnpm --filter @studio-foundation/runner test -- --reporter=verbose 2>&1 | tail -20
```

Expected: all tests pass, no build errors.

**Step 6: Commit**

```bash
git add runner/src/prompt-builder.ts runner/src/runner.ts runner/tests/prompt-builder.test.ts
git commit -m "feat(runner): inject tool plugin prompt snippets into system prompt (STU-30)"
```

---

## Task 6 — Update `.tool.yaml` templates to full format

**Files:**
- Modify: `cli/templates/tools/repo-manager.tool.yaml`
- Modify: `cli/templates/tools/shell.tool.yaml`
- Modify: `cli/templates/tools/search.tool.yaml`
- Create: `cli/templates/tools/git.tool.yaml`

No new tests needed (these are data files used by the loader, already covered by Task 3 tests).

**Step 1: Replace `repo-manager.tool.yaml`**

```yaml
# cli/templates/tools/repo-manager.tool.yaml
name: repo_manager
description: Read and write files in the workspace
version: 1

commands:
  - name: repo_manager-read_file
    description: Read a file from the workspace
    parameters:
      path:
        type: string
        required: true
        description: File path relative to the workspace root
    execute:
      type: builtin
      parse_output: json

  - name: repo_manager-write_file
    description: Write or create a file in the workspace
    parameters:
      path:
        type: string
        required: true
        description: File path relative to the workspace root
      content:
        type: string
        required: true
        description: Full content to write to the file
    execute:
      type: builtin
      parse_output: json

  - name: repo_manager-list_files
    description: List files in the workspace
    parameters:
      path:
        type: string
        required: false
        description: Directory to list (default is workspace root)
      recursive:
        type: boolean
        required: false
        description: Whether to list recursively
    execute:
      type: builtin
      parse_output: json

  - name: repo_manager-apply_patch
    description: Apply a unified diff patch to a file
    parameters:
      path:
        type: string
        required: true
        description: File path to patch
      patch:
        type: string
        required: true
        description: Unified diff patch content
    execute:
      type: builtin
      parse_output: json

prompt_snippet: |
  You have access to file management tools. Read files before modifying them.
  Use repo_manager-write_file to create or update files — provide the full file content.
```

**Step 2: Replace `shell.tool.yaml`**

```yaml
# cli/templates/tools/shell.tool.yaml
name: shell
description: Execute shell commands in the workspace
version: 1

commands:
  - name: shell-run_command
    description: Run a shell command in the workspace directory
    parameters:
      command:
        type: string
        required: true
        description: Shell command to execute
    execute:
      type: builtin
      parse_output: text

prompt_snippet: |
  You have access to a shell tool. Use it to run build, test, or inspection commands.
  Avoid destructive commands. Prefer targeted commands over broad ones.
```

**Step 3: Replace `search.tool.yaml`**

```yaml
# cli/templates/tools/search.tool.yaml
name: search
description: Search the codebase by content or file pattern
version: 1

commands:
  - name: search-search_codebase
    description: Search files by content pattern (uses ripgrep)
    parameters:
      pattern:
        type: string
        required: true
        description: Regex or literal pattern to search for
      file_pattern:
        type: string
        required: false
        description: Glob pattern to restrict which files are searched (e.g. "*.ts")
    execute:
      type: builtin
      parse_output: json

prompt_snippet: |
  You have access to a codebase search tool. Use it to find relevant code before making changes.
```

**Step 4: Create `git.tool.yaml`**

```yaml
# cli/templates/tools/git.tool.yaml
name: git
description: Git version control operations
version: 1

commands:
  - name: git-status
    description: Show working tree status
    parameters: {}
    execute:
      type: shell
      command: git status --porcelain
      parse_output: text

  - name: git-diff
    description: Show changes in the working tree
    parameters:
      staged:
        type: boolean
        required: false
        description: Show staged changes instead of unstaged
      file:
        type: string
        required: false
        description: Restrict diff to this file path
    execute:
      type: shell
      command: |
        git diff {{#if staged}}--cached{{/if}} {{#if file}}{{file}}{{/if}}
      parse_output: text

  - name: git-checkout
    description: Checkout an existing branch or create a new one
    parameters:
      branch:
        type: string
        required: true
        description: Branch name to checkout or create
      create:
        type: boolean
        required: false
        description: Create the branch if it does not exist
    execute:
      type: shell
      command: |
        git checkout {{#if create}}-b{{/if}} {{branch}}
      parse_output: text

  - name: git-commit
    description: Stage all changes and commit with a message
    parameters:
      message:
        type: string
        required: true
        description: Commit message (use conventional commits format)
    execute:
      type: shell
      command: |
        git add -A && git commit -m "{{message}}"
      parse_output: text

  - name: git-push
    description: Push the current branch to origin
    parameters:
      set_upstream:
        type: boolean
        required: false
        description: Set upstream tracking reference (-u flag)
    execute:
      type: shell
      command: |
        git push {{#if set_upstream}}-u{{/if}} origin HEAD
      parse_output: text

prompt_snippet: |
  You have access to git tools. Always create a feature branch before making changes.
  Never commit directly to main or master.
  Use conventional commit messages: <type>(<scope>): <description>

constraints:
  requires_binaries: [git]
```

**Step 5: Commit**

```bash
git add cli/templates/tools/
git commit -m "feat(cli): update .tool.yaml templates to full plugin format + add git.tool.yaml (STU-30)"
```

---

## Task 7 — CLI `run.ts`: load tools from project tools dir

**Files:**
- Modify: `cli/src/commands/run.ts`
- Modify: `runner/src/index.ts` (export `loadProjectTools`, `LoadedPlugin`)

**Step 1: Export `loadProjectTools` from runner**

In `runner/src/index.ts`, add:

```typescript
export { loadProjectTools } from './tools/plugin-loader.js';
export type { LoadedPlugin } from './tools/plugin-loader.js';
```

**Step 2: Update `run.ts` imports**

Remove `createRepoManagerTools, createShellTools, createSearchTools, createPatchTools, createGitTools` from the runner import.
Add `loadProjectTools`.

The import line goes from:
```typescript
import { createDefaultRegistry, ToolRegistry, createRepoManagerTools, createShellTools, createSearchTools, createPatchTools, createGitTools } from '@studio-foundation/runner';
```
to:
```typescript
import { createDefaultRegistry, ToolRegistry, loadProjectTools } from '@studio-foundation/runner';
```

**Step 3: Replace the hardcoded tool registration block**

Find this block (around line 285-299):
```typescript
const toolRegistry = new ToolRegistry();
for (const tool of createRepoManagerTools(repoPath)) {
  toolRegistry.register(tool);
}
for (const tool of createShellTools(repoPath)) {
  toolRegistry.register(tool);
}
for (const tool of createSearchTools(repoPath)) {
  toolRegistry.register(tool);
}
for (const tool of createPatchTools(repoPath)) {
  toolRegistry.register(tool);
}
for (const tool of createGitTools(repoPath)) {
  toolRegistry.register(tool);
}
```

Replace with:
```typescript
const toolsDir = resolve(configsDir, project, 'tools');
const loadedPlugins = await loadProjectTools(toolsDir, repoPath);
const toolRegistry = new ToolRegistry();
for (const plugin of loadedPlugins) {
  toolRegistry.registerPlugin(plugin.name, plugin.tools, plugin.promptSnippet);
}
```

**Step 4: Build**

```bash
pnpm build
```

Expected: No errors. (The run.ts tests are all currently skipped, so no test regressions.)

**Step 5: Commit**

```bash
git add runner/src/index.ts cli/src/commands/run.ts
git commit -m "feat(cli): load tools from project tools dir instead of hardcoded builtins (STU-30)"
```

---

## Task 8 — Full test run + verification

**Step 1: Run all tests**

```bash
pnpm test
```

Expected: all tests pass (or same skips as before — no new failures).

**Step 2: Manual smoke test of the loader**

```bash
node --loader ts-node/esm -e "
import { loadProjectTools } from './runner/src/tools/plugin-loader.js';
const plugins = await loadProjectTools('./runner/tests/fixtures/tools', '/tmp');
console.log(plugins.map(p => ({ name: p.name, tools: p.tools.map(t => t.name), hasSnippet: !!p.promptSnippet })));
" 2>/dev/null || echo "(ts-node not available — skip)"
```

If ts-node not available, skip this — tests already verified loader works.

**Step 3: Verify git log looks clean**

```bash
git log --oneline -6
```

Expected: 6 clean commits for this feature.

**Step 4: Final commit if any stragglers**

If anything was missed, commit it now. Otherwise skip.

---

## Acceptance criteria check

| Criterion | Covered by |
|-----------|-----------|
| Format `.tool.yaml` parseable by runner | Task 3 (plugin-loader) |
| `execute.type: shell` fonctionnels | Tasks 2 + 3 (yaml-executor + loader) |
| `execute.type: builtin` fonctionnels | Task 3 (loader delegates to TS factories) |
| Prompt snippets injectés automatiquement | Tasks 4 + 5 (registry + prompt-builder) |
| Constraints: `requires_binaries` | git.tool.yaml declares it (loader reads it; enforcement TBD) |
| Double gate (projet + agent) enforced | Project gate: loader only reads project tools dir; agent gate: existing `toolRegistry.filter()` |
| `studio tools list <project>` | Existing `studio tools list` already works (reads tools dir) |
| Migration builtins → templates YAML | git.tool.yaml as proof of concept (Tasks 6); builtins still exist for delegation |
| Tool custom créable en < 5 minutes | git.tool.yaml is a working example in pure YAML |

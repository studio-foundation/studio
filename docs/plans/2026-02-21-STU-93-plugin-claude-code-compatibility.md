# STU-93 — Claude Code Plugin Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support `.studio/plugins/<name>/` directories containing `.mcp.json` (MCP servers) and `skills/*.skill.md` files, so agents can declare `plugins: [name]` in their YAML to get MCP tools auto-registered and skill content injected into their system prompt.

**Architecture:** Plugin manifest loading lives in `runner/src/plugins/`. The CLI orchestrates lifecycle (load → start MCP servers → run pipeline → stop MCP servers in finally). Skills are injected into `agentConfig.system_prompt` by the engine before passing to `runAgent()` — zero change to runner's `runAgent()` interface. MCP tools are registered in the existing `ToolRegistry`.

**Tech Stack:** `@modelcontextprotocol/sdk` (new dep in runner), existing `ToolRegistry`, vitest for tests.

**Design doc:** `docs/plans/2026-02-21-STU-93-plugin-claude-code-compatibility-design.md`

---

## Task 1: Add `plugins?` field to AgentConfig in contracts

**Files:**
- Modify: `contracts/src/agent.ts`

**Step 1: Add `plugins?: string[]` to AgentConfig**

In `contracts/src/agent.ts`, add the field after `tools?`:

```typescript
export interface AgentConfig {
  name: string;
  description?: string;
  provider: string;
  model: string;
  system_prompt?: string;
  tools?: string[];
  plugins?: string[];     // ← ADD THIS LINE
  temperature?: number;
  max_tokens?: number;
  anonymize?: boolean;
}
```

**Step 2: Build contracts to propagate the type change**

```bash
pnpm --filter @studio-foundation/contracts build
```

Expected: clean build, no errors.

**Step 3: Commit**

```bash
git add contracts/src/agent.ts
git commit -m "feat(contracts): add plugins field to AgentConfig"
```

---

## Task 2: Install @modelcontextprotocol/sdk in runner

**Files:**
- Modify: `runner/package.json`

**Step 1: Add the dependency**

```bash
pnpm add @modelcontextprotocol/sdk --filter @studio-foundation/runner
```

Expected: `@modelcontextprotocol/sdk` appears in `runner/package.json` dependencies.

**Step 2: Verify the package is available**

```bash
node -e "import('@modelcontextprotocol/sdk/client/index.js').then(() => console.log('OK'))" --input-type=module
```

Expected: prints `OK`.

**Step 3: Commit**

```bash
git add runner/package.json pnpm-lock.yaml
git commit -m "feat(runner): add @modelcontextprotocol/sdk dependency"
```

---

## Task 3: Implement plugin-loader.ts (TDD)

**Files:**
- Create: `runner/src/plugins/plugin-loader.ts`
- Create: `runner/src/plugins/plugin-loader.test.ts`

**Step 1: Write the failing test**

Create `runner/src/plugins/plugin-loader.test.ts`:

```typescript
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
    expect(result).toHaveLength(3);
    const names = result.map((p) => p.name).sort();
    expect(names).toEqual(['analysis', 'code-review', 'empty-plugin']);
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
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @studio-foundation/runner test runner/src/plugins/plugin-loader.test.ts 2>&1 | head -20
```

Expected: FAIL — `plugin-loader.ts` not found.

**Step 3: Implement plugin-loader.ts**

Create `runner/src/plugins/plugin-loader.ts`:

```typescript
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface MCPServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

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
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, MCPServerDef> };
      mcpServers = parsed.mcpServers ?? {};
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
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @studio-foundation/runner test runner/src/plugins/plugin-loader.test.ts
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add runner/src/plugins/plugin-loader.ts runner/src/plugins/plugin-loader.test.ts
git commit -m "feat(runner): implement plugin-loader for Claude Code plugin discovery"
```

---

## Task 4: Implement MCPClient (TDD)

**Files:**
- Create: `runner/src/plugins/mcp-client.ts`
- Create: `runner/src/plugins/mcp-client.test.ts`

**Step 1: Write the failing tests**

Create `runner/src/plugins/mcp-client.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { MCPClient } from './mcp-client.js';

describe('MCPClient', () => {
  it('generates correct tool prefix', () => {
    const client = new MCPClient('code-review', 'github', {
      command: 'npx',
      args: ['-y', '@mcp/server-github'],
    });
    expect(client.toolPrefix()).toBe('code-review-github');
  });

  it('resolves ${ENV_VAR} in env config', () => {
    process.env.TEST_TOKEN = 'secret-123';
    const client = new MCPClient('myplugin', 'myserver', {
      command: 'npx',
      env: { MY_TOKEN: '${TEST_TOKEN}' },
    });
    // Verify via resolveEnv (exported for testing)
    const resolved = client.resolveEnv({ MY_TOKEN: '${TEST_TOKEN}' });
    expect(resolved.MY_TOKEN).toBe('secret-123');
    delete process.env.TEST_TOKEN;
  });

  it('leaves env vars without substitution syntax as-is', () => {
    const client = new MCPClient('p', 's', { command: 'cmd' });
    const resolved = client.resolveEnv({ KEY: 'literal-value' });
    expect(resolved.KEY).toBe('literal-value');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @studio-foundation/runner test runner/src/plugins/mcp-client.test.ts 2>&1 | head -20
```

Expected: FAIL — `mcp-client.ts` not found.

**Step 3: Implement mcp-client.ts**

Create `runner/src/plugins/mcp-client.ts`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '../tools/tool-registry.js';
import type { MCPServerDef } from './plugin-loader.js';

export class MCPClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(
    private pluginName: string,
    private serverName: string,
    private def: MCPServerDef
  ) {
    const env = this.resolveEnv(def.env ?? {});
    this.transport = new StdioClientTransport({
      command: def.command,
      args: def.args ?? [],
      env: { ...process.env, ...env } as Record<string, string>,
    });
    this.client = new Client(
      { name: 'studio', version: '1.0.0' },
      { capabilities: {} }
    );
  }

  toolPrefix(): string {
    return `${this.pluginName}-${this.serverName}`;
  }

  /** Resolves ${VAR_NAME} placeholders from process.env. */
  resolveEnv(env: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, val] of Object.entries(env)) {
      result[key] = val.replace(/\$\{([^}]+)\}/g, (_, v: string) => process.env[v] ?? '');
    }
    return result;
  }

  async start(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async getTools(): Promise<Tool[]> {
    const { tools } = await this.client.listTools();
    const prefix = this.toolPrefix();

    return tools.map((t) => ({
      name: `${prefix}-${t.name}`,
      description: t.description ?? '',
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      execute: async (args: Record<string, unknown>) => {
        try {
          const result = await this.client.callTool({ name: t.name, arguments: args });
          return { success: true, output: result.content };
        } catch (err) {
          return {
            success: false,
            output: null,
            error: (err as Error).message,
          };
        }
      },
    }));
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      // Ignore close errors — process may have already exited
    }
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/runner test runner/src/plugins/mcp-client.test.ts
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add runner/src/plugins/mcp-client.ts runner/src/plugins/mcp-client.test.ts
git commit -m "feat(runner): implement MCPClient for MCP server lifecycle and tool discovery"
```

---

## Task 5: Create runner/src/plugins/index.ts and update runner/src/index.ts

**Files:**
- Create: `runner/src/plugins/index.ts`
- Modify: `runner/src/index.ts`

**Step 1: Create the barrel export**

Create `runner/src/plugins/index.ts`:

```typescript
export { loadPlugins } from './plugin-loader.js';
export type { PluginManifest, MCPServerDef, SkillContent } from './plugin-loader.js';
export { MCPClient } from './mcp-client.js';
```

**Step 2: Add plugin exports to runner/src/index.ts**

In `runner/src/index.ts`, add after the `loadProjectTools` export:

```typescript
// Plugin system (Claude Code plugin compatibility)
export { loadPlugins, MCPClient } from './plugins/index.js';
export type { PluginManifest, MCPServerDef, SkillContent } from './plugins/index.js';
```

**Step 3: Build runner to verify no TS errors**

```bash
pnpm --filter @studio-foundation/runner build
```

Expected: clean build.

**Step 4: Commit**

```bash
git add runner/src/plugins/index.ts runner/src/index.ts
git commit -m "feat(runner): export plugin system from runner package"
```

---

## Task 6: Engine — Add pluginSkills to EngineConfig and inject into agent

**Files:**
- Modify: `engine/src/engine.ts`
- Create: `engine/src/pipeline/agent-loader.test.ts` (extend existing if present, else create)

**Step 1: Write a test for skills injection**

Add to `engine/src/pipeline/agent-loader.test.ts` (create if missing):

```typescript
import { describe, it, expect } from 'vitest';
import { parseAgentYaml } from './agent-loader.js';

describe('parseAgentYaml', () => {
  it('parses plugins field from agent YAML', () => {
    const yaml = `
name: code-reviewer
provider: anthropic
model: claude-sonnet-4-20250514
plugins:
  - code-review
  - analysis
tools:
  - repo_manager-read_file
`;
    const result = parseAgentYaml(yaml);
    expect(result.plugins).toEqual(['code-review', 'analysis']);
  });

  it('returns undefined plugins when not specified', () => {
    const yaml = `
name: analyst
provider: anthropic
model: claude-haiku-4-5-20251001
`;
    const result = parseAgentYaml(yaml);
    expect(result.plugins).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it passes (parseAgentYaml already passes unknown fields through)**

```bash
pnpm --filter @studio-foundation/engine test engine/src/pipeline/agent-loader.test.ts
```

Expected: PASS — `parseAgentYaml` casts to `AgentConfig` which now includes `plugins?: string[]`.

**Step 3: Add pluginSkills to EngineConfig**

In `engine/src/engine.ts`, update the `EngineConfig` interface (around line 83):

```typescript
export interface EngineConfig {
  configsDir: string;
  repoPath?: string;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  db?: RunStore;
  providerOverride?: string;
  /**
   * Skills content from active plugins, keyed by plugin name.
   * Each entry is an array of formatted markdown strings to inject
   * into the system prompt of agents that declare the plugin.
   */
  pluginSkills?: Record<string, string[]>;
}
```

**Step 4: Inject skills into agent in executeStage**

In `engine/src/engine.ts`, in the `executeStage` method, after the line:
```typescript
const agentConfig = await loadAgentProfile(stageDef.agent, paths.agentsDir);
```

Add:

```typescript
// Inject plugin skills into system_prompt if agent declares plugins
const agentConfig = await loadAgentProfile(stageDef.agent, paths.agentsDir);
if (agentConfig.plugins?.length && this.config.pluginSkills) {
  const skillChunks = agentConfig.plugins
    .flatMap((p) => this.config.pluginSkills![p] ?? []);
  if (skillChunks.length > 0) {
    agentConfig.system_prompt = `${agentConfig.system_prompt ?? ''}\n\n${skillChunks.join('\n\n---\n\n')}`;
  }
}
```

Note: `agentConfig` needs to be `let` not `const` — or use an intermediate. Actually `loadAgentProfile` returns the config and we mutate `system_prompt` on the result. The returned object is a new object. But the `const` is fine if we mutate the property (it's not reassigning the variable). Just mutate:

```typescript
const agentConfig = await loadAgentProfile(stageDef.agent, paths.agentsDir);
if (this.config.providerOverride) {
  agentConfig.provider = this.config.providerOverride;
}
// Inject plugin skills into system_prompt for agents that declare plugins
if (agentConfig.plugins?.length && this.config.pluginSkills) {
  const skillChunks = agentConfig.plugins
    .flatMap((p) => this.config.pluginSkills![p] ?? []);
  if (skillChunks.length > 0) {
    agentConfig.system_prompt = `${agentConfig.system_prompt ?? ''}\n\n${skillChunks.join('\n\n---\n\n')}`;
  }
}
```

**Step 5: Build engine to verify no TS errors**

```bash
pnpm --filter @studio-foundation/engine build
```

Expected: clean build.

**Step 6: Commit**

```bash
git add engine/src/engine.ts engine/src/pipeline/agent-loader.test.ts
git commit -m "feat(engine): inject plugin skills into agent system_prompt via pluginSkills config"
```

---

## Task 7: CLI — Integrate plugin loading into run.ts

**Files:**
- Modify: `cli/src/commands/run.ts`

**Step 1: Add imports at the top of run.ts**

After the existing `@studio-foundation/runner` import (line 9), add:

```typescript
import { loadPlugins, MCPClient } from '@studio-foundation/runner';
import type { PluginManifest } from '@studio-foundation/runner';
```

**Step 2: Add plugin loading and MCP server startup after toolRegistry creation**

In `runCommand()`, after the tool registry section (after line 310 where `toolRegistry.registerPlugin` is called):

```typescript
// Load plugins from .studio/plugins/
const pluginsDir = resolve(configsDir, 'plugins');
const pluginManifests = await loadPlugins(pluginsDir);

// Start MCP servers for each plugin and register their tools
const mcpClients: MCPClient[] = [];
for (const manifest of pluginManifests) {
  for (const [serverName, serverDef] of Object.entries(manifest.mcpServers)) {
    const client = new MCPClient(manifest.name, serverName, serverDef);
    try {
      await client.start();
      const mcpTools = await client.getTools();
      toolRegistry.registerPlugin(`${manifest.name}-${serverName}`, mcpTools);
      mcpClients.push(client);
    } catch (err) {
      console.warn(chalk.yellow(`⚠ Plugin '${manifest.name}': failed to start MCP server '${serverName}': ${(err as Error).message}`));
    }
  }
}

// Build skill map for engine skill injection
const pluginSkills: Record<string, string[]> = {};
for (const manifest of pluginManifests) {
  if (manifest.skills.length > 0) {
    pluginSkills[manifest.name] = manifest.skills.map(
      (s) => `## Skill: ${s.name}\n\n${s.content}`
    );
  }
}
```

**Step 3: Pass pluginSkills to PipelineEngine**

Update the `PipelineEngine` constructor call (around line 326) to include `pluginSkills`:

```typescript
const engine = new PipelineEngine(
  {
    configsDir,
    repoPath,
    providerRegistry,
    toolRegistry,
    pluginSkills,           // ← ADD THIS
    ...(options.provider ? { providerOverride: options.provider } : {}),
  },
  events
);
```

**Step 4: Add MCP server cleanup to the finally block**

Update the try/finally block (around line 345) to stop MCP servers:

```typescript
let result;
try {
  result = await engine.run({
    pipeline: pipelineName,
    input,
    anonymize: options.anonymize,
  });
} finally {
  process.off('SIGINT', onInterrupt);
  runLogger.close();
  // Stop all MCP servers (even if pipeline failed)
  await Promise.allSettled(mcpClients.map((c) => c.close()));
}
```

**Step 5: Build CLI to verify no TS errors**

```bash
pnpm --filter @studio-foundation/cli build
```

Expected: clean build.

**Step 6: Commit**

```bash
git add cli/src/commands/run.ts
git commit -m "feat(cli): integrate plugin loading and MCP server lifecycle into run command"
```

---

## Task 8: CLI — Enhance studio tools list to show plugins

**Files:**
- Modify: `cli/src/commands/tools.ts`

**Step 1: Update the `list` case in `toolsCommand` to also show plugins**

In `cli/src/commands/tools.ts`, update the `'list'` case (around line 94):

```typescript
case 'list': {
  const config = await loadConfig();
  const studioDir = config.resolvedStudioDir;
  if (!studioDir) {
    console.error("Error: No .studio/ directory found. Run 'studio init' first.");
    process.exit(1);
  }
  const toolsDir = getToolsDir(studioDir);
  const tools = await listTools(toolsDir);

  if (tools.length === 0) {
    console.log(chalk.yellow('No tools installed.'));
    console.log('  Run: studio tools add <name>');
  } else {
    console.log('\nInstalled tools:');
    for (const t of tools) {
      console.log(`  - ${t}`);
    }
  }

  // Show installed plugins (from .studio/plugins/)
  const { loadPlugins: loadPluginManifests } = await import('@studio-foundation/runner');
  const pluginsDir = resolve(studioDir, 'plugins');
  const manifests = await loadPluginManifests(pluginsDir);
  if (manifests.length > 0) {
    console.log('\nInstalled plugins:');
    for (const m of manifests) {
      const serverNames = Object.keys(m.mcpServers);
      const skillCount = m.skills.length;
      const parts: string[] = [];
      if (serverNames.length > 0) parts.push(`MCP: ${serverNames.join(', ')}`);
      if (skillCount > 0) parts.push(`${skillCount} skill${skillCount !== 1 ? 's' : ''}`);
      console.log(`  - ${m.name}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`);
    }
  }
  console.log('');
  break;
}
```

Also add the necessary import at the top of the file:

```typescript
import { resolve } from 'node:path';
```

(Check if `resolve` is already imported — it is, at line 2.)

**Step 2: Build CLI to verify no TS errors**

```bash
pnpm --filter @studio-foundation/cli build
```

Expected: clean build.

**Step 3: Commit**

```bash
git add cli/src/commands/tools.ts
git commit -m "feat(cli): show installed plugins in studio tools list"
```

---

## Task 9: Full build + run all tests

**Step 1: Build everything from root**

```bash
pnpm build
```

Expected: all 5 packages build cleanly (contracts → ralph → runner → engine → cli order).

**Step 2: Run all tests**

```bash
pnpm test
```

Expected: all tests pass, including new tests in:
- `runner/src/plugins/plugin-loader.test.ts`
- `runner/src/plugins/mcp-client.test.ts`
- `engine/src/pipeline/agent-loader.test.ts`

**Step 3: Manual smoke test — verify plugin discovery works without MCP servers**

```bash
# Create a test plugin directory structure
mkdir -p /tmp/studio-smoke-test/.studio/plugins/test-plugin/skills
echo '{"mcpServers": {}}' > /tmp/studio-smoke-test/.studio/plugins/test-plugin/.mcp.json
echo '# Test Skill\n\nDo great work.' > /tmp/studio-smoke-test/.studio/plugins/test-plugin/skills/test.skill.md

# Verify loadPlugins reads it correctly (via a quick node script)
node --input-type=module <<'EOF'
import { loadPlugins } from './runner/dist/index.js';
const manifests = await loadPlugins('/tmp/studio-smoke-test/.studio/plugins');
console.log(JSON.stringify(manifests, null, 2));
EOF
```

Expected: JSON output showing `test-plugin` with `mcpServers: {}` and `skills: [{name: "test", content: "..."}]`.

**Step 4: Commit**

If any fixes were needed, commit them:

```bash
git add -A
git commit -m "chore: fix any issues found during smoke test"
```

---

## Task 10: Create a git branch and open PR

**Step 1: Verify you're on a feature branch (not main)**

```bash
git branch --show-current
```

Expected: `arianedguay/stu-93-compatibilite-format-plugin-claude-code-mcp-skills-hooks` (branch was pre-created by Linear).

If on `main`, create the branch first:
```bash
git checkout -b arianedguay/stu-93-compatibilite-format-plugin-claude-code-mcp-skills-hooks
```

**Step 2: Push and open PR**

```bash
git push -u origin arianedguay/stu-93-compatibilite-format-plugin-claude-code-mcp-skills-hooks
gh pr create \
  --title "feat(stu-93): Claude Code plugin compatibility — MCP servers + skills injection" \
  --body "$(cat <<'EOF'
## What

Supports `.studio/plugins/<name>/` directories containing Claude Code plugin format:
- `.mcp.json` — MCP servers started at run time, tools auto-registered in ToolRegistry
- `skills/*.skill.md` — markdown injected into agent system_prompt for agents declaring `plugins: [name]`

## Why

Enables using official Anthropic plugins (code-review, feature-dev) in Studio pipelines immediately. Same ecosystem, Studio governance layer on top.

## Packages touched

- `@studio-foundation/contracts` — `AgentConfig.plugins?: string[]`
- `@studio-foundation/runner` — new `runner/src/plugins/` module (plugin-loader, mcp-client), `@modelcontextprotocol/sdk` dependency
- `@studio-foundation/engine` — `EngineConfig.pluginSkills`, skill injection in `executeStage()`
- `@studio-foundation/cli` — plugin loading + MCP lifecycle in `run.ts`, plugin display in `tools list`

## How to test

1. Create `.studio/plugins/my-plugin/.mcp.json` with an MCP server config
2. Create `.studio/plugins/my-plugin/skills/my-skill.skill.md`
3. Add `plugins: [my-plugin]` to an agent YAML
4. `studio run <pipeline>` — MCP server starts, skills appear in prompt
5. `studio tools list` — shows "Installed plugins: my-plugin (MCP: server-name; 1 skill)"

## Out of scope (separate issues)

- `hooks/` → STU-94
- `agents/` → post-MVP
- `commands/` → post-MVP

Closes #STU-93
EOF
)"
```

---

## Reference

**Key files created/modified:**

| File | Action |
|------|--------|
| `contracts/src/agent.ts` | Add `plugins?: string[]` to AgentConfig |
| `runner/src/plugins/plugin-loader.ts` | NEW — scans .studio/plugins/*, parses .mcp.json + skills |
| `runner/src/plugins/mcp-client.ts` | NEW — MCP server lifecycle + tool discovery |
| `runner/src/plugins/index.ts` | NEW — barrel export |
| `runner/src/index.ts` | Export plugin types |
| `runner/package.json` | Add @modelcontextprotocol/sdk |
| `engine/src/engine.ts` | Add pluginSkills to EngineConfig, inject in executeStage |
| `cli/src/commands/run.ts` | loadPlugins + MCP lifecycle + pluginSkills to engine |
| `cli/src/commands/tools.ts` | Show plugins in tools list |

**Test files:**

| File | Tests |
|------|-------|
| `runner/src/plugins/plugin-loader.test.ts` | loadPlugins: missing dir, all plugins loaded, MCP parsed, skills loaded |
| `runner/src/plugins/mcp-client.test.ts` | toolPrefix, resolveEnv |
| `engine/src/pipeline/agent-loader.test.ts` | parseAgentYaml: plugins field parsed |

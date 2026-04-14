# @studio-foundation/runner

Multi-provider LLM agent runner with tool plugin execution, streaming support, and PII anonymization.

## Role

runner handles everything that touches external services: LLM API calls and tool execution. It's the only package that knows about Anthropic, OpenAI, or what `repo_manager-write_file` does.

```
engine → runner.runAgent(config) → AgentRunResult
                  ↓
         [builds prompt] → [calls LLM] → [executes tool calls] → [returns result]
```

## Key exports

```typescript
import { runAgent, createDefaultRegistry, ToolRegistry, AnonymizationMiddleware } from '@studio-foundation/runner';

const registry = createDefaultRegistry({
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  openai: { apiKey: process.env.OPENAI_API_KEY },
});

const result = await runAgent({
  agent: agentConfig,
  task: taskInput,
  context: agentContext,
  toolRegistry,
  providerRegistry: registry,
  outputContract: contract,
  anonymizationMiddleware: new AnonymizationMiddleware(),
  callbacks: {
    onToolCallStart: (e) => { /* e.tool, e.params */ },
    onToolCallComplete: (e) => { /* e.tool, e.result, e.error */ },
    onAgentToken: (e) => { /* streaming token */ },
    onPreToolUse: async (e) => ({ blocked: false }),   // hook callback
    onPostToolUse: async (e) => ({}),                  // hook callback
  },
});
```

## Providers

| Provider | Class | Notes |
|----------|-------|-------|
| Anthropic | `AnthropicProvider` | Claude models, prompt caching (90% cost reduction on retries) |
| OpenAI | `OpenAIProvider` | Chat completions API |
| OpenAI Responses | `OpenAIResponsesProvider` | Responses API |
| Mock | `MockProvider` | For tests — reads from `mock.yaml`, no API calls |

Use `createDefaultRegistry()` to get all providers wired up. Use `--provider mock` in the CLI for testing without API keys.

## Builtin tools

| Tool | Factory | What it does |
|------|---------|-------------|
| `repo_manager-read_file` | `createRepoManagerTools()` | Read files in the workspace |
| `repo_manager-write_file` | `createRepoManagerTools()` | Write/create files |
| `repo_manager-list_files` | `createRepoManagerTools()` | List files and directories |
| `shell-run_command` | `createShellTools()` | Execute shell commands |
| `search-search_codebase` | `createSearchTools()` | Search code with ripgrep |
| `patch-apply_patch` | `createPatchTools()` | Apply unified diffs |
| `git-checkout` | `createGitTools()` | Checkout or create branches |
| `git-commit` | `createGitTools()` | Create commits |
| `git-push` | `createGitTools()` | Push to remote |
| `git-pull` | `createGitTools()` | Pull from remote |
| `git-status` | `createGitTools()` | Show working tree status |
| `git-diff` | `createGitTools()` | Show diffs |
| `studio_run` | `createStudioRunTool()` | Spawn and await a sub-pipeline run |

`studio_run` is only registered when a `RunSpawner` is injected into the engine (via `EngineConfig.spawner`). Agents use it to trigger nested pipelines and receive their output.

Tools are registered into a `ToolRegistry` and passed to `runAgent`. The runner injects tool descriptions into the system prompt automatically.

## PII Anonymization

```typescript
const middleware = new AnonymizationMiddleware();
// Passed to runAgent() → transparently replaces PII in prompts before LLM calls
// Keymap stored in .studio/runs/anonymization/<run-id>.keymap.json
const keymap = middleware.getKeymap(); // Reconstruct original values
```

## Plugin system

runner supports loading Claude Code plugins and YAML tool plugins:

```typescript
import { loadPlugin } from '@studio-foundation/runner';

// Load a Claude Code plugin (.mcp.json + skills/ + agents/)
const plugin = await loadPlugin('/path/to/plugin');
// plugin.skills → array of skill markdown content
// plugin.mcpServers → MCP server configs
```

YAML tool plugins (`.tool.yaml`) are loaded via `ToolRegistry.loadYamlPlugin()`.

## Lifecycle hook callbacks

`onPreToolUse` and `onPostToolUse` in the callbacks wire to stage hook configuration:

```typescript
callbacks: {
  onPreToolUse: async (event) => {
    // event: { tool, params, timestamp }
    // Return { blocked: true, error: '...' } to block the tool call
    return { blocked: false };
  },
  onPostToolUse: async (event) => {
    // event: { tool, params, result, error, timestamp }
    // Return { append_message: '...' } to inject feedback into context
    return {};
  },
}
```

These callbacks are wired by the engine from the stage's `hooks` YAML configuration.

## Rules

- **runner doesn't validate, doesn't retry.** It executes one agent turn and returns `AgentRunResult`. ralph handles the loop.
- **runner doesn't know engine.** No pipeline state, no events, no stage concepts.
- Prompt assembly lives in `prompt-builder.ts`. Provider abstractions in `providers/`.

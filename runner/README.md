# @studio/runner

Multi-provider LLM agent runner with tool plugin execution.

## Role

runner handles everything that touches external services: LLM API calls and tool execution. It's the only package that knows about Anthropic, OpenAI, or what `repo_manager-write_file` does.

```
engine → runner.runAgent(config) → AgentRunResult
                  ↓
         [builds prompt] → [calls LLM] → [executes tool calls] → [returns result]
```

## Key exports

```typescript
import { runAgent, createDefaultRegistry, ToolRegistry } from '@studio/runner';

const registry = createDefaultRegistry({
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  openai: { apiKey: process.env.OPENAI_API_KEY },
});

const result = await runAgent({
  agentProfile,
  context,
  toolRegistry,
  providerRegistry: registry,
});
```

## Providers

| Provider | Class | Notes |
|----------|-------|-------|
| Anthropic | `AnthropicProvider` | Claude models, prompt caching |
| OpenAI | `OpenAIProvider` | Chat completions API |
| OpenAI Responses | `OpenAIResponsesProvider` | Responses API |
| Mock | `MockProvider` | For tests — reads from `mock.yaml`, no API calls |

Use `createDefaultRegistry()` to get all providers wired up. Use `--provider mock` in the CLI for testing without API keys.

## Builtin tools

| Tool | Factory | What it does |
|------|---------|-------------|
| `repo_manager-*` | `createRepoManagerTools()` | Read/write/list files in the workspace |
| `shell-run_command` | `createShellTools()` | Execute shell commands |
| `search-search_codebase` | `createSearchTools()` | Search code with ripgrep |
| `patch-apply_patch` | `createPatchTools()` | Apply unified diffs |
| `git-*` | `createGitTools()` | Git checkout, commit, push, pull, status, diff |

Tools are registered into a `ToolRegistry` and passed to `runAgent`. The runner injects tool descriptions into the system prompt automatically.

## Rules

- **runner doesn't validate, doesn't retry.** It executes one agent turn and returns `AgentRunResult`. ralph handles the loop.
- **runner doesn't know engine.** No pipeline state, no events, no stage concepts.
- Prompt assembly lives in `prompt-builder.ts`. Provider abstractions in `providers/`.

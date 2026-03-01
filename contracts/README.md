# @studio/contracts

Shared TypeScript types and interfaces for the Studio monorepo. Zero dependencies, zero logic.

## Role

`contracts` is the leaf package — every other Studio package imports from it, nothing imports it back. It defines the language that all packages speak.

```
contracts ← ralph
contracts ← runner
contracts ← engine
contracts ← cli
```

## What's in here

| Module | Purpose |
|--------|---------|
| `pipeline.ts` | `PipelineDefinition`, `StageDefinition`, `StageGroup`, `StageHooks`, `ToolHookDef`, `StageHookDef`, `StartupCommand`, `isStageGroup()` |
| `stage.ts` | `StageStatus`, `StageKind`, `StageResult` |
| `task.ts` | `TaskStatus` |
| `agent.ts` | `AgentConfig`, `AgentProfile`, `ToolCall` (includes `plugins`, `skills`, `anonymize`) |
| `run.ts` | `PipelineRun`, `StageRun`, `TaskRun`, `AgentRun`, `AgentStatus` |
| `validation.ts` | `OutputContract`, `ToolCallRequirements`, `ValidationResult`, `ValidationRule` |
| `provider.ts` | `LLMRequest`, `LLMResponse`, `Message`, `ToolDefinition` |
| `errors.ts` | `ErrorCode` (enum), `StudioError` |
| `context-pack.ts` | `ContextPackDefinition`, `ResolvedContextPack` |
| `tool-plugin.ts` | `ToolPluginDef`, `ToolCommandDef`, `ShellExecute`, `BuiltinExecute`, `ParameterDef` |
| `runner-events.ts` | `RunnerCallbacks`, `ToolCallStartEvent`, `ToolCallCompleteEvent`, `AgentThinkingEvent`, `AgentProgressEvent`, `AgentTokenEvent` |
| `spawner.ts` | `RunSpawner`, `SpawnConfig`, `SpawnResult` |
| `integration-plugin.ts` | `IntegrationPluginDef` |

## Key types

### Hooks (pipeline.ts)

```typescript
// Stage-level hook (on_stage_start, on_stage_complete)
interface StageHookDef {
  command: string;
  on_failure?: 'warn' | 'reject' | 'fail';  // default: 'warn'
}

// Tool-level hook (pre_tool_use, post_tool_use)
interface ToolHookDef {
  matcher: string;  // exact tool name, e.g. "repo_manager-write_file"
  command: string;
  on_failure?: 'warn' | 'reject';
}

interface StageHooks {
  on_stage_start?: StageHookDef[];
  on_stage_complete?: StageHookDef[];
  pre_tool_use?: ToolHookDef[];
  post_tool_use?: ToolHookDef[];
}
```

### Agent (agent.ts)

```typescript
interface AgentConfig {
  name: string;
  provider: string;
  model: string;
  system_prompt?: string;
  tools?: string[];
  plugins?: string[];   // Claude Code plugin names
  skills?: string[];    // .skill.md file names
  anonymize?: boolean;  // Enable PII anonymization
}
```

### on_pipeline_start (pipeline.ts)

```typescript
interface StartupCommand {
  command: string;    // Shell command to run
  inject_as: string;  // Key to inject stdout under
}
```

### Sub-pipeline spawning (spawner.ts)

```typescript
interface RunSpawner {
  spawnAndWait(config: SpawnConfig): Promise<SpawnResult>;
}

interface SpawnConfig {
  pipeline: string;
  input: Record<string, unknown>;
  parentRunId: string;
  depth: number;
}
```

Used by the `studio_run` builtin tool to spawn sub-pipelines from within an agent run.

## Rules

- **Zero dependencies** — no imports from other `@studio/*` packages, ever.
- **Zero logic** — types and interfaces only. The one exception: `isStageGroup()` in `pipeline.ts` is a pure type guard function (no side effects, no state).
- If you need to add a type used by two packages, put it here.
- If you're adding logic, you're in the wrong package.

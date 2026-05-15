# @studio-foundation/contracts

**Studio** is a declarative YAML runtime for AI agents. It orchestrates multi-stage agent workflows with structured output validation and automatic retry. This package is **contracts**: the shared TypeScript types and interfaces that every other Studio package imports. Zero dependencies, zero logic.

`contracts` is the leaf of the dependency graph. It defines the language all Studio packages speak: `PipelineDefinition`, `StageRun`, `OutputContract`, `AgentConfig`, `LLMRequest`, and the rest. Install it if you're writing tooling that reads or produces Studio configs, or if you're embedding Studio packages into your own code and need the types.

- Homepage: https://github.com/studio-foundation/studio
- Full docs: [README](https://github.com/studio-foundation/studio#readme) · [INVARIANTS](https://github.com/studio-foundation/studio/blob/main/INVARIANTS.md)
- Use via the CLI: [`@studio-foundation/cli`](https://www.npmjs.com/package/@studio-foundation/cli)

## Install

```bash
npm install @studio-foundation/contracts
# or
pnpm add @studio-foundation/contracts
```

## Usage

```typescript
import type {
  PipelineDefinition,
  StageDefinition,
  OutputContract,
  AgentConfig,
  StageStatus,
} from '@studio-foundation/contracts';

import { isStageGroup } from '@studio-foundation/contracts'; // the only runtime export

for (const stage of pipeline.stages) {
  if (isStageGroup(stage)) {
    // handle a group
  } else {
    // handle a plain stage
  }
}
```

## Dependency position

```
contracts ← ralph
contracts ← runner
contracts ← anonymizer
contracts ← engine
contracts ← cli
contracts ← api
```

Nothing imports upward. If you find yourself adding a dep here, you're solving the wrong problem.

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

## For contributors

Internal rules that govern this package:

- **Zero dependencies**: no imports from other `@studio-foundation/*` packages, ever.
- **Zero logic**: types and interfaces only. The one exception: `isStageGroup()` in `pipeline.ts` is a pure type guard function (no side effects, no state).
- If you need to add a type used by two packages, put it here.
- If you're adding logic, you're in the wrong package.

## License

AGPL-3.0-only

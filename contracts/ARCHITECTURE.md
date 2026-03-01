# @studio/contracts

Types et interfaces partagés par tous les packages Studio. ZERO dépendances. ZERO logique.

## Règles

- Ce package n'a AUCUNE dépendance (pas de `@studio/*`, pas de libs externes)
- JAMAIS de logique — uniquement des types, interfaces, enums TypeScript
- Exception unique : `isStageGroup()` dans `pipeline.ts` (type guard pur, sans état)
- Tout changement ici impacte TOUS les autres packages — être conservateur
- Exporter tout depuis `index.ts`

## Fichiers clés

- `pipeline.ts` — `PipelineDefinition`, `StageDefinition`, `StageGroup`, `StageHooks`, `ToolHookDef`, `StageHookDef`, `StartupCommand`, `isStageGroup()`
- `stage.ts` — `StageStatus`, `StageKind` (= string), `StageResult`
- `task.ts` — `TaskStatus`
- `agent.ts` — `AgentConfig`, `AgentProfile`, `ToolCall`
- `run.ts` — `PipelineRun`, `StageRun`, `TaskRun`, `AgentRun`, `AgentStatus`
- `validation.ts` — `OutputContract`, `ToolCallRequirements`, `ValidationResult`, `ValidationRule`
- `provider.ts` — `LLMRequest`, `LLMResponse`, `Message`, `ToolDefinition`
- `errors.ts` — `ErrorCode` (enum), `StudioError`
- `context-pack.ts` — `ContextPackDefinition`, `ResolvedContextPack`
- `tool-plugin.ts` — `ToolPluginDef`, `ToolCommandDef`, `ShellExecute`, `BuiltinExecute`, `ParameterDef`
- `runner-events.ts` — `RunnerCallbacks`, événements de streaming tool calls et tokens
- `spawner.ts` — `RunSpawner`, `SpawnConfig`, `SpawnResult`
- `integration-plugin.ts` — `IntegrationPluginDef`

## Test

```bash
pnpm test
```

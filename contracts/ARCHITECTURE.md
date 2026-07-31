# @studio-foundation/contracts

Types et interfaces partagés par tous les packages Studio. ZERO dépendances. ZERO logique.

## Règles

- Ce package n'a AUCUNE dépendance (pas de `@studio/*`, pas de libs externes)
- JAMAIS de logique — uniquement des types, interfaces, enums TypeScript
- Exceptions, toutes pures et sans état : les type guards de `pipeline.ts`
  (`isStageGroup()`, `isMapStage()`, `isCallStage()`) et les helpers d'agrégation
  de `usage.ts` (`accumulateTokenUsage()`, `sumTokenUsage()`, `withModel()`) —
  l'arithmétique qui accompagne le type `TokenUsage`, sinon recopiée dans chaque
  package qui additionne des tokens
- `exports` déclare `require` en plus de `import` : `runner` et `anonymizer`
  compilent en CommonJS, et leur `require()` d'un package ESM-only échouerait
  (Node ≥ 22.12 sait charger de l'ESM depuis `require`)
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
- `usage.ts` — `TokenUsage`, `ModelTokenUsage`, `accumulateTokenUsage()`, `sumTokenUsage()`, `withModel()`
- `errors.ts` — `ErrorCode` (enum), `StudioError`
- `context-pack.ts` — `ContextPackDefinition`, `ResolvedContextPack`
- `tool-plugin.ts` — `ToolPluginDef`, `ToolCommandDef`, `ShellExecute`, `BuiltinExecute`, `ParameterDef`
- `runner-events.ts` — `RunnerCallbacks`, événements de streaming tool calls et tokens
- `spawner.ts` — `RunSpawner`, `SpawnConfig`, `SpawnResult`
- `trigger.ts` — `TriggerDef`

## Test

```bash
pnpm test
```

# @studio/engine

Orchestrateur de pipelines. Le cerveau de Studio.

## Concept

Charge une pipeline YAML → exécute les stages en séquence (ou en groups avec feedback loops) → pour chaque stage : hooks + `ralph(runAgent, validator)` → persiste les runs → émet des events.

## Règles

- **Domain-agnostic.** Pas de référence à "code", "file", "git", "QA" dans le source. `StageKind = string`.
- `deriveStageStatus()` dans `state/status-derivation.ts` est LA fonction critique — mapping déterministe ralph result → stage status
- La DB est configurable : `SQLiteRunStore` | `PgRunStore` | `InMemoryRunStore` (union `AnyRunStore`)
- Le engine ne construit pas de prompts — c'est runner
- Le engine ne sait pas ce qu'est `repo_manager-write_file` — c'est runner
- Dépend de `@studio/contracts`, `@studio/ralph`, `@studio/runner`, `@studio/anonymizer`

## Fichiers clés

- `engine.ts` — `PipelineEngine` (classe principale), `EngineConfig`, `RunInput`
- `events.ts` — `EngineEvents`, `PipelineEventEmitter`
- `state/status-derivation.ts` — `deriveStageStatus()` ← CRITIQUE
- `state/run-store.ts` — `AnyRunStore`, `InMemoryRunStore`
- `pipeline/loader.ts` — charge YAML → `PipelineDefinition`
- `pipeline/agent-loader.ts` — charge agent YAML + injecte skills
- `pipeline/contract-loader.ts` — charge contract YAML
- `pipeline/context-propagation.ts` — `createInitialContext`, `addStageOutput`, `getContextForStage`
- `pipeline/context-pack-loader.ts` — charge les context packs
- `pipeline/hook-executor.ts` — `runStageHook()`, `runToolHook()` (4 points de hook)
- `pipeline/startup-executor.ts` — `executeStartupCommands()` pour `on_pipeline_start`
- `pipeline/post-validator.ts` — `postValidate()` (rejection detection)
- `pipeline/skill-loader.ts` — charge les `.skill.md` files
- `db/client.ts` — SQLite client (pour WebhookStore, IntegrationStore côté api)
- `spawners/direct-engine-spawner.ts` — `DirectEngineSpawner` implémente `RunSpawner`

## Groups (feedback loops)

Un group contient plusieurs stages qui itèrent ensemble. Si le dernier stage rejette (via `post_validation.rejection_detection`), le group redémarre depuis le début avec le feedback accumulé. `max_iterations` cap.

## Hooks lifecycle

4 points déterministes : `on_stage_start`, `on_stage_complete`, `pre_tool_use`, `post_tool_use`.
`on_failure: warn | reject | fail`. Les hooks `pre_tool_use` avec reject bloquent le tool call.

## État machine

```
pending → running → success
                  → failed     (ralph exhausted, ou hook on_failure: fail)
                  → rejected   (post_validation, ou hook on_failure: reject)
                  → skipped
                  → cancelled  (AbortSignal)
```

## Dépendances

`@studio/contracts`, `@studio/ralph`, `@studio/runner`, `@studio/anonymizer`

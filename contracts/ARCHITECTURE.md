# @studio/contracts

Types et interfaces partagés par tous les packages Studio. ZERO logique.

## Règles

- Ce package n'a AUCUNE dépendance
- JAMAIS de logique, uniquement des types/interfaces/enums TypeScript
- Tout changement ici impacte TOUS les autres repos — être conservateur
- Exporter tout depuis index.ts

## Fichiers clés

- `pipeline.ts` — PipelineDefinition, StageDefinition
- `stage.ts` — StageStatus, StageKind, StageResult
- `task.ts` — TaskStatus, TaskResult, TaskConfig
- `agent.ts` — AgentConfig, AgentProfile, ToolCall
- `run.ts` — PipelineRun, StageRun, TaskRun, AgentRun
- `validation.ts` — OutputContract, ValidationResult, ValidationRule
- `provider.ts` — LLMProvider, LLMRequest, LLMResponse, ToolDefinition
- `errors.ts` — StudioError, error codes enum

## Test

```bash
npm test  # compile-time type checks uniquement
```

## Philosophy

This is the foundation. Keep it stable. Keep it simple. Keep it pure types.

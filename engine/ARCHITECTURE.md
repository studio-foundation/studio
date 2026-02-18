# @studio/engine

Orchestrateur de pipelines. Le cerveau de Studio.

## Concept

Charge une pipeline YAML → exécute les stages en séquence →
pour chaque task: ralph(runner.run, validator) → persiste les runs en SQLite.

## Règles

- UN pipeline = séquence de stages (pas de DAG pour la v7, KISS)
- deriveStageStatusFromTasks() est LA fonction critique — elle doit être
  déterministe et testée exhaustivement
- La DB (SQLite) est UNIQUEMENT dans ce repo
- Context propagation : output stage N → input stage N+1
- Events (onStageStart, etc.) pour hooks futurs (UI, logging)

## Fichiers clés

- `engine.ts` — PipelineEngine, la classe principale
- `state/state-machine.ts` — lifecycle des stages
- `state/status-derivation.ts` — deriveStageStatusFromTasks() ← CRITIQUE
- `state/run-store.ts` — persistence SQLite via Prisma
- `pipeline/loader.ts` — charge YAML → PipelineDefinition
- `pipeline/context-propagation.ts` — passe le contexte entre stages

## Le test qui compte

tests/e2e/feature-v5.test.ts — FAQ sur About.tsx, doit passer 10/10.
Si ce test passe pas de façon fiable, rien d'autre compte.

## Dépendances

@studio/contracts, @studio/ralph, @studio/runner

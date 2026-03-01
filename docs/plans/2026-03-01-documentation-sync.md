# Documentation Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Synchronize all Studio documentation with the actual state of the codebase — add what exists in code but is absent from docs, correct wrong type names, and move speculative content to Roadmap sections.

**Architecture:** Read-then-write per file. One file at a time. Present diff before touching. Scope: CLAUDE.md, README.md (root), and 5 package READMEs (contracts, ralph, runner, engine, cli). Out of scope: INVARIANTS.md, BUSINESS_PLAN.md, FOUNDATRICE_NOTES.md, TEMPLATES.md.

**Tech Stack:** Markdown only. No code changes.

---

## Pre-work: Confirmed Discrepancies (audit already complete — do not re-audit)

The audit has already been run. All discrepancies below are confirmed against actual source files.

---

### Task 1: contracts/README.md — Fix wrong type names

**Files:**
- Modify: `contracts/README.md`

Type names in the "What's in here" table are wrong. They don't match `contracts/src/*.ts`.

**Confirmed discrepancies (corrections):**

| Module | Current (wrong) | Actual (code) |
|--------|-----------------|---------------|
| `stage.ts` | `StageStatus`, `StageResult`, `StageOutput` | `StageStatus`, `StageResult` (no `StageOutput`) |
| `task.ts` | `TaskDefinition`, `RalphSettings` | `TaskStatus` only |
| `run.ts` | `RunRecord`, `RunStatus`, `RunSummary` | `PipelineRun`, `StageRun`, `TaskRun`, `AgentRun`, `AgentStatus` |
| `validation.ts` | `ToolCallConstraints` | `ToolCallRequirements` |
| `provider.ts` | `LLMResponse`, `ToolCall`, `TokenUsage` | `LLMRequest`, `LLMResponse`, `Message`, `ToolDefinition` (no `ToolCall` here — it's in agent.ts; no `TokenUsage` standalone type) |
| `context-pack.ts` | `ContextPack`, `ContextPackDefinition` | `ContextPackDefinition`, `ResolvedContextPack` |
| `tool-plugin.ts` | `ToolPlugin`, `ToolPluginCommand` | `ToolPluginDef`, `ToolCommandDef` |

**Additions (modules present in code, absent from table):**
- `spawner.ts` — `RunSpawner`, `SpawnConfig`, `SpawnResult`
- `integration-plugin.ts` — `IntegrationPluginDef`

**Note about "Zero logic" rule:** `isStageGroup()` is a type guard function exported from `pipeline.ts`. The README says "Zero logic — types and interfaces only." This is the one exception — it's a pure type narrowing function. Update the rule to clarify.

**Step 1: Present the proposed changes to the user and wait for confirmation**

Show the proposed new "What's in here" table and the additions. Ask: "Confirm to proceed with contracts/README.md?"

**Step 2: Edit contracts/README.md**

Update:
1. The "What's in here" table with correct type names
2. Add `spawner.ts` and `integration-plugin.ts` rows
3. Correct the "Zero logic" rule to note `isStageGroup()` exception

**Step 3: Verify**

Read the file back and confirm type names match `contracts/src/index.ts` exports.

---

### Task 2: ralph/README.md — Add 'cancelled' status

**Files:**
- Modify: `ralph/README.md`

**Confirmed discrepancy:**

The `RalphResult` type in `ralph/src/loop.ts` has three states:
```typescript
type RalphResult<T> =
  | { status: 'success'; result: T; attempts: number }
  | { status: 'exhausted'; lastResult: T; failures: string[]; attempts: number }
  | { status: 'cancelled'; lastResult?: T; attempts: number };
```

The README only documents `'success' | 'exhausted'` and omits `'cancelled'`. The `'cancelled'` state is triggered by `AbortSignal`.

**Step 1: Present the proposed change**

Show the corrected `RalphResult` type and a one-line note: "AbortSignal support — pass `signal` in `RalphConfig` to enable cooperative cancellation. Returns `{ status: 'cancelled' }` if aborted."

**Step 2: Edit ralph/README.md**

Update:
1. The code example showing `result.status` to include `'cancelled'`
2. Note `signal?: AbortSignal` in the `ralph()` config parameters

---

### Task 3: runner/README.md — Add studio_run tool

**Files:**
- Modify: `runner/README.md`

**Confirmed discrepancy:**

The builtin tools table omits `studio_run` (from `tools/builtin/studio-run.ts`). This tool lets agents spawn sub-pipelines and is wired via `RunSpawner`.

**Step 1: Present the proposed addition**

Show the new row to add:
```
| `studio_run` | `createStudioRunTool()` | Spawn and await a sub-pipeline run |
```
And a note: "Only available when `spawner` is configured in `EngineConfig`. Wired by the engine when `RunSpawner` is provided."

**Step 2: Edit runner/README.md**

Add the `studio_run` row to the builtin tools table.

---

### Task 4: engine/README.md — Clarify RunStore type

**Files:**
- Modify: `engine/README.md`

**Confirmed discrepancy:**

The `EngineConfig` example shows `db: runStore` but doesn't specify the type. The actual type is `AnyRunStore` (a union of `InMemoryRunStore` and `PgRunStore`). The README mentions "Persistence: `SQLiteRunStore` for production" which is now outdated — it's `PgRunStore` (PostgreSQL) for production.

**Step 1: Present the proposed change**

Show:
- `db` type is `AnyRunStore` — union of `InMemoryRunStore` | `PgRunStore`
- PostgreSQL for production, InMemory for tests

**Step 2: Edit engine/README.md**

Update:
1. The Rules section: "Persistence: `PgRunStore` for production, `InMemoryRunStore` for tests."
2. The EngineConfig example to note `db: AnyRunStore`

---

### Task 5: cli/README.md — Add missing commands, fix dependency claim

**Files:**
- Modify: `cli/README.md`

**Confirmed discrepancies:**

**Missing commands** (present in `cli/src/commands/`, absent from README):
- `studio logs [run-id]` — `commands/logs.ts`
- `studio replay [run-id]` — `commands/replay.ts`
- `studio integrations` — `commands/integrations.ts`
- `studio templates` — `commands/templates.ts`
- `studio project` — `commands/project.ts`
- `studio api start` — `commands/api.ts`
- `studio registry install/remove/search/publish/audit/sync/update` — `commands/registry/`

**Wrong dependency claim:**
The Rules section says "cli depends on engine + contracts only (not ralph or runner directly)."
The actual code: cli is the composition root and imports from `runner` (ToolRegistry, ProviderRegistry, MCPClient). INVARIANTS.md explicitly documents this as a noted exception to the DAG rule.

**Step 1: Present the proposed additions**

Show the commands to add (organized by group) and the corrected dependency note.

**Step 2: Edit cli/README.md**

Update:
1. Commands section — add missing commands in appropriate groups
2. Rules section — correct the dependency claim: "cli is the composition root; it imports from engine, runner, and api. This is a documented exception to the DAG (see INVARIANTS.md)."

---

### Task 6: CLAUDE.md — Add missing CLI commands and API routes

**Files:**
- Modify: `CLAUDE.md`

**Confirmed discrepancies:**

**CLI commands — missing from "Commandes" section:**
```bash
# Runs
studio logs [run-id]                         # Afficher les logs d'un run
studio replay [run-id]                       # Rejouer un run

# API
studio api start                             # Démarrer le serveur API

# Project
studio project                               # Gestion de projet

# Registry
studio registry install <name>               # Installer un tool depuis le registry
studio registry remove <name>                # Supprimer un tool du registry
studio registry search <query>               # Rechercher dans le registry
studio registry publish <path>               # Publier un tool
studio registry audit                        # Auditer les tools installés
studio registry sync                         # Synchroniser le registry.lock.json
studio registry update [name]                # Mettre à jour les tools installés

# Templates
studio templates                             # Lister les templates disponibles
studio integrations                          # Gérer les intégrations (Linear, etc.)
```

**API routes — missing from "Endpoints REST" section:**
```
GET    /api/contracts               → liste tous les contrats
GET    /api/contracts/:name         → contenu d'un contrat
PUT    /api/contracts/:name         → créer ou modifier un contrat
DELETE /api/contracts/:name         → supprimer un contrat

GET    /api/skills                  → liste tous les skills
GET    /api/skills/:name            → contenu d'un skill
PUT    /api/skills/:name            → créer ou modifier un skill
DELETE /api/skills/:name            → supprimer un skill

GET    /api/tools                   → liste les tools disponibles

POST   /api/validate                → valider un output JSON contre un contrat

GET    /api/config                  → configuration courante (API keys masquées)
PUT    /api/config                  → modifier la configuration

POST   /api/webhooks                → enregistrer un webhook
GET    /api/webhooks                → lister les webhooks
DELETE /api/webhooks/:id            → supprimer un webhook
```

**Builtin tools — missing from "Tools" section:**
```
git-checkout        Checkout ou créer une branche
git-commit          Créer un commit
git-push            Pousser vers le remote
git-pull            Tirer depuis le remote
git-status          Afficher le status du working tree
git-diff            Afficher les diffs
patch-apply_patch   Appliquer un unified diff
studio_run          Spawner un sous-pipeline (requiert RunSpawner dans EngineConfig)
```

**Step 1: Present each section of proposed additions**

Show the exact text to add for CLI commands, API routes, and tools. Wait for confirmation before writing.

**Step 2: Edit CLAUDE.md — CLI commands**

Add missing commands to the "Commandes" section.

**Step 3: Edit CLAUDE.md — API routes**

Add missing routes to the "Endpoints REST" section.

**Step 4: Edit CLAUDE.md — Builtin tools**

Add missing tools to the "Tools / Builtins actuels" table.

---

### Task 7: README.md — Fix architecture, .studio/ structure, status

**Files:**
- Modify: `README.md`

**Confirmed discrepancies:**

**Architecture section** shows 5 packages, missing `api` and `anonymizer`:
```
Current:
@studio/cli → @studio/engine → @studio/ralph + @studio/runner → @studio/contracts

Actual (7 packages):
@studio/cli → @studio/api → @studio/engine → @studio/ralph + @studio/runner + @studio/anonymizer → @studio/contracts
```

**`.studio/` structure in "What gets generated"** shows old `projects/` subdirectory (pre-migration):
```
# Current (WRONG — from before stu-85 flat structure migration):
.studio/
├── config.yaml
├── projects/
│   └── software/
│       ├── pipelines/
│       ...

# Actual (flat):
.studio/
├── config.yaml
├── pipelines/
├── agents/
├── contracts/
├── tools/
├── inputs/
├── registry.lock.json
└── runs/
```

**Status section** — "What's functional" is incomplete:
- Missing: `@studio/api` HTTP REST API (Fastify + Swagger UI)
- Missing: Registry system (`studio registry install/remove/search/publish`)
- Missing: Integration system (Linear webhook handler)
- Missing: SSE streaming (`GET /api/runs/:id/stream`)
- Missing: Sub-pipeline spawning (`studio_run` tool + `RunSpawner`)

**CLI section** — missing commands (same list as Task 5).

**Step 1: Present the proposed changes**

Show the corrected architecture diagram, fixed `.studio/` tree, updated Status "What's functional" list, and CLI additions.

**Step 2: Edit README.md**

Update:
1. Architecture section — add `@studio/api` and `@studio/anonymizer`
2. `.studio/` directory tree — fix to flat structure
3. Status "What's functional" — add api, registry, integrations, SSE, sub-pipeline spawning
4. CLI section — add missing commands

---

## Execution order

1. contracts/README.md (type name corrections — highest impact, most wrong)
2. ralph/README.md (small, quick)
3. runner/README.md (small, quick)
4. engine/README.md (small, quick)
5. cli/README.md (missing commands)
6. CLAUDE.md (largest scope — CLI commands + API routes + tools)
7. README.md (architecture + .studio/ structure — public-facing, careful)

## Rules

- One file at a time
- Present discrepancies + proposed content → wait for confirmation → write
- Never delete: move speculative content to `## Roadmap` if needed
- No cosmetic changes — only substantive discrepancies
- No changes to INVARIANTS.md, TEMPLATES.md, BUSINESS_PLAN.md, FOUNDATRICE_NOTES.md

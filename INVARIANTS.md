# INVARIANTS.md: Studio

Non-negotiable contracts on system behavior. These invariants are enforced by code (TypeScript types, package structure, dependency graph), this file makes them explicit for humans and AI agents.

**Ground rule:** If you find code that violates one of these invariants, it is an architecture error, not an acceptable exception.

---

## INV-01: `contracts` is a leaf package

**Description:** `@studio-foundation/contracts` has zero internal dependencies on other `@studio/*` packages. Zero. No exceptions.

**Enforced by:** [`contracts/package.json`](contracts/package.json): the `dependencies` section contains no `@studio/*` entries.

**What breaks if violated:** Circular dependency. `ralph`, `runner`, and `engine` all import `contracts`. If `contracts` imports any of them, the dependency graph becomes a cycle and the entire system fails at initialization.

---

## INV-02: `ralph` does not know `runner`

**Description:** `ralph` takes a generic `executor: (context: ExecutionContext) => Promise<T>`. It does not know that `T` will be an `AgentRunResult`. It has no knowledge of LLMs, providers, or tools.

**Enforced by:** [`ralph/src/loop.ts`](ralph/src/loop.ts): `RalphConfig<T>` is a generic parameterized type. [`ralph/package.json`](ralph/package.json): depends only on `@studio-foundation/contracts`, not on `@studio-foundation/runner`.

**What breaks if violated:** `ralph` becomes coupled to a concrete implementation. It can no longer be tested without a real LLM. The separation between "retry loop" and "LLM execution" disappears, and the retry logic becomes impossible to reuse for other executors.

---

## INV-03: `runner` only executes, never validates or retries

**Description:** `runner.runAgent()` calls the LLM, collects the result, and returns an `AgentRunResult`. It does not validate output format. It does not trigger retries. It returns immediately after the LLM call.

**Enforced by:** [`runner/src/runner.ts`](runner/src/runner.ts): no references to `ValidationResult`, no retry loops. Validation and retry live exclusively in `ralph`.

**What breaks if violated:** Double validation (runner + ralph), contradictory behavior, and inability to distinguish "invalid format" from "LLM error". The responsibility pipeline `execute → validate → retry` becomes ambiguous.

---

## INV-04: `engine` is domain-agnostic

**Description:** The engine contains no references to domain concepts: "code", "git", "QA", "feature", "bug". `StageKind` is defined as `string`, a free value. The engine never branches on the value of `stage.kind`.

**Enforced by:** [`contracts/src/stage.ts`](contracts/src/stage.ts): `kind: string`. [`engine/src/engine.ts`](engine/src/engine.ts): `stage_kind` is passed to the runner as opaque metadata, never used in engine logic.

**What breaks if violated:** The engine becomes a framework for a specific domain. Pipelines from other domains (legal, medical, analytics) can no longer use it without modifying the core. The YAML-first architecture collapses, behavior ends up in code instead of configs.

---

## INV-05: Tools live in `runner`, not in `engine`

**Description:** The tool registry, plugin loader, and tool executor live in `runner/src/tools/`. The engine passes configurations to the runner but never loads, instantiates, or has knowledge of specific tools (`repo_manager-write_file`, `shell-run_command`, etc.).

**Enforced by:** [`runner/src/tools/`](runner/src/tools/): contains `tool-registry.ts`, `tool-executor.ts`, `plugin-loader.ts`. The engine has no `tools/` directory.

**What breaks if violated:** The engine becomes dependent on concrete tool implementations. Adding a tool requires modifying the engine. The orchestration/execution separation disappears.

---

## INV-06: Prompts live in `runner`, not in `engine`

**Description:** `prompt-builder.ts` lives in `runner/src/`. It assembles the system prompt, contract constraints, tool plugin snippets, and retry context. The engine builds no prompts.

**Enforced by:** [`runner/src/prompt-builder.ts`](runner/src/prompt-builder.ts): single point of prompt assembly. No `prompt-builder.ts` file exists in `engine/`.

**What breaks if violated:** Prompt logic becomes scattered between engine and runner. Context propagation, tool snippets, and retry instructions lose coherence. Changing the prompt format requires touching multiple packages.

---

## INV-07: The state machine is deterministic

**Description:** `deriveStageStatus(ralphResult)` maps RALPH results to stage status directly and exhaustively. No conditional logic on output content. `ralph 'success' → stage 'success'`, `ralph 'exhausted' → stage 'failed'`, `ralph 'cancelled' → stage 'cancelled'`. Nothing else.

**Enforced by:** [`engine/src/state/status-derivation.ts`](engine/src/state/status-derivation.ts): exhaustive mapping with a `throw` for unknown states. `RalphResult` is a discriminated union with 3 states: `success | exhausted | cancelled`.

**What breaks if violated:** This was an early architectural bug where stage status did not match task result. The current design makes this function the single contract between ralph and engine. If it becomes non-deterministic (branching on output content, intermediate states), the pipeline becomes unpredictable.

---

## INV-08: Validation is binary: pass or fail

**Description:** `ValidationResult` has a `valid: boolean` field. An output is valid or it isn't. No partial credit. Warnings exist but do not change the result: an output with warnings but `valid: true` is accepted.

**Enforced by:** [`contracts/src/validation.ts`](contracts/src/validation.ts): `ValidationResult.valid: boolean`. All validators in [`runner/src/`](runner/src/) return this interface.

**What breaks if violated:** If validation becomes a score or gradient, ralph's retry logic stops working. The acceptance threshold becomes arbitrary and configurable, a source of bugs and surprising behavior.

---

## INV-09: A project is fully self-contained in its directory

**Description:** Everything for a project (pipelines, agents, contracts, tools) lives in `.studio/`. No project references configs from another project. All loaders are scoped to the project directory.

**Enforced by:** [`engine/src/pipeline/types.ts`](engine/src/pipeline/types.ts): `resolveProjectPaths(configsDir)` derives all paths from `configsDir` (the project's `.studio/`): `pipelines/`, `agents/`, `contracts/`. [`engine/src/engine.ts`](engine/src/engine.ts): `configsDir` is passed to the engine as the project root; all loaders are scoped to that directory and never escape it.

**What breaks if violated:** Projects bleed into each other. Modifying one project's configs can affect another. The concept of a project as an isolated, deployable unit disappears, making it impossible to share a project between teams without sharing all configs.

---

## INV-10: The dependency graph is a strict DAG

**Description:** Dependencies between packages form a directed acyclic graph (DAG). The order is: `(contracts, anonymizer)` → `(ralph, runner)` → `engine` → `cli`. No reverse dependencies. `ralph` and `runner` are siblings, neither knows the other. `anonymizer` is a co-leaf with `contracts`: it depends only on `@redactpii/node` (external), not on any `@studio/*` package.

**Enforced by:** The `package.json` of each package defines dependencies. `pnpm` detects cycles on install. To verify:

```bash
cat contracts/package.json   # dependencies: {} (no internal deps)
cat anonymizer/package.json  # dependencies: { "@redactpii/node": ... } (external only)
cat ralph/package.json       # dependencies: { "@studio-foundation/contracts": "workspace:*" }
cat runner/package.json      # dependencies: { "@studio-foundation/contracts": "workspace:*", "@studio-foundation/anonymizer": "workspace:*" }
cat engine/package.json      # dependencies: { "@studio-foundation/ralph": ..., "@studio-foundation/runner": ..., "@studio-foundation/contracts": ... }
cat cli/package.json         # dependencies: { "@studio-foundation/engine": ..., "@studio-foundation/contracts": ..., "@studio-foundation/api": ..., "@studio-foundation/runner": ... }
```

**Documented exception (CLI → API):** `@studio-foundation/cli` depends on `@studio-foundation/api`. This is intentional and not a DAG violation. The `studio api start` command imports `bootstrap` from `@studio-foundation/api` to start the HTTP server directly from the CLI. This dependency follows the flow (cli is the highest layer): `api` does not know `cli`. The DAG remains acyclic.

**Documented exception (CLI → runner):** `@studio-foundation/cli` depends on `@studio-foundation/runner`. This is intentional: the CLI is the **composition root** of the application. It instantiates `ToolRegistry`, `ProviderRegistry`, and `MCPClient` (all types from `runner`) and passes them to `PipelineEngine` via `EngineConfig`. The CLI also handles `studio tools` commands that use runner's tool template utilities. This dependency follows the flow: `runner` does not know `cli`. The DAG remains acyclic.

**What breaks if violated:** Circular dependency → crash at module initialization. Or coupling that turns a local change into a cascade of modifications across the monorepo.

---

## Quick reference

| ID | Invariant | Package(s) | Key file |
|----|-----------|------------|----------|
| INV-01 | `contracts` = leaf package | contracts | `contracts/package.json` |
| INV-02 | `ralph` does not know `runner` | ralph | `ralph/src/loop.ts` |
| INV-03 | `runner` only executes | runner | `runner/src/runner.ts` |
| INV-04 | `engine` is domain-agnostic | engine, contracts | `engine/src/engine.ts` |
| INV-05 | Tools in `runner` | runner, engine | `runner/src/tools/` |
| INV-06 | Prompts in `runner` | runner, engine | `runner/src/prompt-builder.ts` |
| INV-07 | Deterministic state machine | engine, ralph | `engine/src/state/status-derivation.ts` |
| INV-08 | Binary validation | contracts, runner | `contracts/src/validation.ts` |
| INV-09 | Projects are self-contained | engine | `engine/src/engine.ts` |
| INV-10 | Strict dependency DAG | all | `*/package.json` |

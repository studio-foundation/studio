# INVARIANTS.md: Studio

Non-negotiable contracts on system behavior. These invariants are enforced by code (TypeScript types, package structure, dependency graph), this file makes them explicit for humans and AI agents.

**Ground rule:** If you find code that violates one of these invariants, it is an architecture error, not an acceptable exception.

**Declared is not enforced.** An invariant nobody can break by accident is the only kind that holds. INV-04, INV-05, INV-06, INV-10 and INV-12 are checked by [scripts/check-invariants.mjs](scripts/check-invariants.mjs) (`pnpm check:invariants`, blocking in CI), INV-10's import direction additionally by ESLint, and INV-11 by [scripts/check-kernel-domain-free.mjs](scripts/check-kernel-domain-free.mjs). The rest are properties of type signatures and call graphs that no grep can settle; each says so under **Enforced by**. Loosening a check to make a change pass is the same act as violating the invariant.

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

**Description:** The engine contains no references to domain concepts: "code", "git", "QA", "feature", "bug". `StageKind` is defined as `string`, a free value. The engine never branches on the value of `stage.kind`. Nor does it *act* on a domain: resolving a workspace by cloning a repository is a caller responsibility, and lives in [`api/src/utils/repo-resolver.ts`](api/src/utils/repo-resolver.ts) — the API reaches it directly, the CLI through the `@studio-foundation/api/repo-resolver` subpath.

**Enforced by:** [`contracts/src/stage.ts`](contracts/src/stage.ts): `kind: string`. [`engine/src/engine.ts`](engine/src/engine.ts): `stage_kind` is passed to the runner as opaque metadata, never used in engine logic. [scripts/check-invariants.mjs](scripts/check-invariants.mjs) fails the build when `engine/src/**` shells out to a git subcommand, names a builtin tool, names a pipeline/contract/stage from a template, or says "QA".

**What breaks if violated:** The engine becomes a framework for a specific domain. Pipelines from other domains (legal, medical, analytics) can no longer use it without modifying the core. The YAML-first architecture collapses, behavior ends up in code instead of configs.

---

## INV-05: Tools live in `runner`, not in `engine`

**Description:** The tool registry, plugin loader, and tool executor live in `runner/src/tools/`. The engine passes configurations to the runner but never loads, instantiates, or has knowledge of specific tools (`repo_manager-write_file`, `shell-run_command`, etc.).

**Enforced by:** [`runner/src/tools/`](runner/src/tools/): contains `tool-registry.ts`, `tool-executor.ts`, `plugin-loader.ts`. The engine has no `tools/` directory. [scripts/check-invariants.mjs](scripts/check-invariants.mjs) asserts both halves: `runner/src/tools/tool-registry.ts` exists and `engine/src/tools/` does not.

**What breaks if violated:** The engine becomes dependent on concrete tool implementations. Adding a tool requires modifying the engine. The orchestration/execution separation disappears.

---

## INV-06: Prompts live in `runner`, not in `engine`

**Description:** `prompt-builder.ts` lives in `runner/src/`. It assembles the system prompt, contract constraints, tool plugin snippets, agent skills, project invariants, and retry context. The engine builds no prompts.

The engine still *reads* what goes into one — `.studio/skills/*.skill.md` and `.studio/invariants.md` are paths it owns (INV-09), and no other package may resolve them. The line is loading versus assembling: the engine hands `runAgent` the loaded content as `pluginSkills`, `skills` and `projectInvariants`, and `buildPrompt` decides the headings, the order, and the separators. An engine that concatenates into `agentConfig.system_prompt` has taken that decision back.

**Enforced by:** [`runner/src/prompt-builder.ts`](runner/src/prompt-builder.ts): single point of prompt assembly. [scripts/check-invariants.mjs](scripts/check-invariants.mjs) fails the build when `engine/src/**` assigns to `system_prompt` or ships a file named `prompt-builder`, and when `runner/src/prompt-builder.ts` is missing.

**What breaks if violated:** Prompt logic becomes scattered between engine and runner. Context propagation, tool snippets, and retry instructions lose coherence. Changing the prompt format requires touching multiple packages.

---

## INV-07: Every status comes from a declared rule

**Description:** A stage's status is decided in three places, in this order, and nowhere else:

1. **[`deriveStageStatus(ralphResult)`](engine/src/state/status-derivation.ts)** — total over RALPH's three outcomes: `success → success`, `exhausted → failed`, `cancelled → cancelled`, `throw` otherwise.
2. **Post-validation**, when and only when the contract declares `post_validation.rejection_detection` — a rejecting verdict turns `success` into `rejected`. The field, the accepted values and the rejected values are read from the contract YAML; none of them is hardcoded.
3. **`on_stage_complete` hooks**, per each hook's own `on_failure`: `warn` (default) leaves the status alone, `reject` turns it into `rejected`, `fail` into `failed`.

Steps 2 and 3 apply only to a stage that reached `success`; `cancelled` returns before both ([`stage-executor.ts`](engine/src/pipeline/stage-executor.ts)).

So the rule is not "nothing branches on output content" — step 2 does, and that is its job. It is that **no step infers a verdict**: every branch reads a field a config author declared, with values that author wrote down.

Two statuses never arrive this way. `skipped` is set before any of it, on a stage whose `when` condition was false — it never ran. `interrupted` is not a stage status at all in practice: [`reconcileOrphan`](engine/src/state/orphan.ts) stamps it on a *run* whose owning process died without writing a terminal status.

The full list lives in [`contracts/src/stage.ts`](contracts/src/stage.ts) and is the source both this file and CLAUDE.md follow:

```
pending | running | success | failed | skipped | rejected | cancelled | interrupted
```

`StageLifecycleState` in [`state-machine.ts`](engine/src/state/state-machine.ts) covers the seven a stage transitions through, `interrupted` excluded.

**Enforced by:** [`engine/src/state/status-derivation.ts`](engine/src/state/status-derivation.ts): exhaustive mapping with a `throw` for unknown states. `RalphResult` is a discriminated union with 3 states: `success | exhausted | cancelled`. [`engine/src/state/state-machine.ts`](engine/src/state/state-machine.ts): `transition()` throws on any pair absent from `VALID_TRANSITIONS`, so a status cannot be reached by assignment from an arbitrary state.

**What breaks if violated:** This was an early architectural bug where stage status did not match task result. If a step starts inferring a verdict — reading the output and deciding for itself what it means — the pipeline becomes unpredictable and a config author loses the ability to say what "rejected" means for their domain.

---

## INV-08: Validation is binary: pass or fail

**Description:** `ValidationResult` has a `valid: boolean` field. An output is valid or it isn't. No partial credit. Warnings exist but do not change the result: an output with warnings but `valid: true` is accepted.

**Enforced by:** [`contracts/src/validation.ts`](contracts/src/validation.ts): `ValidationResult.valid: boolean`. All validators in [`runner/src/`](runner/src/) return this interface.

**What breaks if violated:** If validation becomes a score or gradient, ralph's retry logic stops working. The acceptance threshold becomes arbitrary and configurable, a source of bugs and surprising behavior.

---

## INV-09: A project is fully self-contained in its directory

**Description:** Everything for a project (pipelines, agents, contracts, tools) lives in `.studio/`. No project references configs from another project. All loaders are scoped to the project directory.

**Enforced by:** [`engine/src/pipeline/types.ts`](engine/src/pipeline/types.ts): `resolveProjectPaths(configsDir)` derives all paths from `configsDir` (the project's `.studio/`): `pipelines/`, `agents/`, `contracts/`, `skills/`. [`engine/src/engine.ts`](engine/src/engine.ts): `configsDir` is passed to the engine as the project root.

Deriving the directories is not enough — a name written in a YAML file is joined onto them, so `skills: ["../../x"]` would escape a project that only derives its paths correctly. [`engine/src/pipeline/safe-path.ts`](engine/src/pipeline/safe-path.ts): `resolveWithin(baseDir, segment, label)` resolves a config-supplied path segment and throws if it leaves `baseDir`, refusing `..`, absolute paths and `~`. Applied to every segment a config author controls: skill names ([`skill-loader.ts`](engine/src/pipeline/skill-loader.ts)), context pack names and their `files[].path` entries ([`context-pack-loader.ts`](engine/src/pipeline/context-pack-loader.ts)).

**Not covered:** the workspace (`repoPath` / `--repo-path`, [`api/src/utils/repo-resolver.ts`](api/src/utils/repo-resolver.ts)) is deliberately outside the project directory — it is the repository the pipeline operates on, chosen by whoever launches the run, not by a config a project may have installed from a registry.

**What breaks if violated:** Projects bleed into each other. Modifying one project's configs can affect another. The concept of a project as an isolated, deployable unit disappears, making it impossible to share a project between teams without sharing all configs.

---

## INV-10: The dependency graph is a strict DAG

**Description:** Dependencies between packages form a directed acyclic graph (DAG). The order is: `(contracts, anonymizer)` → `(ralph, runner)` → `engine` → `api` → `cli`. No reverse dependencies. `ralph` and `runner` are siblings, neither knows the other. `anonymizer` is a co-leaf with `contracts`: it depends only on `@redactpii/node` (external), not on any `@studio/*` package. Note that `engine` does **not** depend on `anonymizer` — the middleware is instantiated in `runner`, which is where the LLM call it wraps happens.

The full edge list, which is what the two mechanical checks below encode:

| Package | May import |
|---|---|
| `contracts` | nothing |
| `anonymizer` | nothing |
| `ralph` | `contracts` |
| `runner` | `contracts`, `anonymizer` |
| `engine` | `contracts`, `ralph`, `runner` |
| `api` | `contracts`, `engine`, `runner` |
| `cli` | `contracts`, `engine`, `runner`, `api` |

**Enforced by:** three layers, none of which is sufficient alone. `pnpm` detects cycles on install. `ALLOWED_INTERNAL_IMPORTS` in [eslint.config.mjs](eslint.config.mjs) mirrors the table and rejects any `@studio-foundation/*` import outside a package's row — but ESLint reads source, not manifests. [scripts/check-invariants.mjs](scripts/check-invariants.mjs) closes that half: it reads every `package.json` and fails on an internal dependency the table does not allow. Adding an edge means editing the table, the ESLint map, the script's `DAG`, and the package's `package.json` — four deliberate acts, which is the point.

**Documented exception (CLI → API):** `@studio-foundation/cli` depends on `@studio-foundation/api`. This is intentional and not a DAG violation. The `studio api start` command imports `bootstrap` from `@studio-foundation/api` to start the HTTP server directly from the CLI. This dependency follows the flow (cli is the highest layer): `api` does not know `cli`. The DAG remains acyclic.

**Documented exception (CLI → runner):** `@studio-foundation/cli` depends on `@studio-foundation/runner`. This is intentional: the CLI is the **composition root** of the application. It instantiates `ToolRegistry`, `ProviderRegistry`, and `MCPClient` (all types from `runner`) and passes them to `PipelineEngine` via `EngineConfig`. The CLI also handles `studio tools` commands that use runner's tool template utilities. This dependency follows the flow: `runner` does not know `cli`. The DAG remains acyclic.

**Documented exception (API → runner):** `@studio-foundation/api` depends on `@studio-foundation/runner` for the same reason, and it is an exception on the same terms: the API is the composition root when a run is launched over HTTP rather than from a terminal, so it builds the same registries the CLI does. It skips `ralph` and `anonymizer` because it never assembles either — both are reached through `engine` and `runner` respectively. `runner` does not know `api`. The DAG remains acyclic.

**What breaks if violated:** Circular dependency → crash at module initialization. Or coupling that turns a local change into a cascade of modifications across the monorepo.

---

## INV-11: The kernel implements only primitives; domain tools are marketplace plugins

**Description:** A tool ships in the kernel only if it satisfies **all three** criteria:

1. **Primitive** — it cannot be built out of the other builtins.
2. **No domain choice** — no reasonable project would want a substitute.
3. **Bootstrap-necessary** — without it, `studio run` cannot work at all.

`repo_manager` (including `apply_patch`), `shell` and `studio_run` qualify. `git` fails
criterion 2 — version control is a project choice, not a law of nature, and a team on
another VCS or none at all should not inherit one. `search` fails criterion 1 (shell plus
ripgrep). `web_search` fails criterion 2 (which provider?). All of them live in the
marketplace.

The same reasoning covers *inbound* behaviour. An external system pushing to Studio is
served by a **trigger** (`.studio/triggers/*.trigger.yaml`): the kernel verifies the
signature, matches the payload and launches the run, while every product-specific
choice — which events count, which field becomes which input, what to do on failure —
is written in the trigger's YAML. Anything a trigger does *outbound* is a tool or an
MCP server, which the kernel already runs. No vendor's conventions live in kernel code.

The kernel carries a **seed cache** of the official marketplace under
`cli/templates/seed/` so a fresh install works with no network. The difference from a
builtin is authority, not packaging: a builtin is privileged and unremovable, while a
seed entry is an ordinary package that happens to be pre-downloaded — removable,
overridable, pinnable to another version. The kernel carries a blob whose contents it
does not interpret, which is why the seed is exempt from the check below.

**Enforced by:** [scripts/check-kernel-domain-free.mjs](scripts/check-kernel-domain-free.mjs),
run as `pnpm check:kernel` and blocking in CI. It fails when a package bundles a
`.trigger.yaml`, bundles a `.tool.yaml` outside the builtin allowlist, references a tool
action that left the kernel, or names a source directory after a product.

That last check reads the *path*, not the contents. Grepping source text for vendor names
was tried and abandoned: "linear" is an ordinary English adjective and a fixture name in
the MCP tests, so it fired on prose. A directory named after a product is unambiguous,
and it is the shape the violation actually took — `api/src/integrations/linear/` held one
tracker's webhook and failure handling until STU-698 deleted it.

**What breaks if violated:** the kernel accumulates opinions its users cannot override.
A bundled `prompt_snippet` dictating a branching model, or a hardcoded search provider,
can only be changed by editing the kernel — which is exactly what a plugin is for.

---

## INV-12: The API never chooses what to run

**Description:** `@studio-foundation/api` translates an HTTP request into an engine call and streams the result back. It does not decide *what* the run is. The pipeline a run executes is named by the request or by the `.trigger.yaml` the project authored — [`trigger-runtime.ts`](api/src/trigger-runtime.ts) reads `trigger.pipeline` and never supplies a fallback. The same holds for the agents, contracts and stages that pipeline references: the API hardcodes none of their names.

This is INV-04 restated one layer up, and it is a distinct invariant because the API's exception surface is different. The API is allowed things the engine is not: it is a composition root (INV-10), so it builds tool registries; it resolves the workspace, `git clone` included ([`utils/repo-resolver.ts`](api/src/utils/repo-resolver.ts)), because that is precisely the caller responsibility INV-04 keeps out of the engine. What it may not do is know a project's vocabulary.

The violation this invariant was written for is already gone: `api/src/integrations/` held a tracker webhook that defaulted an unconfigured integration to a template's pipeline name, so a project that installed Studio inherited someone else's vocabulary. STU-698 deleted that subsystem in favour of triggers, which removed the default structurally rather than by fixing it. INV-12 exists so it cannot come back — a `?? 'some-pipeline'` is a one-character-looking change that reads as a kindness.

**Enforced by:** [scripts/check-invariants.mjs](scripts/check-invariants.mjs) fails the build when any file under `api/src/` names a pipeline, contract or stage shipped in a template.

**What breaks if violated:** a webhook launches a pipeline the project never configured, and the failure surfaces as "pipeline not found" — a missing file — rather than "no pipeline configured", a missing setting. The user debugs the wrong thing. More slowly, the kernel accretes one deployment's naming until a project that names its stages differently is a second-class citizen.

---

## Quick reference

Checked mechanically in CI unless the last column says otherwise.

| ID | Invariant | Package(s) | Key file | Checked by |
|----|-----------|------------|----------|------------|
| INV-01 | `contracts` = leaf package | contracts | `contracts/package.json` | `check:invariants`, ESLint |
| INV-02 | `ralph` does not know `runner` | ralph | `ralph/src/loop.ts` | ESLint |
| INV-03 | `runner` only executes | runner | `runner/src/runner.ts` | review |
| INV-04 | `engine` is domain-agnostic | engine, contracts | `engine/src/engine.ts` | `check:invariants` |
| INV-05 | Tools in `runner` | runner, engine | `runner/src/tools/` | `check:invariants` |
| INV-06 | Prompts in `runner` | runner, engine | `runner/src/prompt-builder.ts` | `check:invariants` |
| INV-07 | Every status comes from a declared rule | engine, ralph | `engine/src/state/status-derivation.ts` | types, review |
| INV-08 | Binary validation | contracts, runner | `contracts/src/validation.ts` | types |
| INV-09 | Projects are self-contained | engine | `engine/src/pipeline/safe-path.ts` | tests |
| INV-10 | Strict dependency DAG | all | `*/package.json` | `check:invariants`, ESLint |
| INV-11 | Kernel implements only primitives | runner, cli | `runner/src/tools/plugin-loader.ts` | `check:kernel` |
| INV-12 | The API never chooses what to run | api | `api/src/trigger-runtime.ts` | `check:invariants` |

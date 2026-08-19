# Changelog

All notable changes to Studio. The root and all 7 packages share one version
([unified versioning](CLAUDE.md#versioning--releases)) — an entry here covers every package.

Pre-1.0, a breaking change earns a MINOR bump, not a MAJOR. Breaking entries are marked.

Full notes for each version live on its [GitHub release](https://github.com/studio-foundation/studio/releases).

## [0.16.0] — 2026-08-19

### Tools

- **`from_context:` on a `.tool.yaml` command parameter** — the parameter is resolved from the current stage's own resolved context (`from_context: input.book_dir`) instead of being supplied by the model. It is omitted from the tool's JSON schema entirely, so the model never sees or sets it. A "pass this value back verbatim" parameter was really only advisory: nothing stopped the model from substituting a different, plausible-looking value on retry, which let a tool call satisfy `tool_calls.minimum` while querying the wrong target. The value is threaded down through `runAgent` -> `ToolExecutor` -> the shell tool's `execute()`, each map/child pipeline run getting its own isolated context so concurrent fan-out items never share one another's values. (STU-762)

### Anonymization

- **`anonymize_fields:` in an input file** — declares which fields an anonymized run tokenizes, reaching the run-level middleware as its default scope. The field scope existed in the middleware since 0.5.2 but nothing fed it, so `--input-file` had no way to say anything and an anonymized run tokenized every field. It is a control key, stripped from the input like `repo_url`. Names stay opaque end to end — no kernel branching on what a field means. (STU-399)

## [0.15.1] — 2026-08-01

### Fixed

- `studio doctor`'s env-var check scanned `config.yaml`'s raw text for `${VAR}` refs, so a variable name only mentioned in a comment (or an invalid one like `STUDIO_SMART_*`) was reported as an unset reference. It now parses the file first and walks only its string values, which also drops the false positive on a var whose only real reference already declares a `${VAR:-default}` fallback. (STU-756)
- A failed/rejected/cancelled child of a `map`/`call` stage surfaced a bare "Child run \<id\> \<status\>", discarding the real error already recorded on the child's failed stage. `DirectEngineSpawner` now pulls that stage's agent-run error into the thrown message, so it reaches `map_item_complete`, the run JSONL, and `studio status` without a manual lookup of the child run. (STU-765)

## [0.15.0] — 2026-07-31

### Cost

- **`batch:` on a fan-out (`map`) stage** — dispatches its items' LLM calls through the provider's batch endpoint instead of one synchronous request each. Anthropic's Message Batches API bills every token (input, output, cache write, cache read) at 50% of the synchronous rate in exchange for up to 24h to finish, and a fan-out has no interactive deadline — measured on a full wiki run, the four `map` stages are 98% of its API-equivalent cost. The child runs are untouched: contracts, RALPH, hooks, post-validation and the `resume` cache all behave identically. Each item parks its call in a shared batch window whose barrier releases one batch as soon as no live item can still add to it; validation stays per item after collection, so a failed item retries into the *next* batch and rounds shrink. `concurrency` defaults to `min(items, max_size)` under `batch:` rather than 1, since items must be in flight together to share a batch. Tuning: `max_size`, `poll_interval_ms`, `max_wait_ms`, `flush_after_ms`. A provider with no batch endpoint (mock, ollama, claude-code) runs the stage exactly as before, warning once and naming the provider. See CONCEPTS.md.
- `AnthropicProvider` implements the new `BatchProvider` capability (`submitBatch`), and the runner exports `BatchWindow` / `BatchingProviderRegistry` for callers that want to coalesce calls themselves.
- `onBatchDispatch` / `onBatchComplete` engine events, rendered by the CLI's fan-out progress (`⇢ batch #1 — 40 requests submitted`) and written to the run JSONL as `batch_dispatch` / `batch_complete`.
- `SpawnConfig.overrides` — per-spawn execution overrides honoured by the in-process spawner and ignored by remote ones. Today it carries the substituted provider registry a batched map stage hands its children.
- **Prompt caching is no longer unconditional.** The Anthropic provider marked system + the last tool with `cache_control` on every call; a cache write bills above the plain input rate and only earns it back when something reads the prefix again, so a call with no successor cost *more* cached than uncached — measured on a real run as 4.5M cache-write tokens against 1.05M reads, +35% on the bill. `LLMRequest.cache_prompt` moves the decision to the caller, absent meaning no, and the runner decides it once per agent run rather than per turn. The `auto` policy caches iff the stage's contract obliges tool calls (`tool_calls.minimum` / `required_tools` / `required_tool_groups`) and the agent has tools — that contract is the one declaration in `.studio/` that predicts a second turn before the first has happened. Agents override with `prompt_cache: on | off`. TTL stays at the 5m default.

### Observability

- **Per-call token usage is recorded end to end.** One shape (`TokenUsage` in `contracts/src/usage.ts`) carries prompt / completion / total plus cached and cache-creation counts and a `by_model` split; the four counts are disjoint because each bills at its own rate. Every provider normalizes to it — claude-code now reads the CLI's `usage`/`modelUsage` block instead of discarding it (`modelUsage` preferred, so a stage that delegated is priced correctly), and OpenAI's cache counts are split back out of its input total. It accumulates upward with nothing dropped: the runner sums turns, the engine sums RALPH attempts (a stage that retried twice reports both), and a `call`/`map` stage carries the roll-up of the child runs it spawned — the fan-out is usually the most expensive stage and used to report zero. ralph never learns what a token is.
- Where it lands: `StageRun.token_usage`, the `stage_complete` / `stage_retry` / `map_item_complete` / `pipeline_complete` events, and the run JSONL under `tokens`. `studio status` aggregates it — run total with the cache split, a count per stage line, a per-model table. Runs recorded before this carry the older `{prompt, completion, total}` shape and still read. A stage whose provider reported nothing has no usage at all rather than a row of zeros: an unmeasured stage must not read as a free one.

### CLI

- `studio registry info <name>` completes the registry discovery verbs: `search` prints a match list and `browse` a popularity list, neither showing the version, license, `studio_version` range, dependencies or `provides` that decide whether an install is safe on this machine. It reads the merged index rather than adding a fetch path, resolves the way `install` does (an ambiguous unqualified name is refused with the qualified forms, never picked by registration order), and falls back to the bundled seed so a fresh install can inspect the default marketplace offline. A `name@version` that was never published is an error, not a silent fall back to the newest. Beyond the index entry it prints the versions the registry carries, whether the running CLI satisfies the declared `studio_version` (a warning — nothing is being installed), and the installed version from `.studio/registry.lock.json`, naming its marketplace when that differs.
- **A stage with no `contract:` is now visible.** It runs with nothing to validate against — no schema check, no `tool_calls` floor, no rejection detection — and said so nowhere; next to a `.studio/contracts/` directory that silence reads as "validation is on", which is how three official templates shipped contracts no stage referenced. `studio run` prints one line per contract-less stage, once at startup, on stderr so `--json` stdout stays clean; `studio doctor` gains a Contracts check reporting the same across every pipeline, naming each as `pipeline 'x', stage 'y'`. Both are warnings and stay warnings — exit codes and stage statuses are untouched. Opt out project-wide with `warnings.missing_contract: false` in `.studio/config.yaml`; doctor then still shows the count, marked suppressed. `map` and `call` entries are never reported: what validates them is the sub-pipeline they run.

### Fixed

- The kernel no longer renders one template's stage names better than everyone else's. `humanReadableStageName` mapped stage names through a lookup table whose first four entries were the `software-full` template's stages, so `brief-analysis` printed as "Analyzing brief" while any other name fell through to title-casing. The table is gone entirely. `✗ rejected by QA` becomes `✗ rejected` — `rejected` is produced by any contract's `post_validation.rejection_detection`, and naming QA sends a user looking for a stage they never wrote.

### Invariants

- INV-13: the CLI names no domain either. `check:invariants` now runs the domain-vocabulary grep over `cli/src/`, minus the two exceptions the CLI has and the API does not (it renders builtin tool names and shells out to `git diff --numstat`, both reporting what the runner did). The name patterns also match the character-class spelling a regex literal uses (`brief[-_]analysis`) — how the stage-name table went unseen while the same check ran green over `api/src/`.

### Contributing

- `.githooks/prepare-commit-msg` appends the `Signed-off-by` trailer on every commit, wired once per clone with `make hooks` — git has no `commit.signoff` config, so a hook is the mechanism. Deriving it from `user.name`/`user.email` also closes a latent trap: `check-dco.sh` compares the trailer against the commit author verbatim, name included, so an author name differing from the signed-off name failed the check on an otherwise valid commit.

## [0.14.0] — 2026-07-28

### Breaking

- `.integration.yaml` and the `studio integrations` command are gone, along with `api/src/integrations/`. Inbound events are now a `.trigger.yaml` in `.studio/triggers/`: an HMAC-verified webhook that matches the payload with stage-condition syntax over `payload.<path>`, maps it into pipeline input, and launches a run. Everything a trigger says back to the external system is an ordinary tool call, and `on_failure` is a shell command receiving its values through the environment (`STUDIO_RUN_ID`, `STUDIO_META`, …), never interpolated into the command string. The kernel names no product — which events count and which field becomes which input are the trigger file's opinions, so a new one is a marketplace package rather than a Studio release. See [ADR 0004](docs/adr/0004-triggers-over-integrations.md).
- `resolveRepoPath`, `cloneRepo` and `RepoResolveOptions` are no longer exported from `@studio-foundation/engine`. Repo resolution shells out to `git clone`, which INV-04 does not allow in the engine; it moved to `api/src/utils/`, reachable as `@studio-foundation/api/repo-resolver`.

### API

- `POST /api/triggers/<name>/webhook`, served by `studio api start`. The seeded `linear` plugin ships a `.trigger.yaml` in place of its integration; the `slack` and `webhook` integration packages are dropped — a generic webhook trigger covers them.

### Invariants

- INV-04/05/06/10/12 are enforced by `scripts/check-invariants.mjs` (`pnpm check:invariants`, blocking in CI). It greps the engine for domain vocabulary, asserts where the tool runtime and prompt builder live, and validates every `package.json` against the dependency DAG — the half ESLint cannot see, since it reads source and not manifests.
- INV-06 is real again: the engine still loads skills and invariants, but hands them to `runAgent` as `pluginSkills`, `skills` and `projectInvariants` instead of concatenating them into `system_prompt`. `buildPrompt` assembles the identity block, preserving the previous ordering.
- INV-07 is rewritten around the three points that decide a status — `deriveStageStatus`, post-validation, `on_stage_complete` hooks. INV-12 is new: the API never chooses what to run.

### Docs

- TEMPLATES.md describes the real registry: templates are packages, not directories in this repo.
- CLAUDE.md and GOVERNANCE.md claimed the engine depends on anonymizer. It does not; runner does.

## [0.13.0] — 2026-07-28

### Breaking

- Paths a config supplies must stay inside the directory they are resolved against — `..`, absolute paths and `~` are refused (INV-09). Applies to skill names, context pack names, and a context pack's `files[].path` entries. A config reaching outside its project this way now fails with an error naming the offending value instead of silently reading the file. The workspace is unaffected: `--repo-path` is chosen by whoever launches the run, not by an installed config.

### Docs

- CONTRIBUTING.md, DCO sign-off on every commit, and ADR 0003 on contribution rights.
- CHANGELOG.md, backfilled to 0.5.0.

## [0.12.0] — 2026-07-28

### Breaking

- `git`, `search`, `web-search` and the integrations are no longer kernel builtins. They moved to the marketplace as ordinary plugins, leaving `repo_manager-*`, `shell-run_command`, `repo_manager-apply_patch` and `studio_run-run_pipeline` as the whole builtin list (INV-11). A config naming `git-commit` or `search-search_codebase` needs the plugin installed — `studio init` and `studio registry install` pull it from the bundled seed cache, so this works with no network.

### Registry

- `studio marketplace add <url>` registers a marketplace in `~/.studio/marketplaces.json` — per machine, never per project, so a checkout cannot redirect its own installs. GitHub marketplaces are read over raw HTTP, anything else is shallow-cloned.
- `git` sources: an index entry can point at another repo. The fetch verifies the pinned `sha` against its `ref`, asserts a LICENSE matching `license`, and asserts `provides` against the payload in both directions.
- A package name is unique per marketplace, not globally. An unqualified name found in several is refused with the qualified forms.
- Range-aware updates: `registry update` targets the highest version the recorded ranges accept (`--latest` overrides), `registry outdated` reports `wanted` and `latest` separately, `registry audit` flags an installed version no recorded range still accepts — offline.
- Installed-graph conflict detection reports both constraints when two dependents disagree.

### CLI

- `studio init` is a dependency resolver. A package declares `dependencies.plugins.{required,recommended}` in `metadata.json`; required entries install transitively and abort init when unresolvable, recommended ones are prompted individually.
- `studio upgrade` self-updates the standalone binary, refusing on an npm-owned install.
- `install.ps1` for Windows (`irm | iex`).
- Map fan-out shows what each item produced on its live line.

### Fixed

- Plugins install by content kind, dispatching each file to its `.studio/` subdirectory by filename suffix; the lockfile records the paths written, so `remove` and `audit` act on what was installed.
- Package payloads resolve through the index `source` field.
- musl is detected positively instead of assumed from the absence of glibc.
- Compiled binaries are smoke-tested before they leave the build.

### Docs

- ADRs for the distribution and packaging models; GOVERNANCE.md refreshed against the current kernel.

## [0.11.1] — 2026-07-27

Re-release of 0.11.0. Releases are immutable here, so `v0.11.0` was published before its
standalone binaries could be attached and carries none — 0.11.1 is the first release cut
with the draft-first procedure, and the first with working `install.sh` assets. The npm
packages are unchanged apart from the version.

### Fixed

- Release binaries are attached to a draft release, so immutability can no longer publish a release without them.

## [0.11.0] — 2026-07-27

### Distribution

- Studio ships as a standalone binary alongside the npm packages. `install.sh` and per-platform npm packages (`@studio-foundation/cli-{linux,darwin,win}-*`) cover linux x64/arm64 (glibc + musl), macOS arm64/x64, and Windows x64 — no Node.js required to run the CLI.

### Preflight

Four startup checks, each opt-in by the presence of the config it reads:

- `studio doctor` — aggregates every check `studio run` performs, plus an env-var check `run` doesn't have: a `${VAR}` with nothing behind it resolves to an empty string, so the key passes the contract while carrying no value.
- Config contract — `.studio/config.example.yaml`, the committed twin of the gitignored `config.yaml`. Every key left uncommented is required.
- `studio_version` — a semver range in `.studio/config.yaml`, checked before any stage and on `studio registry install`.
- `requires_binaries` — declared project-wide and per plugin in `constraints.requires_binaries`; entries may carry a semver range (`"node >=18 <=22"`), probed via `<binary> --version`.

### CLI

- `studio cache clean` clears the map-stage resume cache.
- `studio status` shows per-stage duration and nests child pipelines under their parent stage.
- `studio init` generates an `ONBOARDING.md` for the new project.

### Fixed

- One JSONL log per top-level run, so `studio status` can reconstruct nested runs instead of losing child stages across files.
- `better-sqlite3` replaced with the built-in `node:sqlite` — one less native module to compile at install time.
- Providers are constructed lazily, so an unused provider block with an empty key no longer breaks startup.
- The onboarding template is read from the bundled assets, so it resolves inside the standalone binary.

### Repo

- ESLint across the monorepo, blocking in CI. The import-boundary rule mirrors the dependency DAG, so an upward `@studio-foundation/*` import can no longer land silently.
- Runtime and shared-type invariants of `@studio-foundation/contracts` covered by tests.

## [0.10.0] — 2026-07-26

### Engine

- Env var interpolation in agent YAML (#209). `config.yaml` already interpolated `${VAR}`; `agent.yaml` did not, so retargeting a tier of agents meant editing committed YAML. Both now go through the same interpolation.
- `${VAR:-default}` syntax — an unset *or empty* var falls back to the default. `${VAR}` without a default keeps its prior empty-string behavior.
- `resolveEnvVars` moved to `engine/src/pipeline/env-vars.ts`, re-exported from `cli/config.ts`.

Backward compatible: agent YAML with no `${...}` is byte-identical after interpolation.

## [0.9.0] — 2026-07-22

### Engine

- Map-item completion events carry the child run's `output` (fresh spawn and cache-served alike), so a fan-out's discoveries can be rendered live instead of only signalling which items settled (STU-626).

### CLI

- `--stream-items` emits one tagged NDJSON line per map item to stderr as it lands (`{map,index,total,label,status,cached,output}`), while stdout stays reserved for the `--json` aggregate (STU-626).

### Docs

- README gains npm version, downloads, and license badges.

## [0.8.5] — 2026-07-22

### Fixed

- Ctrl-C cancels a run while a spinner is on screen (#204). ora put stdin in raw mode, which disabled the terminal's Ctrl-C→SIGINT translation. Every run-progress spinner now keeps stdin cooked (`discardStdin: false`).

## [0.8.4] — 2026-07-22

### Fixed

- `replay` and `restart` match the full run id (STU-619).

## [0.8.3] — 2026-07-21

### Fixed

- Killed runs no longer stay `running` forever (STU-625). A run whose process died without writing a terminal status stayed at `status: running` in `runs.db` permanently. The store stamps the owning pid + hostname at creation and, on read, reconciles an orphaned `running` row (same host, dead process) to the new terminal status `interrupted`.

### Engine

- Runs carry owner identity (`pid`, `hostname`) and reconcile orphaned `running` rows across all three stores (SQLite, Postgres, in-memory).

### Contracts

- New `interrupted` run status; optional `pid` / `hostname` fields on `PipelineRun`.

### CLI

- `studio status` renders `cancelled`, `interrupted` and `running` distinctly instead of lumping them into "✗ failed".

### Docs

- 0.x version bumps are classified by reachable surface, not by lines added.

## [0.8.2] — 2026-07-21

### Fixed

- A nested spinner no longer swallows Ctrl-C (STU-620).

## [0.8.1] — 2026-07-21

### Fixed

- A live thinking spinner stays on the innermost child stage (STU-620).

## [0.8.0] — 2026-07-21

### CLI

- Nested `call`/child stage progress rendered under `--live` (STU-620).

### Fixed

- The spawner is handed down to spawned child engines (STU-615).
- `condition`-skipped call stages render as skipped, not failed (STU-608).

## [0.7.0] — 2026-07-21

### Engine

- Call stage failure tolerance — `on_failure: 'fail' | 'continue'` on `call` stages (STU-606). Default `'fail'` keeps prior behavior. Under `'continue'` a failed child records its stage as failed but the parent proceeds, propagating no output. A cancelled child still cancels the parent, and a `condition`-skipped call stays `skipped`. The loader rejects unknown `on_failure` values.

## [0.6.0] — 2026-07-20

### Engine

- Per-item resume for fan-out (`map`) stages — a `resume` key (default `false`). On re-run it skips items that already completed, keyed on the item **input** rather than its index, so a reordered or extended list still reuses prior work. Failures are never cached; the cache lives at `.studio/runs/map-cache/`. The stage output gains a `resumed` count.

### Tooling & Docs

- `bump-version` skill — classifies the next semver level from the commits since the last published npm version, then drives the bump PR, the dispatched publish, and the release.
- npm publish runs on `workflow_dispatch` only, not on `release: created` — a failed publish no longer burns a version number under this repo's immutable releases.
- Release procedure and the 1.0 criteria documented in `CLAUDE.md`.

## [0.5.2] — 2026-07-20

First stable line since `0.4.0-beta`. Unified version across the root and all 7 packages.

### Engine

- Fan-out (`map`) stages — run a sub-pipeline once per item of a list and collect the structured outputs, with `concurrency` and `on_item_failure` (`fail-fast` / `collect-all`) (STU-454).
- `call` stage — invoke a named pipeline once and use its last-stage output inline (STU-599).
- `expected_outputs.files` — a stage declares the artifacts it must leave on disk; a miss enriches the RALPH retry feedback instead of passing silently (STU-456).
- External validator hook — validate a stage's real output via a shell command.
- Fail loud at load time: unknown config fields and unknown `context.include` directives are rejected instead of silently dropped (STU-408, STU-593).
- Fail loud at runtime: no more silent tool or dependency drops (STU-409).

### Contracts

- Declarative field-level validation — `schema.fields` checks types, `enum` values, and nested object/array shape natively in the RALPH loop (STU-432).

### Anonymizer

- Field-scoped anonymization — an app declares an opaque scope and only those fields are anonymized before prompt assembly (STU-398, STU-399).
- `DetectionProvider` interface + `RegexDetector` (STU-397).
- NER recall bake-off harness for evaluating detectors (STU-401).

### Providers

- `claude-code` provider — run Studio pipelines on a Claude Code subscription (STU-429, STU-561).

### CLI

- Fan-out (`map`) stage progress rendered under `--live` (STU-598).
- `--json` output survives a stalled pipe reader — stdout is drained before exit (STU-594).

### Fixed

- Per-agent tool whitelist from YAML is enforced.
- A dead script stage surfaces its stderr instead of crashing on `EPIPE` (STU-568).
- Anonymizer salutation/name matching no longer captures lowercase person spans (STU-400).

### Docs

- `GOVERNANCE.md` charter, unified versioning & release policy, repositioned README, template authoring spec.

`0.5.0` and `0.5.1` were tagged but never published — the version ships as `0.5.2`.

## 0.4.1

Never published. The version was bumped in the repo but no release was cut; the work it
carried shipped in `0.5.2`.

## 0.4.0-beta and earlier

`0.4.0-beta` (2026-05-10) and the `0.3.0-beta.x` line (2026-04-14) predate the release
procedure and were published by hand. No notes were recorded; see the git history and the
[tags](https://github.com/studio-foundation/studio/tags) for what landed.

[0.12.0]: https://github.com/studio-foundation/studio/releases/tag/v0.12.0
[0.11.1]: https://github.com/studio-foundation/studio/releases/tag/v0.11.1
[0.11.0]: https://github.com/studio-foundation/studio/releases/tag/v0.11.0
[0.10.0]: https://github.com/studio-foundation/studio/releases/tag/v0.10.0
[0.9.0]: https://github.com/studio-foundation/studio/releases/tag/v0.9.0
[0.8.5]: https://github.com/studio-foundation/studio/releases/tag/v0.8.5
[0.8.4]: https://github.com/studio-foundation/studio/compare/v0.8.3...v0.8.5
[0.8.3]: https://github.com/studio-foundation/studio/releases/tag/v0.8.3
[0.8.2]: https://github.com/studio-foundation/studio/compare/v0.7.0...v0.8.3
[0.8.1]: https://github.com/studio-foundation/studio/compare/v0.7.0...v0.8.3
[0.8.0]: https://github.com/studio-foundation/studio/compare/v0.7.0...v0.8.3
[0.7.0]: https://github.com/studio-foundation/studio/releases/tag/v0.7.0
[0.6.0]: https://github.com/studio-foundation/studio/releases/tag/v0.6.0
[0.5.2]: https://github.com/studio-foundation/studio/releases/tag/v0.5.2

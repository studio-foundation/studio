# Concepts

How Studio works, from the inside out.

---

## RALPH loop

**Recursive Automated Loop for Persistent Handling.**

The core execution primitive. Every stage in a pipeline runs through RALPH:

1. **Execute**: the agent produces output
2. **Validate**: the output is checked against the stage's contract
3. **Pass?**: if yes, advance to the next stage
4. **Retry**: if no, feed the validation errors back to the agent and re-execute with escalated feedback
5. **Repeat** until success or max attempts exhausted

```
execute → validate → pass? → next stage
                   → fail? → enrich feedback → execute again
                   → exhausted? → stage failed
```

RALPH is a standalone package (`@studio-foundation/ralph`). It takes a generic `executor: () => Promise<T>` and a `validator: (result: T) => ValidationResult`. It does not know that an LLM is behind the executor. It does not know what domain the validation covers. It loops until the contract is satisfied or the budget runs out.

**ralph does not know runner.** This is a hard boundary. ralph receives an executor function, it never imports runner, never constructs LLM calls, never touches tool logic.

---

## Output contracts

A contract defines what a stage must produce. It is a YAML file containing a JSON schema plus optional constraints.

```yaml
name: code-generation
version: 1
schema:
  required_fields:
    - summary
    - files_changed
tool_calls:
  minimum: 1
  maximum: 15
  required_tools:
    - repo_manager.write_file
```

Validation is binary. The output either satisfies every constraint or it doesn't. There is no partial credit.

**`tool_calls.minimum`** catches agents that claim to have done work without actually doing it. If the contract requires at least 1 tool call and the agent made 0, the stage fails, regardless of what the agent wrote in its output.

**`tool_calls.maximum`** catches infinite loops and bounds runaway costs. If an agent makes more tool calls than the cap, the stage fails — the cap is also a hard ceiling on per-stage spend, useful when running an orchestrator you don't fully trust yet.

**`required_tools`** enforces that specific tools were actually called. A code generation stage that never called `write_file` didn't generate code.

### Field-level validation (`schema.fields`)

`required_fields` only checks that a top-level key is present. `schema.fields` goes further, declaratively: the type a field must hold, the set of values it may take, and — for objects and arrays — the shape of what's nested inside. It fires only for fields that are present, so it composes cleanly with `required_fields` (presence) rather than duplicating it.

```yaml
name: wiki-page
version: 1
schema:
  required_fields:
    - pages
  fields:
    pages:
      type: array
      items:
        type: object
        required_fields: [title, importance, entity_type]
        fields:
          importance:
            type: string
            enum: [principal, secondary, figurant]
          entity_type:
            type: string
            enum: [person, place, organization, event, concept]
```

Supported per-field keys:

- **`type`** — `string`, `number`, `integer`, `boolean`, `object`, or `array`. A mismatch fails the field (and skips its nested checks, which assume the type held).
- **`enum`** — the allowed values, compared with strict equality.
- **`required_fields`** / **`fields`** — for `object` fields, the nested keys that must be present and the specs applied to nested keys that are. Recurses to any depth.
- **`items`** — for `array` fields, the spec every element must satisfy (e.g. each `pages[]` entry).

Failures name the exact path — `Field 'pages[2].importance' must be one of [principal, secondary, figurant], got "lead"` — so the retry feedback points the agent at the offending value. This is the mechanism that lets invariants like "`importance ∈ {principal, secondary, figurant}`" be enforced by the contract itself instead of by an ad-hoc gate in a downstream script.

### A stage with no contract

`contract:` is optional. A stage that omits it still runs, still retries on a terminal executor error — and validates nothing else: no schema check, no `tool_calls` floor, no rejection detection. Whatever the agent returns is accepted.

That's legitimate (a scratch pipeline, a stage nothing downstream reads), but it used to be indistinguishable from validation being in force, which is how templates shipped contracts no stage referenced. So Studio says it out loud, once at startup:

```
⚠ stage 'code-generation' has no contract — output is not validated
  Add a `contract:` to each, or set `warnings.missing_contract: false` in .studio/config.yaml to silence this.
```

It is a **warning and stays one**: the exit code and every stage status are exactly what they'd be without it. `studio doctor` reports the same thing across every pipeline in `.studio/pipelines/`, so it's catchable before a run, and a project that means it opts out:

```yaml
# .studio/config.yaml
warnings:
  missing_contract: false
```

`map` and `call` entries are never reported — they carry no `contract:` of their own, since what validates them is the sub-pipeline they run.

---

## Anti-theatre

The term for validation that catches agents faking work.

Agents are optimized to produce plausible output. An agent asked to write code can produce a convincing summary of what it "did" without ever calling a write tool. Anti-theatre validation checks what actually happened: tool calls made, files written, commands executed, against what the contract requires.

This is not a heuristic. It is structural. The runner tracks every tool call. The contract specifies what must have occurred. The engine compares the two. Theatre is caught mechanically.

Anti-theatre applies to configs too. A contract or pipeline field the kernel does not implement is **rejected at load time with a hard error** — never silently ignored. A silently ignored field is config-theatre: you believe a guarantee is in place that is never enforced. The error names the unknown field, the file, and suggests the closest valid field.

This is why `field_constraints` and `post_validation.constraints` are rejected rather than implemented: they are not names the kernel implements, and a field the kernel does not implement is theatre. Field-level shape has a real home — declarative **`schema.fields`** (types, enums, nested required fields, array item specs) — and constraints that genuinely need code, span multiple fields, or are written in another language have another — **external validators** (`validators:`), which run against the real output inside the RALPH loop. Each mechanism owns a distinct job; neither is a synonym for an unimplemented field name.

---

## Post-validation rejection

A stage can produce structurally valid output that is semantically negative. A QA stage that returns `{ status: "rejected", issues: [...] }` passed its contract (the schema is satisfied) but the verdict is negative.

Post-validation rejection handles this. Configured in the contract:

```yaml
post_validation:
  rejection_detection:
    field: status
    approved_values: [approved, approved_with_notes]
    rejected_values: [rejected, failed, implementation_incomplete]
    details_field: issues
    summary_field: summary
```

When rejection is detected, the stage status becomes `rejected` (not `failed`). This distinction matters for groups.

---

## Groups

A group is a feedback loop containing multiple stages that execute in iterations.

```yaml
- group: implementation-review
  max_iterations: 3
  stages:
    - name: code-generation
      agent: coder
      contract: code-generation
    - name: qa-review
      agent: analyst
      contract: qa-review
```

If the last stage in the group rejects (via `rejection_detection`), the group restarts from the first stage with accumulated feedback. The `group_feedback` context carries rejection reasons from previous iterations, so each retry is informed by what went wrong before.

Groups enable creation-critique-revision workflows without manual intervention. The code generation stage writes code, the QA stage reviews it, and if QA rejects, code generation runs again with QA's feedback. Up to `max_iterations` times.

---

## Fan-out (map) stages

A **fan-out** (or **map**) stage runs a sub-pipeline once per item of a list, then collects the structured outputs. It exists to replace the "shell `studio run <pipeline>` per item, parse stdout, scrape the run log" glue that scripts otherwise reinvent — the child runs are spawned **in-process** through the engine's run spawner, and each returns its last stage's output **directly**. No subprocess, no tempfiles, no log scraping.

```yaml
- name: plan            # a normal stage produces the list…
  agent: planner
  contract: entity-list

- map: generate-pages   # …and the fan-out runs a sub-pipeline per item
  over: stages.plan.output.entities   # context path to the array
  pipeline: wiki-page-item            # sub-pipeline run once per item
  input:                              # per-item input template
    entity: "{{item}}"
    book_context: "{{input.book_context}}"
  concurrency: 4                      # max items in flight (default 1)
  on_item_failure: collect-all        # fail-fast (default) | collect-all
  resume: true                        # skip items already done in a prior run (default false)
  batch: true                         # dispatch the items' LLM calls as one batch (default false)
```

- **`over`** resolves to a list via the same reference syntax as `condition`: `input.<path>` or `stages.<name>.output(.<path>)`. If it doesn't resolve to an array, the stage fails.
- **Per-item input** comes from `input:` (a template where `{{item}}`, `{{item.<path>}}`, `{{index}}`, `{{input}}`, `{{input.<path>}}` are substituted — a value that is exactly one `{{ref}}` keeps its native type), or from `as: <key>` shorthand (`{ <key>: item }`), or the item object itself when neither is given.
- **`concurrency`** bounds how many item runs are in flight at once (default 1 = sequential).
- **`on_item_failure`** is the per-item failure policy:
  - `fail-fast` (default): stop launching new items on the first failure; the stage fails. In-flight items still finish.
  - `collect-all`: run every item regardless; the stage succeeds as long as at least one item succeeded, and the pipeline keeps going. Per-item failures are surfaced in the output, never fatal (a batch where *every* item fails is still a failure).
- **`resume`** (default `false`) turns on **per-item resume** — see below.
- **`batch`** (default `false`) turns on **batched dispatch** — see below.

The stage output is structured for the next stage to consume — no scraping:

```jsonc
{
  "total": 3, "succeeded": 3, "failed": 0,
  "resumed": 0,   // of the successes, how many were served from the resume cache
  "outputs": [ /* successful item outputs, in order */ ],
  "results": [ { "index": 0, "status": "success", "output": {…}, "run_id": "…", "cached": false }, … ]
}
```

Each entry in `results` also carries `token_usage` (what the item's child run
spent) and `stages` — that child's per-stage breakdown, one entry per stage with
its `status`, RALPH `attempts` and own `token_usage`. Both are present on a
**failed** item too: its calls were billed, and a caller pricing the fan-out from
the flat number alone counts every failure as a single call. A cache-served item
has neither — a resumed item costs nothing this run.

A downstream stage reads it like any other stage output, e.g. `over: stages.generate-pages.output.outputs` or `context.include: [previous_stage_output]`. Child runs count against `maxDepth`, exactly like `studio_run`.

### Per-item resume (`resume: true`)

A fan-out over hundreds of network-bound items is a run measured in hours. Without resume, one timeout near the end re-costs the **whole** stage on the next invocation — the all-or-nothing regression that blocks migrating hand-written per-unit loops (`discover_relationships.py`'s per-chunk votes cache, `generate_wiki_pages.py`'s per-page commit) to `map`. `resume: true` lifts that per-unit persistence into the engine:

- **Skips items already completed** in an earlier run of the same stage, and re-spawns only the incomplete ones.
- **The resume key is the item _input_** (the sub-pipeline input built for the item), never its index or list position. So reordering or filtering the `over:` list still hits the cache — a verdict computed for item X is never replayed for a different item Y (the identity-vs-inputs trap recorded in wiki-creator's alias/page caches) — while changing an item's content (or its `input:`/`as:` mapping, or the target `pipeline:`) misses and recomputes.
- **Failures are never cached.** A failed item retries on the next run; completed items stay done.
- **Orthogonal to `on_item_failure`.** The cache is consulted and written under both `fail-fast` and `collect-all`, and a cache-served item counts as a success — it never trips `fail-fast`. On a `fail-fast` re-run, the previously-completed prefix is served from cache and the stage picks up at the first item that had not finished.

The cache is a JSON file per completed item under `.studio/runs/map-cache/<pipeline>/<stage>/<sub-pipeline>/<item-input-hash>.json`, so it survives a process restart between runs. It is best-effort: a read error is a miss and a write error is swallowed (the item simply re-runs) — resume never fails the stage. Cache-served items are flagged `cached: true` in the `map_item_complete` event and counted in the output's `resumed`.

The key covers the item input and the target pipeline, **not the provider or the model** — so a warm re-run under a different provider replays the first provider's outputs. Clear the cache first when comparing providers: `studio cache clean` (whole cache) or `studio cache clean --pipeline <name>` (one parent pipeline). See [CLI.md](CLI.md).

### Batched dispatch (`batch: true`)

The items of a fan-out are independent and nothing interactive is waiting on any single one of them. That is exactly what a vendor batch endpoint is priced for: Anthropic's Message Batches API bills **every** token — input, output, cache write, cache read — at **50%** of the synchronous rate, in exchange for up to 24h to finish. On a bulk stage that is the largest cost lever available, and `batch: true` is how a map stage takes it.

```yaml
- map: generate-pages
  over: stages.plan.output.entities
  pipeline: wiki-page-item
  as: entity
  resume: true
  batch: true          # or the object form, for tuning:
  # batch:
  #   max_size: 500          # requests per batch (default 500)
  #   poll_interval_ms: 15000 # how often to ask whether the batch ended (default 15000)
  #   max_wait_ms: 86400000   # whole-batch budget (default 24h — the API's own expiry)
  #   flush_after_ms: 30000   # send what is queued after this quiet (default 30000, 0 disables)
```

**What it does.** Items still run as ordinary child runs — same contracts, same RALPH loop, same hooks, same post-validation, same `resume` cache. What changes is only how their LLM calls leave the process: instead of N synchronous requests, each item parks its call in a shared **batch window**, and the window submits them together as one job.

The window sends a batch when nothing live can still add to it — every in-flight item is either parked or already inside a dispatch — or when the batch hits `max_size`. Items that finish (or are served from the resume cache) simply lower that bar rather than holding it up.

**What it does not change:**

- **Validation stays per item, after the batch returns.** An item whose output fails its contract retries by calling again, and lands in the *next* batch alongside whichever other items are also retrying. Rounds shrink — the retry loop never has to know batching exists.
- **A per-request failure is that item's failure**, not the stage's. It reaches the child run as an ordinary executor error, so `on_item_failure` and RALPH treat it exactly as they treat any other.
- **`resume` composes.** A cached item is never dispatched, so a warm re-run batches only what is actually left.

**What it does change, and you should expect:**

- **`concurrency` defaults to `min(items, max_size)`** here instead of `1` — items have to be in flight together to share a batch. An explicit `concurrency` is still honoured and caps the batch at that size; it is also how you bound how many child runs exist at once over a very long list.
- **Nothing streams.** A batched response arrives whole, so `--live` shows no tokens for these items. It does show each batch leaving and returning (`⇢ batch #1 — 40 requests submitted`), because a batch can take an hour and "queued at half price" and "hung" look identical otherwise. The `batch_dispatch` / `batch_complete` events are in the run JSONL.
- **Latency is the trade.** There is no per-call timeout to set; `max_wait_ms` is the whole-stage budget that replaces one.
- **A provider with no batch endpoint runs the stage unchanged** — correct, just not cheaper. Today only `anthropic` batches; `mock`, `ollama` and `claude-code` fall back with a warning naming the provider. Batching also does not apply to a provider that owns its own agent loop, where there is no single call to intercept.
- **Remote spawners do not batch.** The window is an object in this process, so a fan-out running through the HTTP spawner dispatches normally.

### Live progress

Under `--live` (and in the default spinner mode) a fan-out stage renders its own progress instead of a single hanging spinner — essential for real workloads of hundreds of items over runs measured in hours. The CLI surfaces:

- a header naming the fan-out with its item count and concurrency,
- a live status line with advancing `done`/`failed` counts and the **identities of the items currently in flight** (derived from each item, e.g. its `title`/`name`/`id`, not just an index) — it tracks multiple items at once under `concurrency > 1`,
- a per-item **failure line the moment it happens**, naming the item and its child run ID (so you can `studio status <run-id>` to drill in), not just an aggregate at the end,
- a final `succeeded/failed` summary.

**Nesting decision (explicit):** child sub-pipeline stages are **collapsed**, not rendered — each item is a single progress line. A fan-out over hundreds of multi-stage sub-pipelines would otherwise drown the terminal, and child runs are spawned through a fresh engine that carries no event sink, so their stage events never reach the parent display anyway. Drill into any one child via its run ID. The full map lifecycle (`map_start`, `map_item_start`, `map_item_complete`, `map_complete`) is also written to the run JSONL.

---

## Call (sub-pipeline) stages

A **call** stage runs a named pipeline **once** and exposes its output to later stages under the stage name. It is a fan-out with the iteration removed — the same in-process run spawner, structured output, no log scraping — for when the shape is a **sequence**, not a fan-out. It exists so a pipeline can chain other top-level pipelines in one YAML instead of an external orchestrator sequencing them:

```yaml
name: wiki
description: Full wiki build — the four pipelines run_wiki.py used to sequence
version: 1
stages:
  - call: wiki-extraction     # stage name; pipeline defaults to the same name
  - call: wiki-resolution
  - call: wiki-preparation
  - call: pages-export
```

- **`call`** is the stage name (the discriminant). Restart targets it by name: `studio replay <run> --restart --stage wiki-resolution`.
- **`pipeline`** is the sub-pipeline to run; it **defaults to the `call` value**, so calling a pipeline under its own name needs one line. Set it when the stage name and pipeline name differ (e.g. calling the same pipeline twice).
- **`input`** maps the child's input from the parent context: a template where `{{input}}`, `{{input.<path>}}` and `{{stages.<name>.output.<path>}}` are substituted (a value that is exactly one `{{ref}}` keeps its native type). **Omitted → the parent input is forwarded to the child unchanged**, which is what the sequence above relies on. A non-object parent input with no template fails the stage.
- **`condition`** skips the call when false, like any other stage.
- The child's output is propagated **directly** (not wrapped) under the stage name — `stages.<call>.output.<path>` — and a child failure fails the call stage and stops the parent. Child runs count against `maxDepth`, exactly like `map` and `studio_run`.

`studio status <run-id>` surfaces each stage's **wall-clock** next to its status marker, and for a call-chained run it nests every child pipeline's own stages beneath the call — so which child dominates the run is read off the line, not reconstructed from the JSONL:

```
Stages:
  [1/2] wiki-extraction ............... ✓  1.3s
    └─ wiki-extraction
       [1/2] extract-entities .......... ✓  0.9s
       [2/2] emit-pages ................ ✓  0.4s
  [2/2] pages-export .................. ✓  16.3s
    └─ pages-export
       [1/1] write-files ............... ✓  16.2s
```

---

## Script stages

A stage with `executor: script` runs a deterministic script instead of an LLM — `script` is the path, `runtime` is `python`, `node` or `shell`. It receives the stage context as JSON on stdin, returns its output as JSON on stdout, and is validated and retried by RALPH like any other stage.

**What it reads on stdin.** The whole `AgentContext`, JSON-encoded: `previous_outputs`, `previous_tool_results`, `startup_context` and the rest arrive as the structures they already were. So does the pipeline input — `context.include: [input]` sets both `input`, the unserialized value, and `additional_context`, its YAML rendering for an LLM prompt. A script reads `input`; nothing has to parse YAML back out of a string. This is what makes a script sub-pipeline a workable body for a `map` stage, whose per-item input is assembled structurally.

```python
import json, sys
ctx = json.load(sys.stdin)
url = ctx["input"]["url"]        # not a YAML dump
```

**Which interpreter it runs.** The script is spawned directly, not through a shell, so the repo needs a way to say which interpreter it means. Resolution order, first match wins:

1. **`STUDIO_<RUNTIME>_BIN`** — `STUDIO_PYTHON_BIN`, `STUDIO_NODE_BIN`, `STUDIO_SHELL_BIN`. An absolute path, taken verbatim. The studio process inherits its environment, so a consumer repo's Makefile hands the interpreter over with no config round-trip.
2. **`VIRTUAL_ENV`** (python) — an activated virtualenv wins over one sitting at `cwd`: the operator chose it, whereas a `.venv/` on disk may be a stale sibling of the one they meant. This is what makes `source .venv-3.12/bin/activate && studio run …` work.
3. **`venv/` then `.venv/` at the stage's `cwd`** (python) — sniffed, activated by prepending its `bin` to `PATH`.
4. **The runtime default** — `python3`, `node`, `sh`, resolved through `PATH`.

Steps 2 and 3 also set `VIRTUAL_ENV` and prepend `bin` to `PATH` for the child, so a script that shells out further stays inside the same environment. A stage that fails to spawn names the interpreter path it tried and the override variable that would change it — a missing interpreter reads as a missing interpreter, not as a dead stage.

---

## Context propagation

Each stage declares exactly what context it receives:

```yaml
context:
  include:
    - input                    # Original pipeline input
    - previous_stage_output    # Output from the preceding stage
    - all_stage_outputs        # Outputs from all preceding stages
    - group_feedback           # Accumulated rejection feedback
    - repo_files               # Files from the workspace
```

If `context` is not specified, the stage receives nothing. This is explicit by design, no implicit state leakage between stages.

---

## on_pipeline_start

Shell commands that run before any stage and inject dynamic context:

```yaml
on_pipeline_start:
  - command: "git status --short"
    inject_as: git_status
  - command: "git log --oneline -5"
    inject_as: recent_commits
```

The stdout of each command becomes available in every stage's context under the `inject_as` key. This is how pipelines get fresh state (git status, environment info, recent changes) without hardcoding it.

---

## Lifecycle hooks

Shell commands that run at deterministic points in the pipeline lifecycle:

| Hook | When | Available data |
|------|------|----------------|
| `on_stage_start` | Before stage executes | — |
| `on_stage_complete` | After stage succeeds | `{{output.field}}` |
| `pre_tool_use` | Before a specific tool call | `{{tool.argName}}` |
| `post_tool_use` | After a specific tool call | `{{tool.argName}}` |

Each hook has an `on_failure` behavior:
- **`warn`** (default): log and continue
- **`reject`**: stage becomes `rejected`, can trigger group retry
- **`fail`**: stage becomes `failed`, pipeline stops

```yaml
hooks:
  on_stage_complete:
    - command: "npx tsc --noEmit 2>&1 | head -20"
      on_failure: reject
  pre_tool_use:
    - matcher: repo_manager-write_file
      command: "echo 'Writing: {{tool.path}}'"
      on_failure: warn
```

Hooks are how you add static analysis, linting, or custom validation without writing TypeScript. The YAML is the configuration surface. The shell is the execution surface.

---

## Skills

Markdown files (`.skill.md`) in `.studio/skills/` that describe procedural context: conventions, architectural patterns, step-by-step guides.

```markdown
# commit-conventions.skill.md
Commit messages follow conventional commits format:
- feat: new feature
- fix: bug fix
- refactor: code refactoring
Always include the package scope: feat(engine): ...
```

Agents declare which skills they use:

```yaml
name: coder
skills:
  - commit-conventions
  - react-patterns
```

The skill content is auto-injected into the agent's system prompt. No code involved, just markdown that becomes context.

A file may open with YAML frontmatter. It is metadata, not prompt text — the body alone
reaches the model:

```markdown
---
name: commit-conventions
description: How this repo words a commit message.
---
Commit messages follow conventional commits format:
```

Skills resolve by **filename**, so a frontmatter `name` that disagrees with the file it sits
in is a load error rather than a silent preference for one of the two. A file with no
frontmatter is all body, unchanged.

**A declared skill that cannot be read fails the run.** A missing file, a typo, a plugin
that did not install — each aborts the load naming the skill and the path tried, the same
way a missing agent or contract does. Skills carry grounding, so an agent that answered
without one would produce a well-formed, confidently invented answer that validates against
its contract and reports success. Silence is the one outcome that cannot be allowed here.

---

## Tool plugins

A `.tool.yaml` file that defines commands available to agents:

```yaml
name: nutrition
description: Nutritional analysis tools
version: 1

commands:
  - name: nutrition-analyze
    description: Analyze nutritional content of a recipe
    parameters:
      ingredients:
        type: array
        items: string
        required: true
    execute:
      type: shell
      command: |
        echo '{{ingredients | json}}' | nutrition-api --servings={{servings}}
      parse_output: json

prompt_snippet: |
  You have access to nutrition tools. Always verify nutritional content before finalizing.

constraints:
  requires_binaries: [nutrition-api]
```

**Self-documenting:** The `prompt_snippet` is auto-injected into the agent's system prompt. The tool explains itself to the agent.

**Double-gated:** The project authorizes which tool groups are available. The agent YAML authorizes which specific tools it can call. Two layers of access control.

Tools live in runner, not engine. The engine passes configs to the runner. The runner executes the tools. The engine never touches tool logic directly.

---

## Triggers

A `.trigger.yaml` in `.studio/triggers/` is an **inbound** webhook: an external system POSTs to Studio and a run starts. It is the one direction tools and MCP servers do not cover — those are outbound, Studio calling out. Anything a trigger needs to *say back* to that system is a tool call, not part of the trigger.

Serving one is `studio api start`; each trigger gets `POST /api/triggers/<name>/webhook`.

```yaml
name: tracker
version: 1
pipeline: feature-builder

webhook:
  hmac:
    header: x-tracker-signature      # hex sha256 of the raw body
    secret: ${TRACKER_WEBHOOK_SECRET}
  when:                              # same syntax as a stage `when:`, over `payload.`
    - payload.type == "Issue"
    - payload.data.state.name == "In Progress"

input:                               # pipeline input, `{{payload.<path>}}` resolved
  brief_summary: "{{payload.data.title}}"

meta:                                # recorded on the run, not sent to the agent
  issue_id: "{{payload.data.id}}"

log:                                 # what `GET /api/triggers/<name>` shows per delivery
  external_id: "{{payload.data.id}}"
  external_label: "{{payload.data.title}}"
  external_url: "{{payload.data.url}}"

on_failure:                          # runs when the launched run does not succeed
  timeout_ms: 20000
  command: ./notify.sh
```

**No `when:` means every delivery matches** — the file's existence is the opt-in. A delivery that does not match answers `200 {ignored: true}`; a bad signature answers `401`; a match answers `202` with the run id.

**`hmac` fails loud.** A secret written as `${VAR}` with nothing behind it resolves to nothing, and the loader refuses the trigger rather than serve an endpoint that quietly stopped verifying.

**`on_failure` receives its values through the environment** — `STUDIO_TRIGGER`, `STUDIO_RUN_ID`, `STUDIO_RUN_STATUS`, `STUDIO_META` (JSON), `STUDIO_REJECTION_REASON`, `STUDIO_REJECTION_DETAILS` (JSON) — never interpolated into the command string. The payload that produced them came from outside; interpolating it would let the sender run anything.

The kernel names no product here. Which events count, which field becomes which input, and what failure does are all the trigger file's opinions, so publishing one for a new system is a marketplace package, not a Studio release.

---

## Packages: templates and plugins

A marketplace publishes two kinds of package, each defined by its install verb:

| | `template` | `plugin` |
|---|---|---|
| Target | no `.studio/` yet | an existing `.studio/` |
| Verb | `studio init --template X` | `studio plugin add X` |
| Cardinality | one per project, at creation | many, at any time |

Tools, agents, skills, triggers, pipelines, contracts and inputs are not package types. They are **content kinds** carried inside a plugin, declared in its `metadata.json`:

```json
{ "name": "git", "type": "plugin", "provides": { "tools": ["git"] } }
```

On install, each payload file is dispatched to the `.studio/` subdirectory of its kind by filename suffix — `coder.agent.yaml` to `agents/`, `git.tool.yaml` to `tools/`. Filenames are kept as published: the agent and skill loaders resolve by filename, so renaming would break `agent: coder`. `provides` is what search reads; the suffix is what install obeys.

The lockfile records the exact paths a package wrote, so removal and `audit` act on what was installed rather than on a path re-derived from a type.

---

## Marketplaces

A marketplace is a git repository with an `index.json` at its root, listing packages and where each one's payload lives. `studio-community` is the default and needs no registration; `studio marketplace add <url>` registers another, per machine in `~/.studio/marketplaces.json`. A private company marketplace is therefore a repository and one command — no hosted service, no fork of Studio.

```bash
studio marketplace add https://gitlab.internal/platform/studio-marketplace.git --name acme-corp
studio registry install acme-corp:internal-deploy
```

An index entry's `source` says where the payload is:

```json
"source": { "type": "local", "path": "plugins/git" }
"source": { "type": "git", "url": "https://github.com/someone/studio-legal.git",
            "path": "template", "ref": "v2.1.0", "sha": "9f3c1a…" }
```

`local` is the marketplace repo itself, reviewed as a diff at merge time. `git` is someone else's repository, where review sees a URL and nothing more — so the fetch enforces what the diff cannot: the pinned `sha` must still be what `ref` points at, the payload must ship a LICENSE matching the declared `license`, and it must match `provides` in both directions. Any mismatch fails the install. See [ADR 0001](docs/adr/0001-distribution-model.md) and [CLI.md](CLI.md#marketplaces).

A package name is unique within a marketplace, not across them. An unqualified name that exists in several is refused with the qualified forms spelled out, never resolved by registration order.

---

## Package dependencies

A registry package declares what it needs in its `metadata.json`. A template supplies pipelines and contracts; the plugins it depends on supply the tools and agents those pipelines reference.

```json
"dependencies": {
  "plugins": {
    "required": ["git", "coder@>=1.2.0"],
    "recommended": ["github"]
  }
}
```

`studio init --template <name>` and `studio registry install <name>` resolve this graph before the package lands. Required entries install transitively; recommended ones are prompted individually and skipped when prompting isn't possible.

**Entry syntax:** `[marketplace:]name[@range]`.

- **Unqualified** — resolves within the package's own marketplace. `acme-corp:internal-deploy` names another one; a marketplace the user hasn't registered is refused, never added silently.
- **`@range`** — a semver range. The resolver takes the highest indexed version satisfying every constraint on that package, and fails naming both when none does. Greedy: no backtracking, no SAT solving.
- **No range** — whatever the index carries.

Cycles are detected and reported. A required name missing from the index aborts the install; a recommended one is skipped.

`plugins` is the category ADR 0002 settles on. `tools`, `agents`, `skills`, `templates` and `pipelines` are the pre-migration spelling and resolve identically — resolution is by name, never by category.

**Ranges outlive the install.** `registry.lock.json` records the range each dependent declared (`constraints`), so `studio registry update` moves to the highest version those ranges accept rather than to `latest`, `studio registry outdated` separates "newer exists" from "newer I can take", and `studio registry audit` flags an installed graph that drifted out of range. See [CLI.md](CLI.md#updates-and-ranges).

---

## Token usage

Every provider reports what a call spent, in one shape (`TokenUsage`):

```json
{
  "prompt_tokens": 4200,
  "completion_tokens": 3100,
  "total_tokens": 128300,
  "cached_input_tokens": 98000,
  "cache_creation_tokens": 23000,
  "by_model": { "claude-opus-4-5": { "prompt_tokens": 4200, "...": "..." } }
}
```

The four count fields are disjoint on purpose: each is billed at its own rate, so a
stage that read 200k tokens from cache and one that sent 200k fresh differ by an
order of magnitude in cost — one number cannot tell them apart. Providers normalize
to that definition (Anthropic already excludes cache counts from its input total,
OpenAI folds them in and Studio splits them back out).

It accumulates upward, and nothing is dropped on the way:

| Level | What it sums |
|-------|--------------|
| Provider call | One LLM call, per model |
| Agent run (runner) | Every turn of the tool-calling loop |
| Stage (engine) | Every RALPH attempt — the discarded retries too |
| `call` / `map` stage | The child runs it spawned |
| Run | Every stage |

Nothing is fabricated: a stage whose provider reported nothing (a script stage, the
mock provider) has no usage at all rather than a row of zeros — an unmeasured stage
must not read as a free one.

Where it lands: on `StageRun.token_usage`, on the `stage_complete` / `stage_retry` /
`map_item_complete` / `pipeline_complete` events, and in `.studio/runs/<run>.jsonl`
under `tokens`. A `map` item additionally carries `stages` — the child run's
per-stage breakdown, so how many attempts bought that number is readable without
correlating the child's own journal. `studio status <run-id>` aggregates it per stage and per model. See
[CLI.md](CLI.md) for the jq recipes.

---

## Prompt caching (`prompt_cache`)

A prompt cache is not free storage. The write is billed *above* the plain input rate
and only earns that back when a later call reads the same prefix — so a call with no
successor costs more with caching on than off, on every token of the prefix. That is
not a hypothetical: a measured run spent 4.5M tokens writing caches that were read
back 1.05M times, and came out **35% more expensive** than the same run with no
caching at all.

So the decision is never "is this prefix big?" but "will anything read it back?", and
only the runner can answer it — the provider sees one call at a time. A stage that
must call tools comes back through the loop with the same system prompt and the same
tool definitions in front of it, and every turn after the first reads what the first
one wrote. A fan-out item or a QA verdict answers in one turn and never returns.

Agents declare the policy; the default reads the stage:

```yaml
# .studio/agents/extractor.agent.yaml
name: extractor
prompt_cache: auto   # auto (default) | on | off
```

| Value | Behaviour |
|-------|-----------|
| `auto` | Cache only when the stage's **contract** obliges it to call tools (`tool_calls.minimum`, `required_tools`, or `required_tool_groups`) *and* the agent actually has tools. That contract is the one declaration in `.studio/` that predicts a second turn before the first has happened. |
| `on` | Always cache. For a fan-out whose items have been *measured* to share a prefix long enough to beat the write premium — concurrent items all miss an unwarmed cache, so measure before reaching for this. |
| `off` | Never cache, whatever the stage looks like. |

Tools merely being *available* is not enough for `auto`: an agent that can call tools
and doesn't is exactly the single-turn call that was overpaying. The decision is made
once per agent run and held for every turn of it — flipping the marker mid-run writes
a cache the remaining turns never look for.

Providers with no cache controls (mock, ollama, and OpenAI, which caches server-side
at no premium) ignore the setting.

---

## PII anonymization

Transparent middleware that replaces sensitive data with tokens before sending to the LLM:

- Names → `[PERSON_1]`, `[PERSON_2]`
- Emails → `[EMAIL_1]`
- Financial data → `[AMOUNT_1]`

A local keymap stored in `.studio/runs/anonymization/<run-id>.keymap.json` lets you reconstruct the original values after the run.

Activated via `--anonymize` on `studio run`, or `anonymize: true` in agent YAML.

---

## State machine

```
pending → running → success
                  → failed
                  → rejected
                  → skipped
```

`deriveStageStatus(ralphResult)` in `engine/src/state/status-derivation.ts` maps RALPH results to stage status. ralph `success` → stage `success`. ralph `exhausted` → stage `failed`. Simple and deterministic.

---

## Domain-agnostic engine

The engine does not know what domain it operates in. There are no references to "code", "file", "git", or "QA" anywhere in the engine package. All domain semantics come from YAML configs.

This is an architectural commitment enforced as an invariant. If you find yourself writing `if (stage.kind === 'qa')` in the engine, you've made an error, that logic belongs in the contract.

---

## Provider-agnostic runner

The runner supports multiple LLM providers. Different agents in the same pipeline can use different providers and models.

```yaml
# .studio/config.yaml
providers:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
  openai:
    apiKey: ${OPENAI_API_KEY}

defaults:
  provider: anthropic
  model: claude-sonnet-4-20250514
```

Switch models without changing pipeline logic. The orchestration layer depends on the work being done correctly, not on who does it.

---

## Package boundaries

```
@studio-foundation/contracts    → Types, interfaces. Zero dependencies. Leaf package.
@studio-foundation/ralph        → Retry loop + validation. Depends only on contracts.
@studio-foundation/runner       → Tool plugin runtime, LLM providers. Depends only on contracts.
@studio-foundation/anonymizer   → PII middleware. Depends only on contracts.
@studio-foundation/engine       → Pipeline orchestration. Depends on ralph + runner + anonymizer + contracts.
@studio-foundation/api          → HTTP REST API. Depends on engine + contracts.
@studio-foundation/cli          → Terminal interface. Depends on engine + contracts.
```

**No inverse dependencies.** ralph does not know runner. runner does not know engine. If you find yourself importing "upward," it's an architecture error.

---

## Gotchas

**Tool naming: dot vs dash.** In contract YAML, tools use dot notation (`repo_manager.write_file`). The engine transforms to dash notation (`repo_manager-write_file`) at runtime, and that's the form you'll see in logs, hook matchers, and validation errors. Both refer to the same tool.

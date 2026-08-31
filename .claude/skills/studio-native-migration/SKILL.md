---
name: studio-native-migration
description: Use when making a project that already runs on Studio use it natively — replacing subprocess `studio run` calls, hand-rolled fan-outs, caches and Python orchestrators with map/call/script stages, up to a pipeline of pipelines with no orchestrator left. Produces a maturity level, a smell→fix plan and Linear issues on the target project's own team. Direction is Studio → downstream project. For the opposite direction (what the project proves Studio is missing), use harvest-studio-gaps.
---

# Studio Native Migration

Most projects adopt Studio as a subprocess and stop there: the pipelines are real, but a
Python file still chains them, caches them, retries them and checks their outputs. Every
one of those responsibilities already exists in the engine. This skill finds which rung
the project is on and plans the climb.

## The ladder

| Level | Shape | The tell |
|---|---|---|
| **L0** | Studio is a subprocess | `subprocess.run(["studio","run", …])`, stdout parsed for the stage output |
| **L1** | Pipelines per unit of work, glue chains them | An orchestrator file owns order, resume, caching, output checks |
| **L2** | Fan-out is the engine's | `map:` with `over`/`concurrency`/`on_item_failure`/`resume`; no loop spawning runs |
| **L3** | No subprocess left | Sub-pipelines via `call:`, non-LLM work as `executor: script` stages, artifacts via `expected_outputs.files` |
| **L4** | Pipeline of pipelines | One entry pipeline whose stages are `call:`. No orchestrator file. `studio run <entry>` is the product |

**The level is the lowest rung that still has a violation.** Name the violation that pins
it — "L1: `scripts/build.py` still decides stage order" — not just the number.

## Smell → fix

| Smell in the project | Studio surface that replaces it |
|---|---|
| `subprocess.run(["studio","run", …])` | `call:` stage (`pipeline:`, `input:`, `condition:`, `on_failure:`) |
| Scraping stdout for a stage's JSON | The child run returns its last-stage output natively |
| `for item in items:` spawning one run each | `map:` with `over:`, `input:`/`as:`, `concurrency:` |
| `ThreadPoolExecutor` / `asyncio.gather` around LLM calls | `map:` `concurrency:`; add `batch: true` when the work has no interactive deadline |
| `load_cache`/`save_cache` keyed on the input rows | `map:` `resume: true` — keyed on the resolved item input, so a prompt change re-runs |
| `try/except` writing a fallback when the run fails | `on_failure: continue` plus a post stage treating an absent output as the fallback |
| Per-item error swallowing to keep the batch alive | `on_item_failure: collect-all` |
| `if not os.path.exists(out): fail` after a run | `expected_outputs.files` (paths or globs) — checked inside RALPH, so a miss retries |
| `for attempt in range(3)` around a call | RALPH: `ralph.max_attempts` + a `contract:` |
| A validator script run after the stage | `contract:` with `schema.fields`; `post_validation.rejection_detection` for verdicts |
| A gate deciding whether to call the LLM at all | A pre stage emitting the decision + `condition:` on the call |
| Setup shell run before the pipeline | `on_pipeline_start`, or a `executor: script` stage |
| Lint/typecheck run after generation | `hooks.on_stage_complete` with `on_failure: reject` |
| Pricing a run by parsing provider session files | `token_usage` on every event in `.studio/runs/<run>.jsonl`; `studio status` |
| A script checking env vars and binaries first | `requires_binaries`, `config.example.yaml`, `studio doctor` |
| A webhook receiver shelling out to the CLI | `.studio/triggers/*.trigger.yaml` |

Before planning, check `studio_version` in `.studio/config.yaml` and the installed CLI:
half this table is surface that arrived in a specific release, and a plan that assumes a
key the pinned range excludes fails at preflight, not at review.

## The move that unlocks L3: pre / call / post

A glue script almost always does three things at once — gather inputs, invoke the LLM,
parse and persist. Split it into three stages and the middle one becomes native:

```yaml
  - name: entity-species-pre          # gather + decide, no LLM
    executor: script
    runtime: python
    script: scripts/entity_species_pre.py
    contract: entity-species-pre

  - call: entity-species-verdict      # the former subprocess
    pipeline: entity-species-verdicts
    condition: stages.entity-species-pre.output.needs_verdict == true
    on_failure: continue
    input:
      entities: "{{stages.entity-species-pre.output.entities}}"

  - name: entity-species              # parse, fold, persist
    executor: script
    runtime: python
    script: scripts/entity_species.py
    contract: entity-species
```

The fail-safe that used to be a `try/except` is now `on_failure: continue` plus a post
step that reads "no verdict" as "change nothing". The gate that used to be an `if` is
`condition:`. Nothing was rewritten — it was redistributed.

## What stays in Python

Domain logic. `executor: script` stages are the **destination**, not a failure to migrate.
Never promote a deterministic transform into an LLM stage to raise the level — that is
paying tokens for a `sorted()`. The goal is that Studio owns *control flow*; the project
owns *meaning*.

## Procedure

1. **Inventory.** List `.studio/pipelines/`, then every file that invokes Studio or
   sequences its runs. The second list is the work.
2. **Level it.** State the rung and the violation pinning it.
3. **Order the migrations.** Lowest rung first. Each one must be independently shippable
   and leave the full run green — a half-migrated fan-out is worse than none.
4. **Verify each.** `studio run <pipeline> --provider mock` for wiring, then one real
   input with artifacts diffed before/after. A wiring test over the YAML itself
   (stage names, `over:` paths, `input:` references resolve) catches the renames that
   mock runs don't.
5. **Delete the glue and its tests in the same change.** A migration that leaves the old
   path callable is not done; the dead path will be the one someone runs.
6. **File it.** One Linear issue per migration, on the target project's own team — the
   work is in the project, so the ticket is too. Body: current shape (`file:line`),
   target YAML written out, what gets deleted, done criterion. An umbrella issue only
   past five migrations, with these as sub-issues.

## Worked example — wiki-creator, L0 → L4

The whole ladder, in order, in a public repo ([studio-foundation/wiki-creator](https://github.com/studio-foundation/wiki-creator)):

- `expected_outputs.files` per stage, retiring the Python output checks (#230)
- The three flat fan-outs → engine `map:` stages, then the nested one (#241, #242)
- The `studio run` subprocesses → native `call:` stages, in two halves (#235, and the map half)
- Every remaining pre-step → a pipeline stage; the entity trio split pre/call/post ([#246](https://github.com/studio-foundation/wiki-creator/pull/246))
- `run_wiki.py` deleted — 316 lines of orchestration, with its 219-line test file

What is left is `wiki-full.pipeline.yaml`: four `call:` stages and a comment explaining
that RALPH retries live inside each child, so there is no outer retry loop. That is L4.

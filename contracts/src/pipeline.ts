// Pipeline and Stage definitions

import type { StageKind } from './stage';

export interface InputField {
  name: string;
  type: 'text' | 'array';
  prompt: string;
  required: boolean;
  default?: string;
  items?: 'text';
}

export interface InputSchema {
  type: 'structured';
  fields: InputField[];
}

export interface StartupCommand {
  command: string;
  inject_as: string;
}

export interface PipelineDefinition {
  name: string;
  description: string;
  version: number;
  on_pipeline_start?: StartupCommand[];
  input_schema?: InputSchema;
  repo?: {
    url: string;
    branch?: string;
  };
  stages: PipelineEntry[];
}

// Lifecycle hooks — configurable shell commands at stage/tool lifecycle points

export type HookOnFailure = 'warn' | 'reject' | 'fail';

export interface StageHookDef {
  command: string;
  on_failure?: HookOnFailure;  // default: 'warn'
}

export interface ToolHookDef {
  matcher: string;             // exact tool name to match (e.g. "repo_manager-write_file")
  command: string;
  on_failure?: 'warn' | 'reject';  // default: 'warn' — 'fail' not supported at tool boundary
}

export interface StageHooks {
  on_stage_start?: StageHookDef[];
  on_stage_complete?: StageHookDef[];
  pre_tool_use?: ToolHookDef[];
  post_tool_use?: ToolHookDef[];
}

export interface StageDefinition {
  name: string;
  condition?: string;   // e.g. "input.meals_count >= 6" or "stages.foo.output.count > 0"
  kind?: StageKind;
  agent?: string;           // optional — not needed for script executor
  executor?: 'script';      // 'script' or absent (defaults to LLM)
  script?: string;          // path to script file (required when executor: 'script')
  runtime?: 'python' | 'node' | 'shell'; // runtime for script executor
  timeout_ms?: number;      // script timeout in ms (default: 30000)
  contract?: string;
  ralph?: {
    max_attempts: number;
    retry_strategy: string;
    max_tool_calls?: number;
  };
  context?: {
    include: string[];
    packs?: string[];
  };
  tools?: {
    required?: string[];
  };
  hooks?: StageHooks;
}

// A pipeline entry is either a stage, a group of stages, a fan-out over a list,
// or a one-shot call to another pipeline.
export type PipelineEntry = StageDefinition | StageGroup | MapStage | CallStage;

export interface StageGroup {
  group: string;
  max_iterations: number;
  mode?: 'sequential' | 'parallel';         // default: 'sequential'
  on_failure?: 'fail-fast' | 'collect-all'; // parallel only, default: 'fail-fast'
  stages: StageDefinition[];
}

/**
 * A fan-out / map stage: run a sub-pipeline once per item of a list, then
 * collect the structured outputs. Replaces the "shell `studio run` per item +
 * scrape the log" glue — the child runs are spawned in-process via the engine's
 * RunSpawner and their last-stage output is returned directly (no scraping).
 */
export interface MapStage {
  map: string;                              // the fan-out stage name (discriminant)
  condition?: string;                       // skip the whole fan-out if false
  over: string;                             // context path to the list: input.<path> | stages.<name>.output.<path>
  pipeline: string;                         // sub-pipeline run once per item
  /**
   * Per-item input template. Each value may reference the current item and the
   * pipeline input via {{item}}, {{item.<path>}}, {{index}}, {{input.<path>}}.
   * A value that is exactly "{{item}}" (or "{{input.x}}") keeps the resolved
   * value's native type; mixed strings interpolate to text.
   */
  input?: Record<string, unknown>;
  as?: string;                              // shorthand: input = { [as]: item } (ignored when `input` is set)
  concurrency?: number;                     // max items in flight, default 1 (sequential)
  on_item_failure?: 'fail-fast' | 'collect-all'; // default: 'fail-fast'
  /**
   * Per-item resume (default: false). When `true`, a re-run of this map stage
   * skips items that already completed successfully in an earlier run and
   * re-spawns only the incomplete ones — the shape `discover_relationships.py`'s
   * per-chunk votes cache has by hand, lifted into the engine so a run of
   * hundreds of network-bound items isn't all-or-nothing (one timeout near the
   * end no longer re-costs the whole stage).
   *
   * The resume key is derived from the **item input** (the sub-pipeline input
   * built for this item), never its index or list position. So:
   *   - reordering or filtering the `over:` list still hits the cache — a verdict
   *     computed for item X is never replayed for a different item Y (the
   *     identity-vs-inputs trap recorded in wiki-creator's alias/page caches);
   *   - changing an item's content (or the `input:`/`as:` mapping, or the target
   *     `pipeline:`) changes the key, so that item is recomputed.
   *
   * A per-item **failure is never cached** — a failed item retries on the next
   * run while completed items stay done. Resume is orthogonal to
   * `on_item_failure`: the cache is consulted and written under both `fail-fast`
   * and `collect-all`, and a cache-served item counts as a success (it never
   * trips `fail-fast`).
   *
   * The cache lives on disk under `.studio/runs/map-cache/…`, keyed by parent
   * pipeline + stage + sub-pipeline + item-input hash, so it survives a process
   * restart between runs.
   */
  resume?: boolean;
  /**
   * Dispatch this fan-out's LLM calls as batches instead of one synchronous
   * request per item (default: off). `true` takes every default below.
   *
   * The items of a fan-out are independent and nothing is waiting on any single
   * one of them, which is exactly what a vendor batch endpoint is priced for:
   * Anthropic's Message Batches API bills every token — input, output, cache
   * write, cache read — at 50% of the synchronous rate, in exchange for up to
   * 24h to finish. On a bulk stage that is the largest cost lever there is.
   *
   * What it changes, and what it does not:
   *   - Items still run as ordinary child runs. Contracts, RALPH, hooks,
   *     post-validation and the `resume` cache all behave identically; a cached
   *     item is simply never dispatched.
   *   - Validation stays per item, after the batch comes back. An item that
   *     fails retries into the *next* batch, so rounds shrink instead of the
   *     retry loop paying full price per item.
   *   - `concurrency` defaults to `min(items, max_size)` here instead of 1 —
   *     items must be in flight together to share a batch. An explicit
   *     `concurrency` is still honoured, and caps the batch at that size.
   *   - Nothing streams: a batched response arrives whole, so `--live` shows no
   *     tokens for these items.
   *   - A provider with no batch endpoint (mock, ollama, claude-code) runs the
   *     stage exactly as it would without this key — correct, just not cheaper.
   */
  batch?: boolean | MapBatchConfig;
}

/** Tuning for a `map` stage's batched dispatch. Every field has a default. */
export interface MapBatchConfig {
  /** Requests per batch before one is sent without waiting for the rest. Default 500. */
  max_size?: number;
  /** How often to ask whether the batch has ended. Default 15000. */
  poll_interval_ms?: number;
  /**
   * Give up on a batch after this long, failing its requests. Default 86400000
   * (24h — the API's own expiry). A batch has no per-call timeout; this is the
   * whole-stage budget that replaces one.
   */
  max_wait_ms?: number;
  /**
   * Send what is parked after this long with no new request arriving, even
   * while an item is still busy elsewhere. Default 30000, `0` disables it.
   * Without it one slow item would hold the whole batch.
   */
  flush_after_ms?: number;
}

/**
 * A call stage: run a named pipeline once, inline, and expose its output to
 * later parent stages under the stage name. This is `map` with the iteration
 * removed — same RunSpawner machinery, structured output, no log scraping — for
 * when the shape is a sequence, not a fan-out (e.g. chaining wiki-extraction →
 * wiki-resolution → wiki-preparation → pages-export in one top-level pipeline).
 */
export interface CallStage {
  call: string;                             // the stage name (discriminant)
  condition?: string;                       // skip the call if false
  /**
   * What a failed child does to the parent. 'fail' (default) fails the parent
   * pipeline. 'continue' records the stage as failed (surfaced in `studio
   * status`, the run JSONL and the CLI) but proceeds to the next stage,
   * propagating no output — a downstream stage sees this stage name absent
   * from its context and can apply its own safe default. A cancelled child
   * always cancels the parent; a `condition`-skipped call stays `skipped`, so
   * a tolerated failure and a skip are distinguishable in the run record.
   */
  on_failure?: 'fail' | 'continue';
  pipeline?: string;                        // sub-pipeline to run once (defaults to `call`)
  /**
   * Input for the child run. Each value may reference the parent context via
   * {{input}}, {{input.<path>}}, {{stages.<name>.output.<path>}} — the same
   * substitution as `map`'s `input`, minus the per-item {{item}}/{{index}}. A
   * value that is exactly one {{ref}} keeps the resolved value's native type;
   * any other string interpolates to text. Omitted → the parent input is
   * forwarded to the child unchanged.
   */
  input?: Record<string, unknown>;
}

export function isStageGroup(entry: PipelineEntry): entry is StageGroup {
  return 'group' in entry && 'stages' in entry;
}

export function isMapStage(entry: PipelineEntry): entry is MapStage {
  return 'map' in entry && 'over' in entry;
}

export function isCallStage(entry: PipelineEntry): entry is CallStage {
  return 'call' in entry;
}

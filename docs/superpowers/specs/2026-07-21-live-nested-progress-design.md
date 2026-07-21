# Live nested-stage progress (STU-620)

## Problem

Under `studio run --live`, child pipeline work is invisible. A `call` stage renders
as a single opaque stage line; a `map` stage renders one line per item. The
sub-pipeline's own stages, tool calls, and tokens never reach the terminal.

Root cause: child engines carry **no event sink**. `EngineEvents` is a second
constructor argument of `PipelineEngine` (`engine/src/engine.ts:150`), not part of
`EngineConfig`. `DirectEngineSpawner` builds each child with config only
(`engine/src/spawners/direct-engine-spawner.ts:11`), so `child.events` is
`undefined`. The child's internal emitter is never connected to the parent's. The
CLI sees only the coarse orchestrator events (`onStageStart/Complete` for a call,
`onMapItemStart/Complete` for map).

Deeply nested pipelines (four levels) show a single running line for the entire
child tree.

## Goal

Render child stage/tool progress under `--live`, indented by nesting depth, to full
depth. Suppress the noisy token/thinking firehose below the top level so the
terminal stays readable.

## Non-goals

- No live re-rendered tree (in-place redraw). Append-only indented lines only.
- No change to non-`--live` (summary/verbose) output beyond what indentation
  naturally adds.
- No new domain concepts in the engine. `depth`/`childId` are orchestration facts,
  not domain.

## Design

Three layers plus wiring. `contracts` is **not** touched — `EngineEvents` lives in
the engine package.

### Layer 1 — `engine/src/events.ts`

Add an optional trailing parameter to every `EngineEvents` callback:

```ts
export interface EventContext {
  depth: number;    // 0 = top-level engine, 1+ = spawned child
  childId: string;  // stable per child run, minted by the spawner
}

export interface EngineEvents {
  onStageStart?(e: StageStartEvent, ctx?: EventContext): void;
  onStageComplete?(e: StageCompleteEvent, ctx?: EventContext): void;
  // ...every callback gains the same optional `ctx?: EventContext`
}
```

The change is additive and optional. The engine's own emit sites in
`engine/src/engine.ts` are **unchanged** — they keep calling
`this.events?.onStageStart?.(payload)` with no `ctx`. Context is supplied by the
spawner's adapter (Layer 2), never by the engine core. A top-level consumer that
ignores the second argument keeps working as-is (`ctx` undefined ⇒ depth 0).

### Layer 2 — `engine/src/spawners/direct-engine-spawner.ts`

- Constructor gains a second argument: `events?: EngineEvents` (the parent sink).
- Maintain a monotonic counter for minting `childId`.
- Per `spawnAndWait(config)`:
  1. Mint `childId` — e.g. `` `d${config.depth}#${counter++}` ``. Unique across
     concurrent siblings at the same depth (map `concurrency > 1`).
  2. Build a **tagging adapter** — an `EngineEvents` whose every handler forwards to
     the parent with `ctx = { depth: config.depth, childId }`. If the parent handler
     already received a `ctx` (grandchild case), the adapter's own `depth`/`childId`
     win for this level; the parent's forwarding chain carries each level's context
     outward.
  3. Build the child engine with the adapter as its events sink and `spawner: this`
     (STU-615 recursion preserved):
     `new PipelineEngine({ ...this.engineConfig, spawner: this }, adapter)`.

Routing key is the spawner-minted `childId`, **not** the engine's `run_id`. The
run_id isn't known until the child run starts, but concurrent map siblings need a
pre-run key to group their interleaved events.

Depth accrues naturally: the orchestrators already call `spawnAndWait` with
`depth: depth + 1`, and the child's own spawner (same shared instance, STU-615)
re-wraps with the deeper `config.depth` on the next level.

### Layer 3 — `cli/src/output/progress.ts`

- Every subscribed handler reads the optional `ctx`.
- `ctx` undefined or `depth === 0` ⇒ **current behavior unchanged**.
- `depth >= 1`:
  - Indent the printed line by `'  '.repeat(depth)`.
  - When more than one child is active concurrently, prefix a short `childId` tag so
    interleaved lines stay attributable.
  - **Suppress** `onAgentToken` and `onAgentThinking` (the streaming firehose).
  - **Keep** `onStageStart` / `onStageComplete` and `onToolCallStart` /
    `onToolCallComplete` (the structure).
- Group per-child render state keyed by `childId` so concurrent map children don't
  clobber each other's spinner/line state.

The existing `MapRenderer` (`cli/src/output/map-progress.ts`) and `ParallelRenderer`
keep their coarse per-item / per-group lines; child stage lines now appear indented
beneath them. Update the `map-progress.ts:17-20` comment that documents the old
deliberate collapse.

### Wiring — `cli/src/commands/run.ts`

Pass the events sink into the spawner alongside the top engine:

```ts
const spawner = new DirectEngineSpawner(engineConfig, events);
const engine = new PipelineEngine({ ...engineConfig, spawner, maxDepth: 3 }, events);
```

## Data flow

```
top engine (depth 0, no ctx)
  └─ call/map orchestrator → spawner.spawnAndWait({ depth: 1, ... })
       └─ adapter(depth 1, childId A) wraps parent events
            └─ child engine emits onStageStart(payload)
                 → adapter → parent.onStageStart(payload, { depth: 1, childId: A })
                      └─ grandchild via spawnAndWait({ depth: 2, ... })
                           └─ adapter(depth 2, childId B) → ... → CLI (indent ×2)
```

## Testing

**engine** (`--provider mock`):
- Adapter tags forwarded events with the correct `depth` and a stable `childId`.
- A 4-level nested `call` chain emits stage events at depths 0 → 3 in order.
- Two concurrent `map` children carry **distinct** `childId`s; their events do not
  collide.
- Top-level events still arrive with `ctx` undefined (back-compat).

**cli**:
- Snapshot the indented render for a 2-level call — child stage lines indented once.
- Assert `onAgentToken` / `onAgentThinking` are dropped at `depth >= 1` and kept at
  depth 0.

## Risk / cost

- `EngineEvents` signature widens (optional param) — additive, no existing caller
  breaks.
- Terminal noise at high concurrency is mitigated, not eliminated, by indent +
  `childId` tag; acceptable for the primary nested-`call` (sequential) use case.
```
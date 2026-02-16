# Pipeline Observability Design

## Problem

The pipeline runs but provides minimal visibility. We need per-stage output summaries, tool call details, token usage, duration, and retry diagnostics.

## Architecture

### Layer 1 — Runner (token accumulation)

**File:** `runner/src/runner.ts`

Add `token_usage` to `AgentRunResult`. Accumulate tokens across the multi-turn tool-calling loop (not just last response).

```typescript
interface AgentRunResult {
  // existing fields...
  token_usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
```

### Layer 2 — Engine events (dedicated event types)

**File:** `engine/src/events.ts`

Replace `StageRun`/`PipelineRun` callbacks with dedicated event types:

- `PipelineStartEvent` — pipeline name, run ID
- `PipelineCompleteEvent` — status, duration, total_tokens, total_tool_calls
- `StageStartEvent` — stage name, index, total stages
- `StageCompleteEvent` — status, attempts, duration, output_summary, tool_calls summary, token_usage
- `StageRetryEvent` — stage, attempt, failures, raw output, tool_calls_count

Contract types (`PipelineRun`, `StageRun`) remain unchanged.

### Layer 3 — Engine (summary generation + accumulation)

**File:** `engine/src/engine.ts`

- `summarizeOutput(output, stageKind)` — returns human-readable summary based on stage kind (analysis, planning, code_generation, qa, custom)
- `summarizeToolCalls(toolCalls)` — extracts tool name + key argument (file path, command, etc.)
- Accumulate pipeline-level totals: total tokens, total tool calls
- Emit enriched events using new types

### Layer 4 — CLI display (progress + formatter)

**Files:** `cli/src/output/progress.ts`, `cli/src/output/formatter.ts`

Normal mode:
```
  [1/4] brief-analysis .............. ✓ (1 attempt, 12s)
        → 5 requirements, 3 acceptance criteria
```

Verbose mode adds: full JSON output, token breakdown per stage, raw agent response on retry.

Pipeline complete shows: total duration, total tokens, total tool calls.

Reuse existing `formatDuration` from `formatter.ts` (export it).

## Files to modify

1. `runner/src/runner.ts` — token accumulation in multi-turn loop
2. `engine/src/events.ts` — new dedicated event types, update EngineEvents
3. `engine/src/engine.ts` — summary functions, accumulate totals, emit enriched events
4. `cli/src/output/progress.ts` — display enriched stage/pipeline events
5. `cli/src/output/formatter.ts` — export formatDuration

## Decisions

- **Dedicated event types** over enriching contract types — keeps display concerns out of shared contracts
- **No new CLI flags** — reuses existing `--verbose` and `--json`
- **No new files** — everything fits in existing modules

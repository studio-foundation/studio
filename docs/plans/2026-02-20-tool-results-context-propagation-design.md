# Design: Tool Results Context Propagation

**Date:** 2026-02-20
**Status:** Approved

## Problem

When a pipeline runs multiple stages, stage N redoes the same tool searches that stage N-1 already performed. Stage 2 (`implementation-plan`) receives the compact JSON output from stage 1 (`brief-analysis`) — e.g. `{summary, requirements, acceptance_criteria}` — but has no access to the actual tool call results (search results, file contents) discovered during stage 1. The agent in stage 2 has no choice but to re-explore from scratch.

This causes two problems:
1. **Cost & latency** — duplicate LLM turns and tool executions per pipeline run
2. **Inconsistency** — stage 2 may search differently and find different things than stage 1

## Root Cause

`AgentRunResult` already contains `tool_calls: ToolCall[]` with `result` populated. However, `engine.ts` only stores `result.output` (the final JSON) in `PipelineContext.stageOutputs`. Tool results are discarded after each stage.

## Solution: New `context.include` option — `previous_stage_tool_results`

A new opt-in include type that forwards the tool call results from the previous stage into the next stage's prompt.

### Data flow

```
Stage 1 completes
  └─ engine stores ToolCall[] in PipelineContext.stageToolResults["brief-analysis"]

Stage 2 requests context.include: ["input", "previous_stage_output", "previous_stage_tool_results"]
  └─ context-propagation builds AgentContext with previous_tool_results field
       └─ prompt-builder renders "## Previous Stage Discoveries" section
```

### Prompt injection (stage 2 user message)

```
## Previous Stage Discoveries (brief-analysis)

### search_codebase("about")
- src/pages/about.tsx:1 — export default function About() { ...

### search_codebase("useState")
- src/components/Accordion.tsx:3 — import { useState } from 'react'

[...all tool calls with results]
```

## Packages Changed

| Package | Change |
|---------|--------|
| `engine` | `PipelineContext` adds `stageToolResults: Map<string, ToolCall[]>`; engine populates it after each stage; `context-propagation.ts` handles new include option |
| `runner` | `AgentContext` adds optional `previous_tool_results?: Record<string, ToolCall[]>`; `prompt-builder.ts` renders it |
| `contracts` | No change — `ToolCall` already has `result?: unknown` |
| templates | `feature-builder.pipeline.yaml` — add `previous_stage_tool_results` to `implementation-plan` includes; `code-generation` already uses `all_stage_outputs` but may also benefit |

## Design Decisions

**Why opt-in?** Follows the existing `context.include` pattern. Pipeline authors control exactly what context each stage receives. Auto-including with `previous_stage_output` would silently bloat tokens.

**`previous_stage_tool_results` vs `all_stage_tool_results`?** Symmetric with `previous_stage_output` / `all_stage_outputs`. Implement `previous_stage_tool_results` first; `all_stage_tool_results` can follow the same pattern if needed.

**Result truncation?** Individual tool results can be large. Cap each result at ~2000 chars in the prompt renderer to prevent runaway token usage, with a `[truncated]` marker.

**Groups?** Same approach applies — stage tool results within a group iteration are stored and can be included. Group stages that use `group_feedback` may also want `previous_stage_tool_results`.

## Invariants Preserved

- Engine remains domain-agnostic (no new domain knowledge added)
- `contracts` remains a leaf package (no new imports)
- `ralph` is not touched
- All changes are additive / opt-in

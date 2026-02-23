# STU-119: `studio replay <run-id>` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `studio replay <run-id>` command that reads a JSONL log file and replays events through `ProgressDisplay`, producing output visually identical to `studio run --live`.

**Architecture:** One new file `cli/src/commands/replay.ts` containing the command handler, JSONL file discovery (same pattern as `logs.ts`), and event mapping from JSONL fields to `EngineEvents` handler signatures. Registered in `cli/src/index.ts`. Tests in `cli/tests/commands/replay.test.ts`.

**Tech Stack:** TypeScript, Commander.js, `ProgressDisplay` from `cli/src/output/progress.ts`, vitest.

---

### Task 1: JSONL file discovery + event mapping (pure functions)

**Files:**
- Create: `cli/src/commands/replay.ts`
- Test: `cli/tests/commands/replay.test.ts`

**Step 1: Write failing tests for `findJsonlFile` and `mapJsonlLineToEvent`**

```typescript
// cli/tests/commands/replay.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { findJsonlFile, mapJsonlLineToEvent } from '../src/commands/replay.js';

const TMP = resolve('/tmp', '.studio-replay-test');
const RUNS_DIR = resolve(TMP, '.studio/runs');

beforeEach(() => {
  mkdirSync(RUNS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('findJsonlFile', () => {
  it('finds a JSONL file matching full 8-char run-id', () => {
    const filename = '2026-02-22T14h35m-feature-builder-abc12345.jsonl';
    writeFileSync(resolve(RUNS_DIR, filename), '');
    const result = findJsonlFile(RUNS_DIR, 'abc12345');
    expect(result).toBe(resolve(RUNS_DIR, filename));
  });

  it('finds a JSONL file matching partial run-id (4 chars)', () => {
    const filename = '2026-02-22T14h35m-feature-builder-abc12345.jsonl';
    writeFileSync(resolve(RUNS_DIR, filename), '');
    const result = findJsonlFile(RUNS_DIR, 'abc1');
    expect(result).toBe(resolve(RUNS_DIR, filename));
  });

  it('throws if no matching file found', () => {
    writeFileSync(resolve(RUNS_DIR, '2026-02-22T14h35m-pipe-zzz99999.jsonl'), '');
    expect(() => findJsonlFile(RUNS_DIR, 'abc1')).toThrow(/No run log found/);
  });

  it('throws if multiple files match an ambiguous prefix', () => {
    writeFileSync(resolve(RUNS_DIR, '2026-02-22T14h35m-pipe1-abc12345.jsonl'), '');
    writeFileSync(resolve(RUNS_DIR, '2026-02-22T15h00m-pipe2-abc12399.jsonl'), '');
    expect(() => findJsonlFile(RUNS_DIR, 'abc12')).toThrow(/Multiple/);
  });

  it('strips dashes from UUID-style run-id before matching', () => {
    const filename = '2026-02-22T14h35m-feature-builder-abc12345.jsonl';
    writeFileSync(resolve(RUNS_DIR, filename), '');
    const result = findJsonlFile(RUNS_DIR, 'abc1-2345');
    expect(result).toBe(resolve(RUNS_DIR, filename));
  });
});

describe('mapJsonlLineToEvent', () => {
  it('maps pipeline_start', () => {
    const line = { event: 'pipeline_start', pipeline: 'feature-builder', run_id: 'abc12345' };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onPipelineStart',
      payload: { pipeline_name: 'feature-builder', run_id: 'abc12345' },
    });
  });

  it('maps pipeline_complete', () => {
    const line = {
      event: 'pipeline_complete', pipeline_name: 'feature-builder', run_id: 'abc12345',
      status: 'success', duration_ms: 5000, total_tokens: 1000, total_tool_calls: 3,
    };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onPipelineComplete',
      payload: {
        pipeline_name: 'feature-builder', run_id: 'abc12345',
        status: 'success', duration_ms: 5000, total_tokens: 1000, total_tool_calls: 3,
      },
    });
  });

  it('maps stage_start (stage → stage_name)', () => {
    const line = { event: 'stage_start', stage: 'code-generation', stage_index: 0, total_stages: 3 };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onStageStart',
      payload: { stage_name: 'code-generation', stage_index: 0, total_stages: 3 },
    });
  });

  it('maps stage_complete with token remapping', () => {
    const line = {
      event: 'stage_complete', stage: 'code-generation', status: 'success',
      stage_index: 0, total_stages: 3,
      attempts: 1, duration_ms: 2000,
      tokens: { prompt: 500, completion: 200, total: 700 },
      tool_calls: [{ name: 'repo_manager-write_file', arguments_summary: 'path=src/foo.ts' }],
      output: { summary: 'done' },
    };
    const result = mapJsonlLineToEvent(line);
    expect(result?.payload).toMatchObject({
      stage_name: 'code-generation',
      token_usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
    });
  });

  it('maps stage_retry', () => {
    const line = {
      event: 'stage_retry', stage: 'code-generation', attempt: 2, max_attempts: 3,
      failures: ['missing field: summary'], tool_calls_count: 1,
    };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onTaskRetry',
      payload: {
        stage: 'code-generation', attempt: 2, max_attempts: 3,
        failures: ['missing field: summary'], tool_calls_count: 1,
      },
    });
  });

  it('maps group events (group → group_name)', () => {
    const line = { event: 'group_start', group: 'impl-review', max_iterations: 3 };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onGroupStart',
      payload: { group_name: 'impl-review', max_iterations: 3 },
    });
  });

  it('maps tool_call_start', () => {
    const line = { event: 'tool_call_start', tool: 'repo_manager-write_file', params: { path: 'src/foo.ts' } };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onToolCallStart',
      payload: { tool: 'repo_manager-write_file', params: { path: 'src/foo.ts' }, timestamp: 0 },
    });
  });

  it('maps tool_call_complete', () => {
    const line = { event: 'tool_call_complete', tool: 'repo_manager-write_file', result: { written: true }, duration_ms: 50 };
    const result = mapJsonlLineToEvent(line);
    expect(result).toEqual({
      handler: 'onToolCallComplete',
      payload: { tool: 'repo_manager-write_file', result: { written: true }, duration_ms: 50, timestamp: 0 },
    });
  });

  it('returns null for unknown event types', () => {
    const line = { event: 'unknown_thing', data: 123 };
    const result = mapJsonlLineToEvent(line);
    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd cli && pnpm test -- tests/commands/replay.test.ts`
Expected: FAIL — module `../src/commands/replay.js` does not exist.

**Step 3: Implement `findJsonlFile` and `mapJsonlLineToEvent`**

```typescript
// cli/src/commands/replay.ts
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { ProgressDisplay } from '../output/progress.js';

// ── JSONL file discovery ─────────────────────────────────────────────────────

function normalizeRunId(runId: string): string {
  return runId.replace(/-/g, '');
}

/**
 * Extracts the 8-char run-id suffix from a JSONL filename.
 * Filename format: `<date>-<pipeline>-<shortRunId>.jsonl`
 * The run-id is always the last segment before `.jsonl`.
 */
function extractRunIdFromFilename(filename: string): string {
  const base = filename.replace(/\.jsonl$/, '');
  const lastDash = base.lastIndexOf('-');
  return lastDash >= 0 ? base.slice(lastDash + 1) : base;
}

export function findJsonlFile(runsDir: string, runId: string): string {
  let entries: string[];
  try {
    entries = readdirSync(runsDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    throw new Error(`No runs directory found at ${runsDir}`);
  }

  const needle = normalizeRunId(runId);

  const matching = entries.filter((name) => {
    const fileRunId = extractRunIdFromFilename(name);
    return fileRunId.startsWith(needle);
  });

  if (matching.length === 0) {
    throw new Error(
      `No run log found for run id "${runId}". Use \`studio logs\` to see available runs.`
    );
  }

  if (matching.length > 1) {
    const ids = matching.map((f) => `  - ${extractRunIdFromFilename(f)} (${f})`).join('\n');
    throw new Error(`Multiple runs match "${runId}":\n${ids}\nProvide more characters to disambiguate.`);
  }

  return resolve(runsDir, matching[0]);
}

// ── JSONL → EngineEvents mapping ─────────────────────────────────────────────

export interface MappedEvent {
  handler: string;
  payload: Record<string, unknown>;
}

export function mapJsonlLineToEvent(
  line: Record<string, unknown>
): MappedEvent | null {
  const event = line.event as string;

  switch (event) {
    case 'pipeline_start':
      return {
        handler: 'onPipelineStart',
        payload: {
          pipeline_name: line.pipeline as string,
          run_id: line.run_id as string,
        },
      };

    case 'pipeline_complete':
      return {
        handler: 'onPipelineComplete',
        payload: {
          pipeline_name: line.pipeline_name as string,
          run_id: line.run_id as string,
          status: line.status as string,
          duration_ms: line.duration_ms as number,
          total_tokens: line.total_tokens as number,
          total_tool_calls: line.total_tool_calls as number,
        },
      };

    case 'stage_start':
      return {
        handler: 'onStageStart',
        payload: {
          stage_name: line.stage as string,
          stage_index: line.stage_index as number,
          total_stages: line.total_stages as number,
        },
      };

    case 'stage_complete': {
      const tokens = line.tokens as
        | { prompt: number; completion: number; total: number }
        | undefined;
      return {
        handler: 'onStageComplete',
        payload: {
          stage_name: line.stage as string,
          stage_index: line.stage_index as number,
          total_stages: line.total_stages as number,
          status: line.status as string,
          attempts: line.attempts as number,
          duration_ms: line.duration_ms as number,
          ...(tokens
            ? {
                token_usage: {
                  prompt_tokens: tokens.prompt,
                  completion_tokens: tokens.completion,
                  total_tokens: tokens.total,
                },
              }
            : {}),
          ...(line.tool_calls ? { tool_calls: line.tool_calls } : {}),
          ...(line.output !== undefined ? { output: line.output } : {}),
          ...(line.rejection_reason ? { rejection_reason: line.rejection_reason } : {}),
          ...(line.rejection_details ? { rejection_details: line.rejection_details } : {}),
        },
      };
    }

    case 'stage_retry':
      return {
        handler: 'onTaskRetry',
        payload: {
          stage: line.stage as string,
          attempt: line.attempt as number,
          max_attempts: line.max_attempts as number,
          failures: line.failures as string[],
          ...(line.agent_output_raw ? { agent_output_raw: line.agent_output_raw } : {}),
          ...(line.tool_calls_count !== undefined
            ? { tool_calls_count: line.tool_calls_count }
            : {}),
        },
      };

    case 'group_start':
      return {
        handler: 'onGroupStart',
        payload: {
          group_name: line.group as string,
          max_iterations: line.max_iterations as number,
        },
      };

    case 'group_iteration':
      return {
        handler: 'onGroupIteration',
        payload: {
          group_name: line.group as string,
          iteration: line.iteration as number,
          max_iterations: line.max_iterations as number,
        },
      };

    case 'group_feedback':
      return {
        handler: 'onGroupFeedback',
        payload: {
          group_name: line.group as string,
          iteration: line.iteration as number,
          rejection_reason: line.rejection_reason as string,
          rejection_details: line.rejection_details as string[],
        },
      };

    case 'group_complete':
      return {
        handler: 'onGroupComplete',
        payload: {
          group_name: line.group as string,
          iterations: line.iterations as number,
          status: line.status as string,
        },
      };

    case 'tool_call_start':
      return {
        handler: 'onToolCallStart',
        payload: {
          tool: line.tool as string,
          params: (line.params as Record<string, unknown>) ?? {},
          timestamp: 0,
        },
      };

    case 'tool_call_complete':
      return {
        handler: 'onToolCallComplete',
        payload: {
          tool: line.tool as string,
          result: line.result,
          ...(line.error ? { error: line.error } : {}),
          duration_ms: (line.duration_ms as number) ?? 0,
          timestamp: 0,
        },
      };

    default:
      return null;
  }
}

// ── Replay command ───────────────────────────────────────────────────────────

interface ReplayOptions {
  verbose?: boolean;
}

export async function replayCommand(
  runId: string,
  options: ReplayOptions
): Promise<void> {
  try {
    const runsDir = resolve(process.cwd(), '.studio/runs');
    const filePath = findJsonlFile(runsDir, runId);

    const content = readFileSync(filePath, 'utf-8');
    const lines = content
      .split('\n')
      .filter((l) => l.trim().length > 0);

    const progress = new ProgressDisplay(false, {
      live: true,
      verbose: !!options.verbose,
    });
    const events = progress.getEvents();

    for (const raw of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Skip corrupt lines
        continue;
      }

      const mapped = mapJsonlLineToEvent(parsed);
      if (!mapped) continue;

      const handler = events[mapped.handler as keyof typeof events];
      if (handler) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (handler as (e: any) => void)(mapped.payload);
      }
    }
  } catch (error) {
    console.error(
      chalk.red('Error:'),
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd cli && pnpm test -- tests/commands/replay.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add cli/src/commands/replay.ts cli/tests/commands/replay.test.ts
git commit -m "feat(cli): add replay command — JSONL discovery + event mapping (STU-119)"
```

---

### Task 2: Register the replay command in the CLI

**Files:**
- Modify: `cli/src/index.ts:8` (add import) and `~50` (add command block)

**Step 1: Write failing test — run `studio replay --help` to verify the command is registered**

No separate test needed — the integration is tested by the Task 1 test importing `replay.ts`. Registration is purely wiring.

**Step 2: Add the import and command registration**

In `cli/src/index.ts`, add after line 8:
```typescript
import { replayCommand } from './commands/replay.js';
```

Add after the `logs` command block (after line 50):
```typescript
program
  .command('replay <run-id>')
  .description('Replay a past pipeline run from JSONL logs (same rendering as --live)')
  .option('--verbose', 'Show complete outputs and tool call results')
  .action(replayCommand);
```

**Step 3: Build and verify**

Run: `pnpm build`
Expected: Build succeeds with no errors.

**Step 4: Commit**

```bash
git add cli/src/index.ts
git commit -m "feat(cli): register studio replay command (STU-119)"
```

---

### Task 3: Integration test — replay a synthetic JSONL file

**Files:**
- Modify: `cli/tests/commands/replay.test.ts` (add integration test)

**Step 1: Write integration test**

Add to `cli/tests/commands/replay.test.ts`:

```typescript
import { mapJsonlLineToEvent, findJsonlFile } from '../src/commands/replay.js';

describe('replay integration — full JSONL file', () => {
  it('maps a complete pipeline run through all events without errors', () => {
    const jsonlLines = [
      { event: 'pipeline_start', pipeline: 'test-pipe', run_id: 'aabb1122', ts: '2026-02-22T14:00:00Z' },
      { event: 'stage_start', stage: 'analysis', stage_index: 0, total_stages: 2, ts: '2026-02-22T14:00:01Z' },
      { event: 'tool_call_start', tool: 'repo_manager-read_file', params: { path: 'README.md' }, ts: '2026-02-22T14:00:02Z' },
      { event: 'tool_call_complete', tool: 'repo_manager-read_file', result: { content: '# Hello' }, duration_ms: 100, ts: '2026-02-22T14:00:02Z' },
      { event: 'stage_complete', stage: 'analysis', stage_index: 0, total_stages: 2, status: 'success', attempts: 1, duration_ms: 2000, tokens: { prompt: 500, completion: 200, total: 700 }, output: { summary: 'analyzed' }, ts: '2026-02-22T14:00:03Z' },
      { event: 'stage_start', stage: 'code-generation', stage_index: 1, total_stages: 2, ts: '2026-02-22T14:00:04Z' },
      { event: 'stage_retry', stage: 'code-generation', attempt: 2, max_attempts: 3, failures: ['missing field'], ts: '2026-02-22T14:00:05Z' },
      { event: 'stage_complete', stage: 'code-generation', stage_index: 1, total_stages: 2, status: 'success', attempts: 2, duration_ms: 4000, tokens: { prompt: 800, completion: 400, total: 1200 }, output: { summary: 'generated' }, ts: '2026-02-22T14:00:08Z' },
      { event: 'pipeline_complete', pipeline_name: 'test-pipe', run_id: 'aabb1122', status: 'success', duration_ms: 8000, total_tokens: 1900, total_tool_calls: 1, ts: '2026-02-22T14:00:08Z' },
    ];

    // Every line should map without errors
    const mapped = jsonlLines.map((line) => mapJsonlLineToEvent(line));
    expect(mapped.every((m) => m !== null)).toBe(true);
    expect(mapped.map((m) => m!.handler)).toEqual([
      'onPipelineStart',
      'onStageStart',
      'onToolCallStart',
      'onToolCallComplete',
      'onStageComplete',
      'onStageStart',
      'onTaskRetry',
      'onStageComplete',
      'onPipelineComplete',
    ]);
  });

  it('maps a rejected group run', () => {
    const jsonlLines = [
      { event: 'pipeline_start', pipeline: 'test-pipe', run_id: 'ccdd3344', ts: '2026-02-22T14:00:00Z' },
      { event: 'group_start', group: 'impl-review', max_iterations: 3, ts: '2026-02-22T14:00:01Z' },
      { event: 'group_iteration', group: 'impl-review', iteration: 1, max_iterations: 3, ts: '2026-02-22T14:00:02Z' },
      { event: 'stage_start', stage: 'code-gen', stage_index: 0, total_stages: 2, ts: '2026-02-22T14:00:03Z' },
      { event: 'stage_complete', stage: 'code-gen', stage_index: 0, total_stages: 2, status: 'success', attempts: 1, duration_ms: 2000, ts: '2026-02-22T14:00:05Z' },
      { event: 'stage_start', stage: 'qa-review', stage_index: 1, total_stages: 2, ts: '2026-02-22T14:00:06Z' },
      { event: 'stage_complete', stage: 'qa-review', stage_index: 1, total_stages: 2, status: 'rejected', attempts: 1, duration_ms: 1500, rejection_reason: 'code incomplete', rejection_details: ['missing error handling'], ts: '2026-02-22T14:00:07Z' },
      { event: 'group_feedback', group: 'impl-review', iteration: 1, rejection_reason: 'code incomplete', rejection_details: ['missing error handling'], ts: '2026-02-22T14:00:07Z' },
      { event: 'group_complete', group: 'impl-review', iterations: 1, status: 'rejected', ts: '2026-02-22T14:00:07Z' },
      { event: 'pipeline_complete', pipeline_name: 'test-pipe', run_id: 'ccdd3344', status: 'rejected', duration_ms: 7000, total_tokens: 2000, total_tool_calls: 0, ts: '2026-02-22T14:00:07Z' },
    ];

    const mapped = jsonlLines.map((line) => mapJsonlLineToEvent(line));
    expect(mapped.every((m) => m !== null)).toBe(true);

    // Verify rejection data is preserved
    const stageComplete = mapped.find((m) => m!.handler === 'onStageComplete' && m!.payload.status === 'rejected');
    expect(stageComplete!.payload.rejection_reason).toBe('code incomplete');
    expect(stageComplete!.payload.rejection_details).toEqual(['missing error handling']);
  });

  it('skips corrupt JSONL lines gracefully', () => {
    const validLine = { event: 'pipeline_start', pipeline: 'test', run_id: 'xxxx' };
    const mapped = mapJsonlLineToEvent(validLine);
    expect(mapped).not.toBeNull();

    // Unknown events return null
    const unknownLine = { event: 'totally_unknown', data: 123 };
    expect(mapJsonlLineToEvent(unknownLine)).toBeNull();
  });
});
```

**Step 2: Run tests**

Run: `cd cli && pnpm test -- tests/commands/replay.test.ts`
Expected: All tests PASS.

**Step 3: Commit**

```bash
git add cli/tests/commands/replay.test.ts
git commit -m "test(cli): add integration tests for replay event mapping (STU-119)"
```

---

### Task 4: Build, full test suite, final verification

**Files:** None new — verification only.

**Step 1: Build the entire monorepo**

Run: `pnpm build`
Expected: Build succeeds with no errors.

**Step 2: Run the full CLI test suite**

Run: `cd cli && pnpm test`
Expected: All tests pass, including the new replay tests.

**Step 3: Run pnpm test at root level**

Run: `pnpm test`
Expected: All packages pass.

**Step 4: Commit if any adjustments were needed**

Only if fixes were made in previous steps.

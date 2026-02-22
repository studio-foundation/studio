# STU-66: CLI Output UX Polish — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Polish the CLI output during `studio run` to show clear stage progress with attempt counters, compact token counts, inline retry messages, and a clean footer with run ID.

**Architecture:** Modify the existing `ProgressDisplay` class and formatters in-place. Add `max_attempts` to the engine's `StageStartEvent` so the spinner can show `(attempt 1/3)`. Extract pure formatting helpers for testability.

**Tech Stack:** TypeScript, ora (spinners), chalk (colors), vitest (tests)

---

### Task 1: Add `max_attempts` to engine event types

**Files:**
- Modify: `engine/src/events.ts:31-35` (StageStartEvent)
- Modify: `engine/src/events.ts:52-58` (StageRetryEvent)

**Step 1: Add `max_attempts` to `StageStartEvent`**

In `engine/src/events.ts`, add `max_attempts: number` to the interface:

```typescript
export interface StageStartEvent {
  stage_name: string;
  stage_index: number;
  total_stages: number;
  max_attempts: number;
}
```

**Step 2: Add `max_attempts` to `StageRetryEvent`**

Same file, add `max_attempts: number`:

```typescript
export interface StageRetryEvent {
  stage: string;
  attempt: number;
  max_attempts: number;
  failures: string[];
  agent_output_raw?: string;
  tool_calls_count?: number;
}
```

**Step 3: Pass `max_attempts` in engine emission — onStageStart**

In `engine/src/engine.ts:351-355`, add the field:

```typescript
this.events?.onStageStart?.({
  stage_name: stageDef.name,
  stage_index: stageIndex,
  total_stages: totalStages,
  max_attempts: stageDef.ralph?.max_attempts ?? 3,
});
```

**Step 4: Pass `max_attempts` in engine emission — onTaskRetry**

In `engine/src/engine.ts:581-587`, add the field:

```typescript
this.events?.onTaskRetry?.({
  stage: stageDef.name,
  attempt: event.attempt,
  max_attempts: stageDef.ralph?.max_attempts ?? 3,
  failures: event.allFailures,
  agent_output_raw: rawOutput,
  tool_calls_count: event.result.tool_calls_count,
});
```

**Step 5: Build to verify types compile**

Run: `pnpm build`
Expected: PASS — no consumers break because `max_attempts` is a new additive field.

**Step 6: Commit**

```bash
git add engine/src/events.ts engine/src/engine.ts
git commit -m "feat(engine): add max_attempts to StageStartEvent and StageRetryEvent"
```

---

### Task 2: Add `formatTokens()` helper (TDD)

**Files:**
- Modify: `cli/src/output/formatters.ts`
- Modify: `cli/tests/output/formatters.test.ts`

**Step 1: Write the failing tests**

Add to `cli/tests/output/formatters.test.ts`:

```typescript
import {
  // ... existing imports
  formatTokens,
} from '../../src/output/formatters.js';

describe('formatTokens', () => {
  it('returns raw number for values under 1000', () => {
    expect(formatTokens(450)).toBe('450');
  });

  it('formats thousands with one decimal', () => {
    expect(formatTokens(2100)).toBe('2.1k');
  });

  it('drops .0 for clean thousands', () => {
    expect(formatTokens(3000)).toBe('3k');
  });

  it('formats large token counts', () => {
    expect(formatTokens(17900)).toBe('17.9k');
  });

  it('formats millions', () => {
    expect(formatTokens(1234567)).toBe('1.2M');
  });

  it('returns 0 for zero', () => {
    expect(formatTokens(0)).toBe('0');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @studio/cli test -- --run tests/output/formatters.test.ts`
Expected: FAIL — `formatTokens` is not exported

**Step 3: Write minimal implementation**

Add to `cli/src/output/formatters.ts`:

```typescript
/**
 * Formats a token count into a compact human-readable string.
 * 450 → "450", 2100 → "2.1k", 17900 → "17.9k", 1234567 → "1.2M"
 */
export function formatTokens(count: number): string {
  if (count === 0) return '0';
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const k = count / 1000;
    return k % 1 === 0 ? `${k}k` : `${parseFloat(k.toFixed(1))}k`;
  }
  const m = count / 1_000_000;
  return m % 1 === 0 ? `${m}M` : `${parseFloat(m.toFixed(1))}M`;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @studio/cli test -- --run tests/output/formatters.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add cli/src/output/formatters.ts cli/tests/output/formatters.test.ts
git commit -m "feat(cli): add formatTokens() compact token formatter"
```

---

### Task 3: Add `formatStageLine()` helper (TDD)

**Files:**
- Modify: `cli/src/output/formatters.ts`
- Modify: `cli/tests/output/formatters.test.ts`

**Step 1: Write the failing tests**

Add to `cli/tests/output/formatters.test.ts`:

```typescript
import {
  // ... existing imports
  formatStageLine,
} from '../../src/output/formatters.js';

describe('formatStageLine', () => {
  it('fills dots between name and suffix to fixed width', () => {
    const line = formatStageLine('[1/4]', 'brief-analysis', '✓ done');
    // Should have dots between "brief-analysis" and "✓ done"
    expect(line).toContain('[1/4] brief-analysis');
    expect(line).toContain('✓ done');
    expect(line).toMatch(/brief-analysis\s*\.{2,}\s*✓ done/);
  });

  it('produces consistent alignment regardless of name length', () => {
    const short = formatStageLine('[1/4]', 'qa-review', '✓');
    const long = formatStageLine('[2/4]', 'implementation-plan', '✓');
    // Both lines should have the suffix starting at the same column
    const shortDotEnd = short.indexOf('✓');
    const longDotEnd = long.indexOf('✓');
    expect(shortDotEnd).toBe(longDotEnd);
  });

  it('handles very long stage names by using minimum dots', () => {
    const line = formatStageLine('[1/4]', 'a-very-long-stage-name-that-exceeds-normal', '✓');
    // Should still have at least 2 dots
    expect(line).toMatch(/\.{2,}/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @studio/cli test -- --run tests/output/formatters.test.ts`
Expected: FAIL — `formatStageLine` is not exported

**Step 3: Write minimal implementation**

Add to `cli/src/output/formatters.ts`:

```typescript
const STAGE_LINE_WIDTH = 42;

/**
 * Formats a stage progress line with dot-filling for alignment.
 * formatStageLine("[1/4]", "brief-analysis", "✓ (12s, 2.1k tokens)")
 * → "[1/4] brief-analysis ............ ✓ (12s, 2.1k tokens)"
 */
export function formatStageLine(prefix: string, name: string, suffix: string): string {
  const left = `${prefix} ${name} `;
  const dotsNeeded = Math.max(2, STAGE_LINE_WIDTH - left.length);
  const dots = '.'.repeat(dotsNeeded);
  return `${left}${dots} ${suffix}`;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @studio/cli test -- --run tests/output/formatters.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add cli/src/output/formatters.ts cli/tests/output/formatters.test.ts
git commit -m "feat(cli): add formatStageLine() dot-filled stage line formatter"
```

---

### Task 4: Add `countWriteFiles()` helper (TDD)

**Files:**
- Modify: `cli/src/output/formatters.ts`
- Modify: `cli/tests/output/formatters.test.ts`

**Step 1: Write the failing tests**

```typescript
import {
  // ... existing imports
  countWriteFiles,
} from '../../src/output/formatters.js';

describe('countWriteFiles', () => {
  it('returns 0 when no tool calls', () => {
    expect(countWriteFiles([])).toBe(0);
  });

  it('counts write_file tool calls', () => {
    const calls: ToolCallSummary[] = [
      { name: 'repo_manager-write_file', arguments_summary: 'a.ts' },
      { name: 'repo_manager-read_file', arguments_summary: 'b.ts' },
      { name: 'repo_manager-write_file', arguments_summary: 'c.ts' },
    ];
    expect(countWriteFiles(calls)).toBe(2);
  });

  it('counts apply_patch tool calls as file writes', () => {
    const calls: ToolCallSummary[] = [
      { name: 'repo_manager-apply_patch', arguments_summary: 'a.ts' },
    ];
    expect(countWriteFiles(calls)).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @studio/cli test -- --run tests/output/formatters.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
/** Counts how many tool calls wrote or patched files. */
export function countWriteFiles(toolCalls: ToolCallSummary[]): number {
  return toolCalls.filter((tc) => {
    const action = toolAction(tc.name);
    return action === 'write_file' || action === 'apply_patch';
  }).length;
}
```

Note: `toolAction()` is already defined as a private function in formatters.ts. Just use it.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @studio/cli test -- --run tests/output/formatters.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add cli/src/output/formatters.ts cli/tests/output/formatters.test.ts
git commit -m "feat(cli): add countWriteFiles() helper for stage summary"
```

---

### Task 5: Update `ProgressDisplay` — quiet mode handlers

**Files:**
- Modify: `cli/src/output/progress.ts`

This is the main change. Update event handlers in `ProgressDisplay.getEvents()` for quiet mode (the default). Live mode stays unchanged.

**Step 1: Add state tracking fields**

Add to the `ProgressDisplay` class:

```typescript
private runId = '';
private currentMaxAttempts = 3;
private currentAttempt = 1;
private currentStageIndex = 0;
private currentTotalStages = 0;
private currentStageName = '';
```

**Step 2: Update `onPipelineStart`**

Store run_id, keep the existing output but move run_id to footer instead:

```typescript
onPipelineStart: (event) => {
  if (this.jsonMode) return;
  this.runId = event.run_id;
  console.log(chalk.blue(`\nRunning pipeline: ${event.pipeline_name}\n`));
},
```

**Step 3: Update `onStageStart`**

Use raw stage name with dots and attempt counter:

```typescript
onStageStart: (event) => {
  if (this.jsonMode) return;
  this.currentStageIndex = event.stage_index;
  this.currentTotalStages = event.total_stages;
  this.currentStageName = event.stage_name;
  this.currentMaxAttempts = event.max_attempts;
  this.currentAttempt = 1;
  const prefix = `[${event.stage_index + 1}/${event.total_stages}]`;
  const suffix = `(attempt ${this.currentAttempt}/${this.currentMaxAttempts})`;
  this.spinnerText = formatStageLine(prefix, event.stage_name, suffix);
  if (this.live) {
    console.log(chalk.cyan(`${formatStageLine(prefix, event.stage_name, '')}...`));
    this.thinkingSpinner = ora({ text: chalk.dim('Thinking...'), indent: 2, color: 'gray' }).start();
  } else {
    this.spinner = ora({ text: this.spinnerText, color: 'cyan' }).start();
  }
},
```

**Step 4: Update `onStageComplete`**

Show tokens and file count inline:

```typescript
onStageComplete: (event) => {
  if (this.jsonMode) return;

  const duration = formatDuration(event.duration_ms);
  const prefix = `[${event.stage_index + 1}/${event.total_stages}]`;

  // Build compact info parts: duration, tokens, files
  const infoParts: string[] = [duration];
  if (event.token_usage && event.token_usage.total_tokens > 0) {
    infoParts.push(`${formatTokens(event.token_usage.total_tokens)} tokens`);
  }
  const filesWritten = event.tool_calls ? countWriteFiles(event.tool_calls) : 0;
  if (filesWritten > 0) {
    infoParts.push(`${filesWritten} file${filesWritten !== 1 ? 's' : ''}`);
  }

  if (this.live) {
    // Live mode: keep existing behavior (thinking spinner, etc.)
    if (this.isStreamingTokens) { process.stdout.write('\n'); this.isStreamingTokens = false; }
    this.thinkingSpinner?.stop();
    this.thinkingSpinner = null;
    if (event.status === 'success') {
      console.log(chalk.green(`  ✓`) + chalk.gray(` (${infoParts.join(', ')})`));
    } else if (event.status === 'rejected') {
      console.log(chalk.red(`  ✗ rejected`) + chalk.gray(` (${duration})`));
      if (event.rejection_reason) console.log(chalk.red(`    ${event.rejection_reason}`));
      if (event.rejection_details?.length) {
        for (const detail of event.rejection_details) {
          console.log(chalk.yellow(`      - ${detail}`));
        }
      }
    } else {
      console.log(chalk.red(`  ✗ failed`) + chalk.gray(` (${infoParts.join(', ')})`));
    }
  } else if (event.status === 'success') {
    this.spinner?.succeed(
      formatStageLine(prefix, event.stage_name, chalk.green('✓') + chalk.gray(` (${infoParts.join(', ')})`))
    );
  } else if (event.status === 'rejected') {
    this.spinner?.fail(
      formatStageLine(prefix, event.stage_name, chalk.red('✗ rejected') + chalk.gray(` (${duration})`))
    );
    if (event.rejection_reason) console.log(chalk.red(`  ${event.rejection_reason}`));
    if (event.rejection_details?.length) {
      for (const detail of event.rejection_details) {
        console.log(chalk.yellow(`    - ${detail}`));
      }
    }
  } else {
    this.spinner?.fail(
      formatStageLine(prefix, event.stage_name, chalk.red('✗ failed') + chalk.gray(` (${infoParts.join(', ')})`))
    );
  }
  this.spinner = null;

  // Tool call summary: quiet + verbose only (in live mode, each was shown individually)
  if (!this.live && event.tool_calls && event.tool_calls.length > 0) {
    const summary = summarizeToolCalls(event.tool_calls);
    if (summary) console.log(chalk.gray(`  ${summary}`));
  }

  // Output summary: all modes
  if (event.status !== 'rejected' && event.output) {
    const summary = summarizeOutput(event.output);
    if (summary) console.log(chalk.gray(`  ${summary}`));
  }

  // Verbose extras stay the same (JSON dump, token breakdown)
  if (this.verbose && event.output) {
    console.log(chalk.gray('  Output:'));
    const json = JSON.stringify(event.output, null, 2);
    const lines = json.split('\n');
    for (const line of lines.slice(0, 20)) {
      console.log(chalk.gray(`    ${line}`));
    }
    if (lines.length > 20) {
      console.log(chalk.gray(`    ... (${lines.length - 20} more lines)`));
    }
  }
  if (this.verbose && event.token_usage) {
    const u = event.token_usage;
    console.log(chalk.gray(`  Tokens: ${u.prompt_tokens} prompt + ${u.completion_tokens} completion = ${u.total_tokens} total`));
  }
},
```

**Step 5: Update `onTaskRetry`**

Inline retry format — fail the spinner, start a new one:

```typescript
onTaskRetry: (event) => {
  if (this.jsonMode) return;
  if (this.isStreamingTokens) { process.stdout.write('\n'); this.isStreamingTokens = false; }
  this.toolSpinner?.stop(); this.toolSpinner = null;
  this.thinkingSpinner?.stop(); this.thinkingSpinner = null;

  this.currentAttempt = event.attempt + 1;
  const prefix = `[${this.currentStageIndex + 1}/${this.currentTotalStages}]`;

  // Fail the current spinner with the retry reason
  const reason = event.failures.length > 0 ? event.failures[0] : 'validation failed';
  if (this.live) {
    console.log(chalk.yellow(`  ✗ retry (${reason})`));
  } else {
    this.spinner?.fail(
      formatStageLine(prefix, this.currentStageName, chalk.yellow(`✗ retry`) + chalk.gray(` (${reason})`))
    );
    this.spinner = null;
  }

  // Verbose extras
  if (this.verbose && event.failures.length > 1) {
    for (const failure of event.failures.slice(1)) {
      console.log(chalk.yellow(`    - ${failure}`));
    }
  }
  if (this.verbose && event.agent_output_raw) {
    console.log(chalk.gray(`    Raw response: ${event.agent_output_raw.slice(0, 300)}`));
  }

  // Start a new spinner for the next attempt
  if (!this.live) {
    const suffix = `(attempt ${this.currentAttempt}/${event.max_attempts})`;
    this.spinnerText = formatStageLine(prefix, this.currentStageName, suffix);
    this.spinner = ora({ text: this.spinnerText, color: 'cyan' }).start();
  }
},
```

**Step 6: Update `onPipelineComplete`**

Merge tokens inline, add run ID footer:

```typescript
onPipelineComplete: (event) => {
  if (this.jsonMode) return;

  console.log('');
  const duration = formatDuration(event.duration_ms);
  const tokenStr = event.total_tokens > 0 ? `, ${formatTokens(event.total_tokens)} tokens total` : '';

  if (event.status === 'success') {
    console.log(chalk.green(`✓ Pipeline completed`) + chalk.gray(` (${duration}${tokenStr})`));
  } else if (event.status === 'rejected') {
    console.log(chalk.red(`✗ Pipeline rejected`) + chalk.gray(` (${duration}${tokenStr})`));
  } else {
    console.log(chalk.red(`✗ Pipeline failed`) + chalk.gray(` (${duration}${tokenStr})`));
  }

  console.log('');
  console.log(chalk.gray(`Run ID: ${this.runId}`));
  console.log(chalk.gray(`View details: studio status ${this.runId}`));
},
```

**Step 7: Add imports**

At the top of `cli/src/output/progress.ts`, update the import from formatters:

```typescript
import { humanReadableStageName, summarizeToolCalls, summarizeOutput, getToolIcon, summarizeToolParams, summarizeToolResult, formatTokens, formatStageLine, countWriteFiles } from './formatters.js';
```

**Step 8: Build to verify**

Run: `pnpm build`
Expected: PASS

**Step 9: Commit**

```bash
git add cli/src/output/progress.ts
git commit -m "feat(cli): update ProgressDisplay for polished stage output format"
```

---

### Task 6: Update `run.ts` — input confirmation + remove `formatResult`

**Files:**
- Modify: `cli/src/commands/run.ts`

**Step 1: Add "✓ Input collected" after input resolution**

After the input resolution block (around line 244), add:

```typescript
if (!options.json) {
  console.log(chalk.green('\n✓ Input collected\n'));
}
```

This goes right after the `else` block that throws `'Error: --input or --input-file is required'` — after all input paths converge.

**Step 2: Remove `formatResult()` call**

In `run.ts:391-395`, the current code calls `formatResult(result)` after the engine finishes. Remove this block since `ProgressDisplay` now shows everything:

Before:
```typescript
if (options.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  formatResult(result);
}
```

After:
```typescript
if (options.json) {
  console.log(JSON.stringify(result, null, 2));
}
```

Also remove the unused import of `formatResult` from the top of the file.

**Step 3: Build to verify**

Run: `pnpm build`
Expected: PASS

**Step 4: Commit**

```bash
git add cli/src/commands/run.ts
git commit -m "feat(cli): add input confirmation, remove duplicate formatResult summary"
```

---

### Task 7: Update `mergeEvents` logger for `max_attempts`

**Files:**
- Modify: `cli/src/commands/run.ts:92-102` (onStageStart handler in mergeEvents)
- Modify: `cli/src/commands/run.ts:135-144` (onTaskRetry handler in mergeEvents)

**Step 1: Log `max_attempts` in onStageStart**

```typescript
onStageStart: (e) => {
  totalStages = e.total_stages;
  progressEvents.onStageStart?.(e);
  logger.log({
    event: 'stage_start',
    run_id: undefined,
    stage: e.stage_name,
    stage_index: e.stage_index,
    total_stages: e.total_stages,
    max_attempts: e.max_attempts,
  });
},
```

**Step 2: Log `max_attempts` in onTaskRetry**

Replace the hardcoded `max_attempts: 5` with the real value:

```typescript
onTaskRetry: (e) => {
  progressEvents.onTaskRetry?.(e);
  logger.log({
    event: 'stage_retry',
    run_id: undefined,
    stage: e.stage,
    attempt: e.attempt,
    max_attempts: e.max_attempts,
    failure_reason: e.failures?.length ? e.failures[0] : undefined,
  });
},
```

**Step 3: Commit**

```bash
git add cli/src/commands/run.ts
git commit -m "fix(cli): log real max_attempts instead of hardcoded value"
```

---

### Task 8: Update existing tests

**Files:**
- Modify: `cli/tests/output/progress-spinner.test.ts`
- Modify: `cli/tests/formatter.test.ts`

**Step 1: Update `stageStartEvent` helper in progress-spinner.test.ts**

The helper needs `max_attempts` now:

```typescript
function stageStartEvent(n = 1, total = 3) {
  return { stage_name: 'code-generation', stage_index: n - 1, total_stages: total, max_attempts: 3 };
}
```

**Step 2: Update `formatResult` tests in formatter.test.ts**

Since `formatResult` is no longer called from `run.ts`, but the function still exists (it may be used elsewhere or kept for `studio status`), keep the tests but verify they still pass. If `formatResult` is removed entirely, delete its tests too.

Decision: Keep `formatResult` and its tests — it's still useful for `studio status` command output. Only remove the call from `run.ts`.

**Step 3: Run all CLI tests**

Run: `pnpm --filter @studio/cli test`
Expected: PASS

**Step 4: Run full build**

Run: `pnpm build`
Expected: PASS

**Step 5: Commit**

```bash
git add cli/tests/output/progress-spinner.test.ts
git commit -m "test(cli): update progress spinner tests for max_attempts field"
```

---

### Task 9: Final verification

**Step 1: Run all tests across the monorepo**

Run: `pnpm test`
Expected: PASS for all packages (contracts, ralph, runner, engine, cli)

**Step 2: Run a mock pipeline to verify output**

Run: `pnpm --filter @studio/cli build && node cli/dist/index.js run feature-builder --provider mock`
(Assuming a mock.yaml exists in a test .studio/ directory)

Visually verify the output matches the target UX from the issue.

**Step 3: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix(cli): fixups from manual verification"
```

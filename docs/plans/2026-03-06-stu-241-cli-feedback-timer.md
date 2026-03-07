# STU-241 — CLI feedback timer + streaming visible — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a real-time elapsed timer to CLI stage spinners so users know a long-running stage is alive.

**Architecture:** Add `stageStartTime` + `timerInterval` state to `ProgressDisplay`. In non-live mode, `setInterval` updates the ora spinner text every second. In live mode, `setInterval` updates the `thinkingSpinner` text, restarting with accumulated time after tool calls.

**Tech Stack:** TypeScript, `ora` (already used), `vitest` with `vi.useFakeTimers()` for timer tests.

---

### Task 1: Timer utilities — add state + private methods to ProgressDisplay

**Files:**
- Modify: `cli/src/output/progress.ts`
- Test: `cli/tests/output/progress-timer.test.ts` (create)

The test file needs to mock `ora` exactly like the existing `progress-spinner.test.ts` does.

**Step 1: Write the failing test**

Create `cli/tests/output/progress-timer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockOraInstance = {
  start: vi.fn().mockReturnThis(),
  stop: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  text: '',
};
vi.mock('ora', () => ({ default: vi.fn(() => mockOraInstance) }));

import { ProgressDisplay } from '../../src/output/progress.js';

describe('ProgressDisplay — timer utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears timer idempotently (no error if called twice)', () => {
    const d = new ProgressDisplay(false, 'quiet');
    // Access private method via cast
    const p = d as unknown as { clearTimer(): void };
    expect(() => {
      p.clearTimer();
      p.clearTimer();
    }).not.toThrow();
  });

  it('startTimer calls updateFn with elapsed seconds after each tick', () => {
    const d = new ProgressDisplay(false, 'quiet');
    const p = d as unknown as {
      startTimer(fn: (s: string) => void): void;
      clearTimer(): void;
    };
    const calls: string[] = [];
    p.startTimer((s) => calls.push(s));

    vi.advanceTimersByTime(1000);
    expect(calls[0]).toBe('1s');

    vi.advanceTimersByTime(2000);
    expect(calls[2]).toBe('3s');

    p.clearTimer();
  });

  it('clearTimer stops the interval (no more updateFn calls after clear)', () => {
    const d = new ProgressDisplay(false, 'quiet');
    const p = d as unknown as {
      startTimer(fn: (s: string) => void): void;
      clearTimer(): void;
    };
    const calls: string[] = [];
    p.startTimer((s) => calls.push(s));
    vi.advanceTimersByTime(2000);
    p.clearTimer();
    const countAfterClear = calls.length;
    vi.advanceTimersByTime(5000);
    expect(calls.length).toBe(countAfterClear);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /path/to/.worktrees/stu-241-cli-feedback-timer
pnpm --filter @studio/cli test -- --run tests/output/progress-timer.test.ts 2>&1 | tail -20
```

Expected: FAIL — `clearTimer is not a function` or similar.

**Step 3: Add timer state + private methods to `progress.ts`**

Add these two fields to the class (after `private isStreamingTokens = false;` on line 13):

```typescript
private stageStartTime = 0;
private timerInterval: ReturnType<typeof setInterval> | null = null;
```

Add these two private methods after the `constructor` block (after line 37):

```typescript
private startTimer(updateFn: (elapsed: string) => void): void {
  this.stageStartTime = Date.now();
  this.timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - this.stageStartTime) / 1000);
    updateFn(`${s}s`);
  }, 1000);
}

private clearTimer(): void {
  if (this.timerInterval) {
    clearInterval(this.timerInterval);
    this.timerInterval = null;
  }
}

private elapsedSeconds(): number {
  return Math.floor((Date.now() - this.stageStartTime) / 1000);
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @studio/cli test -- --run tests/output/progress-timer.test.ts 2>&1 | tail -20
```

Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add cli/src/output/progress.ts cli/tests/output/progress-timer.test.ts
git commit -m "feat(cli): add timer utilities to ProgressDisplay [STU-241]"
```

---

### Task 2: Timer in non-live mode

Update the non-live mode spinner to show elapsed seconds.

**Files:**
- Modify: `cli/src/output/progress.ts`
- Modify: `cli/tests/output/progress-timer.test.ts`

**Step 1: Write the failing test**

Add this `describe` block to `progress-timer.test.ts`:

```typescript
function makeQuietDisplay() {
  return new ProgressDisplay(false, 'quiet');
}

function stageStartEvent(n = 1, total = 3) {
  return { stage_name: 'entity-extraction', stage_index: n - 1, total_stages: total, max_attempts: 3 };
}

describe('ProgressDisplay — timer in non-live mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates spinner text with elapsed seconds every second', () => {
    const d = makeQuietDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());

    vi.advanceTimersByTime(5000);

    // spinner.text should have been updated with (5s)
    expect(mockOraInstance.text).toContain('5s');
  });

  it('clears timer on onStageComplete', () => {
    const d = makeQuietDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.advanceTimersByTime(3000);

    events.onStageComplete!({
      stage_name: 'entity-extraction', stage_index: 0, total_stages: 3,
      status: 'success', attempts: 1, duration_ms: 3000,
    });

    // timer is stopped — advancing further should not update text
    const textAfterComplete = mockOraInstance.text;
    vi.advanceTimersByTime(5000);
    // text should not have changed to (8s) etc
    expect(mockOraInstance.text).toBe(textAfterComplete);
  });

  it('clears timer on onTaskRetry', () => {
    const d = makeQuietDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.advanceTimersByTime(2000);

    events.onTaskRetry!({ stage: 'entity-extraction', attempt: 2, max_attempts: 3, failures: ['missing field'] });

    const textAfterRetry = mockOraInstance.text;
    vi.advanceTimersByTime(5000);
    expect(mockOraInstance.text).toBe(textAfterRetry);
  });

  it('clears timer on interrupt()', () => {
    const d = makeQuietDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.advanceTimersByTime(2000);

    d.interrupt();

    const textAfterInterrupt = mockOraInstance.text;
    vi.advanceTimersByTime(5000);
    expect(mockOraInstance.text).toBe(textAfterInterrupt);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @studio/cli test -- --run tests/output/progress-timer.test.ts 2>&1 | tail -20
```

Expected: FAIL — timer not started, `mockOraInstance.text` not updated.

**Step 3: Modify `onStageStart` in non-live branch**

In `progress.ts`, find the `onStageStart` handler. The non-live branch currently looks like (lines 71–75):

```typescript
} else {
  const suffix = `(attempt ${this.currentAttempt}/${this.currentMaxAttempts})`;
  this.spinnerText = formatStageLine(prefix, event.stage_name, suffix);
  this.spinner = ora({ text: this.spinnerText, color: 'cyan' }).start();
}
```

Replace with:

```typescript
} else {
  this.spinnerText = formatStageLine(prefix, event.stage_name, '');
  this.spinner = ora({ text: this.spinnerText, color: 'cyan' }).start();
  this.startTimer((elapsed) => {
    if (this.spinner) {
      this.spinner.text = formatStageLine(prefix, event.stage_name, `(${elapsed})`);
    }
  });
}
```

**Step 4: Add `clearTimer()` calls to the non-live exits**

In `onStageComplete`, before `this.spinner = null` (after the succeed/fail calls), add `this.clearTimer()`:

```typescript
// After the succeed/fail spinner calls, before the null assignment:
this.clearTimer();
this.spinner = null;
```

In `onTaskRetry`, add `this.clearTimer()` as the very **first** line of the handler (before the existing `if (this.isStreamingTokens)` check):

```typescript
onTaskRetry: (event) => {
  if (this.jsonMode) return;
  this.clearTimer();  // ← add this line
  // ... rest of existing code
```

In `interrupt()`, add `this.clearTimer()` as the first line:

```typescript
interrupt(): void {
  this.clearTimer();  // ← add this line
  if (this.isStreamingTokens) {
  // ... rest of existing code
```

**Step 5: Run test to verify it passes**

```bash
pnpm --filter @studio/cli test -- --run tests/output/progress-timer.test.ts 2>&1 | tail -20
```

Expected: PASS.

**Step 6: Run full test suite to check no regressions**

```bash
pnpm --filter @studio/cli test -- --run 2>&1 | tail -10
```

Expected: all passing, 0 failures.

**Step 7: Commit**

```bash
git add cli/src/output/progress.ts cli/tests/output/progress-timer.test.ts
git commit -m "feat(cli): timer in non-live spinner — updates every second [STU-241]"
```

---

### Task 3: Timer in live mode (thinkingSpinner)

Update the `thinkingSpinner` to show elapsed time, and show "from Xs" when it restarts after a tool call.

**Files:**
- Modify: `cli/src/output/progress.ts`
- Modify: `cli/tests/output/progress-timer.test.ts`

**Step 1: Write the failing test**

Add this `describe` block to `progress-timer.test.ts`:

```typescript
function makeLiveDisplay() {
  return new ProgressDisplay(false, 'live');
}

function toolCallStartEvent() {
  return { tool: 'repo_manager-write_file', params: { path: 'out.json' }, timestamp: Date.now() };
}

function toolCallCompleteEvent() {
  return { tool: 'repo_manager-write_file', result: 'ok', duration_ms: 100, timestamp: Date.now() };
}

describe('ProgressDisplay — timer in live mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('thinkingSpinner text includes elapsed seconds', () => {
    const d = makeLiveDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());

    vi.advanceTimersByTime(7000);

    // The thinkingSpinner text should contain (7s)
    expect(mockOraInstance.text).toContain('7s');
  });

  it('after tool call, thinkingSpinner shows accumulated time', () => {
    const d = makeLiveDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.advanceTimersByTime(10000); // 10s thinking
    events.onToolCallStart!(toolCallStartEvent());
    vi.advanceTimersByTime(2000); // 2s tool call
    events.onToolCallComplete!(toolCallCompleteEvent());

    // Spinner restarts — should show "from 12s" (accumulated)
    expect(mockOraInstance.text).toContain('from 12s');
  });

  it('clears timer on onStageComplete in live mode', () => {
    const d = makeLiveDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.advanceTimersByTime(5000);

    events.onStageComplete!({
      stage_name: 'entity-extraction', stage_index: 0, total_stages: 3,
      status: 'success', attempts: 1, duration_ms: 5000,
    });

    const textAfter = mockOraInstance.text;
    vi.advanceTimersByTime(5000);
    expect(mockOraInstance.text).toBe(textAfter);
  });

  it('clears timer on onTaskRetry in live mode', () => {
    const d = makeLiveDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.advanceTimersByTime(3000);

    events.onTaskRetry!({ stage: 'entity-extraction', attempt: 2, max_attempts: 3, failures: ['missing field'] });

    const textAfter = mockOraInstance.text;
    vi.advanceTimersByTime(5000);
    expect(mockOraInstance.text).toBe(textAfter);
  });

  it('clears timer on onAgentToken (before tokens stream)', () => {
    const d = makeLiveDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.advanceTimersByTime(3000);

    // Timer should stop when tokens start
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    events.onAgentToken!({ token: 'Hello', stage: 'entity-extraction', timestamp: Date.now() });
    writeSpy.mockRestore();

    const textAfterToken = mockOraInstance.text;
    vi.advanceTimersByTime(5000);
    expect(mockOraInstance.text).toBe(textAfterToken);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @studio/cli test -- --run tests/output/progress-timer.test.ts 2>&1 | tail -20
```

Expected: FAIL.

**Step 3: Modify `onStageStart` in live branch**

Current live branch (lines 68–70):

```typescript
if (this.live) {
  console.log(chalk.cyan(`${formatStageLine(prefix, event.stage_name, '')}...`));
  this.thinkingSpinner = ora({ text: chalk.dim('Thinking...'), indent: 2, color: 'gray' }).start();
}
```

Replace with:

```typescript
if (this.live) {
  console.log(chalk.cyan(`${formatStageLine(prefix, event.stage_name, '')}...`));
  this.thinkingSpinner = ora({ text: chalk.dim('Thinking... (0s)'), indent: 2, color: 'gray' }).start();
  this.startTimer((elapsed) => {
    if (this.thinkingSpinner) {
      this.thinkingSpinner.text = chalk.dim(`Thinking... (${elapsed})`);
    }
  });
}
```

**Step 4: Modify `onAgentToken` to clear timer before stopping spinner**

Current handler (lines 254–263):

```typescript
onAgentToken: (event) => {
  if (this.jsonMode || !this.live) return;
  if (this.thinkingSpinner) {
    this.thinkingSpinner.stop();
    this.thinkingSpinner = null;
    process.stdout.write('  ');
  }
  this.isStreamingTokens = true;
  process.stdout.write(chalk.dim(event.token));
},
```

Add `this.clearTimer()` before the spinner stop:

```typescript
onAgentToken: (event) => {
  if (this.jsonMode || !this.live) return;
  if (this.thinkingSpinner) {
    this.clearTimer();
    this.thinkingSpinner.stop();
    this.thinkingSpinner = null;
    process.stdout.write('  ');
  }
  this.isStreamingTokens = true;
  process.stdout.write(chalk.dim(event.token));
},
```

**Step 5: Modify `onToolCallStart` to clear timer**

Current handler (lines 265–281). Add `this.clearTimer()` right after the `if (this.isStreamingTokens)` block and before `this.thinkingSpinner?.stop()`:

```typescript
onToolCallStart: (event) => {
  if (this.jsonMode || !this.live) return;
  if (this.isStreamingTokens) {
    process.stdout.write('\n');
    this.isStreamingTokens = false;
  }
  this.clearTimer();          // ← add this line
  this.thinkingSpinner?.stop();
  this.thinkingSpinner = null;
  // ... rest unchanged
```

**Step 6: Modify `onToolCallComplete` to restart spinner with accumulated time**

Current handler restarts the thinking spinner (line 303):

```typescript
this.thinkingSpinner = ora({ text: chalk.dim('Thinking...'), indent: 2, color: 'gray' }).start();
```

Replace with:

```typescript
const fromSec = this.elapsedSeconds();
this.thinkingSpinner = ora({ text: chalk.dim(`Thinking... (from ${fromSec}s)`), indent: 2, color: 'gray' }).start();
this.startTimer((elapsed) => {
  if (this.thinkingSpinner) {
    this.thinkingSpinner.text = chalk.dim(`Thinking... (from ${elapsed})`);
  }
});
```

Note: `startTimer` resets `stageStartTime`, so the "from Xs" label is set once at restart, but the timer continues counting from stage start. To keep the total elapsed time accurate, **do not reset `stageStartTime`** — instead, store the elapsed at restart and offset:

Actually, to keep it simple and correct: `startTimer` always sets `stageStartTime = Date.now()`. For the "from" label, use the elapsed captured at the moment of `onToolCallComplete`. Change `onToolCallComplete` to:

```typescript
const fromSec = this.elapsedSeconds();           // elapsed so far (before restart)
const restartTime = Date.now();                  // new zero point for countdown
this.thinkingSpinner = ora({
  text: chalk.dim(`Thinking... (from ${fromSec}s)`),
  indent: 2,
  color: 'gray',
}).start();
// Start a new interval from the restart point, but display total from stage start
this.timerInterval = setInterval(() => {
  const totalSec = Math.floor((Date.now() - this.stageStartTime) / 1000);
  if (this.thinkingSpinner) {
    this.thinkingSpinner.text = chalk.dim(`Thinking... (from ${totalSec}s)`);
  }
}, 1000);
_ = restartTime; // suppress unused var
```

Wait, this is getting complicated. Simpler approach: `startTimer` should NOT reset `stageStartTime`. Rename to separate concerns:

```typescript
private startTimer(updateFn: (elapsed: string) => void): void {
  // Only reset stageStartTime on first call (onStageStart)
  this.timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - this.stageStartTime) / 1000);
    updateFn(`${s}s`);
  }, 1000);
}
```

And have a separate `resetStageTimer()` that sets `stageStartTime`:

```typescript
private resetStageTimer(): void {
  this.stageStartTime = Date.now();
}
```

Call `resetStageTimer()` once in `onStageStart`. `startTimer` just starts the interval without touching `stageStartTime`.

Full corrected implementation for Task 1 methods:

```typescript
private resetStageTimer(): void {
  this.stageStartTime = Date.now();
}

private startTimer(updateFn: (elapsed: string) => void): void {
  this.timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - this.stageStartTime) / 1000);
    updateFn(`${s}s`);
  }, 1000);
}

private clearTimer(): void {
  if (this.timerInterval) {
    clearInterval(this.timerInterval);
    this.timerInterval = null;
  }
}

private elapsedSeconds(): number {
  return Math.floor((Date.now() - this.stageStartTime) / 1000);
}
```

In `onStageStart`, call both `this.resetStageTimer()` then `this.startTimer(...)`.

In `onToolCallComplete`, call `this.clearTimer()` first, then `this.startTimer(...)` (reuses stageStartTime which hasn't changed — so elapsed keeps counting correctly from stage start).

This is the correct approach. **Update the Task 1 test** to reflect `resetStageTimer` instead of `startTimer` resetting time:

```typescript
it('startTimer calls updateFn with elapsed seconds after each tick', () => {
  const d = new ProgressDisplay(false, 'quiet');
  const p = d as unknown as {
    resetStageTimer(): void;
    startTimer(fn: (s: string) => void): void;
    clearTimer(): void;
  };
  const calls: string[] = [];
  p.resetStageTimer();
  p.startTimer((s) => calls.push(s));

  vi.advanceTimersByTime(1000);
  expect(calls[0]).toBe('1s');

  vi.advanceTimersByTime(2000);
  expect(calls[2]).toBe('3s');

  p.clearTimer();
});
```

So `onToolCallComplete` becomes:

```typescript
this.clearTimer();
const fromSec = this.elapsedSeconds();
this.thinkingSpinner = ora({
  text: chalk.dim(`Thinking... (from ${fromSec}s)`),
  indent: 2,
  color: 'gray',
}).start();
this.startTimer((elapsed) => {
  if (this.thinkingSpinner) {
    this.thinkingSpinner.text = chalk.dim(`Thinking... (from ${elapsed})`);
  }
});
```

This correctly shows `from 12s` (total elapsed from stage start) and keeps updating with total elapsed.

**Step 7: Run test to verify it passes**

```bash
pnpm --filter @studio/cli test -- --run tests/output/progress-timer.test.ts 2>&1 | tail -20
```

Expected: all timer tests PASS.

**Step 8: Run full test suite**

```bash
pnpm --filter @studio/cli test -- --run 2>&1 | tail -10
```

Expected: all passing.

**Step 9: Commit**

```bash
git add cli/src/output/progress.ts cli/tests/output/progress-timer.test.ts
git commit -m "feat(cli): timer in live mode thinking spinner + 'from Xs' on restart [STU-241]"
```

---

### Task 4: Build, verify, and PR

**Step 1: Build the full monorepo**

```bash
cd /path/to/.worktrees/stu-241-cli-feedback-timer
pnpm build 2>&1 | tail -10
```

Expected: clean build, no TypeScript errors.

**Step 2: Run full test suite one last time**

```bash
pnpm test 2>&1 | tail -15
```

Expected: all tests passing, 0 failures.

**Step 3: Push and create PR**

```bash
git push -u origin arianedguay/stu-241-cli-feedback-timer-en-temps-reel-streaming-visible-sur
gh pr create \
  --title "feat(cli): real-time timer on stage spinners [STU-241]" \
  --body "$(cat <<'EOF'
## What

Adds a real-time elapsed timer to CLI stage spinners so users know long-running stages are alive.

## Why

On pipelines with 40-90s stages, the spinner showed no feedback — users couldn't tell if the pipeline was progressing or stuck.

## Changes

- `cli/src/output/progress.ts` — `ProgressDisplay` gets `stageStartTime`, `timerInterval`, and private helpers `resetStageTimer()`, `startTimer()`, `clearTimer()`, `elapsedSeconds()`
- Non-live mode: spinner updates with `(Xs)` every second
- Live mode: `thinkingSpinner` updates with `Thinking... (Xs)`, restarts with `Thinking... (from Xs)` after tool calls
- Timer is cleared on stage complete, retry, and interrupt (Ctrl+C)

## Packages touched

- `@studio/cli` only — no changes to engine, runner, contracts

## How to test

```bash
studio run <any-pipeline> --input "..." --live   # see Thinking... (7s) → (from 14s)
studio run <any-pipeline> --input "..."          # see (23s) updating on spinner
```
EOF
)" \
  --base main
```

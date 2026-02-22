# STU-101: --verbose flag for --live mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `--live --verbose` display full tool call results and stage outputs without truncation.

**Architecture:** Change `ProgressDisplay` from a tri-state `displayMode` to two independent booleans (`live`, `verbose`). Add `formatToolResult()` to format full tool results. When both flags are active, bypass `summarizeToolResult()` and increase `formatStageOutput` depth.

**Tech Stack:** TypeScript, Vitest, chalk, ora

---

### Task 1: Add `formatToolResult` function with tests

**Files:**
- Modify: `cli/src/output/formatters.ts:137` (after `summarizeToolResult`)
- Modify: `cli/tests/output/formatters.test.ts:199` (after `summarizeToolResult` tests)

**Step 1: Write the failing tests**

Add at the end of `cli/tests/output/formatters.test.ts`:

```typescript
describe('formatToolResult', () => {
  it('formats a plain string with indentation', () => {
    const result = formatToolResult('line1\nline2\nline3');
    expect(result).toBe('  line1\n  line2\n  line3');
  });

  it('formats a single-line string', () => {
    const result = formatToolResult('short result');
    expect(result).toBe('  short result');
  });

  it('extracts .content from read_file-style results', () => {
    const result = formatToolResult({ content: 'file content\nline 2' });
    expect(result).toBe('  file content\n  line 2');
  });

  it('formats arrays as JSON', () => {
    const result = formatToolResult(['a.ts', 'b.ts']);
    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
  });

  it('formats objects without .content as indented JSON', () => {
    const result = formatToolResult({ written: true, path: 'src/app.ts' });
    expect(result).toContain('"written": true');
    expect(result).toContain('"path": "src/app.ts"');
  });

  it('returns "  (error)" for error strings', () => {
    const result = formatToolResult(undefined, 'file not found');
    expect(result).toBe('  (error) file not found');
  });

  it('returns "  (empty)" for null', () => {
    const result = formatToolResult(null);
    expect(result).toBe('  (empty)');
  });

  it('returns "  (empty)" for undefined without error', () => {
    const result = formatToolResult(undefined);
    expect(result).toBe('  (empty)');
  });

  it('formats object with .content as empty string', () => {
    const result = formatToolResult({ content: '' });
    expect(result).toBe('  (empty content)');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd cli && pnpm test -- --run tests/output/formatters.test.ts`
Expected: FAIL — `formatToolResult` is not exported

**Step 3: Write the implementation**

Add in `cli/src/output/formatters.ts` after the `summarizeToolResult` function (after line 137):

```typescript
/**
 * Formats the full result of a tool call for verbose display.
 * Each line is indented with 2 spaces.
 */
export function formatToolResult(result: unknown, error?: string): string {
  if (error) return `  (error) ${error}`;
  if (result === null || result === undefined) return '  (empty)';

  if (typeof result === 'string') {
    return result.split('\n').map(line => `  ${line}`).join('\n');
  }

  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if (typeof obj.content === 'string') {
      if (obj.content.length === 0) return '  (empty content)';
      return obj.content.split('\n').map(line => `  ${line}`).join('\n');
    }
  }

  // Arrays and other objects: indented JSON
  const json = JSON.stringify(result, null, 2);
  return json.split('\n').map(line => `  ${line}`).join('\n');
}
```

**Step 4: Update the import in the test file**

Add `formatToolResult` to the import in `cli/tests/output/formatters.test.ts:4`:

```typescript
import {
  humanReadableStageName,
  summarizeToolCalls,
  getToolIcon,
  summarizeToolParams,
  summarizeToolResult,
  formatStageOutput,
  formatToolResult,
} from '../../src/output/formatters.js';
```

**Step 5: Run tests to verify they pass**

Run: `cd cli && pnpm test -- --run tests/output/formatters.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add cli/src/output/formatters.ts cli/tests/output/formatters.test.ts
git commit -m "feat(cli): add formatToolResult for verbose tool output (STU-101)"
```

---

### Task 2: Refactor ProgressDisplay to use two booleans

**Files:**
- Modify: `cli/src/output/progress.ts` (constructor + properties)
- Modify: `cli/tests/output/progress-spinner.test.ts` (update `makeDisplay` helper)

**Step 1: Write the failing test**

Add a new describe block at the end of `cli/tests/output/progress-spinner.test.ts`:

```typescript
describe('ProgressDisplay — constructor accepts live + verbose booleans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts {live: true, verbose: false} and behaves like live mode', () => {
    const d = new ProgressDisplay(false, { live: true, verbose: false });
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    expect(ora).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Thinking') }));
  });

  it('accepts {live: false, verbose: false} and behaves like quiet mode', () => {
    const d = new ProgressDisplay(false, { live: false, verbose: false });
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    // quiet mode: uses regular spinner, no thinking spinner
    expect(ora).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Thinking') }));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd cli && pnpm test -- --run tests/output/progress-spinner.test.ts`
Expected: FAIL — constructor doesn't accept object

**Step 3: Refactor the constructor**

In `cli/src/output/progress.ts`, change the constructor and properties:

Replace lines 7-24:

```typescript
export class ProgressDisplay {
  private spinner: Ora | null = null;
  private spinnerText = '';
  private toolSpinner: Ora | null = null;
  private thinkingSpinner: Ora | null = null;
  private currentToolText = '';
  private isStreamingTokens = false;

  readonly live: boolean;
  readonly verbose: boolean;

  constructor(
    private jsonMode: boolean,
    mode: 'quiet' | 'verbose' | 'live' | { live: boolean; verbose: boolean }
  ) {
    if (typeof mode === 'string') {
      this.live = mode === 'live';
      this.verbose = mode === 'verbose';
    } else {
      this.live = mode.live;
      this.verbose = mode.verbose;
    }
  }
```

Remove the old `displayMode` field and the two getters (`get verbose()`, `get live()`). All existing references to `this.live` and `this.verbose` continue to work because they are now direct properties.

**Step 4: Run tests to verify they pass**

Run: `cd cli && pnpm test -- --run tests/output/progress-spinner.test.ts`
Expected: ALL PASS (old tests pass because `makeDisplay()` passes `'live'` string, new tests pass with object form)

**Step 5: Commit**

```bash
git add cli/src/output/progress.ts cli/tests/output/progress-spinner.test.ts
git commit -m "refactor(cli): ProgressDisplay accepts live+verbose as independent booleans (STU-101)"
```

---

### Task 3: Update run.ts to pass both flags

**Files:**
- Modify: `cli/src/commands/run.ts:340-345`

**Step 1: Update run.ts**

Replace lines 340-345 in `cli/src/commands/run.ts`:

```typescript
    const progress = new ProgressDisplay(!!options.json, {
      live: !!options.live,
      verbose: !!options.verbose,
    });
```

This removes the warning and the tri-state logic entirely.

**Step 2: Run full CLI test suite**

Run: `cd cli && pnpm test`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add cli/src/commands/run.ts
git commit -m "feat(cli): pass --live and --verbose independently to ProgressDisplay (STU-101)"
```

---

### Task 4: Wire verbose behavior into onToolCallComplete

**Files:**
- Modify: `cli/src/output/progress.ts:249-260` (`onToolCallComplete` handler)
- Modify: `cli/tests/output/progress-spinner.test.ts` (add verbose test)

**Step 1: Write the failing test**

Add to the `ProgressDisplay — constructor accepts live + verbose booleans` describe block in `cli/tests/output/progress-spinner.test.ts`:

```typescript
  it('prints full tool result in live+verbose mode', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = new ProgressDisplay(false, { live: true, verbose: true });
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    events.onToolCallStart!(toolCallStartEvent());
    events.onToolCallComplete!({
      tool: 'repo_manager-read_file',
      result: { content: 'const x = 1;\nconst y = 2;' },
      duration_ms: 50,
      timestamp: Date.now(),
    });
    // Should print full content, not just "2 lines"
    const allOutput = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).toContain('const x = 1;');
    expect(allOutput).toContain('const y = 2;');
    logSpy.mockRestore();
  });

  it('does NOT print full tool result in live-only mode', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = new ProgressDisplay(false, { live: true, verbose: false });
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    events.onToolCallStart!(toolCallStartEvent());
    events.onToolCallComplete!({
      tool: 'repo_manager-read_file',
      result: { content: 'const x = 1;\nconst y = 2;' },
      duration_ms: 50,
      timestamp: Date.now(),
    });
    const allOutput = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).not.toContain('const x = 1;');
    logSpy.mockRestore();
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd cli && pnpm test -- --run tests/output/progress-spinner.test.ts`
Expected: FAIL — verbose tool result not printed

**Step 3: Update onToolCallComplete in progress.ts**

Replace the `onToolCallComplete` handler (lines 249-260) with:

```typescript
      onToolCallComplete: (event) => {
        if (this.jsonMode || !this.live) return;
        const summary = summarizeToolResult(event.result, event.error);
        if (event.error) {
          this.toolSpinner?.fail(chalk.red(`${this.currentToolText} — ${event.error}`));
        } else {
          this.toolSpinner?.succeed(chalk.white(this.currentToolText) + chalk.gray(` → ${summary}`));
        }
        this.toolSpinner = null;

        // Verbose: print full tool result below the spinner line
        if (this.verbose && !event.error) {
          const full = formatToolResult(event.result);
          for (const line of full.split('\n')) {
            console.log(chalk.gray(line));
          }
        }

        // Restart thinking spinner even on error — LLM still processes the result and may retry
        this.thinkingSpinner = ora({ text: chalk.dim('Thinking...'), indent: 2, color: 'gray' }).start();
      },
```

Also add the import for `formatToolResult` at the top of `progress.ts` (line 5):

```typescript
import { humanReadableStageName, summarizeToolCalls, getToolIcon, summarizeToolParams, summarizeToolResult, formatStageOutput, formatToolResult } from './formatters.js';
```

**Step 4: Run tests to verify they pass**

Run: `cd cli && pnpm test -- --run tests/output/progress-spinner.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add cli/src/output/progress.ts cli/tests/output/progress-spinner.test.ts
git commit -m "feat(cli): show full tool results in --live --verbose mode (STU-101)"
```

---

### Task 5: Wire verbose behavior into onStageComplete

**Files:**
- Modify: `cli/src/output/progress.ts:119-133` (`onStageComplete` handler)
- Modify: `cli/tests/output/progress-spinner.test.ts` (add verbose stage output test)

**Step 1: Write the failing test**

Add to the verbose describe block in `cli/tests/output/progress-spinner.test.ts`:

```typescript
  it('shows token breakdown in live+verbose mode', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = new ProgressDisplay(false, { live: true, verbose: true });
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    events.onStageComplete!({
      ...stageCompleteEvent(),
      token_usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    });
    const allOutput = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).toContain('Tokens:');
    expect(allOutput).toContain('1500');
    logSpy.mockRestore();
  });

  it('does NOT show token breakdown in live-only mode', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = new ProgressDisplay(false, { live: true, verbose: false });
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    events.onStageComplete!({
      ...stageCompleteEvent(),
      token_usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    });
    const allOutput = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).not.toContain('Tokens:');
    logSpy.mockRestore();
  });

  it('passes maxDepth Infinity to formatStageOutput in live+verbose mode', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = new ProgressDisplay(false, { live: true, verbose: true });
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    events.onStageComplete!({
      ...stageCompleteEvent(),
      output: { a: { b: { c: { d: { e: 'deep value' } } } } },
    });
    const allOutput = logSpy.mock.calls.map(c => c[0]).join('\n');
    // With Infinity depth, 'deep value' should appear as-is, not as JSON
    expect(allOutput).toContain('deep value');
    expect(allOutput).not.toContain('{"e":"deep value"}');
    logSpy.mockRestore();
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd cli && pnpm test -- --run tests/output/progress-spinner.test.ts`
Expected: FAIL — token breakdown not shown in live+verbose, deep value shown as JSON

**Step 3: Update onStageComplete in progress.ts**

Replace the formatted output + token breakdown section (lines 119-133) with:

```typescript
        // Formatted output: all modes (verbose uses unlimited depth)
        if (event.status !== 'rejected' && event.output && typeof event.output === 'object') {
          const depth = this.verbose ? Infinity : 4;
          const formatted = formatStageOutput(event.output as Record<string, unknown>, depth);
          if (formatted) {
            for (const line of formatted.split('\n')) {
              console.log(chalk.gray(`  ${line}`));
            }
          }
        }

        // Token breakdown: verbose mode (both standalone and live+verbose)
        if (this.verbose && event.token_usage) {
          const u = event.token_usage;
          console.log(chalk.gray(`  Tokens: ${u.prompt_tokens} prompt + ${u.completion_tokens} completion = ${u.total_tokens} total`));
        }
```

**Step 4: Run tests to verify they pass**

Run: `cd cli && pnpm test -- --run tests/output/progress-spinner.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add cli/src/output/progress.ts cli/tests/output/progress-spinner.test.ts
git commit -m "feat(cli): unlimited depth + token breakdown in --live --verbose (STU-101)"
```

---

### Task 6: Full build + test verification

**Step 1: Run full build**

Run: `pnpm build`
Expected: BUILD SUCCESS

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS

**Step 3: Final commit if any lint/type fixes needed**

Only if step 1-2 revealed issues.

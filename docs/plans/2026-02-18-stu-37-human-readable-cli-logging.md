# STU-37 Human-Readable CLI Logging — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace raw JSON / individual tool call listing in the terminal with a human-readable, spinner-based display; keep `--verbose` for the technical format.

**Architecture:** Three pure utility functions (`humanReadableStageName`, `summarizeToolCalls`, `summarizeOutput`) go in a new `cli/src/output/formatters.ts`. `ProgressDisplay` in `progress.ts` gains an `ora` spinner instance, uses those functions for the default view, and falls back to the existing detailed display in `--verbose` mode.

**Tech Stack:** TypeScript, `chalk` (already dep), `ora` (already dep — not yet used), `vitest`.

---

## Current state (what exists)

- `cli/src/output/progress.ts` — `ProgressDisplay` class. On `onStageStart`, uses `process.stdout.write` to print `[1/4] stage-name ........... ` with no newline. On `onStageComplete`, appends status to that line, then prints `output_summary` (raw JSON string, truncated) and each tool call individually.
- `cli/src/output/formatter.ts` — `formatResult()` post-run summary (unchanged by this ticket).
- `ora` is in `package.json` dependencies but is **not yet imported anywhere**.
- There are **no existing test files** in `cli/`.

## What changes

| File | Action |
|------|--------|
| `cli/src/output/formatters.ts` | **Create** — 3 pure helper functions |
| `cli/src/output/formatters.test.ts` | **Create** — unit tests for those functions |
| `cli/src/output/progress.ts` | **Modify** — add spinner, use helpers, keep `--verbose` path |

## Tool name format reminder

Tool names in `ToolCallSummary.name` use hyphens: `repo_manager-read_file`, `repo_manager-write_file`, `shell-run_command`, `search-search_codebase`, `repo_manager-list_files`. The current `progress.ts` splits on `.` (broken) — fix this while adding the grouping logic.

---

## Task 1 — Write failing tests for `formatters.ts`

**Files:**
- Create: `cli/src/output/formatters.test.ts`

**Step 1: Write the test file**

```typescript
// cli/src/output/formatters.test.ts
import { describe, it, expect } from 'vitest';
import {
  humanReadableStageName,
  summarizeToolCalls,
  summarizeOutput,
} from './formatters.js';
import type { ToolCallSummary } from '@studio-foundation/engine';

describe('humanReadableStageName', () => {
  it('maps brief-analysis to Analyzing brief', () => {
    expect(humanReadableStageName('brief-analysis')).toBe('Analyzing brief');
  });

  it('maps implementation-plan to Planning implementation', () => {
    expect(humanReadableStageName('implementation-plan')).toBe('Planning implementation');
  });

  it('maps code-generation to Generating code', () => {
    expect(humanReadableStageName('code-generation')).toBe('Generating code');
  });

  it('maps qa-review to Reviewing', () => {
    expect(humanReadableStageName('qa-review')).toBe('Reviewing');
  });

  it('falls back to title-cased words for unknown names', () => {
    expect(humanReadableStageName('custom-stage')).toBe('Custom Stage');
  });

  it('handles single-word stage names', () => {
    expect(humanReadableStageName('analysis')).toBe('Analysis');
  });
});

describe('summarizeToolCalls', () => {
  it('returns empty string for empty array', () => {
    expect(summarizeToolCalls([])).toBe('');
  });

  it('groups read_file calls', () => {
    const calls: ToolCallSummary[] = [
      { name: 'repo_manager-read_file', arguments_summary: 'src/a.ts' },
      { name: 'repo_manager-read_file', arguments_summary: 'src/b.ts' },
      { name: 'repo_manager-read_file', arguments_summary: 'src/c.ts' },
    ];
    expect(summarizeToolCalls(calls)).toBe('Read 3 files');
  });

  it('groups write_file calls', () => {
    const calls: ToolCallSummary[] = [
      { name: 'repo_manager-write_file', arguments_summary: 'src/a.ts' },
    ];
    expect(summarizeToolCalls(calls)).toBe('Wrote 1 file');
  });

  it('groups mixed tool calls', () => {
    const calls: ToolCallSummary[] = [
      { name: 'repo_manager-read_file', arguments_summary: 'a' },
      { name: 'repo_manager-read_file', arguments_summary: 'b' },
      { name: 'repo_manager-write_file', arguments_summary: 'c' },
      { name: 'shell-run_command', arguments_summary: 'npm test' },
    ];
    expect(summarizeToolCalls(calls)).toBe('Read 2 files, wrote 1 file, ran 1 command');
  });

  it('groups list_files calls', () => {
    const calls: ToolCallSummary[] = [
      { name: 'repo_manager-list_files', arguments_summary: 'src/' },
      { name: 'repo_manager-list_files', arguments_summary: 'tests/' },
    ];
    expect(summarizeToolCalls(calls)).toBe('Listed 2 directories');
  });

  it('handles unknown tool names with a generic label', () => {
    const calls: ToolCallSummary[] = [
      { name: 'custom-do_something', arguments_summary: '' },
    ];
    expect(summarizeToolCalls(calls)).toBe('1 tool call');
  });

  it('groups search calls', () => {
    const calls: ToolCallSummary[] = [
      { name: 'search-search_codebase', arguments_summary: 'useState' },
    ];
    expect(summarizeToolCalls(calls)).toBe('Searched 1 time');
  });
});

describe('summarizeOutput', () => {
  it('returns null for null/undefined', () => {
    expect(summarizeOutput(null)).toBeNull();
    expect(summarizeOutput(undefined)).toBeNull();
  });

  it('returns null for non-object', () => {
    expect(summarizeOutput('hello')).toBeNull();
    expect(summarizeOutput(42)).toBeNull();
  });

  it('prefers the summary field when present', () => {
    const output = { summary: 'Added FAQ section with 3 questions', files_changed: ['src/about.tsx'] };
    expect(summarizeOutput(output)).toBe('Added FAQ section with 3 questions');
  });

  it('truncates long summary strings', () => {
    const long = 'x'.repeat(200);
    expect(summarizeOutput({ summary: long })).toHaveLength(153); // 150 + '...'
  });

  it('falls back to description field', () => {
    const output = { description: 'Some description', count: 3 };
    expect(summarizeOutput(output)).toBe('Some description');
  });

  it('falls back to field count when no summary or description', () => {
    const output = { files_changed: [], requirements: [], acceptance_criteria: [] };
    expect(summarizeOutput(output)).toBe('3 fields: files_changed, requirements, acceptance_criteria');
  });

  it('returns null for empty object', () => {
    expect(summarizeOutput({})).toBeNull();
  });
});
```

**Step 2: Run the test to confirm it fails**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio-foundation/cli test
```

Expected: FAIL — module `./formatters.js` not found.

**Step 3: Commit the failing tests**

```bash
git add cli/src/output/formatters.test.ts
git commit -m "test(cli): add failing tests for humanReadableStageName, summarizeToolCalls, summarizeOutput"
```

---

## Task 2 — Implement `formatters.ts`

**Files:**
- Create: `cli/src/output/formatters.ts`

**Step 1: Write the implementation**

```typescript
// cli/src/output/formatters.ts
import type { ToolCallSummary } from '@studio-foundation/engine';

// ── Stage name mapping ────────────────────────────────────────────────────────

const STAGE_NAME_PATTERNS: Array<[RegExp, string]> = [
  [/^brief[-_]analysis$/i, 'Analyzing brief'],
  [/^implementation[-_]plan$/i, 'Planning implementation'],
  [/^code[-_]gen(?:eration)?$/i, 'Generating code'],
  [/^qa[-_]review$/i, 'Reviewing'],
  [/^analysis$/i, 'Analysis'],
  [/^planning$/i, 'Planning'],
  [/^generation$/i, 'Generating'],
  [/^review$/i, 'Reviewing'],
];

/**
 * Converts a kebab-case stage name to a human-readable label.
 * Uses a lookup table for known names; falls back to title-casing.
 */
export function humanReadableStageName(stageName: string): string {
  for (const [pattern, label] of STAGE_NAME_PATTERNS) {
    if (pattern.test(stageName)) return label;
  }
  return stageName
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ── Tool call grouping ────────────────────────────────────────────────────────

interface ToolGroup {
  singular: string;
  plural: string;
  verb: string;  // past tense verb, e.g. "Read", "Wrote"
}

const TOOL_GROUPS: Record<string, ToolGroup> = {
  read_file:       { verb: 'Read',     singular: 'file',      plural: 'files' },
  write_file:      { verb: 'Wrote',    singular: 'file',      plural: 'files' },
  list_files:      { verb: 'Listed',   singular: 'directory', plural: 'directories' },
  run_command:     { verb: 'Ran',      singular: 'command',   plural: 'commands' },
  search_codebase: { verb: 'Searched', singular: 'time',      plural: 'times' },
  apply_patch:     { verb: 'Patched',  singular: 'file',      plural: 'files' },
};

/** Extracts the action part from a tool name like `repo_manager-read_file` → `read_file`. */
function toolAction(name: string): string {
  const idx = name.lastIndexOf('-');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * Groups tool calls by type and returns a human-readable summary string.
 * E.g. "Read 3 files, wrote 1 file, ran 2 commands"
 */
export function summarizeToolCalls(toolCalls: ToolCallSummary[]): string {
  if (toolCalls.length === 0) return '';

  const counts = new Map<string, number>();
  let unknownCount = 0;

  for (const tc of toolCalls) {
    const action = toolAction(tc.name);
    if (TOOL_GROUPS[action]) {
      counts.set(action, (counts.get(action) ?? 0) + 1);
    } else {
      unknownCount++;
    }
  }

  const parts: string[] = [];

  for (const [action, count] of counts) {
    const group = TOOL_GROUPS[action];
    const noun = count === 1 ? group.singular : group.plural;
    // First part uses title-case verb, rest lowercase
    const verb = parts.length === 0 ? group.verb : group.verb.toLowerCase();
    parts.push(`${verb} ${count} ${noun}`);
  }

  if (unknownCount > 0) {
    const label = `${unknownCount} tool call${unknownCount !== 1 ? 's' : ''}`;
    parts.push(label);
  }

  return parts.join(', ');
}

// ── Output summary ────────────────────────────────────────────────────────────

/**
 * Extracts a human-readable summary from a stage output object.
 * Prefers `summary` > `description` > field listing.
 * Never returns raw JSON.
 */
export function summarizeOutput(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  if (typeof output !== 'object' || Array.isArray(output)) return null;

  const o = output as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return null;

  const truncate = (s: string) => s.length > 150 ? s.slice(0, 150) + '...' : s;

  if (typeof o.summary === 'string' && o.summary.length > 0) {
    return truncate(o.summary);
  }
  if (typeof o.description === 'string' && o.description.length > 0) {
    return truncate(o.description);
  }

  return `${keys.length} field${keys.length !== 1 ? 's' : ''}: ${keys.join(', ')}`;
}
```

**Step 2: Run tests to confirm they pass**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio-foundation/cli test
```

Expected: all tests in `formatters.test.ts` PASS.

**Step 3: Commit**

```bash
git add cli/src/output/formatters.ts
git commit -m "feat(cli): add humanReadableStageName, summarizeToolCalls, summarizeOutput helpers"
```

---

## Task 3 — Update `progress.ts` to use spinner + new formatters

**Files:**
- Modify: `cli/src/output/progress.ts`

**Step 1: Rewrite `progress.ts`**

The new file keeps the same class API (`new ProgressDisplay(jsonMode, verbose)` → `.getEvents()`). Behavioural changes:
- `onStageStart` → start `ora` spinner instead of `process.stdout.write`
- `onStageComplete` → call `spinner.succeed/fail`, then print grouped tool calls + summarized output
- `onTaskRetry` → stop spinner, print retry info, restart spinner
- `--verbose` path → after succeed/fail line, also print full JSON + token breakdown (same as current behavior)
- Group/pipeline events unchanged except `onGroupFeedback` stays as-is (uses `rejection_reason` from event)

```typescript
// cli/src/output/progress.ts
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import type { EngineEvents } from '@studio-foundation/engine';
import { formatDuration } from './formatter.js';
import { humanReadableStageName, summarizeToolCalls, summarizeOutput } from './formatters.js';

export class ProgressDisplay {
  private spinner: Ora | null = null;
  private spinnerText = '';

  constructor(
    private jsonMode: boolean,
    private verbose: boolean
  ) {}

  getEvents(): EngineEvents {
    return {
      onPipelineStart: (event) => {
        if (this.jsonMode) return;
        console.log(chalk.blue(`\nRunning pipeline: ${event.pipeline_name}`));
        console.log(chalk.gray(`Run ID: ${event.run_id}\n`));
      },

      onStageStart: (event) => {
        if (this.jsonMode) return;
        const index = `[${event.stage_index + 1}/${event.total_stages}]`;
        const label = humanReadableStageName(event.stage_name);
        this.spinnerText = `${index} ${label}`;
        this.spinner = ora({
          text: this.spinnerText,
          color: 'cyan',
        }).start();
      },

      onStageComplete: (event) => {
        if (this.jsonMode) return;

        const duration = formatDuration(event.duration_ms);
        const label = humanReadableStageName(event.stage_name);
        const attemptsStr = `${event.attempts} attempt${event.attempts !== 1 ? 's' : ''}`;

        if (event.status === 'success') {
          this.spinner?.succeed(
            chalk.white(label) +
            chalk.gray(` (${attemptsStr}, ${duration})`)
          );
        } else if (event.status === 'rejected') {
          this.spinner?.fail(
            chalk.red(`${label} — rejected`) +
            chalk.gray(` (${duration})`)
          );
          if (event.rejection_reason) {
            console.log(chalk.red(`  ✗ ${event.rejection_reason}`));
          }
          if (event.rejection_details?.length) {
            for (const detail of event.rejection_details) {
              console.log(chalk.yellow(`    - ${detail}`));
            }
          }
        } else {
          this.spinner?.fail(
            chalk.red(`${label} — failed`) +
            chalk.gray(` (${attemptsStr}, ${duration})`)
          );
        }
        this.spinner = null;

        // Default: grouped tool calls summary
        if (event.tool_calls && event.tool_calls.length > 0) {
          const summary = summarizeToolCalls(event.tool_calls);
          if (summary) console.log(chalk.gray(`  ${summary}`));
        }

        // Default: human-readable output summary (no raw JSON)
        if (event.status !== 'rejected' && event.output) {
          const summary = summarizeOutput(event.output);
          if (summary) console.log(chalk.gray(`  ${summary}`));
        }

        // Verbose extras: full JSON output
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

        // Verbose extras: token breakdown
        if (this.verbose && event.token_usage) {
          const u = event.token_usage;
          console.log(chalk.gray(`  Tokens: ${u.prompt_tokens} prompt + ${u.completion_tokens} completion = ${u.total_tokens} total`));
        }
      },

      onTaskRetry: (event) => {
        if (this.jsonMode) return;
        // Stop spinner before printing, restart after
        this.spinner?.stop();
        this.spinner = null;

        console.log(chalk.yellow(`  ↻ Retry #${event.attempt}:`));
        for (const failure of event.failures) {
          console.log(chalk.yellow(`    - ${failure}`));
        }
        if (this.verbose && event.agent_output_raw) {
          console.log(chalk.gray(`    Raw response: ${event.agent_output_raw.slice(0, 300)}`));
        }
        if (this.verbose && event.tool_calls_count !== undefined) {
          console.log(chalk.gray(`    Tool calls made: ${event.tool_calls_count}`));
        }

        // Restart spinner for ongoing stage
        this.spinner = ora({
          text: this.spinnerText,
          color: 'cyan',
        }).start();
      },

      onGroupStart: () => {
        // Silent — group is transparent at the pipeline level
      },

      onGroupIteration: (event) => {
        if (this.jsonMode) return;
        if (event.iteration > 1) {
          console.log(chalk.yellow(`\n  ↻ Feedback loop iteration ${event.iteration}/${event.max_iterations}`));
        }
      },

      onGroupFeedback: (event) => {
        if (this.jsonMode) return;
        console.log(chalk.yellow(`    Rejected: ${event.rejection_reason}`));
        if (this.verbose && event.rejection_details.length > 0) {
          for (const detail of event.rejection_details) {
            console.log(chalk.yellow(`      - ${detail}`));
          }
        }
        console.log(chalk.yellow(`    Re-running with feedback...`));
      },

      onGroupComplete: (event) => {
        if (this.jsonMode) return;
        if (event.iterations > 1) {
          if (event.status === 'success') {
            console.log(chalk.green(`  ✓ Approved after ${event.iterations} iterations`));
          } else {
            console.log(chalk.red(`  ✗ Rejected after ${event.iterations} iterations (max reached)`));
          }
        }
      },

      onPipelineComplete: (event) => {
        if (this.jsonMode) return;

        console.log('');
        if (event.status === 'success') {
          console.log(chalk.green(`✓ Pipeline completed in ${formatDuration(event.duration_ms)}`));
        } else if (event.status === 'rejected') {
          console.log(chalk.red(`✗ Pipeline rejected`));
        } else {
          console.log(chalk.red(`✗ Pipeline failed after ${formatDuration(event.duration_ms)}`));
        }

        const parts: string[] = [];
        if (event.total_tokens > 0) {
          parts.push(`${event.total_tokens.toLocaleString()} tokens`);
        }
        if (event.total_tool_calls > 0) {
          parts.push(`${event.total_tool_calls} tool calls`);
        }
        if (parts.length > 0) {
          console.log(chalk.gray(`  ${parts.join(' | ')}`));
        }
      },
    };
  }
}
```

**Step 2: Build to check for type errors**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build
```

Expected: clean build, no TypeScript errors.

**Step 3: Run the tests**

```bash
pnpm --filter @studio-foundation/cli test
```

Expected: all tests pass.

**Step 4: Commit**

```bash
git add cli/src/output/progress.ts
git commit -m "feat(cli): use ora spinner and human-readable formatting in ProgressDisplay

- Replace process.stdout.write dots with ora spinner on stage start
- Group tool calls via summarizeToolCalls() (e.g. 'Read 3 files, wrote 1 file')
- Show summarizeOutput() instead of raw JSON for stage output
- Stop/restart spinner around onTaskRetry messages
- --verbose still shows full JSON output and token breakdown
- Remove domain-specific 'QA' wording from groupFeedback message"
```

---

## Task 4 — Final build verification

**Step 1: Full build from workspace root**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build
```

Expected: all 5 packages build without errors.

**Step 2: Run all workspace tests**

```bash
pnpm test
```

Expected: all tests pass.

**Step 3: Manual smoke test (optional — uses mock provider)**

If a `.studio/` config exists locally, you can run:
```bash
studio run software/feature-builder --input "Test" --provider mock
```

Otherwise verify visually that `ora` is importable:
```bash
node -e "import('ora').then(m => console.log('ora ok:', typeof m.default))"
```

Expected: `ora ok: function`

**Step 4: Commit if anything changed**

Nothing should change here — this is verification only.

---

## Acceptance Criteria Check

- [ ] No raw JSON in terminal by default (verified by `summarizeOutput` tests)
- [ ] Tool calls grouped (`summarizeToolCalls` tests cover this)
- [ ] Spinner shown during stage execution (`ora` used in `onStageStart/onStageComplete`)
- [ ] `--verbose` preserves full JSON output and token details (kept in `onStageComplete`)
- [ ] JSONL logs untouched (`run-logger.ts` not modified)
- [ ] `pnpm build` clean
- [ ] All tests pass

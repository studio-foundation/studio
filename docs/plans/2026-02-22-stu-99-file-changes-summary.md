# STU-99: File Changes Summary — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Display a git-diff-style summary of files written by `repo_manager-write_file` at the end of every `studio run`.

**Architecture:** CLI-only feature (engine stays domain-agnostic). A `FileChangeCollector` class listens to `onToolCallComplete` events, records paths from `repo_manager-write_file` calls, then shells out to `git diff --numstat` for line counts. The formatter appends a "Changes:" block after the stages summary.

**Tech Stack:** TypeScript, Vitest, chalk, `child_process.execSync` for git commands.

---

### Task 1: FileChangeCollector — core class with tests

**Files:**
- Create: `cli/src/output/file-changes.ts`
- Create: `cli/tests/output/file-changes.test.ts`

**Step 1: Write the failing test**

In `cli/tests/output/file-changes.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { FileChangeCollector } from '../../src/output/file-changes.js';

describe('FileChangeCollector', () => {
  it('collects unique file paths from tool call events', () => {
    const collector = new FileChangeCollector();

    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/app.ts', written: true },
      duration_ms: 10,
      timestamp: Date.now(),
    });
    collector.onToolCallComplete({
      tool: 'repo_manager-read_file',
      result: { content: '...' },
      duration_ms: 5,
      timestamp: Date.now(),
    });
    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/app.ts', written: true },
      duration_ms: 8,
      timestamp: Date.now(),
    });

    expect(collector.getWrittenPaths()).toEqual(['src/app.ts']);
  });

  it('returns empty array when no write calls', () => {
    const collector = new FileChangeCollector();
    expect(collector.getWrittenPaths()).toEqual([]);
  });

  it('ignores failed tool calls', () => {
    const collector = new FileChangeCollector();

    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: undefined,
      error: 'Permission denied',
      duration_ms: 10,
      timestamp: Date.now(),
    });

    expect(collector.getWrittenPaths()).toEqual([]);
  });

  it('collects multiple distinct paths in order', () => {
    const collector = new FileChangeCollector();

    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/b.ts', written: true },
      duration_ms: 10,
      timestamp: Date.now(),
    });
    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/a.ts', written: true },
      duration_ms: 10,
      timestamp: Date.now(),
    });

    expect(collector.getWrittenPaths()).toEqual(['src/b.ts', 'src/a.ts']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test -- cli/tests/output/file-changes.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

In `cli/src/output/file-changes.ts`:

```typescript
import type { ToolCallCompleteEvent } from '@studio-foundation/contracts';

export class FileChangeCollector {
  private paths = new Set<string>();

  onToolCallComplete(event: ToolCallCompleteEvent): void {
    if (event.tool !== 'repo_manager-write_file') return;
    if (event.error) return;

    const result = event.result as { path?: string } | undefined;
    if (result?.path) {
      this.paths.add(result.path);
    }
  }

  getWrittenPaths(): string[] {
    return [...this.paths];
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test -- cli/tests/output/file-changes.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add cli/src/output/file-changes.ts cli/tests/output/file-changes.test.ts
git commit -m "feat(cli): add FileChangeCollector for tracking written files (STU-99)"
```

---

### Task 2: Git diff integration — `computeSummary()` method

**Files:**
- Modify: `cli/src/output/file-changes.ts`
- Modify: `cli/tests/output/file-changes.test.ts`

**Step 1: Write the failing tests**

Append to `cli/tests/output/file-changes.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import * as cp from 'node:child_process';

// ... existing tests ...

describe('FileChangeCollector.computeSummary', () => {
  it('returns null when no files were written', async () => {
    const collector = new FileChangeCollector();
    const result = collector.computeSummary('/fake/repo');
    expect(result).toBeNull();
  });

  it('parses git diff --numstat for modified files', () => {
    vi.spyOn(cp, 'execSync').mockReturnValue(
      Buffer.from('15\t3\tsrc/app.ts\n')
    );

    const collector = new FileChangeCollector();
    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/app.ts', written: true },
      duration_ms: 10,
      timestamp: Date.now(),
    });

    const summary = collector.computeSummary('/fake/repo');
    expect(summary).toEqual([
      { path: 'src/app.ts', status: 'M', added: 15, removed: 3 },
    ]);

    vi.restoreAllMocks();
  });

  it('marks files not in git diff as Added with line count', () => {
    vi.spyOn(cp, 'execSync')
      .mockReturnValueOnce(Buffer.from(''))          // git diff --numstat returns nothing
      .mockReturnValueOnce(Buffer.from('42\n'));      // wc -l for the new file

    const collector = new FileChangeCollector();
    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/new.ts', written: true },
      duration_ms: 10,
      timestamp: Date.now(),
    });

    const summary = collector.computeSummary('/fake/repo');
    expect(summary).toEqual([
      { path: 'src/new.ts', status: 'A', added: 42, removed: 0 },
    ]);

    vi.restoreAllMocks();
  });

  it('returns null when git is not available', () => {
    vi.spyOn(cp, 'execSync').mockImplementation(() => {
      throw new Error('git not found');
    });

    const collector = new FileChangeCollector();
    collector.onToolCallComplete({
      tool: 'repo_manager-write_file',
      result: { path: 'src/app.ts', written: true },
      duration_ms: 10,
      timestamp: Date.now(),
    });

    const summary = collector.computeSummary('/fake/repo');
    expect(summary).toBeNull();

    vi.restoreAllMocks();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test -- cli/tests/output/file-changes.test.ts`
Expected: FAIL — `computeSummary` is not a function

**Step 3: Write minimal implementation**

Add to `cli/src/output/file-changes.ts`:

```typescript
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { ToolCallCompleteEvent } from '@studio-foundation/contracts';

export interface FileChange {
  path: string;
  status: 'M' | 'A';
  added: number;
  removed: number;
}

export class FileChangeCollector {
  private paths = new Set<string>();

  onToolCallComplete(event: ToolCallCompleteEvent): void {
    if (event.tool !== 'repo_manager-write_file') return;
    if (event.error) return;

    const result = event.result as { path?: string } | undefined;
    if (result?.path) {
      this.paths.add(result.path);
    }
  }

  getWrittenPaths(): string[] {
    return [...this.paths];
  }

  computeSummary(repoPath: string): FileChange[] | null {
    const written = this.getWrittenPaths();
    if (written.length === 0) return null;

    try {
      const diffOutput = execSync(
        `git diff --numstat -- ${written.map((p) => JSON.stringify(p)).join(' ')}`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      const diffMap = new Map<string, { added: number; removed: number }>();
      if (diffOutput) {
        for (const line of diffOutput.split('\n')) {
          const [addedStr, removedStr, ...pathParts] = line.split('\t');
          const filePath = pathParts.join('\t');
          diffMap.set(filePath, {
            added: parseInt(addedStr, 10) || 0,
            removed: parseInt(removedStr, 10) || 0,
          });
        }
      }

      const changes: FileChange[] = [];
      for (const filePath of written) {
        const diff = diffMap.get(filePath);
        if (diff) {
          changes.push({ path: filePath, status: 'M', added: diff.added, removed: diff.removed });
        } else {
          // File not in git diff — it's a new file
          let lineCount = 0;
          try {
            const wcOutput = execSync(
              `wc -l < ${JSON.stringify(join(repoPath, filePath))}`,
              { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();
            lineCount = parseInt(wcOutput, 10) || 0;
          } catch {
            // File might have been deleted or moved — skip line count
          }
          changes.push({ path: filePath, status: 'A', added: lineCount, removed: 0 });
        }
      }

      return changes;
    } catch {
      // git not available or not a git repo — graceful degradation
      return null;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test -- cli/tests/output/file-changes.test.ts`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add cli/src/output/file-changes.ts cli/tests/output/file-changes.test.ts
git commit -m "feat(cli): add git diff integration to FileChangeCollector (STU-99)"
```

---

### Task 3: Format the changes block — `formatFileChanges()`

**Files:**
- Modify: `cli/src/output/file-changes.ts`
- Modify: `cli/tests/output/file-changes.test.ts`

**Step 1: Write the failing tests**

Append to `cli/tests/output/file-changes.test.ts`:

```typescript
import { formatFileChanges, type FileChange } from '../../src/output/file-changes.js';

describe('formatFileChanges', () => {
  it('formats modified files with +/- counts', () => {
    const changes: FileChange[] = [
      { path: 'src/app.ts', status: 'M', added: 15, removed: 3 },
    ];
    const lines = formatFileChanges(changes);
    expect(lines).toContain('Changes:');
    expect(lines).toContain('M');
    expect(lines).toContain('src/app.ts');
    expect(lines).toContain('+15');
    expect(lines).toContain('-3');
  });

  it('formats added files with line count', () => {
    const changes: FileChange[] = [
      { path: 'src/new.ts', status: 'A', added: 42, removed: 0 },
    ];
    const lines = formatFileChanges(changes);
    expect(lines).toContain('A');
    expect(lines).toContain('src/new.ts');
    expect(lines).toContain('new file');
    expect(lines).toContain('42');
  });

  it('formats mixed M and A files', () => {
    const changes: FileChange[] = [
      { path: 'src/app.ts', status: 'M', added: 15, removed: 3 },
      { path: 'src/new.ts', status: 'A', added: 42, removed: 0 },
    ];
    const lines = formatFileChanges(changes);
    expect(lines).toContain('M');
    expect(lines).toContain('A');
  });

  it('returns empty string for empty array', () => {
    expect(formatFileChanges([])).toBe('');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test -- cli/tests/output/file-changes.test.ts`
Expected: FAIL — `formatFileChanges` is not exported

**Step 3: Write minimal implementation**

Add to `cli/src/output/file-changes.ts`:

```typescript
import chalk from 'chalk';

export function formatFileChanges(changes: FileChange[]): string {
  if (changes.length === 0) return '';

  const lines: string[] = ['', 'Changes:'];
  for (const change of changes) {
    const tag = change.status === 'A'
      ? chalk.green('A')
      : chalk.yellow('M');

    const detail = change.status === 'A'
      ? chalk.gray(`(new file, ${change.added} lines)`)
      : chalk.gray(`(+${change.added} -${change.removed})`);

    lines.push(`  ${tag} ${change.path}  ${detail}`);
  }

  return lines.join('\n');
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test -- cli/tests/output/file-changes.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add cli/src/output/file-changes.ts cli/tests/output/file-changes.test.ts
git commit -m "feat(cli): add formatFileChanges display formatter (STU-99)"
```

---

### Task 4: Wire into `run.ts` — integrate collector with pipeline events and output

**Files:**
- Modify: `cli/src/commands/run.ts`

**Step 1: Add imports at top of `cli/src/commands/run.ts`**

After line 13 (`import { createRunLogger } from '../run-logger.js';`), add:

```typescript
import { FileChangeCollector, formatFileChanges } from '../output/file-changes.js';
```

**Step 2: Create the collector and wire into events**

In `runCommand()`, after the `mergeEvents` call (line 342-347), add an `onToolCallComplete` wrapper.

Replace lines 342-347:

```typescript
    const progress = new ProgressDisplay(!!options.json, {
      live: !!options.live,
      verbose: !!options.verbose,
    });
    const runLogger = createRunLogger(process.cwd());
    const events = mergeEvents(
      progress.getEvents(),
      runLogger,
      pipelineName,
      input
    );
```

With:

```typescript
    const progress = new ProgressDisplay(!!options.json, {
      live: !!options.live,
      verbose: !!options.verbose,
    });
    const runLogger = createRunLogger(process.cwd());
    const fileCollector = new FileChangeCollector();
    const baseEvents = mergeEvents(
      progress.getEvents(),
      runLogger,
      pipelineName,
      input
    );
    const events: EngineEvents = {
      ...baseEvents,
      onToolCallComplete: (e) => {
        fileCollector.onToolCallComplete(e);
        baseEvents.onToolCallComplete?.(e);
      },
    };
```

**Step 3: Display file changes after pipeline completes**

In `runCommand()`, after `formatResult(result)` (line 391), add:

```typescript
      // File changes summary
      const changes = fileCollector.computeSummary(repoPath);
      if (changes) {
        console.log(formatFileChanges(changes));
      }
```

**Step 4: Build and typecheck**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm build`
Expected: SUCCESS — no type errors

**Step 5: Run all CLI tests**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test`
Expected: PASS

**Step 6: Commit**

```bash
git add cli/src/commands/run.ts
git commit -m "feat(cli): wire FileChangeCollector into studio run output (STU-99)"
```

---

### Task 5: Build, verify, and final commit

**Step 1: Full build**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm build`
Expected: SUCCESS

**Step 2: Run all tests across all packages**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm test`
Expected: PASS

**Step 3: Manual smoke test (optional, if mock provider is set up)**

Run: `cd /home/arianeguay/dev/src/Studio && studio run feature-builder --provider mock --input "test"`

Check that the "Changes:" block appears at the bottom if `repo_manager-write_file` was called, or is absent if not.

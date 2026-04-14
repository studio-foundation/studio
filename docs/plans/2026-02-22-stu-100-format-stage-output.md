# STU-100: formatStageOutput Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace raw JSON output in the CLI with a human-readable recursive formatter that detects types dynamically.

**Architecture:** A single pure function `formatStageOutput` in `cli/src/output/formatters.ts` that recursively walks an output object, rendering each value based on its runtime type. Integrated into `ProgressDisplay.onStageComplete` for all display modes.

**Tech Stack:** TypeScript, vitest, chalk (caller-side only)

---

### Task 1: Write failing tests for formatStageOutput

**Files:**
- Modify: `cli/tests/output/formatters.test.ts`

**Step 1: Add the import and test suite**

Add `formatStageOutput` to the import at line 4 and add the full test suite at the bottom of the file:

```typescript
// Add to imports at top:
import {
  humanReadableStageName,
  summarizeToolCalls,
  summarizeOutput,
  getToolIcon,
  summarizeToolParams,
  summarizeToolResult,
  formatStageOutput,
} from '../../src/output/formatters.js';

// Add at bottom of file:
describe('formatStageOutput', () => {
  it('renders short strings inline', () => {
    const result = formatStageOutput({ status: 'approved' });
    expect(result).toBe('Status : approved');
  });

  it('renders numbers and booleans inline', () => {
    const result = formatStageOutput({ score: 42, passed: true });
    expect(result).toContain('Score  : 42');
    expect(result).toContain('Passed : true');
  });

  it('renders null and undefined as dash', () => {
    const result = formatStageOutput({ value: null });
    expect(result).toBe('Value : —');
  });

  it('aligns keys to the longest key name', () => {
    const result = formatStageOutput({ status: 'ok', summary: 'done' });
    const lines = result.split('\n');
    // Both ':' should be at the same column
    const col0 = lines[0].indexOf(':');
    const col1 = lines[1].indexOf(':');
    expect(col0).toBe(col1);
  });

  it('renders long strings on a new line with indent', () => {
    const longStr = 'The implementation covers all the requested changes and follows the existing patterns in the codebase correctly.';
    const result = formatStageOutput({ summary: longStr });
    expect(result).toContain('Summary :');
    expect(result).toContain('\n');
    expect(result).toContain(`    ${longStr}`);
  });

  it('renders short primitive arrays inline', () => {
    const result = formatStageOutput({ tags: ['ui', 'css', 'dark-mode'] });
    expect(result).toBe('Tags : ui, css, dark-mode');
  });

  it('renders long primitive arrays vertically', () => {
    const items = Array.from({ length: 10 }, (_, i) => `very-long-tag-name-${i}`);
    const result = formatStageOutput({ tags: items });
    expect(result).toContain('Tags :');
    expect(result).toContain('    • very-long-tag-name-0');
    expect(result).toContain('    • very-long-tag-name-9');
  });

  it('renders arrays of objects with numbered indices', () => {
    const result = formatStageOutput({
      issues: [
        { title: 'Missing component', suggestion: 'Add it' },
        { title: 'Bad import', suggestion: 'Fix it' },
      ],
    });
    expect(result).toContain('Issues :');
    expect(result).toContain('    ① Missing component');
    expect(result).toContain('        Suggestion : Add it');
    expect(result).toContain('    ② Bad import');
    expect(result).toContain('        Suggestion : Fix it');
  });

  it('uses fallback numbering beyond 10 items', () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ name: `item-${i}` }));
    const result = formatStageOutput({ list: items });
    expect(result).toContain('(11) item-10');
  });

  it('renders nested objects with indentation', () => {
    const result = formatStageOutput({
      details: { author: 'Alice', score: 95 },
    });
    expect(result).toContain('Details :');
    expect(result).toContain('    Author : Alice');
    expect(result).toContain('    Score  : 95');
  });

  it('falls back to compact JSON at depth > 4', () => {
    const deep = { a: { b: { c: { d: { e: 'deep' } } } } };
    const result = formatStageOutput(deep);
    // At depth 4, the innermost value should be JSON
    expect(result).toContain('{"e":"deep"}');
  });

  it('handles empty object', () => {
    expect(formatStageOutput({})).toBe('');
  });

  it('handles empty arrays', () => {
    const result = formatStageOutput({ items: [] });
    expect(result).toBe('Items : (empty)');
  });

  it('renders a realistic QA output', () => {
    const output = {
      status: 'approved_with_notes',
      summary: 'The implementation is mostly complete.',
      issues: [
        { title: 'ThemeToggle not in layout', suggestion: 'Add <ThemeToggle /> to header' },
        { title: 'localStorage not confirmed', suggestion: 'Implement retrieval logic' },
      ],
    };
    const result = formatStageOutput(output);
    expect(result).toContain('Status  : approved_with_notes');
    expect(result).toContain('Summary : The implementation is mostly complete.');
    expect(result).toContain('Issues  :');
    expect(result).toContain('    ① ThemeToggle not in layout');
    expect(result).toContain('    ② localStorage not confirmed');
  });

  it('renders arrays of objects that have a single string field as compact items', () => {
    const result = formatStageOutput({
      files_changed: [
        { path: 'src/app.ts' },
        { path: 'src/theme.ts' },
      ],
    });
    expect(result).toContain('① src/app.ts');
    expect(result).toContain('② src/theme.ts');
  });
});
```

**Step 2: Run the tests to verify they fail**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test -- --run`
Expected: Compilation error — `formatStageOutput` is not exported from formatters.

---

### Task 2: Implement formatStageOutput

**Files:**
- Modify: `cli/src/output/formatters.ts`

**Step 1: Add the implementation**

Add at the bottom of `cli/src/output/formatters.ts`, before the closing of the file:

```typescript
// ── Stage output formatting ─────────────────────────────────────────────────

const CIRCLED_DIGITS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

function circledIndex(i: number): string {
  return i < CIRCLED_DIGITS.length ? CIRCLED_DIGITS[i] : `(${i + 1})`;
}

function titleCase(key: string): string {
  return key
    .split(/[-_]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function isPrimitive(value: unknown): value is string | number | boolean | null | undefined {
  return value === null || value === undefined || typeof value !== 'object';
}

function formatValue(value: unknown, indent: number, maxDepth: number): string {
  const pad = '    '.repeat(indent);

  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);

  if (typeof value === 'string') {
    if (value.length <= 80) return value;
    return `\n${pad}    ${value}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '(empty)';

    // Array of primitives
    if (value.every(isPrimitive)) {
      const inline = value.map(v => String(v ?? '—')).join(', ');
      if (inline.length <= 80) return inline;
      return '\n' + value.map(v => `${pad}    • ${String(v ?? '—')}`).join('\n');
    }

    // Array of objects
    return '\n' + value.map((item, i) => {
      const idx = circledIndex(i);
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        const keys = Object.keys(obj);
        // Single string field: compact rendering
        if (keys.length === 1 && typeof obj[keys[0]] === 'string') {
          return `${pad}    ${idx} ${obj[keys[0]]}`;
        }
        // First string field as title, rest as sub-fields
        const firstStrKey = keys.find(k => typeof obj[k] === 'string');
        if (firstStrKey && indent + 1 < maxDepth) {
          const title = obj[firstStrKey] as string;
          const rest = keys.filter(k => k !== firstStrKey);
          if (rest.length === 0) return `${pad}    ${idx} ${title}`;
          const subPad = pad + '        ';
          const maxKeyLen = Math.max(...rest.map(k => titleCase(k).length));
          const subFields = rest.map(k => {
            const label = titleCase(k).padEnd(maxKeyLen);
            const val = formatValue(obj[k], indent + 2, maxDepth);
            return `${subPad}${label} : ${val}`;
          }).join('\n');
          return `${pad}    ${idx} ${title}\n${subFields}`;
        }
      }
      // Fallback: JSON
      return `${pad}    ${idx} ${JSON.stringify(item)}`;
    }).join('\n');
  }

  // Nested object
  if (typeof value === 'object') {
    if (indent + 1 >= maxDepth) return JSON.stringify(value);
    const obj = value as Record<string, unknown>;
    const formatted = formatObjectFields(obj, indent + 1, maxDepth);
    return formatted ? '\n' + formatted : '(empty)';
  }

  return String(value);
}

function formatObjectFields(obj: Record<string, unknown>, indent: number, maxDepth: number): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';

  const pad = '    '.repeat(indent);
  const labels = keys.map(k => titleCase(k));
  const maxKeyLen = Math.max(...labels.map(l => l.length));

  return keys.map((key, i) => {
    const label = labels[i].padEnd(maxKeyLen);
    const val = formatValue(obj[key], indent, maxDepth);
    return `${pad}${label} : ${val}`;
  }).join('\n');
}

/**
 * Formats a stage output object as a human-readable string.
 * Detects types dynamically — no hardcoded field names.
 * Returns plain text (no ANSI colors).
 */
export function formatStageOutput(output: Record<string, unknown>, maxDepth = 4): string {
  return formatObjectFields(output, 0, maxDepth);
}
```

**Step 2: Run the tests to verify they pass**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test -- --run`
Expected: All `formatStageOutput` tests pass. If any fail, adjust the implementation to match expectations.

**Step 3: Commit**

```bash
git add cli/src/output/formatters.ts cli/tests/output/formatters.test.ts
git commit -m "feat(cli): add formatStageOutput — human-readable stage output rendering (STU-100)"
```

---

### Task 3: Integrate into ProgressDisplay

**Files:**
- Modify: `cli/src/output/progress.ts:5` (add import)
- Modify: `cli/src/output/progress.ts:119-136` (replace output rendering)

**Step 1: Add the import**

In `progress.ts` line 5, add `formatStageOutput` to the import from `./formatters.js`:

```typescript
import { humanReadableStageName, summarizeToolCalls, summarizeOutput, getToolIcon, summarizeToolParams, summarizeToolResult, formatStageOutput } from './formatters.js';
```

**Step 2: Replace output rendering**

Replace lines 119-136 (the `summarizeOutput` block + verbose JSON block) with:

```typescript
        // Formatted output: all modes
        if (event.status !== 'rejected' && event.output && typeof event.output === 'object') {
          const formatted = formatStageOutput(event.output as Record<string, unknown>);
          if (formatted) {
            for (const line of formatted.split('\n')) {
              console.log(chalk.gray(`  ${line}`));
            }
          }
        }
```

This removes the `summarizeOutput` one-liner and the verbose-only JSON block. The verbose token breakdown (lines 138-142) stays untouched.

**Step 3: Run the full test suite**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test -- --run`
Expected: All tests pass.

**Step 4: Build the project**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm build`
Expected: Build succeeds with no errors.

**Step 5: Commit**

```bash
git add cli/src/output/progress.ts
git commit -m "feat(cli): integrate formatStageOutput into ProgressDisplay (STU-100)"
```

---

### Task 4: Remove unused summarizeOutput (cleanup)

**Files:**
- Modify: `cli/src/output/formatters.ts` (remove `summarizeOutput`)
- Modify: `cli/src/output/progress.ts` (remove from import)
- Modify: `cli/tests/output/formatters.test.ts` (remove tests)

**Step 1: Check if summarizeOutput is used elsewhere**

Run: `grep -r 'summarizeOutput' --include='*.ts' cli/src/ engine/src/`

If only referenced in `formatters.ts`, `progress.ts` import, and tests — safe to remove.

**Step 2: Remove from import in progress.ts**

Remove `summarizeOutput` from the import line.

**Step 3: Remove the function from formatters.ts**

Remove lines 91-116 (the `summarizeOutput` function and its comment header).

**Step 4: Remove from test import and test suite**

Remove `summarizeOutput` from the import and the entire `describe('summarizeOutput', ...)` block.

**Step 5: Run tests and build**

Run: `cd /home/arianeguay/dev/src/Studio && pnpm --filter @studio-foundation/cli test -- --run && pnpm build`
Expected: All pass.

**Step 6: Commit**

```bash
git add cli/src/output/formatters.ts cli/src/output/progress.ts cli/tests/output/formatters.test.ts
git commit -m "refactor(cli): remove summarizeOutput, replaced by formatStageOutput (STU-100)"
```

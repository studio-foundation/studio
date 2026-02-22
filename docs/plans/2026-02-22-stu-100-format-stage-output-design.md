# STU-100: formatStageOutput — Human-Readable Stage Output Rendering

## Problem

The CLI currently shows stage outputs as either a truncated 1-liner (`summarizeOutput()`) or raw JSON limited to 20 lines (verbose mode). Structured outputs with multiple fields (status, summary, issues, files_changed) are unreadable.

## Solution

A single recursive pure function `formatStageOutput(output: Record<string, unknown>, indent?: number): string` in `cli/src/output/formatters.ts`. It detects types dynamically — no field name hardcoding.

### Rendering rules

| Type | Rule | Example |
|------|------|---------|
| `string` ≤ 80 chars | Inline | `Status  : approved_with_notes` |
| `string` > 80 chars | Newline + indent | `Summary :\n    The implementation is mostly...` |
| `number` / `boolean` | Inline | `Score   : 42` |
| `null` / `undefined` | Inline dash | `Value   : —` |
| `array` of primitives, total ≤ 80 chars | Inline comma-separated | `Tags    : ui, dark-mode, css` |
| `array` of primitives, total > 80 chars | Vertical bullets | `Tags    :\n    • ui\n    • dark-mode` |
| `array` of objects | Numbered `①②③…` with recursive indent | See below |
| `object` (nested) | Header + recursive indent | `Details :\n    field : value` |

### Key alignment

Top-level keys are right-padded to align `:` based on the longest key name at that level.

### Example output

```
  Status  : approved_with_notes
  Summary : The implementation is mostly complete...
  Issues  :
    ① ThemeToggle component not included in layout
        suggestion : Add <ThemeToggle /> to the header
    ② localStorage retrieval logic not confirmed
        suggestion : Ensure to implement the logic...
```

### Numbered indices

Array indices use Unicode circled digits `①②③④⑤⑥⑦⑧⑨⑩`. Beyond 10: `(11)`, `(12)`, etc.

### Recursion depth

Max 4 levels of indent. Beyond that, compact JSON fallback.

## Integration

Replace `progress.ts` lines 119-136 (the `summarizeOutput` 1-liner + verbose JSON block) with a single block that calls `formatStageOutput` in **all display modes** (quiet, verbose, live).

```typescript
if (event.status !== 'rejected' && event.output && typeof event.output === 'object') {
  const formatted = formatStageOutput(event.output as Record<string, unknown>);
  for (const line of formatted.split('\n')) {
    console.log(chalk.gray(`  ${line}`));
  }
}
```

## Files changed

| File | Change |
|------|--------|
| `cli/src/output/formatters.ts` | Add `formatStageOutput()` |
| `cli/src/output/progress.ts` | Replace lines 119-136 with formatted output |
| `cli/tests/output/formatters.test.ts` | Tests for `formatStageOutput` |

## What stays the same

- Rejection details rendering
- Tool call summary
- Verbose token breakdown
- Live mode tool spinners

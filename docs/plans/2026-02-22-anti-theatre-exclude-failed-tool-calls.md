# Anti-théâtre: Exclude Failed Tool Calls from Minimum Count — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `tool_calls.minimum` and `required_tools` validation count only successful tool calls, so agents can't meet the minimum by spamming failed calls.

**Architecture:** Filter the `ToolCall[]` array for successful calls (no `error` field) inside the three ralph validator functions. Change `validateToolCalls` to accept `ToolCall[]` instead of `number`. Update the single call-site in engine to pass `result.tool_calls` instead of `result.tool_calls_count`. No type changes needed — `ToolCall.error` already distinguishes success from failure.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces

---

### Task 1: Update `validateToolCalls` — TDD

**Files:**
- Modify: `ralph/tests/validator.test.ts`
- Modify: `ralph/src/validator.ts`

The signature changes from `(toolCallsCount: number, requirements?)` to `(toolCalls: ToolCall[], requirements?)`. The helper `isSuccessfulToolCall` filters out failed calls before counting.

**Step 1: Replace existing `validateToolCalls` tests with new ones**

The existing tests pass raw numbers — they all need to be rewritten. Replace the entire `describe('validateToolCalls', ...)` block (lines 89–136 in `ralph/tests/validator.test.ts`) with:

```typescript
describe('validateToolCalls', () => {
  const success = (id: string): ToolCall => ({ id, name: 'some_tool', arguments: {} });
  const failed = (id: string): ToolCall => ({ id, name: 'some_tool', arguments: {}, error: 'ENOENT' });

  it('passes when successful calls meet minimum', () => {
    const result = validateToolCalls([success('1'), success('2'), success('3')], { minimum: 2 });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when exactly at minimum', () => {
    const result = validateToolCalls([success('1'), success('2')], { minimum: 2 });
    expect(result.valid).toBe(true);
  });

  it('fails when below minimum', () => {
    const result = validateToolCalls([], { minimum: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Expected at least 1 successful tool call');
  });

  it('ANTI-THÉÂTRE: fails when all calls failed', () => {
    const result = validateToolCalls([failed('1'), failed('2'), failed('3')], { minimum: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('got 0 successful');
  });

  it('ANTI-THÉÂTRE: excludes failed calls from count', () => {
    // 1 successful + 2 failed → only 1 counts
    const result = validateToolCalls([success('1'), failed('2'), failed('3')], { minimum: 2 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('got 1 successful');
  });

  it('ANTI-THÉÂTRE: passes when 1 successful + 2 failed and minimum is 1', () => {
    const result = validateToolCalls([success('1'), failed('2'), failed('3')], { minimum: 1 });
    expect(result.valid).toBe(true);
  });

  it('error message mentions failed count when calls were excluded', () => {
    const result = validateToolCalls([failed('1'), failed('2')], { minimum: 1 });
    expect(result.errors[0]).toContain('2 failed excluded');
  });

  it('error message omits excluded count when zero failed calls', () => {
    const result = validateToolCalls([], { minimum: 1 });
    expect(result.errors[0]).not.toContain('excluded');
  });

  it('uses correct pluralization for singular minimum', () => {
    const result = validateToolCalls([], { minimum: 1 });
    expect(result.errors[0]).toContain('tool call,'); // singular — "tool call, got"
  });

  it('uses correct pluralization for plural minimum', () => {
    const result = validateToolCalls([], { minimum: 3 });
    expect(result.errors[0]).toContain('tool calls,'); // plural
  });

  it('passes when no requirements specified', () => {
    const result = validateToolCalls([]);
    expect(result.valid).toBe(true);
  });

  it('passes when requirements is empty object', () => {
    const result = validateToolCalls([], {});
    expect(result.valid).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio/ralph test
```

Expected: TypeScript/type errors or test failures referencing the number-vs-array mismatch.

**Step 3: Update `validateToolCalls` in `ralph/src/validator.ts`**

Replace lines 50–66:

```typescript
function isSuccessfulToolCall(tc: ToolCall): boolean {
  return !tc.error;
}

export function validateToolCalls(toolCalls: ToolCall[], requirements?: ToolCallRequirements): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (requirements?.minimum !== undefined) {
    const successfulCount = toolCalls.filter(isSuccessfulToolCall).length;
    const failedCount = toolCalls.length - successfulCount;

    if (successfulCount < requirements.minimum) {
      const plural = requirements.minimum === 1 ? '' : 's';
      const excluded = failedCount > 0 ? ` (${failedCount} failed excluded)` : '';
      errors.push(
        `Expected at least ${requirements.minimum} successful tool call${plural}, got ${successfulCount} successful${excluded}`
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio/ralph test
```

Expected: All `validateToolCalls` tests pass.

**Step 5: Commit**

```bash
git add ralph/src/validator.ts ralph/tests/validator.test.ts
git commit -m "feat(ralph): validateToolCalls counts only successful tool calls (STU-121)"
```

---

### Task 2: Update `validateRequiredTools` — TDD

**Files:**
- Modify: `ralph/tests/validator.test.ts`
- Modify: `ralph/src/validator.ts`

Required tools must have at least one *successful* call. A required tool called 3 times but always erroring still fails.

**Step 1: Add new tests to the existing `validateRequiredTools` describe block**

Append these cases inside the `describe('validateRequiredTools', ...)` block in `ralph/tests/validator.test.ts`, before the closing `});`:

```typescript
  it('ANTI-THÉÂTRE: fails when required tool called but all calls failed', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'write_file', arguments: {}, error: 'permission denied' },
      { id: '2', name: 'write_file', arguments: {}, error: 'ENOENT' },
    ];
    const result = validateRequiredTools(toolCalls, { required_tools: ['write_file'] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("'write_file'");
    expect(result.errors[0]).toContain('no successful calls');
  });

  it('ANTI-THÉÂTRE: passes when required tool has at least one successful call', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'write_file', arguments: {}, error: 'ENOENT' },
      { id: '2', name: 'write_file', arguments: {} }, // success
    ];
    const result = validateRequiredTools(toolCalls, { required_tools: ['write_file'] });
    expect(result.valid).toBe(true);
  });

  it('ANTI-THÉÂTRE: error distinguishes never-called from all-failed', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'write_file', arguments: {}, error: 'ENOENT' },
    ];
    // write_file was called but all failed — different error than "was not called"
    const result = validateRequiredTools(toolCalls, { required_tools: ['write_file', 'read_file'] });
    expect(result.errors).toHaveLength(2);
    // write_file: called but all failed
    expect(result.errors.some(e => e.includes('write_file') && e.includes('no successful calls'))).toBe(true);
    // read_file: never called
    expect(result.errors.some(e => e.includes('read_file') && e.includes('was not called'))).toBe(true);
  });
```

**Step 2: Run tests to verify new ones fail**

```bash
pnpm --filter @studio/ralph test
```

Expected: The three new ANTI-THÉÂTRE tests fail.

**Step 3: Update `validateRequiredTools` in `ralph/src/validator.ts`**

Replace lines 73–93 with:

```typescript
export function validateRequiredTools(toolCalls: ToolCall[], requirements?: ToolCallRequirements): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (requirements?.required_tools && requirements.required_tools.length > 0) {
    for (const requiredTool of requirements.required_tools) {
      const normalizedRequired = normalizeToolName(requiredTool);
      const matchingCalls = toolCalls.filter(tc => normalizeToolName(tc.name) === normalizedRequired);

      if (matchingCalls.length === 0) {
        errors.push(`Required tool '${requiredTool}' was not called`);
      } else if (!matchingCalls.some(isSuccessfulToolCall)) {
        errors.push(`Required tool '${requiredTool}' has no successful calls (called ${matchingCalls.length} time${matchingCalls.length === 1 ? '' : 's'}, all failed)`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
```

**Step 4: Run tests to verify they all pass**

```bash
pnpm --filter @studio/ralph test
```

Expected: All `validateRequiredTools` tests pass.

**Step 5: Commit**

```bash
git add ralph/src/validator.ts ralph/tests/validator.test.ts
git commit -m "feat(ralph): validateRequiredTools requires at least one successful call (STU-121)"
```

---

### Task 3: Update `validateCountedTools` — TDD

**Files:**
- Modify: `ralph/tests/validator.test.ts`
- Modify: `ralph/src/validator.ts`

Only successful calls to counted tools count toward the minimum.

**Step 1: Add new tests to the existing `validateCountedTools` describe block**

Append these cases inside `describe('validateCountedTools', ...)` before the closing `});`:

```typescript
  it('ANTI-THÉÂTRE: fails when counted tool calls all failed', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-write_file', arguments: {}, error: 'permission denied' },
      { id: '2', name: 'repo_manager-write_file', arguments: {}, error: 'ENOENT' },
    ];
    const result = validateCountedTools(toolCalls, {
      minimum: 1,
      counted_tools: ['repo_manager.write_file'],
    });
    expect(result.valid).toBe(false);
  });

  it('ANTI-THÉÂTRE: excludes failed calls from counted tool count', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-write_file', arguments: {} },          // success
      { id: '2', name: 'repo_manager-apply_patch', arguments: {}, error: 'ENOENT' }, // failed
    ];
    // 1 successful counted, 1 failed counted → total counted successful = 1
    const result = validateCountedTools(toolCalls, {
      minimum: 2,
      counted_tools: ['repo_manager.write_file', 'repo_manager.apply_patch'],
    });
    expect(result.valid).toBe(false);
  });

  it('ANTI-THÉÂTRE: passes when enough successful counted calls', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-write_file', arguments: {} },          // success
      { id: '2', name: 'repo_manager-apply_patch', arguments: {} },          // success
      { id: '3', name: 'repo_manager-read_file', arguments: {}, error: 'ENOENT' }, // failed, not counted
    ];
    const result = validateCountedTools(toolCalls, {
      minimum: 2,
      counted_tools: ['repo_manager.write_file', 'repo_manager.apply_patch'],
    });
    expect(result.valid).toBe(true);
  });
```

**Step 2: Run tests to verify new ones fail**

```bash
pnpm --filter @studio/ralph test
```

Expected: The three new ANTI-THÉÂTRE tests fail.

**Step 3: Update `validateCountedTools` in `ralph/src/validator.ts`**

Replace lines 95–112 with:

```typescript
export function validateCountedTools(toolCalls: ToolCall[], requirements?: ToolCallRequirements): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (requirements?.counted_tools && requirements.counted_tools.length > 0 && requirements?.minimum !== undefined) {
    const countedSet = new Set(requirements.counted_tools.map(normalizeToolName));
    const count = toolCalls.filter(
      tc => countedSet.has(normalizeToolName(tc.name)) && isSuccessfulToolCall(tc)
    ).length;

    if (count < requirements.minimum) {
      const toolNames = requirements.counted_tools.join(', ');
      errors.push(
        `Expected at least ${requirements.minimum} successful call${requirements.minimum === 1 ? '' : 's'} to counted tools [${toolNames}], got ${count}`
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
```

**Step 4: Run tests to verify they all pass**

```bash
pnpm --filter @studio/ralph test
```

Expected: All `validateCountedTools` tests pass.

**Step 5: Commit**

```bash
git add ralph/src/validator.ts ralph/tests/validator.test.ts
git commit -m "feat(ralph): validateCountedTools counts only successful calls (STU-121)"
```

---

### Task 4: Update engine call-site — TDD

**Files:**
- Modify: `engine/src/engine.ts` (line 918)

The engine passes `result.tool_calls_count` (a number) to `validateToolCalls`, which now expects `ToolCall[]`. This is a compile-time break — TypeScript will catch it. Fix the call-site.

**Step 1: Verify the build breaks**

```bash
pnpm build
```

Expected: TypeScript error in `engine/src/engine.ts` around line 918 — argument type `number` is not assignable to `ToolCall[]`.

**Step 2: Fix the call-site in `engine/src/engine.ts` line 918**

Change:

```typescript
validators.push((result) => validateToolCalls(result.tool_calls_count, toolCallReqs));
```

To:

```typescript
validators.push((result) => validateToolCalls(result.tool_calls, toolCallReqs));
```

**Step 3: Run build to verify it compiles**

```bash
pnpm build
```

Expected: Build succeeds.

**Step 4: Run all tests**

```bash
pnpm test
```

Expected: All tests pass across all packages.

**Step 5: Commit**

```bash
git add engine/src/engine.ts
git commit -m "fix(engine): pass tool_calls array (not count) to validateToolCalls (STU-121)"
```

---

### Task 5: Create branch + push PR

**Step 1: Verify you are not on main**

```bash
git branch --show-current
```

If on `main`, create the feature branch first:

```bash
git checkout -b arianedguay/stu-121-anti-theatre-exclure-les-tool-calls-failed-du-comptage
```

If the branch already exists (Linear generated it), check it out:

```bash
git checkout arianedguay/stu-121-anti-theatre-exclure-les-tool-calls-failed-du-comptage
```

**Step 2: Push**

```bash
git push -u origin arianedguay/stu-121-anti-theatre-exclure-les-tool-calls-failed-du-comptage
```

**Step 3: Create PR**

```bash
gh pr create \
  --title "feat(ralph): exclude failed tool calls from anti-théâtre minimum count (STU-121)" \
  --body "$(cat <<'EOF'
## What

`tool_calls.minimum` and `required_tools` now count only **successful** tool calls. A call is successful when `ToolCall.error` is falsy.

Previously, an agent could satisfy `minimum: 1` by making 4 failed `read_file` calls (ENOENT). That's exactly the theatre we're detecting.

## Why

STU-121. Anti-théâtre isn't just about detecting zero tool calls — it's about detecting zero *effective* tool calls.

## Packages touched

- `ralph` — three validator functions updated + tests
- `engine` — one call-site updated (`buildValidator`)

## Changes

- `validateToolCalls(toolCalls: ToolCall[], ...)` — was `(count: number, ...)`; filters to successful before counting
- `validateRequiredTools` — only successful calls to a required tool count; distinguishes "never called" vs "called but all failed" in error message
- `validateCountedTools` — only successful calls to counted tools count toward minimum
- `engine/buildValidator` — passes `result.tool_calls` instead of `result.tool_calls_count`

## How to test

```bash
pnpm build && pnpm test
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

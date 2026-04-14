# tool_calls.maximum Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `maximum` to `ToolCallRequirements` so contracts can declare an upper bound on successful tool calls, causing validation to fail with a loop-detection message when exceeded.

**Architecture:** `maximum` is added to the `ToolCallRequirements` interface in `@studio-foundation/contracts` (leaf package, no deps). The check lives in `validateToolCalls()` in `@studio-foundation/ralph`, alongside the existing `minimum` check, operating on the same `successfulCount`. Injection into RALPH retry context is free — the existing `allFailures` accumulator in `loop.ts` already forwards validation errors to the next attempt.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces

---

### Task 1: Add `maximum` to `ToolCallRequirements` in contracts

**Files:**
- Modify: `contracts/src/validation.ts:3-8`

**Step 1: Add the field**

Open [contracts/src/validation.ts](contracts/src/validation.ts). The current interface is:

```typescript
export interface ToolCallRequirements {
  minimum?: number;
  required_tools?: string[];
  required_tool_groups?: string[][];
  counted_tools?: string[];
}
```

Change it to:

```typescript
export interface ToolCallRequirements {
  minimum?: number;
  maximum?: number;
  required_tools?: string[];
  required_tool_groups?: string[][];
  counted_tools?: string[];
}
```

**Step 2: Build contracts to confirm no TypeScript errors**

Run from worktree root:
```bash
pnpm --filter @studio-foundation/contracts build
```
Expected: no errors, `contracts/dist/` updated.

**Step 3: Commit**

```bash
git add contracts/src/validation.ts
git commit -m "feat(contracts): add maximum to ToolCallRequirements"
```

---

### Task 2: Write failing tests for `maximum` in ralph

**Files:**
- Modify: `ralph/tests/validator.test.ts` — add cases inside `describe('validateToolCalls')`

**Step 1: Add the failing tests**

In [ralph/tests/validator.test.ts](ralph/tests/validator.test.ts), inside the existing `describe('validateToolCalls', () => {` block (after the last existing test at line ~156), add:

```typescript
  // --- maximum ---

  it('passes when successful calls are below maximum', () => {
    const result = validateToolCalls([success('1'), success('2')], { maximum: 5 });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when successful calls equal maximum', () => {
    const result = validateToolCalls([success('1'), success('2'), success('3')], { maximum: 3 });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when successful calls exceed maximum', () => {
    const calls = Array.from({ length: 11 }, (_, i) => success(String(i)));
    const result = validateToolCalls(calls, { maximum: 10 });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('error message includes actual count and maximum', () => {
    const calls = Array.from({ length: 17 }, (_, i) => success(String(i)));
    const result = validateToolCalls(calls, { maximum: 10 });
    expect(result.errors[0]).toContain('17');
    expect(result.errors[0]).toContain('10');
  });

  it('error message mentions loop', () => {
    const calls = Array.from({ length: 11 }, (_, i) => success(String(i)));
    const result = validateToolCalls(calls, { maximum: 10 });
    expect(result.errors[0]).toContain('loop');
  });

  it('maximum counts only successful calls (failed excluded)', () => {
    // 8 successful + 5 failed = 13 total, but only 8 count against maximum
    const calls = [
      ...Array.from({ length: 8 }, (_, i) => success(String(i))),
      ...Array.from({ length: 5 }, (_, i) => failed(String(i + 100))),
    ];
    const result = validateToolCalls(calls, { maximum: 9 });
    expect(result.valid).toBe(true);
  });

  it('maximum works independently of minimum', () => {
    const calls = Array.from({ length: 15 }, (_, i) => success(String(i)));
    const result = validateToolCalls(calls, { maximum: 10 });
    expect(result.valid).toBe(false);
    // minimum not set — only maximum error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('loop');
  });

  it('minimum and maximum can both fail simultaneously', () => {
    // 0 calls → below minimum (1) and... wait, 0 is not above any max
    // Use case: minimum=2, maximum=1 (misconfigured contract, but still valid to test)
    // Actually let's test: 5 calls, minimum=10, maximum=3
    const calls = Array.from({ length: 5 }, (_, i) => success(String(i)));
    const result = validateToolCalls(calls, { minimum: 10, maximum: 3 });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter @studio-foundation/ralph test
```
Expected: new tests fail with errors like "maximum is not a property" or check failures.

**Step 3: Commit the failing tests**

```bash
git add ralph/tests/validator.test.ts
git commit -m "test(ralph): failing tests for tool_calls.maximum"
```

---

### Task 3: Implement `maximum` check in `validateToolCalls`

**Files:**
- Modify: `ralph/src/validator.ts:50-68`

**Step 1: Refactor `successfulCount` out of the `minimum` if-block, then add `maximum` check**

Current code in [ralph/src/validator.ts](ralph/src/validator.ts:50-68):

```typescript
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

Replace with:

```typescript
export function validateToolCalls(toolCalls: ToolCall[], requirements?: ToolCallRequirements): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const successfulCount = toolCalls.filter(isSuccessfulToolCall).length;
  const failedCount = toolCalls.length - successfulCount;

  if (requirements?.minimum !== undefined) {
    if (successfulCount < requirements.minimum) {
      const plural = requirements.minimum === 1 ? '' : 's';
      const excluded = failedCount > 0 ? ` (${failedCount} failed excluded)` : '';
      errors.push(
        `Expected at least ${requirements.minimum} successful tool call${plural}, got ${successfulCount} successful${excluded}`
      );
    }
  }

  if (requirements?.maximum !== undefined) {
    if (successfulCount > requirements.maximum) {
      const plural = successfulCount === 1 ? '' : 's';
      errors.push(
        `Tool call limit exceeded: made ${successfulCount} successful call${plural}, maximum is ${requirements.maximum}. ` +
        `This may indicate a loop. Check that the agent is not repeating the same operation.`
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
```

**Step 2: Run all ralph tests**

```bash
pnpm --filter @studio-foundation/ralph test
```
Expected: all 84 + 8 new = 92 tests pass, 0 failures.

**Step 3: Commit**

```bash
git add ralph/src/validator.ts
git commit -m "feat(ralph): validate tool_calls.maximum to detect agent loops"
```

---

### Task 4: Full build + test suite

**Step 1: Build entire monorepo**

From worktree root:
```bash
pnpm build
```
Expected: all packages build cleanly, no TypeScript errors.

**Step 2: Run full test suite**

```bash
pnpm test
```
Expected: all tests pass across all packages (contracts, anonymizer, ralph, runner, engine, api, cli).

**Step 3: If everything passes, commit nothing** (no changes needed — this step is a verification gate).

If something fails, investigate before continuing.

---

### Task 5: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — section "Contract avec Anti-théâtre (code-generation)"

**Step 1: Find the section**

In [CLAUDE.md](CLAUDE.md), find this block:

```yaml
name: code-generation
version: 1
schema:
  required_fields:
    - summary
    - files_changed
tool_calls:
  minimum: 1
  required_tools:
    - repo_manager.write_file       # Format avec point dans le YAML
```

**Step 2: Add `maximum`**

Replace with:

```yaml
name: code-generation
version: 1
schema:
  required_fields:
    - summary
    - files_changed
tool_calls:
  minimum: 1
  maximum: 15    # Fail si l'agent fait plus de 15 appels réussis (détection de boucle)
  required_tools:
    - repo_manager.write_file       # Format avec point dans le YAML
```

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): document tool_calls.maximum in contract example"
```

---

### Task 6: Final verification

**Step 1: Run full test suite one last time**

```bash
pnpm test
```
Expected: all tests pass.

**Step 2: Check git log**

```bash
git log --oneline -6
```
Expected: 5 commits on top of main:
```
docs(claude-md): document tool_calls.maximum in contract example
feat(ralph): validate tool_calls.maximum to detect agent loops
test(ralph): failing tests for tool_calls.maximum
feat(contracts): add maximum to ToolCallRequirements
docs(plans): design doc for STU-186 tool_calls.maximum
```

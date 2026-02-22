# STU-96: Static Analysis Hooks — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend `on_stage_complete` hook templates to support `{{output.<field>}}` so that hooks can reference stage output fields (e.g. `files_changed`), then wire up `tsc`/ESLint hooks on `code-generation` in the feature-builder pipeline.

**Architecture:** Extend `renderHookCommand` in `hook-executor.ts` with an optional `outputContext` param. In `engine.ts`, thread the last agent output into `runStageHook` calls in the `on_stage_complete` loop. Update the pipeline YAML to add the static analysis hooks.

**Tech Stack:** TypeScript, Node.js child_process, Vitest, YAML

---

### Task 1: Extend `renderHookCommand` with `{{output.<field>}}` support

**Files:**
- Modify: `engine/src/pipeline/hook-executor.test.ts`
- Modify: `engine/src/pipeline/hook-executor.ts`

**Step 1: Write the failing tests**

Add to `engine/src/pipeline/hook-executor.test.ts`, inside the existing `describe('renderHookCommand', ...)` block:

```typescript
  it('substitutes {{output.field}} with value from outputContext', () => {
    const result = renderHookCommand(
      'npx eslint {{output.files_changed}}',
      {},
      { files_changed: 'src/foo.ts' }
    );
    expect(result).toBe('npx eslint src/foo.ts');
  });

  it('space-joins array values from outputContext', () => {
    const result = renderHookCommand(
      'npx eslint {{output.files_changed}}',
      {},
      { files_changed: ['src/foo.ts', 'src/bar.ts'] }
    );
    expect(result).toBe('npx eslint src/foo.ts src/bar.ts');
  });

  it('returns empty string for missing output field', () => {
    const result = renderHookCommand(
      'npx eslint {{output.missing}}',
      {},
      {}
    );
    expect(result).toBe('npx eslint ');
  });

  it('handles mixed {{tool.*}} and {{output.*}} in same command', () => {
    const result = renderHookCommand(
      'run {{tool.script}} on {{output.files_changed}}',
      { script: 'check.sh' },
      { files_changed: 'src/foo.ts' }
    );
    expect(result).toBe('run check.sh on src/foo.ts');
  });

  it('leaves {{tool.*}} unchanged when outputContext not provided', () => {
    const result = renderHookCommand('echo {{tool.path}}', { path: 'x.ts' });
    expect(result).toBe('echo x.ts');
  });
```

**Step 2: Run tests to verify they fail**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio/engine test -- --reporter=verbose 2>&1 | grep -A3 "output"
```

Expected: TypeScript compilation error — `renderHookCommand` doesn't accept 3 arguments yet.

**Step 3: Implement the extension in `hook-executor.ts`**

Replace the `renderHookCommand` function with:

```typescript
/**
 * Renders {{tool.argName}} and {{output.field}} placeholders.
 * Arrays in outputContext are space-joined (CLI-safe).
 * Unknown keys → empty string.
 */
export function renderHookCommand(
  command: string,
  toolArgs: Record<string, unknown>,
  outputContext: Record<string, unknown> = {}
): string {
  return command
    .replace(
      /\{\{tool\.(\w+)\}\}/g,
      (_, key: string) => (toolArgs[key] !== undefined ? String(toolArgs[key]) : '')
    )
    .replace(/\{\{output\.(\w+)\}\}/g, (_, key: string) => {
      const val = outputContext[key];
      if (val === undefined) return '';
      if (Array.isArray(val)) return val.join(' ');
      return String(val);
    });
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio/engine test -- --reporter=verbose 2>&1 | grep -E "✓|✗|PASS|FAIL"
```

Expected: all `renderHookCommand` tests pass.

**Step 5: Commit**

```bash
git add engine/src/pipeline/hook-executor.ts engine/src/pipeline/hook-executor.test.ts
git commit -m "feat(engine): extend renderHookCommand with {{output.*}} template support"
```

---

### Task 2: Extend `runStageHook` to accept `outputContext`

**Files:**
- Modify: `engine/src/pipeline/hook-executor.test.ts`
- Modify: `engine/src/pipeline/hook-executor.ts`

**Step 1: Write the failing test**

Add to `engine/src/pipeline/hook-executor.test.ts`, inside `describe('runStageHook', ...)`:

```typescript
  it('resolves {{output.files_changed}} from outputContext in command', async () => {
    const result = await runStageHook(
      { command: 'echo {{output.files_changed}}', on_failure: 'warn' },
      '/tmp',
      { files_changed: ['src/foo.ts', 'src/bar.ts'] }
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('src/foo.ts src/bar.ts');
  });
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @studio/engine test -- --reporter=verbose 2>&1 | grep -A3 "runStageHook"
```

Expected: TypeScript error — `runStageHook` doesn't accept 3 arguments.

**Step 3: Update `runStageHook` in `hook-executor.ts`**

Replace the `runStageHook` function:

```typescript
/**
 * Run a stage-level hook command (on_stage_start, on_stage_complete).
 * outputContext provides {{output.<field>}} substitution values.
 */
export async function runStageHook(
  hook: StageHookDef,
  cwd: string,
  outputContext: Record<string, unknown> = {}
): Promise<HookResult> {
  const command = renderHookCommand(hook.command, {}, outputContext);
  return execHook(command, cwd);
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio/engine test -- --reporter=verbose
```

Expected: all `hook-executor` tests pass.

**Step 5: Commit**

```bash
git add engine/src/pipeline/hook-executor.ts engine/src/pipeline/hook-executor.test.ts
git commit -m "feat(engine): pass outputContext to runStageHook for {{output.*}} resolution"
```

---

### Task 3: Thread stage output into `on_stage_complete` hooks in `engine.ts`

**Files:**
- Modify: `engine/tests/engine.test.ts`
- Modify: `engine/src/engine.ts`

**Step 1: Write the failing integration test**

Add a new fixture pipeline and test to `engine/tests/engine.test.ts`.

First, add the fixture setup inside `setupTestFixtures()` (add after the existing fixtures):

```typescript
  writeFileSync(join(PIPELINES_DIR, 'hook-output-template.pipeline.yaml'), `
name: hook-output-template
description: Pipeline with on_stage_complete hook using output template
version: 1
stages:
  - name: analysis
    kind: analysis
    agent: test-agent
    contract: test-contract
    hooks:
      on_stage_complete:
        - command: "sh -c 'test -n \\'{{output.files_changed}}\\''  "
          on_failure: reject
    ralph:
      max_attempts: 1
      retry_strategy: none
    context:
      include:
        - input
`);
```

> Note: The mock provider already returns `files_changed: ['file.ts']` in its output. With `{{output.files_changed}}` resolved to `'file.ts'`, `test -n 'file.ts'` exits 0 → stage succeeds. Without the fix, `{{output.files_changed}}` would be left unresolved and `test -n '{{output.files_changed}}'` would still exit 0 (non-empty literal string). So use a more specific test below.

Instead, use a fixture that is guaranteed to **fail** without the fix and **succeed** with it:

```typescript
  // This command exits 0 only if {{output.files_changed}} resolved to exactly 'file.ts'
  writeFileSync(join(PIPELINES_DIR, 'hook-output-template.pipeline.yaml'), `
name: hook-output-template
description: Pipeline with on_stage_complete hook using output template
version: 1
stages:
  - name: analysis
    kind: analysis
    agent: test-agent
    contract: test-contract
    hooks:
      on_stage_complete:
        - command: "sh -c '[ \\"{{output.files_changed}}\\" = \\"file.ts\\" ] || exit 1'"
          on_failure: reject
    ralph:
      max_attempts: 1
      retry_strategy: none
    context:
      include:
        - input
`);
```

Then add the test:

```typescript
  it('on_stage_complete hook resolves {{output.*}} from stage output', async () => {
    const engine = createTestEngine();
    const result = await engine.run({
      pipeline: 'hook-output-template',
      input: 'test',
    });

    // The hook command checks that {{output.files_changed}} == 'file.ts'
    // The mock provider returns files_changed: ['file.ts']
    // If the template is resolved correctly, the hook exits 0 → stage succeeds
    expect(result.status).toBe('success');
    expect(result.stages[0].status).toBe('success');
  });
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @studio/engine test -- --reporter=verbose 2>&1 | tail -20
```

Expected: test fails — stage is `rejected` because `{{output.files_changed}}` is not yet resolved (literal string doesn't equal `file.ts`).

**Step 3: Update `engine.ts` to thread output context**

In `engine.ts`, find the `on_stage_complete` hook loop (around line 619). It looks like:

```typescript
    // Run on_stage_complete hooks — only when stage succeeded (including post-validation)
    if (stageStatus === 'success' && stageHooks?.on_stage_complete?.length) {
      for (const hook of stageHooks.on_stage_complete) {
        const hookResult = await runStageHook(hook, hookCwd);
```

Extract the output context from the ralph result and pass it:

```typescript
    // Run on_stage_complete hooks — only when stage succeeded (including post-validation)
    if (stageStatus === 'success' && stageHooks?.on_stage_complete?.length) {
      const stageOutput = ralphResult.status === 'success'
        ? (ralphResult.result?.output as Record<string, unknown> ?? {})
        : {};
      for (const hook of stageHooks.on_stage_complete) {
        const hookResult = await runStageHook(hook, hookCwd, stageOutput);
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio/engine test -- --reporter=verbose
```

Expected: all engine tests pass, including the new `on_stage_complete` template test.

**Step 5: Build to check TypeScript**

```bash
pnpm build
```

Expected: clean build, no errors.

**Step 6: Commit**

```bash
git add engine/src/engine.ts engine/tests/engine.test.ts
git commit -m "feat(engine): thread stage output into on_stage_complete hook template context"
```

---

### Task 4: Update feature-builder pipeline YAML fixtures

**Files:**
- Modify: `engine/tests/fixtures/software/pipelines/feature-builder.pipeline.yaml`
- Modify: `cli/templates/projects/software/pipelines/feature-builder.pipeline.yaml`

**Step 1: Add hooks to the engine test fixture**

In `engine/tests/fixtures/software/pipelines/feature-builder.pipeline.yaml`, add `hooks` to the `code-generation` stage (inside the `implementation-review` group):

```yaml
      - name: code-generation
        kind: code_generation
        agent: coder
        contract: code-generation
        hooks:
          on_stage_complete:
            - command: "npx tsc --noEmit"
              on_failure: reject
            - command: "npx eslint --rule 'no-empty-catch: error' --rule 'no-unused-vars: warn' {{output.files_changed}}"
              on_failure: reject
        ralph:
          max_attempts: 5
          ...
```

**Step 2: Add hooks to the CLI template**

Do the same in `cli/templates/projects/software/pipelines/feature-builder.pipeline.yaml`.

**Step 3: Run all tests**

```bash
pnpm test
```

Expected: all tests pass. The engine fixture won't actually invoke `npx tsc` because that requires a real project — the fixture tests mock the LLM call but don't run the group hooks in the existing group-loop tests (the hooks only run if the fixture is used in an engine test that exercises the group).

> If any fixture-based test breaks (e.g., group-loop tests run tsc and fail because there's no tsconfig), you'll need to modify the fixture to use a simpler hook command in the test context. In that case, keep the real hooks only in the CLI template and use a different fixture for the engine tests.

**Step 4: Commit**

```bash
git add engine/tests/fixtures/software/pipelines/feature-builder.pipeline.yaml \
        cli/templates/projects/software/pipelines/feature-builder.pipeline.yaml
git commit -m "feat(config): add static analysis hooks to feature-builder code-generation stage"
```

---

### Task 5: Full test run and verification

**Step 1: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass.

**Step 2: Build**

```bash
pnpm build
```

Expected: clean build.

**Step 3: Verify acceptance criteria manually**

Check that the four acceptance criteria from the design doc are covered:
- [ ] `{{output.files_changed}}` with array → space-joined (Task 1 unit test)
- [ ] `on_stage_complete` hook failure → stage `rejected`, stderr in `rejection_details` (engine integration test)
- [ ] `on_stage_complete` hook resolves output template (Task 3 integration test)
- [ ] Pipeline YAMLs have tsc + eslint hooks on code-generation (Task 4)

**Step 4: Final commit if any stray changes**

```bash
git status
# If clean, nothing to do
```

---

## Summary

| Task | Files changed | Commit message |
|------|--------------|----------------|
| 1 | `hook-executor.ts`, `hook-executor.test.ts` | `feat(engine): extend renderHookCommand with {{output.*}} template support` |
| 2 | `hook-executor.ts`, `hook-executor.test.ts` | `feat(engine): pass outputContext to runStageHook for {{output.*}} resolution` |
| 3 | `engine.ts`, `engine.test.ts` | `feat(engine): thread stage output into on_stage_complete hook template context` |
| 4 | two `feature-builder.pipeline.yaml` | `feat(config): add static analysis hooks to feature-builder code-generation stage` |
| 5 | — | (verification only) |

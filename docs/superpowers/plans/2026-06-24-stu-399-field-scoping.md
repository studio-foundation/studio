# STU-399 Field-Scoped Anonymization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the calling app declare which structured input fields to anonymize (an opaque *scope*), while the kernel tokenizes only those fields and passes the rest through as cleartext.

**Architecture:** STU-398 made `AnonymizationMiddleware.anonymizeFields(fields)` anonymize every field with one shared run-level keymap. This adds an optional `scope: string[]` parameter that gates which fields are detected at all; threads an opaque `anonymize_fields?: string[]` list through `TaskInput` (contracts) → `runAgent` (runner) → `buildTaskInput` (engine). Out-of-scope fields are copied byte-for-byte and never reach the detector.

**Tech Stack:** TypeScript, pnpm workspaces, vitest. Packages: `runner`, `contracts`, `engine`.

## Global Constraints

- **Domain-agnostic kernel (INV-04):** no kernel code may branch on a field name's *meaning*. Scope is a pure set-membership check on opaque strings.
- **Three-state scope semantics (verbatim):** `undefined` → anonymize **all** fields (fail-safe); `[]` → anonymize **none**; `['a','c']` → only those fields.
- **Correctness property (non-negotiable):** out-of-scope fields are copied byte-for-byte and are **NEVER** passed to the detector — not "detected but replacement skipped". This keeps their PII out of the tokenizer's inverse map so it cannot collide with a value tokenized in an in-scope field.
- **Backward compatibility:** the `description` (flat) path and existing `anonymizeFields(fields)` callers must keep working. `hasFields()` stays the single source of truth for the structured-vs-flat branch.
- **Build/test:** run from worktree root `/home/arianeguay/dev/src/Studio/.worktrees/feat/stu-399-field-scoping`. Per-package test: `pnpm --filter @studio-foundation/<pkg> test`. Conventional commits, `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

### Task 1: Middleware scope parameter

The core behavioral change. Adds `scope?: string[]` to `anonymizeFields`; out-of-scope fields are copied verbatim with no detector call.

**Files:**
- Modify: `runner/src/middleware/anonymization.ts:33-51` (JSDoc + `anonymizeFields` signature/body)
- Test: `runner/tests/anonymize-fields.test.ts` (append new `describe` block)

**Interfaces:**
- Consumes: existing `AnonymizationMiddleware` (`anonymize`, `deanonymize`, `getKeymap`), `anonymizeWithProvider`, `this.detector`, `this.keymap`, `this.options`.
- Produces: `anonymizeFields(fields: Record<string, string>, scope?: string[]): Promise<Record<string, string>>` — consumed by Task 2 (runner).

- [ ] **Step 1: Write the failing tests**

Append to `runner/tests/anonymize-fields.test.ts`:

```typescript
describe('AnonymizationMiddleware.anonymizeFields scope', () => {
  it('AC1/AC3: with a scope, only scoped fields are tokenized; others stay cleartext', async () => {
    const mw = new AnonymizationMiddleware();
    const out = await mw.anonymizeFields(
      { from: 'mc@acme.com', body: 'Reply to jane@acme.com' },
      ['body'],
    );
    // body is in scope → tokenized
    expect(out.body).toContain('EMAIL_1');
    expect(out.body).not.toContain('jane@acme.com');
    // from is out of scope → byte-for-byte cleartext
    expect(out.from).toBe('mc@acme.com');
  });

  it('AC4: same PII in a scoped AND an unscoped field — full deanonymize round-trip', async () => {
    const mw = new AnonymizationMiddleware();
    // mc@acme.com appears in both `from` (out of scope) and `body` (in scope)
    const out = await mw.anonymizeFields(
      { from: 'mc@acme.com', body: 'Forward to mc@acme.com' },
      ['body'],
    );

    // (1) token in the scoped field, real value in the unscoped field
    expect(out.body).toContain('EMAIL_1');
    expect(out.body).not.toContain('mc@acme.com');
    expect(out.from).toBe('mc@acme.com');

    // (2) a simulated LLM response that references the token reconstructs the real value
    const llmResponse = 'Sent the message to EMAIL_1 as requested.';
    expect(mw.deanonymize(llmResponse)).toBe('Sent the message to mc@acme.com as requested.');

    // (3) the cleartext occurrence that passed through the unscoped field did not
    // pollute the keymap: exactly one mapping, EMAIL_1 → mc@acme.com, no EMAIL_2
    const keymap = mw.getKeymap();
    expect(keymap).toEqual({ EMAIL_1: 'mc@acme.com' });
  });

  it('scope undefined → all fields anonymized (fail-safe default)', async () => {
    const mw = new AnonymizationMiddleware();
    const out = await mw.anonymizeFields({ from: 'mc@acme.com', body: 'Hi jane@acme.com' });
    expect(out.from).not.toContain('mc@acme.com');
    expect(out.body).not.toContain('jane@acme.com');
  });

  it('scope [] → nothing anonymized, every field cleartext', async () => {
    const mw = new AnonymizationMiddleware();
    const out = await mw.anonymizeFields({ from: 'mc@acme.com', body: 'Hi jane@acme.com' }, []);
    expect(out).toEqual({ from: 'mc@acme.com', body: 'Hi jane@acme.com' });
    expect(mw.getKeymap()).toEqual({});
  });

  it('unknown names in scope are ignored (no-op, no crash)', async () => {
    const mw = new AnonymizationMiddleware();
    const out = await mw.anonymizeFields({ body: 'Hi jane@acme.com' }, ['nonexistent']);
    // 'body' not in scope → cleartext; 'nonexistent' simply matches nothing
    expect(out).toEqual({ body: 'Hi jane@acme.com' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @studio-foundation/runner test anonymize-fields`
Expected: FAIL — the AC1/AC3, AC4, `[]`, and unknown-name cases fail because `anonymizeFields` currently anonymizes every field regardless of the second argument.

- [ ] **Step 3: Implement the scope gate**

In `runner/src/middleware/anonymization.ts`, replace the `anonymizeFields` JSDoc + method (lines 33-51) with:

```typescript
  /**
   * Anonymize named input fields independently, BEFORE prompt assembly. Each
   * in-scope field is detected + tokenized through the injected
   * DetectionProvider, all sharing this instance's run-level keymap — so a PII
   * value appearing in two in-scope fields receives the SAME token.
   *
   * `scope` is an OPAQUE list of field names to anonymize: undefined → all
   * fields (fail-safe); [] → none; ['a'] → only field `a`. Out-of-scope fields
   * are copied byte-for-byte and are NEVER passed to the detector, so their PII
   * cannot enter the keymap and collide with a value tokenized elsewhere.
   * Membership is a set check on opaque names — the kernel never branches on
   * what a name means (INV-04). Async because DetectionProvider.detect is async.
   */
  async anonymizeFields(
    fields: Record<string, string>,
    scope?: string[],
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(fields)) {
      // Out of scope → copy verbatim, no detection. Undefined scope = all in.
      if (scope !== undefined && !scope.includes(name)) {
        out[name] = value;
        continue;
      }
      const result = await anonymizeWithProvider(value, this.detector, {
        ...this.options,
        seedKeymap: this.keymap,
      });
      // Carry the accumulated keymap forward so the next field reuses tokens.
      this.keymap = result.keymap;
      out[name] = result.text;
    }
    return out;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @studio-foundation/runner test anonymize-fields`
Expected: PASS — all scope tests plus the pre-existing `anonymizeFields` tests (undefined-scope behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add runner/src/middleware/anonymization.ts runner/tests/anonymize-fields.test.ts
git commit -m "feat(anonymizer): field scope param on anonymizeFields (STU-399)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Thread the opaque scope through TaskInput and the runner

Adds `anonymize_fields?: string[]` to the `TaskInput` contract and passes it from `runAgent` into `anonymizeFields`.

**Files:**
- Modify: `contracts/src/task.ts:17-22` (add field to `TaskInput`)
- Modify: `runner/src/runner.ts:79` (pass `task.anonymize_fields`)
- Test: `runner/tests/runner-anonymization-fields.test.ts` (append AC5 test)

**Interfaces:**
- Consumes: `anonymizeFields(fields, scope?)` from Task 1; `hasFields(task)` from `prompt-builder.ts`.
- Produces: `TaskInput.anonymize_fields?: string[]` — consumed by Task 3 (engine).

- [ ] **Step 1: Write the failing test (AC5 — cleartext field survives to the prompt)**

Append to `runner/tests/runner-anonymization-fields.test.ts` (inside the existing `describe('runAgent with structured-field anonymization', ...)` block):

```typescript
  it('AC5: out-of-scope field reaches the prompt as cleartext (deterministic stage survives)', async () => {
    const provider = new MockProvider('{"result":"ok"}');
    await runAgent({
      agent: { name: 'test', provider: 'mock', model: 'x' },
      task: {
        description: '',
        fields: { from: 'mc@acme.com', body: 'Reply to jane@acme.com' },
        anonymize_fields: ['body'], // only body in scope; from stays clear
      },
      context: {},
      toolRegistry: new ToolRegistry(),
      providerRegistry: registryWith(provider),
      anonymizationMiddleware: new AnonymizationMiddleware(),
    });

    const promptText = provider.capturedRequests[0].messages.map(m => m.content).join(' ');
    // from is out of scope → its real address is present for a cleartext pass
    expect(promptText).toContain('mc@acme.com');
    // body is in scope → tokenized, real address absent
    expect(promptText).toContain('EMAIL_1');
    expect(promptText).not.toContain('jane@acme.com');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @studio-foundation/runner test runner-anonymization-fields`
Expected: FAIL — `anonymize_fields` is not yet a known `TaskInput` property (type error) and/or the runner ignores it, so `mc@acme.com` is tokenized out of the prompt.

- [ ] **Step 3a: Add the field to the contract**

In `contracts/src/task.ts`, the `TaskInput` interface (lines 17-22) becomes:

```typescript
export interface TaskInput {
  description: string;
  fields?: Record<string, string>;
  /**
   * Opaque scope: names of `fields` to anonymize. Treated as opaque strings —
   * the kernel imposes no domain meaning (INV-04). Undefined → anonymize all
   * fields (fail-safe); [] → anonymize none; ['a'] → only field `a`. Ignored
   * when `fields` is absent.
   */
  anonymize_fields?: string[];
  expected_output?: string;
  contract_name?: string;
}
```

- [ ] **Step 3b: Pass the scope in the runner**

In `runner/src/runner.ts`, line 79, replace:

```typescript
      taskForPrompt = { ...task, fields: await mw.anonymizeFields(task.fields!) };
```

with:

```typescript
      taskForPrompt = { ...task, fields: await mw.anonymizeFields(task.fields!, task.anonymize_fields) };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @studio-foundation/runner test runner-anonymization-fields`
Expected: PASS — including the three pre-existing tests in the file (no `anonymize_fields` → undefined → all fields anonymized, unchanged).

- [ ] **Step 5: Commit**

```bash
git add contracts/src/task.ts runner/src/runner.ts runner/tests/runner-anonymization-fields.test.ts
git commit -m "feat(anonymizer): thread opaque anonymize_fields scope through runner (STU-399)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Engine `buildTaskInput` propagates the scope

`buildTaskInput` gains an optional scope argument and sets `anonymize_fields` on the produced `TaskInput`. The *source* of the scope (CLI/input.yaml/API + the app's policy→fields mapping) is deferred to STU-393; the existing caller `stage-executor.ts:337` stays valid by passing no scope.

**Files:**
- Modify: `engine/src/pipeline/task-input.ts:11-24` (add optional param, set `anonymize_fields`)
- Test: `engine/src/pipeline/task-input.test.ts` (append two cases)

**Interfaces:**
- Consumes: `TaskInput.anonymize_fields?: string[]` from Task 2.
- Produces: `buildTaskInput(userInput, contractName?, anonymizeFields?: string[]): TaskInput`.

- [ ] **Step 1: Write the failing tests**

Append to `engine/src/pipeline/task-input.test.ts` (inside the existing `describe('buildTaskInput', ...)` block):

```typescript
  it('propagates an opaque anonymize scope onto a record input', () => {
    const t = buildTaskInput({ from: 'mc@acme.com', body: 'hi' }, 'c', ['body']);
    expect(t.anonymize_fields).toEqual(['body']);
    expect(t.fields).toEqual({ from: 'mc@acme.com', body: 'hi' });
  });

  it('leaves anonymize_fields undefined when no scope is given', () => {
    const t = buildTaskInput({ from: 'mc@acme.com' }, 'c');
    expect(t.anonymize_fields).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @studio-foundation/engine test task-input`
Expected: FAIL — `buildTaskInput` accepts only two arguments, so the third is a type error / `anonymize_fields` is undefined when a scope is passed.

- [ ] **Step 3: Add the optional scope parameter**

In `engine/src/pipeline/task-input.ts`, replace the function (lines 11-24) with:

```typescript
export function buildTaskInput(
  userInput: string | Record<string, unknown>,
  contractName?: string,
  anonymizeFields?: string[],
): TaskInput {
  if (typeof userInput === 'string') {
    return { description: userInput, contract_name: contractName };
  }

  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(userInput)) {
    fields[name] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return { description: '', fields, contract_name: contractName, anonymize_fields: anonymizeFields };
}
```

Also update the JSDoc above the function to note the third argument:

```typescript
/**
 * Build the runner's {@link TaskInput} from a pipeline input.
 *
 * A string input becomes the flat `description` (the default path). A record
 * input is kept as named `fields` so anonymization can address each field
 * before prompt assembly — field names are OPAQUE to the engine (no domain
 * meaning). Non-string field values are stringified so every field is text.
 *
 * `anonymizeFields` is an optional opaque scope (field names to anonymize),
 * propagated onto the TaskInput unchanged; the engine never interprets it.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @studio-foundation/engine test task-input`
Expected: PASS — including the four pre-existing `buildTaskInput` cases (the string path still returns `{ description, contract_name }`; `toEqual` ignores the `undefined` `anonymize_fields` on the record path).

- [ ] **Step 5: Full build + full test sweep, then commit**

```bash
pnpm build
pnpm --filter @studio-foundation/anonymizer --filter @studio-foundation/runner --filter @studio-foundation/engine --filter @studio-foundation/contracts test
git add engine/src/pipeline/task-input.ts engine/src/pipeline/task-input.test.ts
git commit -m "feat(anonymizer): buildTaskInput propagates opaque anonymize scope (STU-399)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Expected: `pnpm build` clean (confirms `stage-executor.ts:337`'s two-arg call still type-checks against the new optional param); all four packages green.

---

## Acceptance-criteria traceability

| AC | Covered by |
|---|---|
| AC1 — middleware anonymizes only scoped fields | Task 1 (AC1/AC3 test) |
| AC2 — field names opaque (no business branch) | Task 1 + Task 2 + Task 3 (set-membership only; review) |
| AC3 — partial mode correct (token in scoped, real in unscoped) | Task 1 (AC1/AC3 test) |
| AC4 — shared keymap, full deanonymize round-trip, no pollution | Task 1 (AC4 test) |
| AC5 — deterministic cleartext stage unaffected by scope | Task 2 (AC5 runner test) |
| three-state semantics (`undefined`/`[]`/list) | Task 1 |
| engine passthrough | Task 3 |

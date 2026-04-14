# Engine Domain-Agnostic Refactor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all domain-specific knowledge (software dev, QA, code generation) from `@studio-foundation/engine` so it can orchestrate any pipeline without code changes.

**Architecture:** 6 targeted changes across `contracts/src/` and `engine/src/`. No structural changes — same files, same APIs, same state machine. Replace hardcoded domain logic with generic equivalents and configurable contract fields.

**Tech Stack:** TypeScript, Vitest, YAML contracts

---

### Task 1: `StageKind` → `string`

**Files:**
- Modify: `contracts/src/stage.ts:5`

**Step 1: Change the type**

In `contracts/src/stage.ts`, replace:
```typescript
export type StageKind = 'analysis' | 'planning' | 'code_generation' | 'qa' | 'custom';
```
With:
```typescript
export type StageKind = string;
```

**Step 2: Build contracts**

Run: `cd /home/arianeguay/dev/src/Studio/contracts && npm run build`
Expected: PASS — no code depends on specific StageKind values at compile time.

**Step 3: Commit**

```bash
git add contracts/src/stage.ts
git commit -m "refactor(contracts): StageKind → string for domain-agnostic kinds"
```

---

### Task 2: `OutputContract` — replace `approval` with `post_validation`

**Files:**
- Modify: `contracts/src/validation.ts:15-18`

**Step 1: Replace the approval interface**

In `contracts/src/validation.ts`, replace:
```typescript
  approval?: {
    status_field: string;
    accepted_values: string[];
  };
```
With:
```typescript
  post_validation?: {
    rejection_detection: {
      field: string;
      rejected_values?: string[];
      approved_values?: string[];
      details_field?: string;
      summary_field?: string;
    };
  };
```

**Step 2: Build contracts**

Run: `cd /home/arianeguay/dev/src/Studio/contracts && npm run build`
Expected: PASS (consumers haven't been updated yet — they'll fail on their own builds).

**Step 3: Commit**

```bash
git add contracts/src/validation.ts
git commit -m "refactor(contracts): replace approval with post_validation.rejection_detection"
```

---

### Task 3: Update post-validator to use new config

**Files:**
- Modify: `engine/src/pipeline/post-validator.ts` (full rewrite of function body)
- Modify: `engine/src/engine.ts:429` (update `contract.approval` → `contract.post_validation`)

**Step 1: Rewrite `postValidate()` in `post-validator.ts`**

Replace the entire function body (lines 17-72) with:

```typescript
export function postValidate(
  output: unknown,
  contract: OutputContract
): PostValidationResult {
  // No post_validation config → everything is accepted
  if (!contract.post_validation?.rejection_detection) {
    return { accepted: true };
  }

  const { field, approved_values, rejected_values, details_field, summary_field } =
    contract.post_validation.rejection_detection;

  if (!field) {
    return { accepted: true };
  }

  // Extract field value from output
  if (!output || typeof output !== 'object') {
    return { accepted: true };
  }

  const o = output as Record<string, unknown>;
  const actualValue = o[field];

  if (typeof actualValue !== 'string') {
    return { accepted: true };
  }

  // Check approved values (if specified)
  if (approved_values?.length && approved_values.includes(actualValue)) {
    return { accepted: true };
  }

  // Check rejected values (if specified)
  if (rejected_values?.length && !rejected_values.includes(actualValue)) {
    // Value is not in rejected list and no approved list matched → accept
    if (!approved_values?.length) {
      return { accepted: true };
    }
  }

  // If we have approved_values and the value isn't in them → rejected
  // If we have rejected_values and the value is in them → rejected

  // Extract details from configured field
  const details: string[] = [];
  if (details_field) {
    const detailsValue = o[details_field];
    if (typeof detailsValue === 'string' && detailsValue.length > 0) {
      details.push(detailsValue);
    } else if (Array.isArray(detailsValue)) {
      for (const item of detailsValue) {
        if (typeof item === 'string') {
          details.push(item);
        } else if (typeof item === 'object' && item !== null) {
          const desc = (item as Record<string, unknown>).description;
          if (typeof desc === 'string') details.push(desc);
        }
      }
    }
  }

  // Extract summary from configured field
  const summary = summary_field && typeof o[summary_field] === 'string'
    ? (o[summary_field] as string)
    : undefined;

  return {
    accepted: false,
    rejection_reason: `Rejected: ${field} = "${actualValue}" (expected: ${(approved_values ?? []).join(' or ')})${summary ? `. ${summary}` : ''}`,
    rejection_details: details.length > 0 ? details : undefined,
  };
}
```

Also update the file comment at the top — remove "QA" references:
```typescript
// Post-validation sémantique
//
// Vérifie le CONTENU de l'output après que ralph a validé le FORMAT.
// Utilisé pour les stages avec une gate d'approbation — l'agent peut
// retourner un JSON valide qui dit quand même "non".
//
// Configuré dans le contract YAML via la section "post_validation".
```

**Step 2: Update engine.ts reference**

In `engine/src/engine.ts`, line 429, replace:
```typescript
    if (stageStatus === 'success' && contract?.approval) {
```
With:
```typescript
    if (stageStatus === 'success' && contract?.post_validation?.rejection_detection) {
```

**Step 3: Build engine**

Run: `cd /home/arianeguay/dev/src/Studio/engine && npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add engine/src/pipeline/post-validator.ts engine/src/engine.ts
git commit -m "refactor(engine): post-validator reads config from post_validation.rejection_detection"
```

---

### Task 4: `summarizeOutput()` → generic

**Files:**
- Modify: `engine/src/engine.ts:55-85` (function body)
- Modify: `engine/src/engine.ts:469` (call site — remove `stageDef.kind` arg)

**Step 1: Replace `summarizeOutput()` function**

Replace lines 55-85 with:
```typescript
function summarizeOutput(output: unknown): string {
  if (!output || typeof output !== 'object') return 'no structured output';
  const o = output as Record<string, unknown>;
  const keys = Object.keys(o);
  return `${keys.length} fields: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}`;
}
```

Remove the `StageKind` import if it's no longer used anywhere in engine.ts (check first — `stage_kind: stageDef.kind` on line 359 still uses it via the type on `StageDefinition`).

**Step 2: Update call site**

On line 469 (approximate — may shift after Task 3), replace:
```typescript
: lastResult ? summarizeOutput(lastResult.output, stageDef.kind) : undefined,
```
With:
```typescript
: lastResult ? summarizeOutput(lastResult.output) : undefined,
```

**Step 3: Build engine**

Run: `cd /home/arianeguay/dev/src/Studio/engine && npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add engine/src/engine.ts
git commit -m "refactor(engine): summarizeOutput is now generic — no stage kind switch"
```

---

### Task 5: `extractToolArgSummary()` → generic

**Files:**
- Modify: `engine/src/engine.ts:94-110`

**Step 1: Replace the function**

Replace lines 94-110 with:
```typescript
function extractToolArgSummary(tc: ToolCall): string {
  const args = tc.arguments as Record<string, unknown>;
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 60 ? value.slice(0, 60) + '...' : value;
    }
  }
  return '';
}
```

**Step 2: Build engine**

Run: `cd /home/arianeguay/dev/src/Studio/engine && npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add engine/src/engine.ts
git commit -m "refactor(engine): extractToolArgSummary is now generic — no tool name checks"
```

---

### Task 6: Context feedback → generic text

**Files:**
- Modify: `engine/src/pipeline/context-propagation.ts:90-108`

**Step 1: Replace the feedback text block**

In the `case 'group_feedback':` block (lines 87-114), replace the `lines` array construction (lines 90-108) with:

```typescript
        if (context.groupFeedback) {
          const fb = context.groupFeedback;
          const lines = [
            `\n## FEEDBACK (Iteration ${fb.iteration + 1}/${fb.max_iterations})`,
            ``,
            `The previous output was REJECTED.`,
            `Reason: ${fb.rejection_reason}`,
          ];

          if (fb.rejection_details?.length) {
            lines.push(``, `Issues:`);
            for (const detail of fb.rejection_details) {
              lines.push(`  - ${detail}`);
            }
          }

          lines.push(``, `Address all issues listed above.`);

          agentContext.additional_context =
            (agentContext.additional_context || '') + '\n' + lines.join('\n');
        }
```

**Step 2: Build engine**

Run: `cd /home/arianeguay/dev/src/Studio/engine && npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add engine/src/pipeline/context-propagation.ts
git commit -m "refactor(engine): group feedback text is now generic — no QA/implementation language"
```

---

### Task 7: Default fallback → `'Rejected'`

**Files:**
- Modify: `engine/src/engine.ts` — 3 occurrences of `'Rejected by QA'`

**Step 1: Replace all 3 occurrences**

Search for `'Rejected by QA'` in `engine/src/engine.ts` and replace with `'Rejected'`. These are on lines ~585, ~592, ~599 (approximate — may shift after earlier tasks).

**Step 2: Build engine**

Run: `cd /home/arianeguay/dev/src/Studio/engine && npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add engine/src/engine.ts
git commit -m "refactor(engine): default rejection fallback is generic — no QA reference"
```

---

### Task 8: Update contract YAML — `qa-review.contract.yaml`

**Files:**
- Modify: `engine/configs/contracts/qa-review.contract.yaml`

**Step 1: Replace approval config**

Replace:
```yaml
approval:
  status_field: status
  accepted_values:
    - approved
    - approved_with_notes
    - success
```

With:
```yaml
post_validation:
  rejection_detection:
    field: status
    approved_values:
      - approved
      - approved_with_notes
      - success
    rejected_values:
      - rejected
      - failed
      - implementation_incomplete
    details_field: issues
    summary_field: summary
```

**Step 2: Commit**

```bash
git add engine/configs/contracts/qa-review.contract.yaml
git commit -m "refactor(config): qa-review contract uses post_validation format"
```

---

### Task 9: Update test fixtures — group-loop.test.ts

**Files:**
- Modify: `engine/tests/group-loop.test.ts:27-39` (qa-gate contract fixture)

**Step 1: Update the qa-gate contract fixture**

Replace (lines 27-39):
```typescript
writeFileSync(join(CONTRACTS_DIR, 'qa-gate.contract.yaml'), `
name: qa-gate
version: 1
schema:
  required_fields:
    - status
    - issues
approval:
  status_field: status
  accepted_values:
    - approved
    - pass
`);
```

With:
```typescript
writeFileSync(join(CONTRACTS_DIR, 'qa-gate.contract.yaml'), `
name: qa-gate
version: 1
schema:
  required_fields:
    - status
    - issues
post_validation:
  rejection_detection:
    field: status
    approved_values:
      - approved
      - pass
    details_field: issues
    summary_field: summary
`);
```

**Step 2: Run group-loop tests**

Run: `cd /home/arianeguay/dev/src/Studio/engine && npx vitest run tests/group-loop.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add engine/tests/group-loop.test.ts
git commit -m "test: update qa-gate fixture to use post_validation config"
```

---

### Task 10: Update test assertions — context-propagation.test.ts

**Files:**
- Modify: `engine/tests/context-propagation.test.ts:190-195`

**Step 1: Update feedback text assertions**

The test on line 190-195 checks for old text. Replace:
```typescript
    expect(agentCtx.additional_context).toContain('QA FEEDBACK');
    expect(agentCtx.additional_context).toContain('Iteration 2/3');
    expect(agentCtx.additional_context).toContain('Props not passed to component');
    expect(agentCtx.additional_context).toContain('Missing onClick handler');
    expect(agentCtx.additional_context).toContain('Wrong prop type');
    expect(agentCtx.additional_context).toContain('MUST fix ALL issues');
```

With:
```typescript
    expect(agentCtx.additional_context).toContain('FEEDBACK');
    expect(agentCtx.additional_context).toContain('Iteration 2/3');
    expect(agentCtx.additional_context).toContain('Props not passed to component');
    expect(agentCtx.additional_context).toContain('Missing onClick handler');
    expect(agentCtx.additional_context).toContain('Wrong prop type');
    expect(agentCtx.additional_context).toContain('Address all issues');
```

**Step 2: Run context propagation tests**

Run: `cd /home/arianeguay/dev/src/Studio/engine && npx vitest run tests/context-propagation.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add engine/tests/context-propagation.test.ts
git commit -m "test: update feedback text assertions for generic wording"
```

---

### Task 11: Full test suite + build

**Step 1: Run all engine tests**

Run: `cd /home/arianeguay/dev/src/Studio/engine && npx vitest run`
Expected: ALL PASS

**Step 2: Build engine**

Run: `cd /home/arianeguay/dev/src/Studio/engine && npm run build`
Expected: PASS with no errors

**Step 3: Build entire workspace**

Run: `cd /home/arianeguay/dev/src/Studio && npm run build:all`
Expected: PASS

**Step 4: Verify domain-agnostic parsing**

Quick manual check — the loader should accept any `kind` value now. Already covered by existing tests that use `kind: analysis` etc., but the point is that `kind: recipe_creation` would also be accepted since `StageKind = string`.

**Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "refactor: engine is now fully domain-agnostic"
```

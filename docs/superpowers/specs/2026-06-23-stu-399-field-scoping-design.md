# STU-399 — Field-scoped anonymization

**Status:** Design approved
**Date:** 2026-06-23
**Linear:** [STU-399](https://linear.app/studioag/issue/STU-399/field-scoping-lapp-declare-quels-champs-anonymiser-le-kernel-les)
**Depends on:** STU-398 (merged, PR #160) — structured-field anonymization before prompt assembly
**Blocks:** STU-393 (email-classifier policy→fields integration)
**Package:** `pkg:anonymizer` (touches `runner`, `contracts`, `engine`)

## Problem

STU-398 made the anonymization middleware operate on **named structured fields** (`TaskInput.fields`) before prompt assembly, with one run-level keymap shared across fields. It anonymizes **every** field.

STU-399 lets the calling app declare **which** fields to anonymize — a *scope* — while the kernel treats the field names as **opaque**. The kernel never learns what a field means; it receives a list of opaque names to tokenize and leaves everything else cleartext.

Motivating case (lives in the app, not the kernel): an email-classifier runs a deterministic stage 1 that matches `from_domain` on **cleartext** (rules keyed on the real sender). So field-scoped anonymization must not touch the fields stage 1 needs in clear. The scope is an app decision, policy-driven (`body_only` → anonymize `[body_snippet]`; `full` → anonymize `[from_address, subject, headers, body_snippet]`). Studio never learns the meaning of `body_only` or `full` — it receives a concrete list of opaque field names.

## Non-negotiable correctness property

**Out-of-scope fields are copied byte-for-byte and are NEVER passed to the detector.** Not "detected but replacement skipped" — never detected at all.

Why this is correctness, not an implementation detail: if an out-of-scope field were detected, its PII value would enter the tokenizer's `inverse` map. The same value later appearing in an in-scope field would then collide with keymap state, producing the same PII value tokenized in one place and cleartext in another, with an ambiguous keymap. By skipping detection entirely on out-of-scope fields, **only the in-scope occurrence ever touches the tokenizer**, and the "same value in scoped + unscoped" case resolves cleanly. This is the case that passes naive tests and breaks when an email address appears in both `from` (out of scope) and `body` (in scope).

## Scope semantics (three states)

`anonymizeFields(fields, scope?: string[])` interprets `scope`:

| `scope` | Behavior | Rationale |
|---|---|---|
| `undefined` | Anonymize **all** fields (unchanged STU-398 behavior) | Fail-safe: a config omission leans toward protecting everything, never leaking. Backward compatible. Mirrors `AnonymizerOptions.categories` where `undefined` = all categories — following an existing convention, not inventing one. |
| `[]` (empty) | Anonymize **nothing** — every field cleartext | Explicit opt-out, a distinct intent from "not declared". |
| `['a','c']` | Only `a` and `c` tokenized; all other fields copied verbatim | The core feature. |

- Unknown names in `scope` (not present in `fields`) are silently ignored (no-op).
- The run-level shared keymap is unchanged: a PII value in two **in-scope** fields still gets the same token.

## Design

### What changes

1. **`runner/src/middleware/anonymization.ts` — the only behavioral change.**
   `anonymizeFields(fields: Record<string,string>, scope?: string[])`. Iterate fields; for each, anonymize through the `DetectionProvider` **iff** in scope (or `scope === undefined`), otherwise copy the value verbatim into the output **without calling the detector**. The shared `this.keymap` accumulation is untouched.

2. **`contracts/src/task.ts` — `TaskInput` gains `anonymize_fields?: string[]`.**
   Carries the opaque scope list engine→runner, alongside `fields`. Documented as **opaque** — the kernel imposes no domain meaning, exactly like `fields` in STU-398. Optional: absent → undefined → anonymize-all path.

3. **`runner/src/runner.ts` (injection point ~L79) — thread the scope.**
   `taskForPrompt = { ...task, fields: await mw.anonymizeFields(task.fields!, task.anonymize_fields) }`.

4. **`engine/src/pipeline/task-input.ts` — `buildTaskInput()` propagates the scope.**
   Gains an optional scope argument and sets `anonymize_fields` on the produced `TaskInput`. The **source** of the scope (CLI flag / input.yaml / API field, and the app's policy→fields mapping) is deferred to STU-393. This ticket delivers a complete, end-to-end-threadable kernel mechanism without inventing the app-facing format.

### What does NOT change

- The `anonymize(text)` flat-string path and `anonymizeWithProvider`.
- Tokenizer, detector, keymap reconstruction (`deanonymize`).
- The `description` (flat) vs `fields` (structured) branch — `hasFields()` stays the single source of truth.
- INV-04: no kernel code branches on a field name's *meaning*. Scope membership is a pure set-membership check on opaque strings.

## Testing (1:1 with acceptance criteria)

| AC | Test | Location |
|---|---|---|
| AC1 — middleware accepts scope, anonymizes only those | partial scope → token in scoped field, others cleartext | `runner/tests/anonymize-fields.test.ts` |
| AC2 — field names opaque to kernel | by review/comment; no branch on a business value (`body`, `subject`…) | code review + INV-04 |
| AC3 — partial mode produces correct result | one field anonymized, one cleartext → token in scoped, real value in unscoped | `runner/tests/anonymize-fields.test.ts` |
| AC4 — shared keymap under partial scoping | same PII value in a scoped AND an unscoped field. **Full round-trip, not keymap-state-only:** (1) token replaces the value in the scoped field, real value stays in the unscoped field; (2) feed a *simulated LLM response that references the token* through `deanonymize` → reconstructs the correct original value; (3) verify the cleartext occurrence that passed through the prompt in the unscoped field did **not** pollute reconstruction. Stopping at "token is in the scoped field" misses half the guarantee — go all the way to reconstruction. | `runner/tests/anonymize-fields.test.ts` |
| AC5 — deterministic cleartext stage unaffected by scope | runner-level: `anonymize_fields` threaded so an unscoped field reaches the assembled prompt as cleartext — proves a downstream deterministic pass (e.g. stage-1 `from_domain` matching) survives anonymization | `runner/tests/runner-anonymization-fields.test.ts` |
| three-state semantics | `undefined` → all; `[]` → none; `['a']` → only `a` | `runner/tests/anonymize-fields.test.ts` |
| engine passthrough | `buildTaskInput(input, contract, scope)` sets `anonymize_fields` | `engine/src/pipeline/task-input.test.ts` |

## Out of scope (this ticket)

- App-side policy→fields mapping (`anonymization.scope` block, `body_only`/`full`) — STU-393.
- CLI flag / input.yaml / API surface for declaring the scope — STU-393.
- The email-classifier stage-1 rules themselves.

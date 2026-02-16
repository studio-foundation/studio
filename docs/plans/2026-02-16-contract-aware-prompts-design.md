# Contract-Aware Prompts — Design

## Problem

The prompt-builder tells the QA agent to include a `status` field, but not which values are acceptable. The agent invents its own vocabulary (`"success"`, `"completed"`, `"pass"`) instead of using the contract-defined values (`"approved"`, `"approved_with_notes"`). The post-validator then rejects valid QA approvals because the status word doesn't match.

## Solution

Pass the full `OutputContract` to the runner instead of just `schema`. The prompt-builder extracts `approval.accepted_values` and injects them into the system prompt alongside the required fields.

## Changes

### 1. runner/src/runner.ts

Change `outputSchema` to `outputContract`:

```typescript
export interface RunAgentConfig {
  // ...existing fields...
  outputContract?: OutputContract;  // was: outputSchema?: { required_fields?: string[] }
}
```

Pass `outputContract` to `buildPrompt` instead of `outputSchema`.

### 2. runner/src/prompt-builder.ts

Change `PromptBuildConfig.outputSchema` to `outputContract`:

```typescript
export interface PromptBuildConfig {
  // ...existing fields...
  outputContract?: OutputContract;  // was: outputSchema
}
```

In `buildPrompt`, after listing required fields, add accepted values when `approval` is present:

```
The "${status_field}" field MUST be one of: "approved", "approved_with_notes", "success".
Any other value means rejection.
```

Generated from `contract.approval.accepted_values` — not hardcoded.

### 3. engine/src/engine.ts

Pass full contract to runner:

```typescript
// was: outputSchema: contract?.schema,
outputContract: contract ?? undefined,
```

## What doesn't change

- The `OutputContract` type (already has `approval`)
- The post-validator logic
- The contract YAML
- Ralph's format validation

## Build order

```
contracts (no change) → runner (rebuild) → engine (rebuild) → cli (rebuild)
```

# Design: Make @studio/engine Domain-Agnostic

## Goal

The engine is a pipeline orchestrator. It loads YAML, executes stages sequentially via ralph (runner, validator), manages state, and persists runs. It should know NOTHING about "software development" — no references to code, files, git, QA. All domain knowledge lives in YAML configs and plugins.

The engine must be able to orchestrate any pipeline (feature builder, document translation, legal review, image processing) without changing a single line.

## Audit Results

6 domain-specific violations found in `engine/src/`:

| # | File | Lines | Violation |
|---|------|-------|-----------|
| 1 | `engine.ts:55-85` | `summarizeOutput()` — switch on StageKind with hardcoded field names (`requirements`, `files_changed`, `issues`) |
| 2 | `engine.ts:94-110` | `extractToolArgSummary()` — hardcoded tool name patterns (`write_file`, `read_file`, `list_files`, `run_command`) |
| 3 | `post-validator.ts:52-69` | Hardcoded `.issues` and `.summary` field access + "QA" prefix in rejection message |
| 4 | `context-propagation.ts:91-108` | Hardcoded prose: "QA FEEDBACK", "Your previous implementation was REJECTED by QA review", "Read the current files..." |
| 5 | `engine.ts:585,592,599` | `'Rejected by QA'` fallback string literals |
| 6 | `contracts/src/stage.ts:5` | `StageKind` — hardcoded union instead of free `string` |

Confirmed domain-agnostic (no changes needed): state machine, stage lifecycle, event types, group iteration logic, context propagation mechanism, RALPH integration, DB persistence.

## Changes

### 1. `StageKind` → `string`

**File:** `contracts/src/stage.ts`

Replace:
```typescript
export type StageKind = 'analysis' | 'planning' | 'code_generation' | 'qa' | 'custom';
```

With:
```typescript
export type StageKind = string;
```

The engine treats `kind` as an opaque label. Pipeline YAML defines whatever kind it wants.

### 2. `summarizeOutput()` → generic

**File:** `engine/src/engine.ts:55-85`

Replace the domain-specific switch with generic logic (the existing `default` branch):

```typescript
function summarizeOutput(output: unknown): string {
  if (!output || typeof output !== 'object') return 'no structured output';
  const o = output as Record<string, unknown>;
  const keys = Object.keys(o);
  return `${keys.length} fields: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}`;
}
```

Remove the `stageKind` parameter from all call sites.

### 3. `extractToolArgSummary()` → generic

**File:** `engine/src/engine.ts:94-110`

Replace hardcoded tool name checks with generic logic:

```typescript
function extractToolArgSummary(tc: ToolCall): string {
  const args = tc.arguments as Record<string, unknown>;
  // Show first string-valued argument, truncated
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 60 ? value.slice(0, 60) + '...' : value;
    }
  }
  return '';
}
```

### 4. Post-validator → new `post_validation` config

**File:** `contracts/src/validation.ts`

Replace `approval` with:

```typescript
export interface OutputContract {
  // ...existing fields...
  post_validation?: {
    rejection_detection: {
      field: string;
      rejected_values?: string[];
      approved_values?: string[];
      details_field?: string;
      summary_field?: string;
    };
  };
}
```

**File:** `engine/src/pipeline/post-validator.ts`

- Read `details_field` and `summary_field` from config instead of hardcoding `.issues` and `.summary`
- Rejection message: `Rejected: field "${field}" = "${value}" (expected: ${approved_values.join(' or ')})` — no "QA" prefix

**File:** `engine/configs/contracts/qa-review.contract.yaml`

Update from:
```yaml
approval:
  status_field: status
  accepted_values: [approved, approved_with_notes, success]
```

To:
```yaml
post_validation:
  rejection_detection:
    field: status
    approved_values: [approved, approved_with_notes, success]
    rejected_values: [rejected, failed, implementation_incomplete]
    details_field: issues
    summary_field: summary
```

### 5. Context feedback → generic text

**File:** `engine/src/pipeline/context-propagation.ts:87-114`

Replace domain-specific prose with generic feedback:

```typescript
case 'group_feedback':
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
  break;
```

### 6. Default fallback → `'Rejected'`

**File:** `engine/src/engine.ts:585,592,599`

Replace `'Rejected by QA'` with `'Rejected'` in 3 locations.

## What Does NOT Change

- Stage lifecycle FSM (`state-machine.ts`)
- `deriveStageStatus()` (`status-derivation.ts`)
- DB schema and persistence (`run-store.ts`, `db/client.ts`)
- Event types (`events.ts`) — already generic
- Loaders (`loader.ts`, `agent-loader.ts`, `contract-loader.ts`)
- RALPH integration
- `PipelineEngine.run()` flow
- Pipeline YAML files (except indirectly via contract config change)
- Agent profile YAMLs

## Validation

After refactor:
1. `feature-builder` pipeline still works (nothing broken)
2. Engine can parse any arbitrary pipeline YAML without complaining about unknown kinds
3. `npm run build` passes in engine/
4. Existing tests pass

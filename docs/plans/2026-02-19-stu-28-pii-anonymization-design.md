# STU-28 — PII Anonymization Design

**Date:** 2026-02-19
**Issue:** STU-28 — Anonymisation PII avec keymap local (--anonymize)

## Objective

Add a transparent PII anonymization middleware to the runner. Sensitive data is replaced with sequential tokens before being sent to the LLM, then restored from a local keymap after the response. The agent, the engine, and ralph are unaware of the anonymization.

## Flow

```
Input "Marie-Claire veut un pad thai, email: mc@acme.com"
         │
         ▼ [AnonymizationMiddleware.anonymize() — before buildPrompt()]
"[PERSON_1] veut un pad thai, email: [EMAIL_1]"
         │
         ▼ [LLM works with placeholders — transparent]
Output "Recette pour [PERSON_1]: ..."
         │
         ▼ [AnonymizationMiddleware.deanonymize() — after LLM response]
"Recette pour Marie-Claire: ..."
         │
         ▼ [engine receives AgentRunResult with real values]
```

Tool results are also anonymized before being sent back to the LLM (within the runner loop).

## Architecture

### New Package: `@studio-foundation/anonymizer`

Sixth package in the monorepo. Depends only on `@studio-foundation/contracts`.

```
anonymizer/
├── src/
│   ├── index.ts       # Public API: anonymize(), deanonymize()
│   ├── detector.ts    # @redactpii/node wrapper → PIISpan[]
│   ├── tokenizer.ts   # PIISpan[] → sequential tokens + keymap
│   ├── keymap.ts      # Persist/load keymap to .studio/runs/anonymization/
│   └── types.ts       # PIICategory, PIISpan, PIIDetectionResult, AnonymizerOptions
├── package.json       # deps: @studio-foundation/contracts, @redactpii/node
└── tsconfig.json
```

**Public interface:**

```typescript
export type PIICategory = 'person' | 'email' | 'phone' | 'address' | 'ssn' | 'credit_card';

export interface AnonymizerOptions {
  categories?: PIICategory[];   // Which categories to detect (default: all)
}

export interface PIIDetectionResult {
  text: string;                    // Anonymized text
  keymap: Record<string, string>;  // "PERSON_1" → "Marie-Claire Dubois"
}

export function anonymize(text: string, options?: AnonymizerOptions): PIIDetectionResult;
export function deanonymize(text: string, keymap: Record<string, string>): string;
```

**Tokenizer design:**
- Sequential counters per category: PERSON_1, PERSON_2, EMAIL_1…
- Inverse map (original value → token) ensures same PII always gets same token
- If the LLM invents an unknown placeholder (e.g. `[PERSON_3]`), `deanonymize()` leaves it as-is — no error

### Middleware in runner

**File:** `runner/src/middleware/anonymization.ts`

```typescript
export class AnonymizationMiddleware {
  private keymap: Map<string, string> = new Map(); // token → original
  private inverse: Map<string, string> = new Map(); // original → token
  private counters: Map<string, number> = new Map(); // category → counter

  anonymize(text: string): string { /* accumulates keymap */ }
  deanonymize(text: string): string { /* restores values from keymap */ }
  getKeymap(): Record<string, string> { }
  mergeKeymap(external: Record<string, string>): void { /* for multi-stage continuity */ }
}
```

**Four injection points in `runAgent()`:**

1. **Before `buildPrompt()`** — anonymize `JSON.stringify(task.input)` and rebuild task with anonymized content
2. **Tool results (standard multi-turn loop)** — anonymize `toolResultsMessage` string before adding to `currentMessages`
3. **Tool results (Responses API path)** — anonymize `executed.result` before returning to the provider callback
4. **After LLM response** — deanonymize `lastResponse.content` / `loopResult.content` before `parseAgentOutput()`

**RunAgentConfig extension:**

```typescript
interface RunAgentConfig {
  // ... existing fields ...
  anonymizationMiddleware?: AnonymizationMiddleware; // optional — absent = no change
}
```

### Activation

Three activation mechanisms:

**1. CLI flag (global for run):**
```bash
studio run software/feature-builder --input "..." --anonymize
```

Add `anonymize?: boolean` to `RunOptions` in `cli/src/commands/run.ts`. Pass to engine as run option.

**2. Agent YAML (per-agent):**
```yaml
# agents/coder.agent.yaml
anonymize: true
```

Add `anonymize?: boolean` to `AgentConfig` in `contracts/src/agent.ts`.

**3. Programmatic (engine API):**
```typescript
interface EngineRunOptions {
  anonymize?: boolean;
}

engine.run(pipelineId, input, { anonymize: true });
```

**Activation logic in engine:** One `AnonymizationMiddleware` is created per run (not per stage) to guarantee token consistency across stages (PERSON_1 in stage 1 = same in stage 2). The middleware is passed to `runAgent()` when:
- `runOptions.anonymize === true`, OR
- `agent.anonymize === true` for that specific agent

### Keymap Persistence

The engine persists the keymap at the end of each run:

```
.studio/runs/anonymization/<run_id>.keymap.json
```

```json
{
  "PERSON_1": "Marie-Claire Dubois",
  "PERSON_2": "Jean-François Tremblay",
  "EMAIL_1": "mc.dubois@acme.com",
  "PHONE_1": "514-555-1234"
}
```

**Properties:**
- Never sent to the LLM
- Never written to JSONL logs (logs contain tokens, not PII)
- Not transmitted via API
- Added to `.gitignore` by `studio init`

## Packages Modified

| Package | Change |
|---------|--------|
| `anonymizer/` | New package — detector, tokenizer, keymap |
| `contracts/` | `AgentConfig.anonymize?: boolean` |
| `runner/` | `AnonymizationMiddleware` class + 4 injection points in `runAgent()`, export the class |
| `engine/` | Create middleware per run, pass to `runAgent()`, persist keymap, `EngineRunOptions` |
| `cli/` | `--anonymize` flag in `studio run` command |
| `pnpm-workspace.yaml` | Add `anonymizer` |

## Dependency Graph (unchanged architecture)

```
@studio-foundation/cli
    │
@studio-foundation/engine
    │
    ├── @studio-foundation/ralph
    │
    └── @studio-foundation/runner
         │
         └── @studio-foundation/anonymizer
              │
              └── @studio-foundation/contracts
```

`@studio-foundation/anonymizer` is a leaf package (like contracts) from the engine's perspective — engine never imports it directly.

## Edge Cases

| Case | Behavior |
|------|----------|
| LLM invents unknown placeholder `[PERSON_3]` | Left as-is — no error |
| Same PII appears multiple times | Same token (inverse map ensures consistency) |
| Run without `--anonymize` | `anonymizationMiddleware` absent → zero behavior change |
| Tool argument contains PII | Covered via input anonymization (full JSON serialized) |
| Tool result contains PII | Anonymized before returning to LLM (injection point 2/3) |

## What Does NOT Change

- Default behavior (without `--anonymize`) is identical
- Engine remains domain-agnostic — never sees placeholders
- ralph is unaware of anonymization
- Agent is unaware of anonymization — transparent
- YAML configs are untouched (except `agent.anonymize: true` addition)

## Testing Strategy

- `@studio-foundation/anonymizer` unit tests: `anonymize()`, `deanonymize()`, token consistency, edge cases
- Runner integration test: middleware activated/deactivated, tool results anonymized
- Engine test: middleware shared across stages, keymap persisted after run
- CLI test: `--anonymize` flag propagation
- Regression: run without `--anonymize` produces identical output

## PII Categories Detected

| Token format | Category | Examples |
|---|---|---|
| `PERSON_N` | Names | Marie-Claire, Jean-François |
| `EMAIL_N` | Email addresses | mc@acme.com |
| `PHONE_N` | Phone numbers | 514-555-1234 |
| `ADDRESS_N` | Physical addresses | 1425 Rue Saint-Denis |
| `SSN_N` | Social security numbers | 123-45-6789 |
| `CREDIT_CARD_N` | Credit card numbers | 4111-1111-1111-1111 |

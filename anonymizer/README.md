# @studio/anonymizer

PII detection and anonymization library. Replaces sensitive data with consistent tokens before sending to LLMs, with a keymap to restore the original values afterward.

## Role

anonymizer sits at the bottom of the stack — a pure utility with zero `@studio/*` dependencies. The runner wraps it in `AnonymizationMiddleware` and injects it transparently into the agent execution loop.

```
user data → anonymize() → [PERSON_1], [EMAIL_1] → LLM → deanonymize() → original values
```

## Key exports

```typescript
import { anonymize, deanonymize, Tokenizer } from '@studio/anonymizer';
import type { PIICategory, PIIDetectionResult, AnonymizerOptions } from '@studio/anonymizer';

// Anonymize a string
const { text, keymap } = anonymize('Hi Marie, call me at 555-867-5309');
// text   → "Hi [PERSON_1], call me at [PHONE_1]"
// keymap → { "PERSON_1": "Marie", "PHONE_1": "555-867-5309" }

// Restore originals
const original = deanonymize(text, keymap);
// → "Hi Marie, call me at 555-867-5309"

// Cross-stage consistency — pass the keymap from a previous call
const { text: text2, keymap: keymap2 } = anonymize(nextChunk, { seedKeymap: keymap });
// PERSON_1 still maps to "Marie" across calls
```

## PII categories

| Category | Token format | What it detects |
|----------|-------------|-----------------|
| `person` | `PERSON_N` | Names after salutations (Dear, Hi, Mr., Dr., etc.) — best effort |
| `email` | `EMAIL_N` | Email addresses |
| `phone` | `PHONE_N` | US phone numbers (10 digits, various formats) |
| `ssn` | `SSN_N` | Social security numbers (ddd-dd-dddd) |
| `credit_card` | `CREDIT_CARD_N` | 16-digit card numbers |
| `address` | `ADDRESS_N` | Reserved (detection not yet implemented) |

## Detection strategy

Two-phase detection on each call:

1. **Regex (high precision)** — email, phone, SSN, credit card. Structural patterns anchored to avoid false positives (e.g. SSN regex uses strict hyphen format to avoid matching phone fragments).

2. **Person names (best effort)** — salutation-gated pattern (`Dear X`, `Hi X`, `Mr. X`, etc.). Only catches explicitly addressed names — not bare occurrences.

Spans are non-overlapping. If two patterns match the same range, the first one wins and the position is marked occupied.

## Token consistency

Same value → same token, within and across calls:

```typescript
// Within one call: two mentions of the same email → same token
anonymize('Contact foo@bar.com or reach foo@bar.com')
// → "Contact [EMAIL_1] or reach [EMAIL_1]"

// Across calls: seed the next call with the previous keymap
const { text: t1, keymap: km1 } = anonymize(stage1Output);
const { text: t2, keymap: km2 } = anonymize(stage2Output, { seedKeymap: km1 });
// EMAIL_1 is the same person in t1 and t2
```

## Filter by category

```typescript
// Only anonymize emails — leave names and phones unchanged
const { text } = anonymize(rawText, { categories: ['email'] });
```

## How it's used in Studio

The runner wraps this in `AnonymizationMiddleware` (in `runner/src/middleware/anonymization.ts`). When `anonymize: true` is set on an agent or a run:

1. Task description is anonymized before being sent to the LLM
2. Tool results are anonymized before being injected back into context
3. The accumulated keymap is written to `.studio/runs/anonymization/<run-id>.keymap.json` for post-run inspection

The middleware is wired by the engine and passed to `runAgent()` — user code doesn't call `anonymize()` directly.

## Rules

- **Zero `@studio/*` dependencies.** This package must stay a pure utility.
- `anonymize()` is stateless — the `Tokenizer` is created fresh each call (or seeded via `seedKeymap`).
- Person detection is always best-effort and non-fatal — failures are silently skipped.

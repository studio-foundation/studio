# DetectionProvider interface + RegexDetector — Design

**Linear:** [STU-397](https://linear.app/studioag/issue/STU-397/interface-detectionprovider-detecteur-regex-de-base-detecttext-spans)
**Package:** `@studio-foundation/anonymizer`
**Date:** 2026-06-21

## Problem

Knowledge of "what constitutes PII" is domain-specific (email/phone/SSN/credit-card formats today; medical and Québécois NER later). Hardcoding it in the kernel contradicts INV-04 (the engine knows no business concept) and caps detection quality at regex.

Direction: the kernel keeps the **mechanism** of anonymization (intercept at ingestion, keymap, reconstruction at output), but **detection** becomes a pluggable provider — same model as the LLM providers (Anthropic/OpenAI/Mock). The kernel does not know what an SSN is; it calls `detect(text)` and tokenizes the returned spans.

This issue lays the foundation: the provider interface + a base regex detector. Testable in isolation, zero dependency on the rest of the redesign.

## Scope

**In scope (this PR):**
- `DetectionProvider` interface + `Span` type.
- `RegexDetector` implementing it, returning spans (positions only) — no replacement.
- A shared private internal that both the new provider and the old `detectPII()` consume.
- Defined, documented overlap resolution.
- Unit tests in isolation (no middleware, no runner).

**Out of scope (deferred):**
- NER, Presidio, Python, composition of multiple detectors, distribution via studio-community (horizon 2).
- **Middleware relocation / switching `anonymize()` to the provider — that is STU-398, kept entirely separate.** The old path (`detectPII()`, `AnonymizationMiddleware`) stays in parallel for progressive migration; it is NOT removed here.
- **`address` detection — dropped from this PR entirely.** See decision below.

## Approach (Option C — shared private internal)

We do **not** couple the new provider to the old `detectPII()` (that would be Option A and would tie the new abstraction to code we want freedom to delete). We also do **not** duplicate the patterns (Option B). Instead:

Extract the regex patterns + matching logic into a **neutral private module** inside the anonymizer package. It does one thing: `text → { start, end, type }[]`. No replacement, no keymap, no value extraction. Both consumers point at it:

- The old `detectPII()` (while it still exists) calls the internal and keeps its current `category` mapping + `value` reconstruction on top.
- The new `RegexDetector.detect()` calls the internal and returns `Span[]` directly.

This keeps a single source of truth for the patterns while letting the old path be removed later (STU-398+) without touching the provider. Option C is precisely what makes that future removal safe.

### Three non-negotiable constraints

1. **Positions only.** The internal returns `start`/`end`, never the extracted substring. The kernel reconstructs the value via `text.slice(start, end)`. Returning the value would duplicate state and let the two disagree. `value` is reconstructed **only** in `detectPII()`, never in the internal.
2. **Private in-package module.** Not a new package, not a new external dependency. `anonymizer` stays co-leaf with `contracts`, zero internal `@studio-foundation/*` deps (INV-10). This is an internal reorg of code already present.
3. **Single canonical `type` vocabulary.** The internal defines the one vocabulary; both consumers conform to it. Otherwise duplication just moves down a level instead of being removed.

## Module layout

```
anonymizer/src/
  detection/
    provider.ts        # PUBLIC: DetectionProvider interface + Span type
    regex-detector.ts  # PUBLIC: RegexDetector implements DetectionProvider
    regex-matcher.ts   # PRIVATE: shared internal — text -> positions
  detector.ts          # refactored: detectPII() now calls the matcher
  index.ts             # adds the 3 public exports (DetectionProvider, Span, RegexDetector)
```

Rationale for the `detection/` subfolder: the package will grow more providers (NER, Presidio HTTP); a folder scales better than flat files.

## Public surface (`provider.ts`)

```ts
export interface Span {
  start: number;
  end: number;
  type: string;
}

export interface DetectionProvider {
  detect(text: string): Promise<Span[]>;
}
```

- **Async by default** so the same contract covers an in-process regex detector and a future network provider (Presidio HTTP) without reworking the interface.
- **`Span.type` is a free `string`** — this is the seam that lets a future NER/Presidio provider return its own vocabulary without touching this interface. `RegexDetector` narrows to its own union internally, which is assignable to `string`.

## Shared internal (`regex-matcher.ts`, private — NOT exported from index)

Owns:

- The **canonical vocabulary**: `type PIIType = 'email' | 'phone' | 'ssn' | 'credit_card' | 'person'`.
- The patterns (email/phone/ssn/credit_card regex + the salutation-based `person` logic), moved from `detector.ts`. **The `person` salutation list must cover FR + EN in this PR (see Constraint 3).**
- The **explicit priority list** in one documented place:

```ts
// Most-specific format wins. credit_card beats ssn on the dangerous digit-run
// collision; email is near-unambiguous (the @) so it stays high; phone is the
// most permissive of the formatted types so it runs late; person is a
// salutation heuristic, last, and only claims what the others leave.
//
// address: intentionally NOT here. Addresses are the least regex-able PII type;
// a number+word+street-suffix pattern false-positives on non-addresses, and in
// an email classifier a false positive (tokenizing legitimate text) is strictly
// worse than a miss. Address detection is delegated to a future NER detector
// (horizon 2). Do NOT add an address regex here.
const PRIORITY: readonly PIIType[] = ['credit_card', 'ssn', 'email', 'phone', 'person'];
```

Exposes `matchPII(text): { start: number; end: number; type: PIIType }[]` — positions only, sorted by `start`.

### Resolution algorithm (priority-as-data)

The priority must hold **regardless of pattern declaration order** (e.g. `credit_card` must beat `ssn` even if the `ssn` match occurs first in the text). This requires collect-then-resolve, not iterate-in-array-order:

1. **Gather** all candidate matches from every pattern, each tagged with its `type`.
2. **Process** candidates in `PRIORITY` order (highest first; within a type, left-to-right by `start`).
3. Maintain an `occupied` set of character positions. Accept a candidate only if **none** of its positions are occupied, then mark its whole span occupied. Lower-priority overlapping matches are **dropped whole** — no merge, no truncation.
4. **Return** accepted spans sorted by `start`.

The resolution *mechanic* (winner takes the whole span, losers dropped) is unchanged from today's behavior. Only the ordering becomes explicit, declared data instead of an accident of array position.

### Constraint 1 — overlap test is true interval intersection (migration risk)

When marking a span occupied, mark the **entire `[start, end)` range**. When testing a candidate, verify that **none** of its positions `[start, end)` are occupied — **not** merely that its `start` is free. A start-only check passes on the tested cases and silently breaks on an untested *partial* overlap (candidate starts in free space but extends into an occupied span, or vice versa).

The current character-position `occupied` Set already does this correctly — keep that approach. If the rewrite moves to interval comparison instead of a position set, the intersection test must be made explicit: two intervals `[a,b)` and `[c,d)` overlap iff `a < d && c < b`. This is the detail that must be deliberately preserved and directly tested.

### Constraint 2 — `person` is the migration risk among the five

Four of the five types are pure format regexes. `person` is **not** — it is a salutation-based contextual heuristic (`Dear/Hi/Mr.`/etc. + a captured proper-noun group), and its span is the **captured name group**, not the full salutation match. "Moved verbatim" is fine, but the spec requires verifying:

- It produces clean positional `{ start, end, type: 'person' }` spans through `matchPII()` like the others (the `start` is the offset of the captured name within the full match, exactly as today).
- Its **last-priority** position interacts correctly with the new collect-then-resolve flow: as the lowest priority it is processed last and only claims positions the four formatted types left free — never overwriting a more confident match.

This is the one type to test carefully through the new flow, since the other four are pure pattern matches with no contextual capture.

### Constraint 3 — `person` salutations must cover FR + EN (deployment prerequisite)

The first club deployment is a **French-language** volleyball club; its emails are mostly in French. Because `person` detection is anchored on the salutation (natural-language context, unlike the four language-neutral format types), an English-only salutation list would **silently miss French names** — leaking the most sensitive PII in the club context: the names of parents and minors. `person` is therefore simultaneously the type most fragile to language and the most critical for this deployment. FR+EN coverage ships in **this** PR, not later.

The salutation list must include, at minimum:

- **English (existing):** `Dear`, `Hi`, `Hello`, `Greetings`, `Hey` (+ `Hey there`), `Mr.`, `Mrs.`, `Ms.`, `Dr.`, `Prof.`
- **French (new):** `Bonjour`, `Bonsoir`, `Allô` / `Allo` (with and without accent), `Salut`, `Cher` / `Chère` / `Chers` / `Chères` (handle accents), `Madame`, `Monsieur`, and the abbreviations `M.` and `Mme`.

Notes:
- The matching stays case-insensitive and accent-aware; the captured-name group (`[A-Z][a-zA-ZÀ-ÿ'\-]+ …`) already tolerates accented surnames (e.g. *Côté*, *Tremblay*), so only the salutation *trigger* list widens.
- Mind the abbreviation boundaries: `M.` must require the trailing period (and a following capitalized name) so it does not fire on a stray capital `M`; `Mme` likewise anchored to a following name.

The other four types (email, phone, ssn, credit_card) are format-based and language-neutral — no change.

## Consumers

```ts
// regex-detector.ts
import type { DetectionProvider, Span } from './provider.js';
import { matchPII } from './regex-matcher.js';

// Regex detection covers the types where regex is reliable (formatted
// identifiers): email, phone, ssn, credit_card, and salutation-based person.
// address is intentionally delegated to a future NER detector — see PRIORITY in
// regex-matcher.ts. Do NOT add an address regex here.
export class RegexDetector implements DetectionProvider {
  async detect(text: string): Promise<Span[]> {
    return matchPII(text); // { start, end, type } already IS a Span
  }
}
```

```ts
// detector.ts (refactored — old path, behavior preserved)
export function detectPII(text: string): PIISpan[] {
  return matchPII(text).map(({ start, end, type }) => ({
    start,
    end,
    category: type,                  // PIIType is a subset of PIICategory
    value: text.slice(start, end),   // value reconstructed HERE, never in the internal
  }));
}
```

`anonymize()` and the middleware are untouched — they still call `detectPII()`, which behaves identically (same categories, same values, same overlaps). `PIIType` values are all members of the existing `PIICategory` union (which also contains `'address'`, now simply never produced).

## Decisions log

- **C over A/B.** Shared private internal. Keeps single source of truth for patterns while allowing the old path to be deleted later without touching the provider.
- **`address` dropped (B over C/A on the address sub-question).** No address regex, not even a minimal one. False positives in an email classifier silently corrupt the LLM signal and a weak detector gives dishonest assurance. The original AC's "addresses" was corrected in STU-397; address is deferred to NER. Documented on both `PRIORITY` and `RegexDetector` (deliberate redundancy — prevents re-adding from either entry point).
- **Explicit priority `credit_card > ssn > email > phone > person`** (most-specific-wins), as declared data in one place, not array order.
- **Free-string `Span.type` at the public interface, internal narrowing to `PIIType`** — the right seam for future providers.
- **FR + EN salutations for `person` in this PR.** The first deployment is a French club; an EN-only list would silently leak parent/minor names. `person` is the type most fragile to language and most critical for the club, so bilingual coverage is a deployment prerequisite, not a later enhancement. The four format types are language-neutral and unchanged.

## Tests (isolation — no middleware, no runner)

New `tests/regex-detector.test.ts`:

- `detect()` returns a `Promise<Span[]>` with correct `start`/`end`/`type` for `email`, `phone`, `ssn`, `credit_card`, `person`.
- Spans carry **no `value`** field.
- **Overlap by priority:** a digit run that both `credit_card` and `ssn`/`phone` could match → assert `credit_card` wins and the losers are absent.
- **Partial-overlap interval test (Constraint 1):** a candidate that partially overlaps an already-accepted higher-priority span (extends into it without sharing a start) is dropped — guards the true-intersection requirement, not just start-position freedom.
- **`person` through the new flow (Constraint 2):** salutation-based name yields a clean span over the captured name only; when a higher-priority formatted span overlaps the name region, `person` yields to it.
- **French salutation (Constraint 3):** a name preceded by a French salutation (e.g. `"Bonjour Marie Tremblay,"`) produces a correct `person` span over the name. Cover representative FR triggers (`Bonjour`, `Madame`/`Monsieur`, `M.`/`Mme`, `Cher`/`Chère`) and an accented surname (e.g. *Côté*) to guard accent handling.

Regression: existing `tests/detector.test.ts` continues to pass unchanged — proves the refactor is behavior-preserving for the old path.

## Acceptance criteria (from STU-397, address corrected)

- [ ] `DetectionProvider` defined in the anonymizer package, `detect(text) → Promise<Span[]>`.
- [ ] `RegexDetector` returns correct spans (`start`/`end`/`type`) for email/phone/ssn/credit_card/person — no replacement. (`address` deliberately delegated to NER, out of regex scope.)
- [ ] `person` salutation list covers FR + EN (`Bonjour`, `Bonsoir`, `Allô`/`Allo`, `Salut`, `Cher`/`Chère`/`Chers`/`Chères`, `Madame`, `Monsieur`, `M.`, `Mme` + existing English); a French-salutation name (e.g. `"Bonjour Marie Tremblay,"`) produces a correct `person` span. Deployment prerequisite for the French club, not deferred.
- [ ] Overlap spans handled in a defined way: explicit documented priority (`credit_card > ssn > email > phone > person`), winner takes the whole span, lower-priority overlaps dropped.
- [ ] Unit tests of the detector in isolation, no dependency on middleware or runner.
- [ ] No internal `@studio-foundation/*` dependency added to anonymizer (stays co-leaf with contracts, INV-10).

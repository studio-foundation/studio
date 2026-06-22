# DetectionProvider + RegexDetector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a pluggable `DetectionProvider` abstraction in `@studio-foundation/anonymizer` plus a base `RegexDetector`, both built on a shared private regex internal, without changing the existing anonymization behavior.

**Architecture:** A private `regex-matcher.ts` owns the patterns, the canonical `PIIType` vocabulary, the explicit priority list, and a collect-then-resolve overlap algorithm (positions only). Two consumers sit on top: the public `RegexDetector` (returns `Span[]`) and the existing `detectPII()` (refactored to map matcher output to its `PIISpan` shape). The old anonymization path stays untouched.

**Tech Stack:** TypeScript (strict, CommonJS target, ESM-style `.js` import specifiers), Vitest, pnpm workspaces. Spec: [docs/superpowers/specs/2026-06-21-detection-provider-regex-detector-design.md](../specs/2026-06-21-detection-provider-regex-detector-design.md).

## Global Constraints

- **No new dependencies.** Add no `@studio-foundation/*` internal dep and no new external dep to `anonymizer`. It stays co-leaf with `contracts` (INV-10). Do not touch `package.json` dependencies.
- **Positions only in the internal.** `regex-matcher.ts` returns `start`/`end`/`type` and never the extracted substring. `value` is reconstructed only in `detectPII()` via `text.slice(start, end)`.
- **Single canonical vocabulary.** `type PIIType = 'email' | 'phone' | 'ssn' | 'credit_card' | 'person'`, defined once in `regex-matcher.ts`. Both consumers conform.
- **Explicit priority as data:** `const PRIORITY: readonly PIIType[] = ['credit_card', 'ssn', 'email', 'phone', 'person']`. Most-specific wins; winner takes the whole span; overlapping lower-priority matches are dropped whole (no merge, no truncation).
- **Overlap = true interval intersection.** Mark the entire `[start, end)` range occupied; reject a candidate if ANY of its `[start, end)` positions are occupied — never a start-only check. Half-open: `[0,5)` and `[5,10)` do NOT overlap.
- **`address` is out of scope.** Add no address pattern. Document the deferral on both `PRIORITY` and `RegexDetector`.
- **`person` salutations cover FR + EN** in this PR (deployment prerequisite). FR triggers: `Bonjour`, `Bonsoir`, `Allô`/`Allo`, `Salut`, `Cher`/`Chère`/`Chers`/`Chères`, `Madame`, `Monsieur`, `M.`, `Mme` — plus existing EN. `M.` requires the trailing period + a following capitalized name; must not fire on a word merely ending in `m` before a period.
- **`Span.type` is `string`** at the public interface; the internal narrows to `PIIType` (assignable to `string`).
- **Behavior-preserving old path.** `detectPII()` keeps its `{ start, end, category, value }` shape; `anonymize()`/middleware are untouched (relocation is STU-398). The existing `tests/detector.test.ts` must keep passing.
- **Commit footer:** every commit ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Setup (once, before Task 1)

From the repo root, ensure workspace deps are installed in this worktree:

```bash
pnpm install
```

All per-task commands below run from the anonymizer package directory:

```bash
cd anonymizer
```

## File Structure

- `anonymizer/src/detection/regex-matcher.ts` — **Create (private).** `PIIType`, `RegexMatch`, patterns, salutation regex, `PRIORITY`, `matchPII()`, `resolveByPriority()`. Not exported from `index.ts`.
- `anonymizer/src/detection/provider.ts` — **Create (public).** `Span`, `DetectionProvider`.
- `anonymizer/src/detection/regex-detector.ts` — **Create (public).** `RegexDetector implements DetectionProvider`.
- `anonymizer/src/detector.ts` — **Modify.** `detectPII()` delegates to `matchPII()`.
- `anonymizer/src/index.ts` — **Modify.** Add 3 public exports.
- `anonymizer/tests/regex-matcher.test.ts` — **Create.** Format detection, priority, interval-overlap (synthetic), person FR/EN, `M.` negative.
- `anonymizer/tests/regex-detector.test.ts` — **Create.** Public async `Span[]` contract, no `value`.
- `anonymizer/README.md` — **Modify.** Reflect provider + explicit priority + FR/EN salutations.

---

### Task 1: Shared internal — format patterns + priority resolution

**Files:**
- Create: `anonymizer/src/detection/regex-matcher.ts`
- Test: `anonymizer/tests/regex-matcher.test.ts`

**Interfaces:**
- Consumes: nothing (leaf internal).
- Produces:
  - `type PIIType = 'email' | 'phone' | 'ssn' | 'credit_card' | 'person'`
  - `interface RegexMatch { start: number; end: number; type: PIIType }`
  - `function matchPII(text: string): RegexMatch[]` — sorted by `start`; format types only in this task (`person` added in Task 2).
  - `function resolveByPriority(candidates: RegexMatch[]): RegexMatch[]` — exported for in-package testing of the overlap rule.

- [ ] **Step 1: Write the failing test**

Create `anonymizer/tests/regex-matcher.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { matchPII, resolveByPriority } from '../src/detection/regex-matcher.js';

describe('matchPII — format types', () => {
  it('detects email with correct bounds and type', () => {
    const text = 'Contact mc@acme.com for info';
    const spans = matchPII(text);
    const email = spans.find(s => s.type === 'email');
    expect(email).toBeDefined();
    expect(text.slice(email!.start, email!.end)).toBe('mc@acme.com');
  });

  it('detects phone, ssn, credit_card', () => {
    expect(matchPII('Call 514-555-1234').some(s => s.type === 'phone')).toBe(true);
    expect(matchPII('SSN 123-45-6789').some(s => s.type === 'ssn')).toBe(true);
    expect(matchPII('Card 4111111111111111').some(s => s.type === 'credit_card')).toBe(true);
  });

  it('returns empty array for clean text', () => {
    expect(matchPII('a normal sentence')).toEqual([]);
  });

  it('returns spans sorted by start', () => {
    const spans = matchPII('Email mc@acme.com then 514-555-1234');
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i - 1].start).toBeLessThanOrEqual(spans[i].start);
    }
  });
});

describe('resolveByPriority — overlap rule', () => {
  it('credit_card outranks ssn on a shared range', () => {
    const out = resolveByPriority([
      { start: 0, end: 19, type: 'ssn' },
      { start: 0, end: 19, type: 'credit_card' },
    ]);
    expect(out).toEqual([{ start: 0, end: 19, type: 'credit_card' }]);
  });

  it('drops a lower-priority span whose interior overlaps (true interval, not start-only)', () => {
    // Winner occupies [10,26). Loser starts at 5 (FREE) but its interior 10..14 collides.
    // A start-only check would wrongly keep the loser; the interval check drops it.
    const out = resolveByPriority([
      { start: 10, end: 26, type: 'credit_card' },
      { start: 5, end: 15, type: 'phone' },
    ]);
    expect(out).toEqual([{ start: 10, end: 26, type: 'credit_card' }]);
  });

  it('keeps half-open adjacent spans (end is exclusive)', () => {
    const out = resolveByPriority([
      { start: 0, end: 5, type: 'email' },
      { start: 5, end: 10, type: 'phone' },
    ]);
    expect(out.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/regex-matcher.test.ts`
Expected: FAIL — cannot resolve `../src/detection/regex-matcher.js` (module does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `anonymizer/src/detection/regex-matcher.ts`:

```ts
// Shared PRIVATE regex internal for the anonymizer package.
// Returns POSITIONS only — never the extracted substring. The kernel
// reconstructs the value via text.slice(start, end); see detector.ts.
// NOT exported from index.ts.

export type PIIType = 'email' | 'phone' | 'ssn' | 'credit_card' | 'person';

export interface RegexMatch {
  start: number;
  end: number;
  type: PIIType;
}

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

type FormatType = Exclude<PIIType, 'person'>;

const FORMAT_PATTERNS: Record<FormatType, RegExp> = {
  credit_card: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  email: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
  phone: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
};

function gatherFormatCandidates(text: string): RegexMatch[] {
  const out: RegexMatch[] = [];
  for (const type of Object.keys(FORMAT_PATTERNS) as FormatType[]) {
    const re = FORMAT_PATTERNS[type];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push({ start: m.index, end: m.index + m[0].length, type });
    }
  }
  return out;
}

function rangeOccupied(occupied: Set<number>, start: number, end: number): boolean {
  // True interval intersection: ANY position in [start, end) being occupied
  // means overlap. Never a start-only check.
  for (let i = start; i < end; i++) {
    if (occupied.has(i)) return true;
  }
  return false;
}

export function resolveByPriority(candidates: RegexMatch[]): RegexMatch[] {
  const rank = (t: PIIType): number => PRIORITY.indexOf(t);
  const ordered = [...candidates].sort(
    (a, b) => rank(a.type) - rank(b.type) || a.start - b.start,
  );
  const occupied = new Set<number>();
  const accepted: RegexMatch[] = [];
  for (const c of ordered) {
    if (rangeOccupied(occupied, c.start, c.end)) continue;
    for (let i = c.start; i < c.end; i++) occupied.add(i);
    accepted.push(c);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

export function matchPII(text: string): RegexMatch[] {
  const candidates = gatherFormatCandidates(text);
  return resolveByPriority(candidates);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/regex-matcher.test.ts`
Expected: PASS (all cases in both describe blocks).

- [ ] **Step 5: Commit**

```bash
git add anonymizer/src/detection/regex-matcher.ts anonymizer/tests/regex-matcher.test.ts
git commit -m "feat(anonymizer): shared regex-matcher with explicit-priority overlap resolution

Private internal returning positions-only RegexMatch[]. Format patterns
(email/phone/ssn/credit_card) plus collect-then-resolve by explicit PRIORITY
(credit_card > ssn > email > phone > person). Overlap is true interval
intersection over [start, end). resolveByPriority exported for testing.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Person detection (FR + EN salutations) in the matcher

**Files:**
- Modify: `anonymizer/src/detection/regex-matcher.ts`
- Test: `anonymizer/tests/regex-matcher.test.ts`

**Interfaces:**
- Consumes: `matchPII`, `RegexMatch` from Task 1.
- Produces: `matchPII()` now also yields `{ type: 'person' }` spans (captured-name range only), resolved at lowest priority.

- [ ] **Step 1: Write the failing test**

Append to `anonymizer/tests/regex-matcher.test.ts`:

```ts
describe('matchPII — person (FR + EN salutations)', () => {
  it('detects an English-salutation name', () => {
    const text = 'Dear John Smith,';
    const p = matchPII(text).find(s => s.type === 'person');
    expect(p).toBeDefined();
    expect(text.slice(p!.start, p!.end)).toBe('John Smith');
  });

  it('detects a French-salutation name (deployment prerequisite)', () => {
    const text = 'Bonjour Marie Tremblay,';
    const p = matchPII(text).find(s => s.type === 'person');
    expect(p).toBeDefined();
    expect(text.slice(p!.start, p!.end)).toBe('Marie Tremblay');
  });

  it('handles accented surnames after French salutations', () => {
    const text = 'Madame Jean Côté';
    const p = matchPII(text).find(s => s.type === 'person');
    expect(p).toBeDefined();
    expect(text.slice(p!.start, p!.end)).toBe('Jean Côté');
  });

  it('detects M. / Mme abbreviation salutations', () => {
    expect(matchPII('M. Dupont').some(s => s.type === 'person')).toBe(true);
    expect(matchPII('Mme Gagnon').some(s => s.type === 'person')).toBe(true);
  });

  it('does NOT match a word merely ending in m before a period (M. negative guard)', () => {
    // "forum." ends in "m." but "m" is not a standalone token (preceded by "u"),
    // so the M. salutation must not fire and "Trois" must not become a person.
    const text = 'Le forum. Trois équipes inscrites';
    expect(matchPII(text).some(s => s.type === 'person')).toBe(false);
  });

  it('person yields to a higher-priority formatted span on overlap', () => {
    // person is lowest priority; if a formatted type claims the range, person loses.
    const out = resolveByPriority([
      { start: 5, end: 16, type: 'person' },
      { start: 5, end: 16, type: 'email' },
    ]);
    expect(out).toEqual([{ start: 5, end: 16, type: 'email' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/regex-matcher.test.ts`
Expected: FAIL — the new `person` cases fail (no person spans produced yet); the `M.` negative may incidentally pass, the positives fail.

- [ ] **Step 3: Write minimal implementation**

In `anonymizer/src/detection/regex-matcher.ts`, add the salutation regex and a person gatherer, and wire it into `matchPII`.

Add after `FORMAT_PATTERNS`:

```ts
// Person detection is salutation-anchored (not a pure format), so it inherits
// the deployment language. The first club deployment is French; an EN-only list
// would silently miss French names and leak the most sensitive PII (parents and
// minors). FR + EN salutations ship together.
//
// `\b...` anchors the trigger to a word boundary. `m\.` REQUIRES the trailing
// period so a word merely ending in "m" before a period (e.g. "forum.") does
// not fire. The captured group (m[1]) is the name only, not the salutation.
const SALUTATION =
  /\b(?:dear|hi|hello|greetings|hey(?:\s+there)?|mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?|bonjour|bonsoir|all[oô]|salut|ch[eè]re?s?|madame|monsieur|mme\.?|m\.)\s+([A-Z][a-zA-ZÀ-ÿ'\-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ'\-]+)*)/gi;

function gatherPersonCandidates(text: string): RegexMatch[] {
  const out: RegexMatch[] = [];
  SALUTATION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SALUTATION.exec(text)) !== null) {
    const name = m[1];
    if (!name) continue;
    const offset = m[0].indexOf(name);
    const start = m.index + offset;
    out.push({ start, end: start + name.length, type: 'person' });
  }
  return out;
}
```

Then change `matchPII` to include person candidates:

```ts
export function matchPII(text: string): RegexMatch[] {
  const candidates = [
    ...gatherFormatCandidates(text),
    ...gatherPersonCandidates(text),
  ];
  return resolveByPriority(candidates);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/regex-matcher.test.ts`
Expected: PASS (all format + person + overlap cases).

- [ ] **Step 5: Commit**

```bash
git add anonymizer/src/detection/regex-matcher.ts anonymizer/tests/regex-matcher.test.ts
git commit -m "feat(anonymizer): FR+EN salutation person detection in matcher

Salutation-anchored person spans (captured name only), resolved at lowest
priority. FR triggers (Bonjour/Bonsoir/Allô/Salut/Cher.../Madame/Monsieur/
M./Mme) alongside existing EN. M. requires the trailing period; a word merely
ending in m before a period does not fire (negative test). Accent-aware.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Public surface — `DetectionProvider` + `RegexDetector`

**Files:**
- Create: `anonymizer/src/detection/provider.ts`
- Create: `anonymizer/src/detection/regex-detector.ts`
- Test: `anonymizer/tests/regex-detector.test.ts`

**Interfaces:**
- Consumes: `matchPII` from Tasks 1–2.
- Produces:
  - `interface Span { start: number; end: number; type: string }`
  - `interface DetectionProvider { detect(text: string): Promise<Span[]> }`
  - `class RegexDetector implements DetectionProvider`

- [ ] **Step 1: Write the failing test**

Create `anonymizer/tests/regex-detector.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RegexDetector } from '../src/detection/regex-detector.js';
import type { Span } from '../src/detection/provider.js';

describe('RegexDetector', () => {
  const detector = new RegexDetector();

  it('detect() returns a Promise<Span[]>', async () => {
    const result = detector.detect('Contact mc@acme.com');
    expect(result).toBeInstanceOf(Promise);
    const spans = await result;
    expect(Array.isArray(spans)).toBe(true);
  });

  it('returns correct start/end/type for each supported type', async () => {
    const text = 'Email mc@acme.com call 514-555-1234 ssn 123-45-6789 card 4111111111111111 Dear John Smith';
    const spans = await detector.detect(text);
    const types = new Set(spans.map(s => s.type));
    expect(types.has('email')).toBe(true);
    expect(types.has('phone')).toBe(true);
    expect(types.has('ssn')).toBe(true);
    expect(types.has('credit_card')).toBe(true);
    expect(types.has('person')).toBe(true);
    for (const s of spans) {
      expect(text.slice(s.start, s.end).length).toBe(s.end - s.start);
    }
  });

  it('spans carry NO value field — positions only', async () => {
    const spans = await detector.detect('Contact mc@acme.com');
    for (const s of spans) {
      expect(Object.keys(s).sort()).toEqual(['end', 'start', 'type']);
      expect((s as Record<string, unknown>).value).toBeUndefined();
    }
  });

  it('detects a French-salutation name end to end', async () => {
    const text = 'Bonjour Marie Tremblay,';
    const spans = await detector.detect(text);
    const person = spans.find((s: Span) => s.type === 'person');
    expect(person).toBeDefined();
    expect(text.slice(person!.start, person!.end)).toBe('Marie Tremblay');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/regex-detector.test.ts`
Expected: FAIL — cannot resolve `../src/detection/regex-detector.js` / `../src/detection/provider.js`.

- [ ] **Step 3: Write minimal implementation**

Create `anonymizer/src/detection/provider.ts`:

```ts
/**
 * A detected PII span — POSITIONS only. The kernel reconstructs the value via
 * text.slice(start, end). `type` is a free string so a future network provider
 * (Presidio/NER) can return its own vocabulary without changing this interface.
 */
export interface Span {
  start: number;
  end: number;
  type: string;
}

/**
 * Pluggable PII detection. Async by default so the same contract covers an
 * in-process detector (regex) and a future network provider (Presidio HTTP).
 */
export interface DetectionProvider {
  detect(text: string): Promise<Span[]>;
}
```

Create `anonymizer/src/detection/regex-detector.ts`:

```ts
import type { DetectionProvider, Span } from './provider.js';
import { matchPII } from './regex-matcher.js';

/**
 * Base in-process detector. Covers the types where regex is reliable
 * (formatted identifiers): email, phone, ssn, credit_card, and salutation-based
 * person (FR + EN).
 *
 * address is intentionally delegated to a future NER detector — see PRIORITY in
 * regex-matcher.ts. Do NOT add an address regex here.
 */
export class RegexDetector implements DetectionProvider {
  async detect(text: string): Promise<Span[]> {
    return matchPII(text).map(({ start, end, type }) => ({ start, end, type }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/regex-detector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add anonymizer/src/detection/provider.ts anonymizer/src/detection/regex-detector.ts anonymizer/tests/regex-detector.test.ts
git commit -m "feat(anonymizer): DetectionProvider interface + RegexDetector

Public async detect(text) -> Promise<Span[]> with free-string Span.type as the
seam for future providers. RegexDetector maps the matcher's positions to Span,
dropping nothing and adding nothing (no value). address deferral documented.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Refactor `detectPII()` onto the shared matcher (behavior-preserving)

**Files:**
- Modify: `anonymizer/src/detector.ts`
- Test: `anonymizer/tests/detector.test.ts` (existing — must keep passing, used as regression)

**Interfaces:**
- Consumes: `matchPII` from Tasks 1–2, `PIISpan`/`PIICategory` from `./types.js`.
- Produces: `detectPII(text: string): PIISpan[]` (unchanged signature and `{ start, end, category, value }` shape).

- [ ] **Step 1: Run the existing tests to confirm the regression baseline passes**

Run: `npx vitest run tests/detector.test.ts`
Expected: PASS (current implementation). This is the behavior we must preserve.

- [ ] **Step 2: Replace the implementation with the matcher delegation**

Overwrite `anonymizer/src/detector.ts` entirely with:

```ts
import type { PIISpan } from './types.js';
import { matchPII } from './detection/regex-matcher.js';

/**
 * Detect PII spans in text.
 * Returns non-overlapping spans sorted by position.
 *
 * Thin adapter over the shared regex-matcher internal: the matcher owns the
 * patterns, the canonical type vocabulary, and overlap resolution (positions
 * only). The value is reconstructed HERE — never inside the internal. PIIType
 * is a subset of PIICategory, so the type assignment is direct.
 */
export function detectPII(text: string): PIISpan[] {
  return matchPII(text).map(({ start, end, type }) => ({
    start,
    end,
    category: type,
    value: text.slice(start, end),
  }));
}
```

- [ ] **Step 3: Run the existing detector tests to verify behavior is preserved**

Run: `npx vitest run tests/detector.test.ts`
Expected: PASS (all 6 existing cases — email/phone/credit_card/clean/bounds/no-overlap).

- [ ] **Step 4: Run the full anonymizer suite to confirm `anonymize()` is unaffected**

Run: `npx vitest run`
Expected: PASS — `tests/anonymizer.test.ts`, `tests/tokenizer.test.ts`, `tests/detector.test.ts`, `tests/regex-matcher.test.ts`, `tests/regex-detector.test.ts` all green.

- [ ] **Step 5: Commit**

```bash
git add anonymizer/src/detector.ts
git commit -m "refactor(anonymizer): detectPII delegates to shared regex-matcher

detectPII becomes a thin adapter mapping matcher positions to PIISpan
(category from type, value reconstructed via text.slice). Behavior preserved;
existing detector tests and anonymize() unchanged. Single source of truth for
the patterns now lives in the matcher (Option C).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Public exports, README, and full build

**Files:**
- Modify: `anonymizer/src/index.ts`
- Modify: `anonymizer/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: package public API exposing `RegexDetector`, `DetectionProvider`, `Span`.

- [ ] **Step 1: Write the failing test**

Append to `anonymizer/tests/regex-detector.test.ts`:

```ts
describe('package public exports', () => {
  it('exposes RegexDetector and the provider types from the package root', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.RegexDetector).toBe('function');
    const det = new mod.RegexDetector();
    const spans = await det.detect('Contact mc@acme.com');
    expect(spans.some((s: { type: string }) => s.type === 'email')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/regex-detector.test.ts`
Expected: FAIL — `mod.RegexDetector` is `undefined` (not yet exported from `index.ts`).

- [ ] **Step 3: Add the exports**

In `anonymizer/src/index.ts`, add these lines after the existing `export { Tokenizer }` line:

```ts
export { RegexDetector } from './detection/regex-detector.js';
export type { DetectionProvider, Span } from './detection/provider.js';
```

(Leave all existing exports and the `anonymize`/`deanonymize` functions unchanged. Do NOT export `matchPII`/`resolveByPriority` — the matcher stays private.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/regex-detector.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the README detection section**

In `anonymizer/README.md`, update the "Detection strategy" section and the category table so the docs match the new behavior. Replace the line that reads:

```
Spans are non-overlapping. If two patterns match the same range, the first one wins and the position is marked occupied.
```

with:

```
Spans are non-overlapping. Overlaps are resolved by an explicit priority
(credit_card > ssn > email > phone > person, most-specific wins): the
highest-priority match takes the whole span and overlapping lower-priority
matches are dropped. Detection is pluggable via the `DetectionProvider`
interface (`detect(text) → Promise<Span[]>`); `RegexDetector` is the built-in
provider. Person detection covers FR + EN salutations. `address` is not
detected by regex — it is delegated to a future NER detector.
```

In the category table, change the `address` row's "What it detects" cell from `Reserved (detection not yet implemented)` to `Reserved — delegated to future NER detector (not regex-detected)`.

- [ ] **Step 6: Build the package and the full workspace**

Run: `pnpm --filter @studio-foundation/anonymizer build`
Expected: `tsc` exits 0, no type errors.

Then from the repo root:

Run: `pnpm build`
Expected: full monorepo build succeeds (anonymizer is a leaf; nothing downstream changed its consumption).

- [ ] **Step 7: Commit**

```bash
git add anonymizer/src/index.ts anonymizer/README.md anonymizer/tests/regex-detector.test.ts
git commit -m "feat(anonymizer): export DetectionProvider/RegexDetector + update README

Public API now exposes RegexDetector, DetectionProvider, Span (matcher stays
private). README documents the explicit overlap priority, the pluggable
provider, FR+EN salutations, and the address-to-NER deferral.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- DetectionProvider interface, async `detect(text) → Promise<Span[]>` → Task 3. ✓
- RegexDetector returns spans, no replacement, email/phone/ssn/credit_card/person → Tasks 1–3. ✓
- `address` out of scope, documented on `PRIORITY` + `RegexDetector` → Tasks 1, 3. ✓
- Defined overlap handling, explicit priority `credit_card > ssn > email > phone > person`, winner-takes-whole-span → Task 1. ✓
- Constraint 1 (true interval intersection, partial-overlap test) → Task 1, `resolveByPriority` synthetic tests. ✓
- Constraint 2 (`person` captured-name span, yields to formatted types, last priority) → Task 2. ✓
- Constraint 3 (FR+EN salutations + `M.` positive and negative) → Task 2. ✓
- Single canonical `PIIType` vocabulary, `Span.type: string` seam → Tasks 1, 3. ✓
- Positions-only internal, value reconstructed in `detectPII` only → Tasks 1, 4. ✓
- Behavior-preserving old path, existing tests pass, `anonymize()` untouched → Task 4. ✓
- INV-10 (no internal deps), no new deps → Global Constraints; no `package.json` edits in any task. ✓
- Tests in isolation (no middleware, no runner) → Tasks 1–3 import only the detection modules. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows complete code. ✓

**3. Type consistency:** `PIIType`, `RegexMatch`, `matchPII`, `resolveByPriority`, `Span`, `DetectionProvider`, `RegexDetector`, `detectPII` used identically across tasks. `category: type` typechecks because `PIIType ⊆ PIICategory`. `Span.type: string` accepts `PIIType`. ✓

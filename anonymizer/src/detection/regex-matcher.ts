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

// Person detection is salutation-anchored (not a pure format), so it inherits
// the deployment language. The first club deployment is French; an EN-only list
// would silently miss French names and leak the most sensitive PII (parents and
// minors). FR + EN salutations ship together.
//
// Case-sensitivity is SPLIT across two passes, because a single regex cannot
// be case-insensitive in one part and case-sensitive in another (the `i` flag
// is all-or-nothing, and `i` on the name capture is exactly the bug: `[A-Z]`
// would then also match lowercase, tokenizing `bonjour marie` as a person):
//
//   1. SALUTATION_TRIGGER (`/gi`) — case-insensitive so `bonjour` / `Bonjour` /
//      `BONJOUR` all fire. It consumes the trigger *and* the whitespace after
//      it, leaving lastIndex at the first character of the name.
//   2. NAME (`/y`, sticky, NO `i`) — case-SENSITIVE, anchored to start exactly
//      where the trigger ended. It requires an initial uppercase on every word,
//      so a lowercase word after a salutation produces no name. A false positive
//      (tokenizing legitimate text) is strictly worse than a miss in an email
//      classifier, so we fail closed.
//
// (ES2025 inline flags `(?i:…)` would express this in one regex, but V8 on the
// supported runtime does not yet parse them.)
//
// `\b...` anchors the trigger to a word boundary. `m\.` REQUIRES the trailing
// period so a word merely ending in "m" before a period (e.g. "forum.") does
// not fire.
const SALUTATION_TRIGGER =
  /\b(?:dear|hi|hello|greetings|hey(?:\s+there)?|mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?|bonjour|bonsoir|all[oô]|salut|ch[eè]re?s?|madame|monsieur|mme\.?|m\.)\s+/gi;
const NAME = /[A-Z][a-zA-ZÀ-ÿ'\-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ'\-]+)*/y;

function gatherPersonCandidates(text: string): RegexMatch[] {
  const out: RegexMatch[] = [];
  SALUTATION_TRIGGER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SALUTATION_TRIGGER.exec(text)) !== null) {
    const start = m.index + m[0].length;
    // Sticky: matches only if a Title-cased name begins exactly at `start`.
    NAME.lastIndex = start;
    const nameMatch = NAME.exec(text);
    if (!nameMatch) continue;
    out.push({ start, end: start + nameMatch[0].length, type: 'person' });
  }
  return out;
}

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
  const candidates = [
    ...gatherFormatCandidates(text),
    ...gatherPersonCandidates(text),
  ];
  return resolveByPriority(candidates);
}

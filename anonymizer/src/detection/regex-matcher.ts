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

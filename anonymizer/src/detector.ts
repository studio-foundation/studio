import type { PIICategory, PIISpan } from './types.js';

// Regex patterns for structural PII (high precision)
const PATTERNS: Array<{ category: PIICategory; regex: RegExp }> = [
  {
    category: 'email',
    regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    category: 'phone',
    // US phone: must be at least 10 digits. Require optional country code + area code.
    // Anchored to avoid matching partial SSN-like strings.
    regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
  },
  {
    category: 'ssn',
    // SSN: exactly ddd-dd-dddd with hyphens (strict format, not dots or spaces
    // to avoid collision with phone numbers already consumed)
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    category: 'credit_card',
    regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  },
];

/**
 * Detect PII spans in text.
 * Returns non-overlapping spans sorted by position.
 */
export function detectPII(text: string): PIISpan[] {
  const spans: PIISpan[] = [];
  const occupied = new Set<number>();

  // Phase 1: Structural PII via regex
  for (const { category, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (isOccupied(occupied, start, end)) continue;
      markOccupied(occupied, start, end);
      spans.push({ start, end, category, value: match[0] });
    }
  }

  // Phase 2: Person names — best-effort via @redactpii/node
  try {
    detectPersons(text, occupied, spans);
  } catch {
    // Person detection is best-effort; silently skip on any error
  }

  return spans.sort((a, b) => a.start - b.start);
}

function isOccupied(occupied: Set<number>, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (occupied.has(i)) return true;
  }
  return false;
}

function markOccupied(occupied: Set<number>, start: number, end: number): void {
  for (let i = start; i < end; i++) {
    occupied.add(i);
  }
}

function detectPersons(text: string, occupied: Set<number>, spans: PIISpan[]): void {
  // The @redactpii/node NAME pattern only catches names after salutations
  // (Dear, Hi, Hello, Hey, etc.) — not bare names. We replicate that pattern
  // here and use it directly, avoiding the ESM/CJS import complexity.
  // This gives best-effort detection for explicitly addressed names.
  const salutationPattern =
    /(?:dear|hi|hello|greetings|hey(?:\s+there)?|mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?)\s+([A-Z][a-zA-ZÀ-ÿ'\-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ'\-]+)*)/gi;

  let match: RegExpExecArray | null;
  salutationPattern.lastIndex = 0;

  while ((match = salutationPattern.exec(text)) !== null) {
    // match[1] is the captured name group
    const nameValue = match[1];
    if (!nameValue) continue;

    // Find the actual start position of the captured name within the full match
    const fullMatchStart = match.index;
    const nameOffset = match[0].indexOf(nameValue);
    const start = fullMatchStart + nameOffset;
    const end = start + nameValue.length;

    if (isOccupied(occupied, start, end)) continue;
    markOccupied(occupied, start, end);
    spans.push({ start, end, category: 'person', value: nameValue });
  }
}

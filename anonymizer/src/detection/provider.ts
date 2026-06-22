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

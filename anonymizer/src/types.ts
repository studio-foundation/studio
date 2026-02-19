export type PIICategory =
  | 'person'
  | 'email'
  | 'phone'
  | 'address'
  | 'ssn'
  | 'credit_card';

export interface PIISpan {
  start: number;
  end: number;
  category: PIICategory;
  value: string;
}

export interface PIIDetectionResult {
  text: string;
  keymap: Record<string, string>;  // "PERSON_1" → "Marie-Claire"
}

export interface AnonymizerOptions {
  categories?: PIICategory[];
  seedKeymap?: Record<string, string>;
}

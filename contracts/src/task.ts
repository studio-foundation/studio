// Task status — used internally by run.ts (TaskRun.status)

export type TaskStatus = 'pending' | 'running' | 'success' | 'failed';

/**
 * Input contract for a single agent run, carried from the engine to the runner.
 *
 * `description` is the default flat task text — most pipelines have only this.
 * `fields`, when present, SUPERSEDES `description`: named fields are preserved
 * structurally so anonymization can tokenize each independently (run-level
 * shared keymap) BEFORE the prompt is assembled, and prompt assembly renders
 * the fields. Field names are OPAQUE to the kernel — it imposes no domain
 * meaning on them; an input opts into field-addressing, the kernel never
 * requires it. One documented branch: `fields` present → field path; absent →
 * flat-description path unchanged.
 */
export interface TaskInput {
  description: string;
  fields?: Record<string, string>;
  /**
   * Opaque scope: names of `fields` to anonymize. Treated as opaque strings —
   * the kernel imposes no domain meaning (INV-04). Undefined → anonymize all
   * fields (fail-safe); [] → anonymize none; ['a'] → only field `a`. Ignored
   * when `fields` is absent.
   */
  anonymize_fields?: string[];
  expected_output?: string;
  contract_name?: string;
}

// Post-execution filesystem check for a stage's declared outputs.
//
// A stage returning "success" only proves the agent finished — not that it
// actually wrote the files it was supposed to. This is the orchestrator
// responsibility that was previously bolted onto callers (e.g. run_wiki.py's
// `check_outputs`/`required_files`: "succeeded but expected files are missing").
// Declaring `expected_outputs.files` in the contract moves that check into the
// engine, where it belongs.
//
// Each entry is a path or glob relative to the repo workspace and must match at
// least one existing file. A miss is a validation error, so it flows into the
// RALPH loop like any other validator: the agent gets a retry with enriched
// feedback, and the stage fails only once attempts are exhausted.
import { glob } from 'node:fs/promises';
import type { ExpectedOutputs, ValidationResult } from '@studio-foundation/contracts';

export async function checkExpectedOutputs(
  expected: ExpectedOutputs | undefined,
  cwd: string
): Promise<ValidationResult> {
  if (!expected?.files || expected.files.length === 0) {
    return { valid: true, errors: [], warnings: [] };
  }

  const errors: string[] = [];
  for (const pattern of expected.files) {
    if (!(await matchesAny(pattern, cwd))) {
      errors.push(`Expected output missing: no file matches '${pattern}'`);
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

/** True as soon as one path matches the pattern under cwd. Fails closed on error. */
async function matchesAny(pattern: string, cwd: string): Promise<boolean> {
  try {
    for await (const _match of glob(pattern, { cwd })) {
      return true;
    }
  } catch {
    // An unreadable directory or bad pattern → treat as "not found", not a crash.
    return false;
  }
  return false;
}

// Run external (out-of-process) validators against a stage's real output.
//
// Each validator is a shell command that receives the output as JSON on stdin and
// prints `{ "valid": boolean, "errors": string[] }` on stdout. This is the binary
// validation hook the declarative contract cannot express (enums, types, cross-field
// rules) and the way to reuse a validator written in another language. Because it
// validates the ACTUAL output — not agent-reported tool arguments — the agent cannot
// fake it. The result flows into the RALPH loop like any other validator.
import { spawn } from 'node:child_process';
import type { ExternalValidator, ValidationResult } from '@studio-foundation/contracts';

const DEFAULT_TIMEOUT_MS = 30_000;

export async function runExternalValidators(
  output: unknown,
  validators: ExternalValidator[] | undefined,
  cwd: string
): Promise<ValidationResult> {
  if (!validators || validators.length === 0) {
    return { valid: true, errors: [], warnings: [] };
  }

  const errors: string[] = [];
  for (const validator of validators) {
    errors.push(...(await runOne(validator, output, cwd)));
  }
  return { valid: errors.length === 0, errors, warnings: [] };
}

/** Run a single validator. Resolves to its error strings (empty = valid). Fails closed. */
function runOne(validator: ExternalValidator, output: unknown, cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', validator.command], { cwd });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      validator.timeout_ms ?? DEFAULT_TIMEOUT_MS
    );

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve([`validator '${validator.name}' failed to start: ${err.message}`]);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        const detail = stderr.trim() || `${stdout.trim().slice(0, 200)} (exit ${code})`;
        resolve([`validator '${validator.name}' produced unparseable output: ${detail}`]);
        return;
      }

      const result = parsed as { valid?: unknown; errors?: unknown };
      if (result.valid === true) {
        resolve([]);
        return;
      }
      const errs =
        Array.isArray(result.errors) && result.errors.length > 0
          ? result.errors.map(String)
          : [`validator '${validator.name}' rejected the output (exit ${code})`];
      resolve(errs);
    });

    // A validator that ignores stdin and exits immediately (e.g. `echo ...`)
    // closes the pipe's read end before we finish writing, so this write emits
    // EPIPE. That's benign — the validator's verdict is captured in 'close' — but
    // without a listener the error is unhandled and crashes the process. Swallow it.
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify(output));
    child.stdin.end();
  });
}

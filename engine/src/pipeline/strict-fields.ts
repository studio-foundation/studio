// STU-408 — fail-loud config loading
//
// The kernel refuses config fields it does not implement. A silently ignored
// field is config-theatre: the user believes a guarantee is in place that is
// never enforced. Unknown fields are a hard load error, never a warning.

/**
 * Throw if `obj` contains any key not in `allowed`.
 *
 * @param obj      parsed YAML object (or nested block) to check
 * @param allowed  every field name the kernel actually implements
 * @param what     human label for the block, e.g. "contract" or "stage 'qa'"
 * @param context  file suffix for the error message, e.g. " (from /path)"
 */
export function assertKnownFields(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
  context: string
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const suggestion = suggestClosest(key, allowed);
      throw new Error(
        `Unknown field '${key}' in ${what}${context}.` +
        (suggestion ? ` Did you mean '${suggestion}'?` : '') +
        ` Known fields: ${[...allowed].sort().join(', ')}.`
      );
    }
  }
}

/**
 * Return the candidate closest to `name`, or undefined if nothing is
 * close enough to be a plausible typo (a far-off name must yield NO
 * suggestion — a wrong "did you mean" is worse than none).
 *
 * Expected behavior (see engine/tests/strict-fields.test.ts):
 *   suggestClosest('post_validations', CONTRACT_FIELDS) === 'post_validation'
 *   suggestClosest('zzz_totally_unrelated', CONTRACT_FIELDS) === undefined
 */
export function suggestClosest(
  name: string,
  candidates: readonly string[]
): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const distance = levenshtein(name, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  // Relative threshold: a short name tolerates 1 typo, a long one a few more.
  // Anything beyond that is not a typo — suggesting it would mislead.
  const threshold = Math.max(1, Math.floor(name.length / 3));
  return bestDistance <= threshold ? best : undefined;
}

/** Minimum single-character edits (insert/delete/substitute) between a and b. */
function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }

  return prev[b.length];
}

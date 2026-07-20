// Shared {{...}} template interpolation for sub-pipeline input mapping.
//
// Both fan-out (`map`) and one-shot (`call`) stages build a child run's input
// from a template of `{{ref}}` references. They differ only in *what* a ref
// resolves against — a map has an item/index scope, a call reads the parent
// context — so the substitution mechanics live here once and each caller passes
// its own resolver.

export type RefResolver = (ref: string) => unknown;

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const SOLE_TOKEN = /^\{\{([^}]+)\}\}$/;
const TOKEN = /\{\{([^}]+)\}\}/g;

/**
 * Interpolate a template value against a reference resolver. Non-strings pass
 * through unchanged. A string that is exactly one `{{ref}}` keeps the resolved
 * value's native type (so an object/array stays structured); any other string
 * interpolates each `{{ref}}` to text.
 */
export function interpolateTemplate(value: unknown, resolve: RefResolver): unknown {
  if (typeof value !== 'string') return value;

  const sole = value.match(SOLE_TOKEN);
  if (sole) return resolve(sole[1].trim());

  return value.replace(TOKEN, (_full, ref) => stringify(resolve(ref.trim())));
}

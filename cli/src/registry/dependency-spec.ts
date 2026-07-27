/**
 * A dependency entry in `metadata.dependencies.<kind>.{required,recommended}`.
 * Syntax: `[marketplace:]name[@range]` — `git`, `git@>=1.2.0`, `acme-corp:deploy@^2.0.0`.
 */
export interface DependencySpec {
  raw: string;
  marketplace: string;
  name: string;
  range?: string;
}

/** The marketplace an unqualified dependency name resolves against. */
export const DEFAULT_MARKETPLACE = 'studio-community';

export function parseDependencySpec(raw: string): DependencySpec {
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(':');
  const marketplace = colon === -1 ? DEFAULT_MARKETPLACE : trimmed.slice(0, colon).trim();
  const rest = (colon === -1 ? trimmed : trimmed.slice(colon + 1)).trim();

  const at = rest.indexOf('@');
  const name = (at === -1 ? rest : rest.slice(0, at)).trim();
  const range = at === -1 ? undefined : rest.slice(at + 1).trim() || undefined;

  if (!name) throw new Error(`Invalid dependency entry: '${raw}'`);
  if (!marketplace) throw new Error(`Invalid dependency entry: '${raw}' — empty marketplace`);

  return { raw: trimmed, marketplace, name, range };
}

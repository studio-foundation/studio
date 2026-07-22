// Environment-variable interpolation for loaded YAML (config and agent profiles).

/**
 * Replace `${VAR}` and `${VAR:-default}` in `content` with `process.env[VAR]`.
 *
 * `${VAR}` resolves to the empty string when VAR is unset.
 * `${VAR:-default}` resolves to `default` when VAR is unset OR empty — so an
 * absent env leaves the YAML's own literal in place (used to keep the shipped
 * provider/model pin when no `.env` overrides it).
 */
export function resolveEnvVars(content: string): string {
  return content.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    const sep = expr.indexOf(':-');
    const name = (sep === -1 ? expr : expr.slice(0, sep)).trim();
    const fallback = sep === -1 ? '' : expr.slice(sep + 2);
    const value = process.env[name];
    return value === undefined || value === '' ? fallback : value;
  });
}

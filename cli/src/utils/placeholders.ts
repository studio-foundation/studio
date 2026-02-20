/**
 * Replace {{ALL_CAPS}} placeholders in `content` with values from `vars`.
 * Throws if any placeholder has no corresponding entry in `vars`.
 */
export function applyPlaceholders(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (match, key) => {
    if (key in vars) return vars[key];
    throw new Error(`Unresolved placeholder: ${match}`);
  });
}

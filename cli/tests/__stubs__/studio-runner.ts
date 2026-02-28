/**
 * Stub for @studio/runner used in tests when the package has not been built.
 * Only exports the symbols used by CLI source code under test.
 */
export async function listAvailableToolTemplates(): Promise<{ name: string; description: string }[]> {
  return [];
}

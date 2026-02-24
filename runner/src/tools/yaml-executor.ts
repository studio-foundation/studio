// runner/src/tools/yaml-executor.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ParseOutputFormat } from '@studio/contracts';

const execFileAsync = promisify(execFile);

/**
 * Render a shell command template with parameter substitution.
 *
 * Supports:
 *   {{param}}              → stringify value (empty string if undefined)
 *   {{#if param}}...{{/if}}              → include block only when param is truthy
 *   {{#if param}}...{{else}}...{{/if}}   → if/else block
 *   {{param | join 'sep'}} → join array with separator
 *   {{param | json}}       → JSON.stringify(value)
 */
export function renderTemplate(
  template: string,
  params: Record<string, unknown>
): string {
  let result = template;

  // {{#if param}}...{{else}}...{{/if}} blocks (with else)
  result = result.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key: string, trueBranch: string, falseBranch: string) =>
      params[key] ? trueBranch : falseBranch
  );

  // {{#if param}}...{{/if}} blocks (without else)
  result = result.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key: string, inner: string) => (params[key] ? inner : '')
  );

  // {{param | join 'sep'}} filter
  result = result.replace(
    /\{\{(\w+)\s*\|\s*join\s+'([^']*)'\}\}/g,
    (_, key: string, sep: string) => {
      const value = params[key];
      return Array.isArray(value) ? value.join(sep) : String(value ?? '');
    }
  );

  // {{param | join "sep"}} filter (double quotes variant)
  result = result.replace(
    /\{\{(\w+)\s*\|\s*join\s+"([^"]*)"\}\}/g,
    (_, key: string, sep: string) => {
      const value = params[key];
      return Array.isArray(value) ? value.join(sep) : String(value ?? '');
    }
  );

  // {{param | json}} filter
  result = result.replace(
    /\{\{(\w+)\s*\|\s*json\}\}/g,
    (_, key: string) => JSON.stringify(params[key] ?? null)
  );

  // Plain {{param}} substitution
  result = result.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => (params[key] === undefined ? '' : String(params[key]))
  );

  return result;
}

export interface ShellResult {
  success: boolean;
  output: unknown;
  error?: string;
}

/**
 * Execute a rendered shell command and parse the output.
 */
export async function executeShellCommand(
  command: string,
  parseOutput: ParseOutputFormat = 'text',
  workingDir: string,
  timeoutMs: number = 30_000,
  env?: Record<string, string>
): Promise<ShellResult> {
  try {
    const { stdout } = await execFileAsync('sh', ['-c', command], {
      cwd: workingDir,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });

    const raw = stdout.trim();

    if (parseOutput === 'json') {
      try {
        return { success: true, output: JSON.parse(raw) };
      } catch {
        return {
          success: false,
          output: undefined,
          error: `Failed to parse JSON output: ${raw.slice(0, 200)}`,
        };
      }
    }

    return { success: true, output: raw };
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: string; stdout?: string };
    // When claude -p exits non-zero, the JSON result is still in stdout.
    // Try to parse it so the runner gets structured error info instead of "Command failed".
    if (parseOutput === 'json' && e.stdout?.trim()) {
      try {
        return { success: false, output: JSON.parse(e.stdout.trim()), error: e.stderr?.trim() || undefined };
      } catch { /* fall through to default error */ }
    }
    return { success: false, output: undefined, error: e.stderr?.trim() || e.message || 'Command failed' };
  }
}

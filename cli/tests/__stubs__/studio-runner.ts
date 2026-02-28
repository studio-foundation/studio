/**
 * Stub for @studio/runner used in tests when the package has not been built.
 * Reads from the actual runner template files so tool/integration tests work correctly.
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const RUNNER_TEMPLATES = resolve(import.meta.dirname, '../../../runner/templates');
const TOOL_TEMPLATES_DIR = resolve(RUNNER_TEMPLATES, 'tools');
const INTEGRATION_TEMPLATES_DIR = resolve(RUNNER_TEMPLATES, 'integrations');

// ── Tool functions ────────────────────────────────────────────────────────────

export async function listAvailableToolTemplates(): Promise<{ name: string; description: string }[]> {
  let files: string[];
  try {
    files = (await readdir(TOOL_TEMPLATES_DIR)).filter(f => f.endsWith('.tool.yaml')).sort();
  } catch {
    return [];
  }
  const result: { name: string; description: string }[] = [];
  for (const file of files) {
    const content = await readFile(resolve(TOOL_TEMPLATES_DIR, file), 'utf-8');
    const def = yaml.load(content) as { description?: string };
    result.push({ name: file.replace('.tool.yaml', ''), description: def.description ?? '' });
  }
  return result;
}

export async function getBundledToolTemplate(name: string): Promise<string | null> {
  const filePath = resolve(TOOL_TEMPLATES_DIR, `${name}.tool.yaml`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export const BUILTIN_TOOL_NAMES = new Set(['repo-manager', 'shell', 'search', 'git']);

// ── Integration functions ─────────────────────────────────────────────────────

export async function getBundledIntegrationTemplate(name: string): Promise<string | null> {
  const filePath = resolve(INTEGRATION_TEMPLATES_DIR, `${name}.integration.yaml`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function listAvailableIntegrationTemplates(): Promise<{ name: string; description: string }[]> {
  let files: string[];
  try {
    files = (await readdir(INTEGRATION_TEMPLATES_DIR)).filter(f => f.endsWith('.integration.yaml')).sort();
  } catch {
    return [];
  }
  const result: { name: string; description: string }[] = [];
  for (const file of files) {
    const content = await readFile(resolve(INTEGRATION_TEMPLATES_DIR, file), 'utf-8');
    const def = yaml.load(content) as { description?: string };
    result.push({ name: file.replace('.integration.yaml', ''), description: def.description ?? '' });
  }
  return result;
}

export async function loadProjectIntegrations(): Promise<unknown[]> {
  return [];
}

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { loadProjectTools } from '@studio-foundation/runner';
import type { StudioConfig } from './config.js';
import {
  CONFIG_FILE,
  CONFIG_EXAMPLE_FILE,
  checkConfig,
  formatConfigCheckError,
} from './config-validation.js';
import { STUDIO_VERSION, checkStudioVersion } from './version-guard.js';
import { checkBinaries, formatBinaryPreflightError, parseRequirement } from './binary-preflight.js';
import type { BinaryRequirement } from './binary-preflight.js';
import {
  SUPPRESS_HINT,
  formatCoverageEntry,
  missingContractWarningsEnabled,
  resolvePipelinesDir,
  scanPipelineContracts,
} from './contract-warnings.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface PreflightCheck {
  name: string;
  status: CheckStatus;
  /** Single line shown next to the check name. */
  detail: string;
  /** Multi-line actionable text, printed below the list when the check didn't pass. */
  fix?: string;
}

/**
 * `${VAR}` references in a raw config that resolve to nothing: no `:-` fallback
 * and no value in the environment. `resolveEnvVars` turns those into an empty
 * string, so the key looks present while carrying no value.
 */
export function unsetEnvRefs(raw: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const missing = new Set<string>();
  for (const [, expr] of raw.matchAll(/\$\{([^}]+)\}/g)) {
    if (expr.includes(':-')) continue;
    const name = expr.trim();
    if (env[name] === undefined || env[name] === '') missing.add(name);
  }
  return [...missing];
}

/** Every string leaf reachable from a parsed YAML document — comments never survive `yaml.load`. */
function leafStringValues(doc: unknown): string[] {
  if (typeof doc === 'string') return [doc];
  if (Array.isArray(doc)) return doc.flatMap(leafStringValues);
  if (doc && typeof doc === 'object') return Object.values(doc).flatMap(leafStringValues);
  return [];
}

function versionCheck(config: StudioConfig): PreflightCheck {
  const required = config.studio_version;
  const error = checkStudioVersion(required, 'This project');
  const suffix = required ? `(project requires ${required})` : '(no requirement declared)';
  return {
    name: 'Studio version',
    status: error ? 'fail' : 'ok',
    detail: `${STUDIO_VERSION}  ${suffix}`,
    ...(error ? { fix: `Error: ${error}` } : {}),
  };
}

async function configCheck(studioDir: string): Promise<PreflightCheck> {
  const result = await checkConfig(studioDir);
  const detail = {
    ok: `matches ${CONFIG_EXAMPLE_FILE}`,
    'no-contract': `no ${CONFIG_EXAMPLE_FILE} — nothing to enforce`,
    'missing-config': `${CONFIG_FILE} not found`,
    'missing-keys': `${CONFIG_FILE} missing ${result.missingKeys.length} key${result.missingKeys.length > 1 ? 's' : ''}: ${result.missingKeys.join(', ')}`,
  }[result.status];
  const fix = formatConfigCheckError(result);
  return {
    name: 'Config',
    status: fix ? 'fail' : 'ok',
    detail,
    ...(fix ? { fix } : {}),
  };
}

async function binaryRequirements(
  studioDir: string,
  config: StudioConfig
): Promise<BinaryRequirement[]> {
  const configsDir = config.paths?.configs ? resolve(config.paths.configs) : studioDir;
  const plugins = await loadProjectTools(join(configsDir, 'tools'), process.cwd());
  return [
    ...(config.requires_binaries ?? []).map((entry) => ({ entry, declaredBy: 'this project' })),
    ...plugins.flatMap((plugin) =>
      (plugin.requiresBinaries ?? []).map((entry) => ({
        entry,
        declaredBy: `tool plugin '${plugin.name}'`,
      }))
    ),
  ];
}

function binaryCheck(requirements: BinaryRequirement[]): PreflightCheck {
  const failures = checkBinaries(requirements);
  const fix = formatBinaryPreflightError(failures);
  const names = [...new Set(requirements.map((r) => parseRequirement(r.entry).binary))];
  return {
    name: 'Required binaries',
    status: fix ? 'fail' : 'ok',
    detail: fix
      ? `${[...new Set(failures.map((f) => f.binary))].join(', ')} missing or unsupported`
      : names.length > 0
        ? names.join(', ')
        : 'none declared',
    ...(fix ? { fix } : {}),
  };
}

async function envCheck(studioDir: string): Promise<PreflightCheck> {
  let raw: string;
  try {
    raw = await readFile(join(studioDir, CONFIG_FILE), 'utf-8');
  } catch {
    return { name: 'Env vars', status: 'ok', detail: `no ${CONFIG_FILE} to read` };
  }

  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch {
    return { name: 'Env vars', status: 'ok', detail: `${CONFIG_FILE} is not valid YAML — skipped` };
  }
  const values = leafStringValues(doc).join('\n');

  const unset = unsetEnvRefs(values);
  const referenced = new Set([...values.matchAll(/\$\{([^}]+)\}/g)].map(([, e]) => e.trim()));
  if (unset.length === 0) {
    return {
      name: 'Env vars',
      status: 'ok',
      detail: referenced.size > 0 ? `${referenced.size} reference(s) resolved` : 'none referenced',
    };
  }
  return {
    name: 'Env vars',
    status: 'warn',
    detail: `${unset.join(', ')} unset — resolves to an empty value`,
    fix:
      `Warning: ${CONFIG_FILE} references environment variable${unset.length > 1 ? 's' : ''} that ${unset.length > 1 ? 'are' : 'is'} unset:\n` +
      unset.map((name) => `  - ${name}`).join('\n') +
      `\n  Export ${unset.length > 1 ? 'them' : 'it'}, or declare a fallback: \${VAR:-default}`,
  };
}

/**
 * Contract coverage across the pipelines this project ships. A stage with no
 * `contract:` runs unvalidated, which is legitimate but silent at run time —
 * this is where it becomes catchable before the run (STU-703). Never a `fail`:
 * the run is not in danger, only unguarded.
 */
async function contractCheck(studioDir: string, config: StudioConfig): Promise<PreflightCheck> {
  const coverage = await scanPipelineContracts(resolvePipelinesDir(studioDir, config));
  const unreadable = coverage.unreadable.length
    ? ` (${coverage.unreadable.length} unreadable: ${coverage.unreadable.join(', ')})`
    : '';

  if (coverage.scanned === 0) {
    return { name: 'Contracts', status: 'ok', detail: `no pipelines found${unreadable}` };
  }

  const count = coverage.stages.length;
  const pipelines = `${coverage.scanned} pipeline${coverage.scanned > 1 ? 's' : ''}`;
  if (count === 0) {
    return {
      name: 'Contracts',
      status: 'ok',
      detail: `every stage validates its output (${pipelines})${unreadable}`,
    };
  }

  const summary = `${count} stage${count > 1 ? 's' : ''} of ${pipelines} run${count > 1 ? '' : 's'} unvalidated`;
  if (!missingContractWarningsEnabled(config)) {
    return {
      name: 'Contracts',
      status: 'ok',
      detail: `${summary} — warnings suppressed${unreadable}`,
    };
  }

  return {
    name: 'Contracts',
    status: 'warn',
    detail: `${summary}${unreadable}`,
    fix:
      'Warning: stages with no `contract:` run unvalidated — no schema check, no tool_calls floor, no rejection detection:\n' +
      coverage.stages.map((s) => `  - ${formatCoverageEntry(s)}`).join('\n') +
      `\n  ${SUPPRESS_HINT}`,
  };
}

/** Every preflight check, in display order. Never throws — a broken check reports itself. */
export async function collectChecks(
  studioDir: string,
  config: StudioConfig
): Promise<PreflightCheck[]> {
  return [
    versionCheck(config),
    await configCheck(studioDir),
    binaryCheck(await binaryRequirements(studioDir, config)),
    await envCheck(studioDir),
    await contractCheck(studioDir, config),
  ];
}

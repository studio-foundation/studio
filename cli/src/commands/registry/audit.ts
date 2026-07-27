import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { findStudioDir } from '../../studio-dir.js';
import { legacyInstallPaths } from '../../registry/legacy-paths.js';
import { constraintsOf, formatConstraints, unsatisfied } from '../../registry/constraints.js';

interface AuditResult {
  name: string;
  ok: boolean;
  status: 'ok' | 'tampered' | 'missing' | 'conflict';
  detail?: string;
}

interface AuditOptions {
  studioDir?: string;
  cwd?: string;
}

export async function auditPackages(options: AuditOptions = {}): Promise<AuditResult[]> {
  const studioDir = options.studioDir ??
    (await findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));
  const lockfile = new RegistryLockfile(studioDir);
  const installed = await lockfile.list();
  const results: AuditResult[] = [];

  for (const entry of installed) {
    // The installed version against the ranges its dependents declared. Both live
    // in the lockfile, so a graph that drifted since install is caught offline.
    const broken = unsatisfied(entry.version, constraintsOf(entry));
    const conflict: AuditResult | null = broken.length === 0 ? null : {
      name: entry.name,
      ok: false,
      status: 'conflict',
      detail: `v${entry.version} does not satisfy ${formatConstraints(broken)}`,
    };

    // A template's payload is a whole tree hashed against remote paths at download
    // time — not reconstructible from disk. Only plugins are verifiable here.
    const legacy = entry.files === undefined;
    const files = entry.type === 'template'
      ? []
      : entry.files ?? legacyInstallPaths(entry.name, entry.type);
    if (files.length === 0) {
      results.push(conflict ?? { name: entry.name, ok: true, status: 'ok' });
      continue;
    }

    if (files.some((f) => !existsSync(resolve(studioDir, f)))) {
      results.push({ name: entry.name, ok: false, status: 'missing' });
      continue;
    }

    // Pre-`files` entries were hashed over content alone; the path went in later.
    const hash = createHash('sha256');
    for (const relPath of files) {
      const content = await readFile(resolve(studioDir, relPath), 'utf8');
      hash.update(legacy ? content : relPath + content);
    }
    if (hash.digest('hex') !== entry.sha256) {
      results.push({ name: entry.name, ok: false, status: 'tampered' });
      continue;
    }
    results.push(conflict ?? { name: entry.name, ok: true, status: 'ok' });
  }

  return results;
}

export async function auditCommand(): Promise<void> {
  const results = await auditPackages();

  if (results.length === 0) {
    console.log(chalk.gray('No packages installed.'));
    return;
  }

  let hasIssues = false;
  for (const r of results) {
    if (r.ok) {
      console.log(chalk.green(`  ✓ ${r.name}`));
    } else {
      hasIssues = true;
      console.log(`  ✗ ${r.name} — ${chalk.red(r.status.toUpperCase())}${r.detail ? `: ${r.detail}` : ''}`);
    }
  }

  if (hasIssues) {
    console.log(chalk.yellow('\nRun: studio registry update <name> to reinstall affected packages'));
    process.exit(1);
  }
}

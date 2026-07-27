import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { findStudioDir } from '../../studio-dir.js';
import { legacyInstallPaths } from '../../registry/legacy-paths.js';

interface AuditResult {
  name: string;
  ok: boolean;
  status: 'ok' | 'tampered' | 'missing';
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
    // A template's payload is a whole tree hashed against remote paths at download
    // time — not reconstructible from disk. Only plugins are verifiable here.
    const legacy = entry.files === undefined;
    const files = entry.type === 'template'
      ? []
      : entry.files ?? legacyInstallPaths(entry.name, entry.type);
    if (files.length === 0) {
      results.push({ name: entry.name, ok: true, status: 'ok' });
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
    const ok = hash.digest('hex') === entry.sha256;
    results.push({ name: entry.name, ok, status: ok ? 'ok' : 'tampered' });
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
      const label = r.status === 'missing' ? chalk.red('MISSING') : chalk.red('TAMPERED');
      console.log(`  ✗ ${r.name} — ${label}`);
    }
  }

  if (hasIssues) {
    console.log(chalk.yellow('\nRun: studio registry update <name> to reinstall affected packages'));
    process.exit(1);
  }
}

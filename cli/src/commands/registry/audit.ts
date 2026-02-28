import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { findStudioDir } from '../../studio-dir.js';
import { INSTALL_DIRS } from '../../registry/types.js';
import type { PackageType } from '../../registry/types.js';

interface AuditResult {
  name: string;
  ok: boolean;
  status: 'ok' | 'tampered' | 'missing';
}

const FILE_EXTENSIONS: Partial<Record<PackageType, string>> = {
  tool: '.tool.yaml',
  pipeline: '.pipeline.yaml',
  integration: '.integration.yaml',
  agent: '.agent.yaml',
  skill: '.skill.md',
};

interface AuditOptions {
  studioDir?: string;
  cwd?: string;
}

export async function auditPackages(options: AuditOptions = {}): Promise<AuditResult[]> {
  const studioDir = options.studioDir ??
    (findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));
  const lockfile = new RegistryLockfile(studioDir);
  const installed = await lockfile.list();
  const results: AuditResult[] = [];

  for (const entry of installed) {
    const type = entry.type as PackageType;
    const destDir = resolve(studioDir, INSTALL_DIRS[type]);

    if (type === 'template' || type === 'plugin') {
      // Directory packages: skip SHA check (would need to hash the full tree)
      results.push({ name: entry.name, ok: true, status: 'ok' });
      continue;
    }

    const ext = FILE_EXTENSIONS[type] ?? '.yaml';
    const filePath = resolve(destDir, `${entry.name}${ext}`);

    if (!existsSync(filePath)) {
      results.push({ name: entry.name, ok: false, status: 'missing' });
      continue;
    }

    const content = await readFile(filePath, 'utf8');
    const actual = createHash('sha256').update(content).digest('hex');
    const ok = actual === entry.sha256;
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

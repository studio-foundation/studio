import chalk from 'chalk';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { findStudioDir } from '../../studio-dir.js';
import { INSTALL_DIRS } from '../../registry/types.js';
import type { PackageType } from '../../registry/types.js';

interface RemoveOptions {
  studioDir?: string;
  cwd?: string;
}

const FILE_EXTENSIONS: Partial<Record<PackageType, string>> = {
  tool: '.tool.yaml',
  pipeline: '.pipeline.yaml',
  integration: '.integration.yaml',
  agent: '.agent.yaml',
  skill: '.skill.md',
};

async function deletePackageFiles(studioDir: string, name: string, type: PackageType): Promise<void> {
  const destDir = resolve(studioDir, INSTALL_DIRS[type]);
  if (type === 'template' || type === 'plugin') {
    const dirPath = resolve(destDir, name);
    if (existsSync(dirPath)) await rm(dirPath, { recursive: true });
  } else {
    const ext = FILE_EXTENSIONS[type] ?? '.yaml';
    const filePath = resolve(destDir, `${name}${ext}`);
    if (existsSync(filePath)) await rm(filePath);
  }
}

export async function removePackage(name: string, options: RemoveOptions = {}): Promise<void> {
  const studioDir = options.studioDir ??
    (await findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));
  const lockfile = new RegistryLockfile(studioDir);
  const entry = await lockfile.get(name);
  if (!entry) throw new Error(`'${name}' is not installed`);

  // Block removal if another package depends on this one
  const dependents = (entry.required_by ?? []).filter(d => d !== '');
  if (dependents.length > 0) {
    throw new Error(`'${name}' is required by: ${dependents.join(', ')}. Remove them first.`);
  }

  const type = entry.type as PackageType;
  await deletePackageFiles(studioDir, name, type);
  await lockfile.remove(name);
  console.log(chalk.green(`✓ Removed ${name}`));

  // Find orphans: packages whose required_by only contained 'name'
  const data = await lockfile.read();
  const orphans: string[] = [];
  for (const [pkgName, pkgEntry] of Object.entries(data.installed)) {
    const wasRequired = pkgEntry.required_by?.includes(name);
    const otherRequirers = (pkgEntry.required_by ?? []).filter(r => r !== name);
    if (wasRequired && otherRequirers.length === 0) {
      orphans.push(pkgName);
    }
  }

  if (orphans.length > 0) {
    const { confirm } = await import('@inquirer/prompts');
    const cleanup = await confirm({
      message: `These packages are no longer needed: [${orphans.join(', ')}]. Remove them?`,
      default: true,
    });
    if (cleanup) {
      for (const orphan of orphans) {
        // Strip the requirer reference so the protection check passes
        await lockfile.removeRequiredBy(orphan, name);
        await removePackage(orphan, { studioDir });
      }
    } else {
      console.log(chalk.yellow(`Packages left installed: [${orphans.join(', ')}]`));
    }
  }
}

export async function removeCommand(name: string): Promise<void> {
  try {
    await removePackage(name);
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

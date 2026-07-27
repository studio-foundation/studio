import chalk from 'chalk';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { findStudioDir } from '../../studio-dir.js';
import { legacyInstallPaths } from '../../registry/legacy-paths.js';
import type { LockfileEntry } from '../../registry/types.js';

interface RemoveOptions {
  studioDir?: string;
  cwd?: string;
}

async function deletePackageFiles(studioDir: string, name: string, entry: LockfileEntry): Promise<void> {
  for (const relPath of entry.files ?? legacyInstallPaths(name, entry.type)) {
    const path = resolve(studioDir, relPath);
    if (existsSync(path)) await rm(path, { recursive: true });
  }
}

export async function removePackage(name: string, options: RemoveOptions = {}): Promise<void> {
  const studioDir = options.studioDir ??
    (await findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));
  const lockfile = new RegistryLockfile(studioDir);
  const entry = await lockfile.get(name);
  if (!entry) throw new Error(`'${name}' is not installed`);

  // Warn, don't block: Studio validates tool availability at run time, so a second
  // gate here would be enforcement without authority and would make cleanup hostile.
  const dependents = (entry.required_by ?? []).filter(d => d !== '');
  if (dependents.length > 0) {
    console.log(chalk.yellow(`⚠ '${name}' is required by: ${dependents.join(', ')} — those references will break.`));
  }

  await deletePackageFiles(studioDir, name, entry);
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
        // Strip the requirer reference so the orphan isn't warned about
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

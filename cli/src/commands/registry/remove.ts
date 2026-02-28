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

export async function removePackage(name: string, options: RemoveOptions = {}): Promise<void> {
  const studioDir = options.studioDir ??
    (await findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));
  const lockfile = new RegistryLockfile(studioDir);
  const entry = await lockfile.get(name);
  if (!entry) throw new Error(`'${name}' is not installed`);

  const type = entry.type as PackageType;
  const destDir = resolve(studioDir, INSTALL_DIRS[type]);

  if (type === 'template' || type === 'plugin') {
    const dirPath = resolve(destDir, name);
    if (existsSync(dirPath)) await rm(dirPath, { recursive: true });
  } else {
    const ext = FILE_EXTENSIONS[type] ?? '.yaml';
    const filePath = resolve(destDir, `${name}${ext}`);
    if (existsSync(filePath)) await rm(filePath);
  }

  await lockfile.remove(name);
  console.log(chalk.green(`✓ Removed ${name}`));
}

export async function removeCommand(name: string): Promise<void> {
  try {
    await removePackage(name);
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

import chalk from 'chalk';
import { resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { RegistryClient } from '../../registry/client.js';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { RegistryCache } from '../../registry/cache.js';
import { syncRegistry } from './sync.js';
import { findStudioDir } from '../../studio-dir.js';
import type { PackageMetadata, PackageType } from '../../registry/types.js';
import { INSTALL_DIRS } from '../../registry/types.js';

const SINGLE_FILE_EXTENSIONS: Partial<Record<PackageType, string>> = {
  tool: '.tool.yaml',
  pipeline: '.pipeline.yaml',
  integration: '.integration.yaml',
  agent: '.agent.yaml',
  skill: '.skill.md',
};

const SHELL_EXEC_PATTERN = /execute:\s*\n\s+type:\s*shell/;

interface InstallOptions {
  studioDir?: string;
  force?: boolean;
  cwd?: string;
}

export async function installPackage(nameAtVersion: string, options: InstallOptions = {}): Promise<void> {
  const [name, requestedVersion] = nameAtVersion.split('@');

  const studioDir = options.studioDir ??
    (await findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));
  const lockfile = new RegistryLockfile(studioDir);

  // Check already installed
  const existing = await lockfile.get(name);
  if (existing && !options.force) {
    console.log(chalk.yellow(`${name} v${existing.version} is already installed. Use --force to reinstall.`));
    return;
  }

  // Sync cache and resolve package type
  await syncRegistry({ force: false, silent: true });
  const cache = new RegistryCache();
  const index = await cache.read();
  const indexEntry = index?.packages.find(p => p.name === name);
  if (!indexEntry) throw new Error(`Package '${name}' not found in registry`);

  const type = indexEntry.type as PackageType;
  const client = new RegistryClient();
  const meta = await client.fetchMetadata(type, name) as PackageMetadata;
  const version = requestedVersion ?? meta.version;

  console.log(`Installing ${chalk.bold(name)} v${version} [${type}]...`);

  let sha256: string;
  const destBaseDir = resolve(studioDir, INSTALL_DIRS[type]);
  await mkdir(destBaseDir, { recursive: true });

  if (type === 'template' || type === 'plugin') {
    const destDir = resolve(destBaseDir, name);
    await mkdir(destDir, { recursive: true });
    sha256 = await client.downloadDirectory(type, name, 'project', destDir);
  } else {
    const ext = SINGLE_FILE_EXTENSIONS[type] ?? '.yaml';
    const filename = `${name}${ext}`;
    const result = await client.downloadFile(type, name, filename, destBaseDir);
    sha256 = result.sha256;

    // Security check for shell commands
    const content = await readFile(result.destPath, 'utf8');
    if (SHELL_EXEC_PATTERN.test(content)) {
      const { confirm } = await import('@inquirer/prompts');
      const proceed = await confirm({
        message: chalk.yellow(`⚠ This package executes shell commands. Review ${result.destPath} before use. Install anyway?`),
        default: false,
      });
      if (!proceed) {
        const { unlink } = await import('node:fs/promises');
        await unlink(result.destPath);
        console.log('Installation cancelled.');
        return;
      }
    }
  }

  // Check requires_binaries
  if (meta.requires_binaries?.length) {
    const { spawnSync } = await import('node:child_process');
    for (const bin of meta.requires_binaries) {
      const check = spawnSync('which', [bin], { encoding: 'utf8' });
      if (check.status !== 0) {
        console.log(chalk.yellow(`⚠ Warning: required binary '${bin}' not found in PATH`));
      }
    }
  }

  await lockfile.add(name, {
    version,
    type,
    installed_at: new Date().toISOString().split('T')[0],
    sha256,
  });

  console.log(chalk.green(`✓ Installed ${name} v${version}`));
}

export async function installCommand(nameAtVersion: string, options: { force?: boolean } = {}): Promise<void> {
  try {
    await installPackage(nameAtVersion, options);
  } catch (err) {
    console.error(chalk.red(`Install failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
}

import chalk from 'chalk';
import { resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { RegistryClient } from '../../registry/client.js';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { RegistryCache } from '../../registry/cache.js';
import { syncRegistry } from './sync.js';
import { findStudioDir } from '../../studio-dir.js';
import { resolveDependencies } from '../../registry/resolver.js';
import type { PackageMetadata, PackageType, RegistryIndex, Lockfile } from '../../registry/types.js';
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
  requiredBy?: string;
  /** Skip interactive prompts (auto-accept). Use when called under a spinner. */
  interactive?: boolean;
  _depth?: number;
  _metaCache?: Map<string, PackageMetadata>;
}

async function doInstallPackage(
  nameAtVersion: string,
  options: InstallOptions,
  client: RegistryClient,
  lockfile: RegistryLockfile,
  index: RegistryIndex,
  lockfileData: Lockfile,
  metaCache: Map<string, PackageMetadata>,
): Promise<void> {
  const [name, requestedVersion] = nameAtVersion.split('@');
  const studioDir = options.studioDir!;
  const depth = options._depth ?? 0;
  const indent = '  '.repeat(depth);

  // Check already installed
  const existing = await lockfile.get(name);
  if (existing && !options.force) {
    if (options.requiredBy) {
      await lockfile.addRequiredBy(name, options.requiredBy);
    }
    if (depth === 0) {
      console.log(chalk.yellow(`${name} v${existing.version} is already installed. Use --force to reinstall.`));
    }
    return;
  }

  const indexEntry = index.packages.find(p => p.name === name);
  if (!indexEntry) throw new Error(`Package '${name}' not found in registry`);

  const type = indexEntry.type as PackageType;

  // Use cached metadata if available (populated by resolver's fetcher)
  let meta = metaCache.get(name);
  if (!meta) {
    meta = await client.fetchMetadata(type, name) as PackageMetadata;
    metaCache.set(name, meta);
  }
  const version = requestedVersion ?? meta.version;

  console.log(`${indent}Installing ${depth > 0 ? 'dependency: ' : ''}${chalk.bold(name)} v${version} [${type}]...`);

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

    const content = await readFile(result.destPath, 'utf8');
    if (SHELL_EXEC_PATTERN.test(content) && options.interactive !== false) {
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
    required_by: options.requiredBy ? [options.requiredBy] : [],
  });

  console.log(`${indent}${chalk.green(`✓ Installed ${name} v${version}`)}`);

  // Resolve and install dependencies
  if (meta.dependencies) {
    const graph = await resolveDependencies(
      name,
      meta,
      index,
      lockfileData,
      (depName) => {
        const depEntry = index.packages.find(p => p.name === depName);
        const depType = (depEntry?.type ?? 'tool') as PackageType;
        const cached = metaCache.get(depName);
        if (cached) return Promise.resolve(cached);
        return client.fetchMetadata(depType, depName).then(m => {
          metaCache.set(depName, m as PackageMetadata);
          return m as PackageMetadata;
        });
      },
    );

    for (const dep of graph.required) {
      await doInstallPackage(
        dep.name,
        { studioDir, requiredBy: name, interactive: options.interactive, _depth: depth + 1 },
        client,
        lockfile,
        index,
        lockfileData,
        metaCache,
      );
    }

    if (depth === 0 && graph.recommended.length > 0) {
      let install = options.interactive !== false;
      if (options.interactive !== false) {
        const names = graph.recommended.map(d => d.name).join(', ');
        const { confirm } = await import('@inquirer/prompts');
        install = await confirm({
          message: `Install recommended packages? [${names}]`,
          default: true,
        });
      }
      if (install) {
        for (const dep of graph.recommended) {
          await doInstallPackage(
            dep.name,
            { studioDir, interactive: options.interactive, _depth: depth + 1 },
            client,
            lockfile,
            index,
            lockfileData,
            metaCache,
          );
        }
      }
    }
  }
}

export async function installPackage(nameAtVersion: string, options: InstallOptions = {}): Promise<void> {
  const [name] = nameAtVersion.split('@');

  const studioDir = options.studioDir ??
    (await findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));
  const resolvedOptions = { ...options, studioDir };

  const lockfile = new RegistryLockfile(studioDir);

  // Sync cache and resolve package type
  await syncRegistry({ force: false, silent: true });
  const cache = new RegistryCache();
  const index = await cache.read();
  if (!index?.packages.find(p => p.name === name)) {
    throw new Error(`Package '${name}' not found in registry`);
  }

  const client = new RegistryClient();
  const lockfileData = await lockfile.read();
  const metaCache = options._metaCache ?? new Map<string, PackageMetadata>();

  await doInstallPackage(
    nameAtVersion,
    resolvedOptions,
    client,
    lockfile,
    index,
    lockfileData,
    metaCache,
  );
}

export async function installCommand(nameAtVersion: string, options: { force?: boolean } = {}): Promise<void> {
  try {
    await installPackage(nameAtVersion, options);
  } catch (err) {
    console.error(chalk.red(`Install failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
}

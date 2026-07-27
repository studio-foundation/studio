import chalk from 'chalk';
import { resolve, dirname, basename } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { RegistryClient } from '../../registry/client.js';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { RegistryCache } from '../../registry/cache.js';
import { seedIndex } from '../../registry/seed.js';
import { syncRegistry } from './sync.js';
import { findStudioDir } from '../../studio-dir.js';
import { resolveDependencies } from '../../registry/resolver.js';
import { checkBinaries, formatBinaryPreflightError } from '../../binary-preflight.js';
import { checkStudioVersion } from '../../version-guard.js';
import type { PackageMetadata, PackageSource, RegistryIndex, Lockfile } from '../../registry/types.js';
import { CONTENT_DIRS, TEMPLATE_DIR, contentKindOf } from '../../registry/types.js';

const SHELL_EXEC_PATTERN = /execute:\s*\n\s+type:\s*shell/;

/**
 * Write a plugin's payload into `.studio/`, one destination per content kind —
 * `coder.agent.yaml` lands in `agents/`, `git.tool.yaml` in `tools/`. Filenames
 * are kept as published: the agent and skill loaders resolve by filename.
 * Returns the written paths (relative to `.studio/`) and a hash over them.
 */
async function writePluginPayload(
  files: Array<{ path: string; content: string }>,
  studioDir: string,
  name: string,
): Promise<{ files: string[]; sha256: string }> {
  const hash = createHash('sha256');
  const written: string[] = [];

  for (const file of files) {
    const filename = basename(file.path);
    if (filename === 'metadata.json') continue;
    const kind = contentKindOf(filename);
    if (!kind) {
      console.log(chalk.yellow(`  ⚠ Skipped ${file.path} — no content kind for this filename`));
      continue;
    }
    const relPath = `${CONTENT_DIRS[kind]}/${filename}`;
    const destPath = resolve(studioDir, relPath);
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, file.content);
    written.push(relPath);
    hash.update(relPath + file.content);
  }

  if (written.length === 0) {
    throw new Error(`Plugin '${name}' delivered no installable content.`);
  }
  return { files: written, sha256: hash.digest('hex') };
}

/** True if any tool the plugin ships runs shell commands. */
function shellsOut(files: Array<{ path: string; content: string }>): boolean {
  return files.some(f => f.path.endsWith('.tool.yaml') && SHELL_EXEC_PATTERN.test(f.content));
}

async function installTemplate(
  client: RegistryClient,
  source: PackageSource,
  studioDir: string,
  name: string,
): Promise<{ files: string[]; sha256: string }> {
  const relPath = `${TEMPLATE_DIR}/${name}`;
  const destDir = resolve(studioDir, relPath);
  await mkdir(destDir, { recursive: true });
  const sha256 = await client.downloadDirectory(source, 'project', destDir);
  return { files: [relPath], sha256 };
}

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
  if (!indexEntry.source) {
    throw new Error(
      `Package '${name}' has no source in the registry index. Run 'studio registry sync --force'.`,
    );
  }

  const type = indexEntry.type;

  // Use cached metadata if available (populated by resolver's fetcher)
  let meta = metaCache.get(name);
  if (!meta) {
    meta = await client.fetchMetadata(indexEntry.source, name) as PackageMetadata;
    metaCache.set(name, meta);
  }
  const version = requestedVersion ?? meta.version;

  const versionError = checkStudioVersion(meta.studio_version, `Package '${name}'`);
  if (versionError) throw new Error(versionError);

  console.log(`${indent}Installing ${depth > 0 ? 'dependency: ' : ''}${chalk.bold(name)} v${version} [${type}]...`);

  let installed: { files: string[]; sha256: string };
  if (type === 'template') {
    installed = await installTemplate(client, indexEntry.source, studioDir, name);
  } else {
    // Anything that isn't a template is a plugin — including a pre-migration
    // single-file package, whose directory holds exactly one payload file.
    const payload = await client.fetchDirectoryFiles(indexEntry.source);

    // Ask before writing, not after: nothing to clean up when the answer is no.
    if (shellsOut(payload) && options.interactive !== false) {
      const { confirm } = await import('@inquirer/prompts');
      const proceed = await confirm({
        message: chalk.yellow(`⚠ '${name}' ships a tool that executes shell commands. Install anyway?`),
        default: false,
      });
      if (!proceed) {
        console.log('Installation cancelled.');
        return;
      }
    }

    installed = await writePluginPayload(payload, studioDir, name);
  }

  if (meta.requires_binaries?.length) {
    // Warning, not a block: a package may legitimately be installed before the
    // binaries it drives. `studio run` is where the same check is enforced.
    const failures = checkBinaries(
      meta.requires_binaries.map((entry) => ({ entry, declaredBy: `package '${name}'` }))
    );
    const error = formatBinaryPreflightError(failures);
    if (error) console.log(chalk.yellow(error.replace(/^Error:/, '⚠ Warning:')));
  }

  await lockfile.add(name, {
    version,
    type,
    installed_at: new Date().toISOString().split('T')[0],
    sha256: installed.sha256,
    files: installed.files,
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
        const cached = metaCache.get(depName);
        if (cached) return Promise.resolve(cached);
        const depEntry = index.packages.find(p => p.name === depName);
        if (!depEntry?.source) {
          return Promise.reject(new Error(`Package '${depName}' not found in registry`));
        }
        return client.fetchMetadata(depEntry.source, depName).then(m => {
          metaCache.set(depName, m as PackageMetadata);
          return m as PackageMetadata;
        });
      },
    );

    for (const dep of graph.required) {
      await doInstallPackage(
        `${dep.name}@${dep.version}`,
        { studioDir, requiredBy: name, interactive: options.interactive, _depth: depth + 1 },
        client,
        lockfile,
        index,
        lockfileData,
        metaCache,
      );
    }

    if (depth === 0 && graph.recommended.length > 0 && options.interactive !== false) {
      const { confirm } = await import('@inquirer/prompts');
      for (const dep of graph.recommended) {
        const wanted = await confirm({
          message: `Install recommended package ${dep.name} v${dep.version}?`,
          default: true,
        });
        if (!wanted) continue;
        await doInstallPackage(
          `${dep.name}@${dep.version}`,
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

export async function installPackage(nameAtVersion: string, options: InstallOptions = {}): Promise<void> {
  const [name] = nameAtVersion.split('@');

  const studioDir = options.studioDir ??
    (await findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));
  const resolvedOptions = { ...options, studioDir };

  const lockfile = new RegistryLockfile(studioDir);

  // Sync cache and resolve package type
  await syncRegistry({ force: false, silent: true });
  const cache = new RegistryCache();
  const index = (await cache.read()) ?? seedIndex();
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

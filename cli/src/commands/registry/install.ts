import chalk from 'chalk';
import { resolve, dirname, basename } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { RegistryClient, type PayloadFile } from '../../registry/client.js';
import { RegistryLockfile } from '../../registry/lockfile.js';
import { syncRegistry } from './sync.js';
import { findStudioDir } from '../../studio-dir.js';
import { resolveDependencies } from '../../registry/resolver.js';
import { findMarketplace } from '../../registry/marketplaces.js';
import {
  entryFor,
  loadMergedIndex,
  parsePackageRef,
  type IndexedPackage,
} from '../../registry/registry-index.js';
import { assertPayload } from '../../registry/verify.js';
import { checkBinaries, formatBinaryPreflightError } from '../../binary-preflight.js';
import { checkStudioVersion } from '../../version-guard.js';
import type { PackageMetadata, PackageSource, Lockfile } from '../../registry/types.js';
import { CONTENT_DIRS, TEMPLATE_DIR, contentKindOf } from '../../registry/types.js';

const SHELL_EXEC_PATTERN = /execute:\s*\n\s+type:\s*shell/;

/** Shipped alongside the payload, installed nowhere: not content, not a mistake. */
const NON_PAYLOAD = /^(metadata\.json|LICEN[SC]E(\.[\w-]+)?|README(\.[\w-]+)?|CHANGELOG(\.[\w-]+)?)$/i;

/**
 * Write a plugin's payload into `.studio/`, one destination per content kind —
 * `coder.agent.yaml` lands in `agents/`, `git.tool.yaml` in `tools/`. Filenames
 * are kept as published: the agent and skill loaders resolve by filename.
 * Returns the written paths (relative to `.studio/`) and a hash over them.
 */
async function writePluginPayload(
  files: PayloadFile[],
  studioDir: string,
  name: string,
): Promise<{ files: string[]; sha256: string }> {
  const hash = createHash('sha256');
  const written: string[] = [];

  for (const file of files) {
    const filename = basename(file.path);
    if (NON_PAYLOAD.test(filename)) continue;
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
function shellsOut(files: PayloadFile[]): boolean {
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
  /** Range `requiredBy` declared on this package, recorded for later updates. */
  requiredRange?: string;
  /** Skip interactive prompts (auto-accept). Use when called under a spinner. */
  interactive?: boolean;
  _depth?: number;
  _metaCache?: Map<string, PackageMetadata>;
}

interface InstallContext {
  lockfile: RegistryLockfile;
  packages: IndexedPackage[];
  marketplaces: string[];
  lockfileData: Lockfile;
  metaCache: Map<string, PackageMetadata>;
}

function clientFor(entry: IndexedPackage): Promise<RegistryClient> {
  return findMarketplace(entry.marketplace).then(m => new RegistryClient(m));
}

async function doInstallPackage(
  ref: string,
  options: InstallOptions,
  ctx: InstallContext,
): Promise<void> {
  const { marketplace, name, version: requestedVersion } = parsePackageRef(ref);
  const studioDir = options.studioDir!;
  const depth = options._depth ?? 0;
  const indent = '  '.repeat(depth);

  // Check already installed
  const existing = await ctx.lockfile.get(name);
  if (existing && !options.force) {
    if (options.requiredBy) {
      await ctx.lockfile.addRequiredBy(name, options.requiredBy, options.requiredRange);
    }
    if (depth === 0) {
      console.log(chalk.yellow(`${name} v${existing.version} is already installed. Use --force to reinstall.`));
    }
    return;
  }

  const indexEntry = entryFor(ctx.packages, name, requestedVersion, marketplace);
  if (!indexEntry) throw new Error(`Package '${name}' not found in registry`);
  if (!indexEntry.source) {
    throw new Error(
      `Package '${name}' has no source in the registry index. Run 'studio registry sync --force'.`,
    );
  }

  const type = indexEntry.type;
  const client = await clientFor(indexEntry);
  const metaKey = `${indexEntry.marketplace}:${name}`;

  // Use cached metadata if available (populated by resolver's fetcher)
  let meta = ctx.metaCache.get(metaKey);
  if (!meta) {
    meta = await client.fetchMetadata(indexEntry.source, name);
    ctx.metaCache.set(metaKey, meta);
  }
  const version = requestedVersion ?? meta.version;

  const versionError = checkStudioVersion(meta.studio_version, `Package '${name}'`);
  if (versionError) throw new Error(versionError);

  const origin = indexEntry.source.type === 'git' ? ` from ${indexEntry.source.url}` : '';
  console.log(`${indent}Installing ${depth > 0 ? 'dependency: ' : ''}${chalk.bold(name)} v${version} [${type}]${origin}...`);

  let installed: { files: string[]; sha256: string };
  if (type === 'template') {
    // A payload hosted outside the marketplace repo was never reviewed as a diff;
    // its entry is all users have, so the fetched files must match what it claims.
    if (indexEntry.source.type === 'git') {
      assertPayload(await client.fetchDirectoryFiles(indexEntry.source), indexEntry);
    }
    installed = await installTemplate(client, indexEntry.source, studioDir, name);
  } else {
    // Anything that isn't a template is a plugin — including a pre-migration
    // single-file package, whose directory holds exactly one payload file.
    const payload = await client.fetchDirectoryFiles(indexEntry.source);
    if (indexEntry.source.type === 'git') assertPayload(payload, indexEntry);

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

  await ctx.lockfile.add(name, {
    version,
    type,
    marketplace: indexEntry.marketplace,
    installed_at: new Date().toISOString().split('T')[0],
    sha256: installed.sha256,
    files: installed.files,
    required_by: options.requiredBy ? [options.requiredBy] : [],
    ...(options.requiredBy && options.requiredRange
      ? { constraints: { [options.requiredBy]: options.requiredRange } }
      : {}),
  });

  console.log(`${indent}${chalk.green(`✓ Installed ${name} v${version}`)}`);

  // Resolve and install dependencies
  if (meta.dependencies) {
    const graph = await resolveDependencies(
      name,
      meta,
      ctx.packages,
      ctx.lockfileData,
      async (depName, depMarketplace) => {
        const key = `${depMarketplace}:${depName}`;
        const cached = ctx.metaCache.get(key);
        if (cached) return cached;
        const depEntry = entryFor(ctx.packages, depName, undefined, depMarketplace);
        if (!depEntry?.source) throw new Error(`Package '${depName}' not found in registry`);
        const depMeta = await (await clientFor(depEntry)).fetchMetadata(depEntry.source, depName);
        ctx.metaCache.set(key, depMeta);
        return depMeta;
      },
      { marketplace: indexEntry.marketplace, registered: ctx.marketplaces },
    );

    for (const dep of graph.required) {
      await doInstallPackage(
        `${dep.marketplace}:${dep.name}@${dep.version}`,
        {
          studioDir,
          requiredBy: name,
          requiredRange: dep.constraints.find(c => c.requiredBy === name)?.range,
          interactive: options.interactive,
          _depth: depth + 1,
        },
        ctx,
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
          `${dep.marketplace}:${dep.name}@${dep.version}`,
          { studioDir, interactive: options.interactive, _depth: depth + 1 },
          ctx,
        );
      }
    }
  }
}

export async function installPackage(ref: string, options: InstallOptions = {}): Promise<void> {
  const { marketplace, name } = parsePackageRef(ref);

  const studioDir = options.studioDir ??
    (await findStudioDir(options.cwd ?? process.cwd()) ?? resolve(process.cwd(), '.studio'));
  const resolvedOptions = { ...options, studioDir };

  const lockfile = new RegistryLockfile(studioDir);

  await syncRegistry({ force: false, silent: true });
  const { packages, marketplaces } = await loadMergedIndex();
  if (!entryFor(packages, name, undefined, marketplace)) {
    throw new Error(`Package '${name}' not found in registry`);
  }

  await doInstallPackage(ref, resolvedOptions, {
    lockfile,
    packages,
    marketplaces: marketplaces.map(m => m.name),
    lockfileData: await lockfile.read(),
    metaCache: options._metaCache ?? new Map<string, PackageMetadata>(),
  });
}

export async function installCommand(ref: string, options: { force?: boolean } = {}): Promise<void> {
  try {
    await installPackage(ref, options);
  } catch (err) {
    console.error(chalk.red(`Install failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
}

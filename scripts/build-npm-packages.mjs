#!/usr/bin/env node
// Wraps each compiled binary in a per-platform npm package, and points
// `@studio-foundation/cli` at them via optionalDependencies — npm installs the one
// matching os/cpu/libc, and cli/bin/studio.mjs runs it instead of the JS build.
//
// The optionalDependencies are written here rather than committed: they pin versions
// that only exist on npm once this workflow has published them, so a committed copy
// would break `pnpm install` in the workspace.
//
// Usage: node scripts/build-npm-packages.mjs   (reads dist-binaries/, writes dist-npm/)

import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS, binaryName } from './platforms.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IN_DIR = join(ROOT, 'dist-binaries');
const OUT_DIR = join(ROOT, 'dist-npm');

const cliPkgPath = join(ROOT, 'cli', 'package.json');
const cliPkg = JSON.parse(await readFile(cliPkgPath, 'utf-8'));
const { version, license, author } = cliPkg;
const { repository } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'));

cliPkg.optionalDependencies = Object.fromEntries(
  Object.keys(PLATFORMS).map(platform => [`@studio-foundation/cli-${platform}`, version])
);
await writeFile(cliPkgPath, JSON.stringify(cliPkg, null, 2) + '\n', 'utf-8');

for (const [platform, meta] of Object.entries(PLATFORMS)) {
  const exe = binaryName(platform);
  const pkgDir = join(OUT_DIR, platform);
  await mkdir(pkgDir, { recursive: true });
  const binary = join(pkgDir, exe);
  await copyFile(join(IN_DIR, exe.replace('studio', `studio-${platform}`)), binary);
  // download-artifact drops the exec bit, so the copy arrives 644 and npm packs it
  // that way — every global install would then fail its first spawn with EACCES.
  await chmod(binary, 0o755);

  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: `@studio-foundation/cli-${platform}`,
        version,
        description: `Standalone studio binary for ${platform}`,
        license,
        author,
        repository,
        os: meta.os,
        cpu: meta.cpu,
        ...(meta.libc ? { libc: meta.libc } : {}),
        files: [exe],
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );
  console.log(join(pkgDir, 'package.json'));
}

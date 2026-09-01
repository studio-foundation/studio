#!/usr/bin/env node
// Compiles the CLI into standalone binaries with `bun build --compile`.
//
// Usage: node scripts/build-binary.mjs [platform ...]   (default: every platform)
// Output: dist-binaries/studio-<platform>[.exe]

import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS, assetName } from './platforms.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist-binaries');
const ENTRY = join(ROOT, 'cli', 'dist', 'index.js');

const requested = process.argv.slice(2);
const platforms = requested.length ? requested : Object.keys(PLATFORMS);

for (const platform of platforms) {
  if (!PLATFORMS[platform]) {
    console.error(`Unknown platform '${platform}'. Known: ${Object.keys(PLATFORMS).join(', ')}`);
    process.exit(1);
  }
}

await mkdir(OUT_DIR, { recursive: true });

for (const platform of platforms) {
  const outfile = join(OUT_DIR, assetName(platform));
  const result = spawnSync(
    'bun',
    ['build', '--compile', `--target=${PLATFORMS[platform].target}`, ENTRY, '--outfile', outfile],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (result.status !== 0) {
    console.error(`bun build failed for ${platform}`);
    process.exit(result.status ?? 1);
  }
  console.log(outfile);
}

#!/usr/bin/env node
// Bump the version across every package.json in the monorepo (root + 7 workspace packages).
// Usage: pnpm version:bump 0.4.2

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');

const packages = [
  'package.json',
  'anonymizer/package.json',
  'api/package.json',
  'cli/package.json',
  'contracts/package.json',
  'engine/package.json',
  'ralph/package.json',
  'runner/package.json',
];

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
  console.error('Usage: pnpm version:bump <semver>');
  console.error('Example: pnpm version:bump 0.4.2');
  process.exit(1);
}

for (const rel of packages) {
  const file = resolve(repoRoot, rel);
  const pkg = JSON.parse(readFileSync(file, 'utf-8'));
  const prev = pkg.version;
  pkg.version = newVersion;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${rel.padEnd(36)} ${prev} → ${newVersion}`);
}

console.log(`\nAll ${packages.length} packages bumped to ${newVersion}.`);
console.log('Note: CLI binary reads its version from cli/package.json at runtime.');

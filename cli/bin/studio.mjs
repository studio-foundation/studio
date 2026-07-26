#!/usr/bin/env node
// Hands off to the standalone binary from the matching @studio-foundation/cli-<platform>
// optional dependency. Falls back to the JS build when npm installed none — an
// unsupported platform, or `--no-optional`.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function platformKey() {
  const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : null;
  if (!arch) return null;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'win32') return arch === 'x64' ? 'win-x64' : null;
  if (process.platform === 'linux') {
    // A musl runtime reports no glibc version; the two are not interchangeable.
    const musl = !process.report.getReport().header.glibcVersionRuntime;
    return `linux-${arch}${musl ? '-musl' : ''}`;
  }
  return null;
}

const platform = platformKey();
let binary = null;
if (platform) {
  const exe = platform.startsWith('win-') ? 'studio.exe' : 'studio';
  try {
    binary = require.resolve(`@studio-foundation/cli-${platform}/${exe}`);
  } catch {
    // No platform package installed — fall through to the JS build.
  }
}

if (binary) {
  const { status, error } = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
  if (error) throw error;
  process.exit(status ?? 1);
}

await import('../dist/index.js');

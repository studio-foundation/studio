#!/usr/bin/env node
// Hands off to the standalone binary from the matching @studio-foundation/cli-<platform>
// optional dependency. Falls back to the JS build when npm installed none — an
// unsupported platform, or `--no-optional`.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { platformKey } from './platform-key.mjs';

const require = createRequire(import.meta.url);

const platform = platformKey();
let binary = null;
if (platform) {
  const exe = platform.startsWith('win-') ? 'studio.exe' : 'studio';
  try {
    binary = require.resolve(`@studio-foundation/cli-${platform}/${exe}`);
  } catch {
    // No platform package installed — fall through to the JS build. A musl x64 host
    // without AVX2 lands here: there is no musl baseline package, and the JS build
    // runs on any CPU.
  }
}

if (binary) {
  const { status, error } = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
  if (error?.code === 'EACCES') {
    console.error(
      `studio: ${binary} is not executable.\n` +
        `Run: chmod +x ${binary}\n` +
        'A published binary ships mode 755, so please report this install.'
    );
    process.exit(126);
  }
  if (error) throw error;
  process.exit(status ?? 1);
}

await import('../dist/index.js');

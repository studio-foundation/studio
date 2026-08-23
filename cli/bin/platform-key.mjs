// Which @studio-foundation/cli-<platform> package holds a binary this host can run.
// Extracted from studio.mjs so the choice is testable without spawning anything.

import { readFileSync } from 'node:fs';

/** A musl runtime reports no glibc version; the two are not interchangeable. */
export function isMusl() {
  return !process.report.getReport().header.glibcVersionRuntime;
}

/**
 * Whether this CPU has AVX2, which Bun's default x64 build is compiled against.
 *
 * Unreadable /proc means assuming it does: that is what shipped before this check,
 * and a wrong `false` would hand a slower binary to every host with a hidden /proc.
 */
export function hasAvx2() {
  try {
    return /^flags\s*:.*\bavx2\b/m.test(readFileSync('/proc/cpuinfo', 'utf-8'));
  } catch {
    return true;
  }
}

export function platformKey({
  platform = process.platform,
  arch = process.arch,
  musl,
  avx2,
} = {}) {
  if (arch !== 'x64' && arch !== 'arm64') return null;
  if (platform === 'darwin') return `darwin-${arch}`;
  if (platform === 'win32') return arch === 'x64' ? 'win-x64' : null;
  if (platform !== 'linux') return null;

  // Without AVX2 the default x64 binary dies on SIGILL — no message, no exit code a
  // human can read (STU-974). The baseline build is the same CLI compiled for it.
  const suffix = arch === 'x64' && !(avx2 ?? hasAvx2()) ? '-baseline' : '';
  return `linux-${arch}${(musl ?? isMusl()) ? '-musl' : ''}${suffix}`;
}

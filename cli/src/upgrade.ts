import { existsSync } from 'node:fs';

export const REPO = 'studio-foundation/studio';

/**
 * How the running Studio got onto this machine. Only a standalone binary can be
 * replaced in place — an npm install is owned by npm, and overwriting a file it
 * tracks breaks the next `npm i -g`.
 */
export type Install = { kind: 'binary'; path: string } | { kind: 'npm' };

/**
 * The npm install resolves through `cli/bin/studio.mjs`, which either runs under Node
 * (JS build) or spawns the binary from a `@studio-foundation/cli-<platform>` package
 * inside `node_modules`. Neither is ours to overwrite.
 */
export function detectInstall(execPath: string = process.execPath): Install {
  const segments = execPath.split(/[/\\]/);
  const name = segments[segments.length - 1];
  if (name !== 'studio' && name !== 'studio.exe') return { kind: 'npm' };
  if (segments.includes('node_modules')) return { kind: 'npm' };
  return { kind: 'binary', path: execPath };
}

/**
 * The release asset suffix for this machine, or null when no binary ships for it.
 * Mirrors the platform table in scripts/platforms.mjs.
 */
export function platformKey(
  platform: string = process.platform,
  arch: string = process.arch,
  isMusl: () => boolean = muslDetected
): string | null {
  if (arch !== 'x64' && arch !== 'arm64') return null;
  if (platform === 'darwin') return `darwin-${arch}`;
  if (platform === 'win32') return arch === 'x64' ? 'win-x64' : null;
  if (platform === 'linux') return `linux-${arch}${isMusl() ? '-musl' : ''}`;
  return null;
}

/**
 * Positive musl detection — the loader file only exists on a musl system. Probing for
 * glibc instead is what shipped the wrong binary to Fedora once, and `process.report`
 * is not available inside the Bun-compiled binary this runs in.
 */
function muslDetected(): boolean {
  const suffix = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return existsSync(`/lib/ld-musl-${suffix}.so.1`);
}

export function assetName(platform: string): string {
  return platform.startsWith('win-') ? `studio-${platform}.exe` : `studio-${platform}`;
}

/** The sha256 listed for `asset` in a `sha256sum`-format manifest, or null. */
export function checksumFor(manifest: string, asset: string): string | null {
  for (const line of manifest.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === asset && hash) return hash;
  }
  return null;
}

export async function resolveLatestTag(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`could not resolve the latest release (HTTP ${res.status})`);
  const { tag_name: tag } = (await res.json()) as { tag_name?: string };
  if (!tag) throw new Error('the latest release has no tag');
  return tag;
}

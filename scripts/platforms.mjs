// The platforms Studio ships a standalone binary for.
//
// Key = release asset suffix (`studio-<key>`) and npm package suffix
// (`@studio-foundation/cli-<key>`). `target` is the Bun compile target; `os`/`cpu`/`libc`
// are the npm fields that make the package install only where it runs.

export const PLATFORMS = {
  'darwin-arm64': { target: 'bun-darwin-arm64', os: ['darwin'], cpu: ['arm64'] },
  'darwin-x64': { target: 'bun-darwin-x64', os: ['darwin'], cpu: ['x64'] },
  'linux-arm64': { target: 'bun-linux-arm64', os: ['linux'], cpu: ['arm64'], libc: ['glibc'] },
  'linux-arm64-musl': { target: 'bun-linux-arm64-musl', os: ['linux'], cpu: ['arm64'], libc: ['musl'] },
  'linux-x64': { target: 'bun-linux-x64', os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
  // For x64 CPUs without AVX2, which the default build assumes. npm cannot tell them
  // apart — `cpu: ['x64']` matches both — so both packages install and the launcher
  // picks between them at runtime (STU-974).
  'linux-x64-baseline': {
    target: 'bun-linux-x64-baseline', os: ['linux'], cpu: ['x64'], libc: ['glibc'],
  },
  'linux-x64-musl': { target: 'bun-linux-x64-musl', os: ['linux'], cpu: ['x64'], libc: ['musl'] },
  'win-x64': { target: 'bun-windows-x64', os: ['win32'], cpu: ['x64'] },
};

/** Binary file name for a platform — Windows needs the .exe suffix to be executable. */
export function binaryName(platform) {
  return platform.startsWith('win-') ? 'studio.exe' : 'studio';
}

/** Release asset name for a platform — what `studio init`'s installers download. */
export function assetName(platform) {
  return `studio-${platform}${platform.startsWith('win-') ? '.exe' : ''}`;
}

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
  'linux-x64-musl': { target: 'bun-linux-x64-musl', os: ['linux'], cpu: ['x64'], libc: ['musl'] },
  'win-x64': { target: 'bun-windows-x64', os: ['win32'], cpu: ['x64'] },
};

/** Binary file name for a platform — Windows needs the .exe suffix to be executable. */
export function binaryName(platform) {
  return platform.startsWith('win-') ? 'studio.exe' : 'studio';
}

import { describe, it, expect } from 'vitest';
import { assetName, checksumFor, detectInstall, platformKey, resolveLatestTag } from '../src/upgrade.js';

describe('detectInstall', () => {
  it('recognises a standalone binary', () => {
    expect(detectInstall('/home/ari/.local/bin/studio')).toEqual({
      kind: 'binary',
      path: '/home/ari/.local/bin/studio',
    });
    expect(detectInstall('C:\\Users\\ari\\bin\\studio.exe')).toEqual({
      kind: 'binary',
      path: 'C:\\Users\\ari\\bin\\studio.exe',
    });
  });

  it('refuses the binary npm owns, wherever node_modules sits in the path', () => {
    expect(
      detectInstall('/usr/lib/node_modules/@studio-foundation/cli-linux-x64/studio')
    ).toEqual({ kind: 'npm' });
    expect(
      detectInstall('C:\\npm\\node_modules\\@studio-foundation\\cli-win-x64\\studio.exe')
    ).toEqual({ kind: 'npm' });
  });

  it('refuses the JS build, which runs under node', () => {
    expect(detectInstall('/usr/bin/node')).toEqual({ kind: 'npm' });
  });

  it('is not fooled by a directory merely named node_modules-something', () => {
    expect(detectInstall('/opt/node_modules-backup/studio')).toEqual({
      kind: 'binary',
      path: '/opt/node_modules-backup/studio',
    });
  });
});

describe('platformKey', () => {
  const glibc = () => false;
  const musl = () => true;

  it('maps every platform a binary ships for', () => {
    expect(platformKey('darwin', 'arm64', glibc)).toBe('darwin-arm64');
    expect(platformKey('darwin', 'x64', glibc)).toBe('darwin-x64');
    expect(platformKey('linux', 'x64', glibc)).toBe('linux-x64');
    expect(platformKey('linux', 'arm64', glibc)).toBe('linux-arm64');
    expect(platformKey('linux', 'x64', musl)).toBe('linux-x64-musl');
    expect(platformKey('linux', 'arm64', musl)).toBe('linux-arm64-musl');
    expect(platformKey('win32', 'x64', glibc)).toBe('win-x64');
  });

  it('returns null where no binary ships', () => {
    expect(platformKey('win32', 'arm64', glibc)).toBeNull();
    expect(platformKey('linux', 'ia32', glibc)).toBeNull();
    expect(platformKey('freebsd', 'x64', glibc)).toBeNull();
  });

  it('ignores libc off Linux', () => {
    expect(platformKey('darwin', 'arm64', musl)).toBe('darwin-arm64');
  });
});

describe('assetName', () => {
  it('suffixes only the Windows asset', () => {
    expect(assetName('linux-x64')).toBe('studio-linux-x64');
    expect(assetName('win-x64')).toBe('studio-win-x64.exe');
  });
});

describe('checksumFor', () => {
  const manifest = [
    'aaa11  studio-linux-arm64',
    'bbb22  studio-linux-x64',
    'ccc33  studio-linux-x64-musl',
    '',
  ].join('\n');

  it('reads the hash of an exact asset name', () => {
    expect(checksumFor(manifest, 'studio-linux-x64')).toBe('bbb22');
    expect(checksumFor(manifest, 'studio-linux-x64-musl')).toBe('ccc33');
  });

  it('returns null for an asset the manifest does not list', () => {
    expect(checksumFor(manifest, 'studio-darwin-arm64')).toBeNull();
  });
});

describe('resolveLatestTag', () => {
  const respond = (body: unknown, ok = true, status = 200) =>
    (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;

  it('returns the tag of the latest release', async () => {
    await expect(resolveLatestTag(respond({ tag_name: 'v0.11.1' }))).resolves.toBe('v0.11.1');
  });

  it('throws on a failed request', async () => {
    await expect(resolveLatestTag(respond({}, false, 403))).rejects.toThrow('HTTP 403');
  });

  it('throws when the release carries no tag', async () => {
    await expect(resolveLatestTag(respond({}))).rejects.toThrow('no tag');
  });
});

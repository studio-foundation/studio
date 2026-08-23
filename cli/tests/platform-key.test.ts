import { describe, it, expect } from 'vitest';

import { platformKey } from '../bin/platform-key.mjs';
import { PLATFORMS } from '../../scripts/platforms.mjs';

describe('platformKey', () => {
  it('picks the baseline build on an x64 CPU without AVX2', () => {
    expect(platformKey({ platform: 'linux', arch: 'x64', musl: false, avx2: false })).toBe(
      'linux-x64-baseline'
    );
  });

  it('keeps the default build on an x64 CPU with AVX2', () => {
    expect(platformKey({ platform: 'linux', arch: 'x64', musl: false, avx2: true })).toBe(
      'linux-x64'
    );
  });

  it('does not baseline arm64, which has no such split', () => {
    expect(platformKey({ platform: 'linux', arch: 'arm64', musl: false, avx2: false })).toBe(
      'linux-arm64'
    );
  });

  it('keeps musl and the baseline suffix distinct', () => {
    expect(platformKey({ platform: 'linux', arch: 'x64', musl: true, avx2: true })).toBe(
      'linux-x64-musl'
    );
  });

  it('leaves the non-linux keys alone', () => {
    expect(platformKey({ platform: 'darwin', arch: 'arm64' })).toBe('darwin-arm64');
    expect(platformKey({ platform: 'win32', arch: 'x64' })).toBe('win-x64');
    expect(platformKey({ platform: 'freebsd', arch: 'x64' })).toBeNull();
    expect(platformKey({ platform: 'linux', arch: 'ppc64' })).toBeNull();
  });

  it('only names platforms that are actually built', () => {
    const built = new Set(Object.keys(PLATFORMS));
    const keys = [
      platformKey({ platform: 'linux', arch: 'x64', musl: false, avx2: false }),
      platformKey({ platform: 'linux', arch: 'x64', musl: false, avx2: true }),
      platformKey({ platform: 'linux', arch: 'arm64', musl: false, avx2: true }),
      platformKey({ platform: 'darwin', arch: 'arm64' }),
      platformKey({ platform: 'win32', arch: 'x64' }),
    ];

    expect(keys.filter(key => !built.has(key!))).toEqual([]);
  });
});

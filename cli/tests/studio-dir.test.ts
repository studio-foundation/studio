import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { findStudioDir } from '../src/studio-dir.js';

const TMP = resolve(import.meta.dirname, '.tmp-studio-dir-test');

beforeEach(async () => { await mkdir(TMP, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('findStudioDir', () => {
  it('finds .studio/ in the given directory', async () => {
    await mkdir(resolve(TMP, '.studio'), { recursive: true });
    const result = await findStudioDir(TMP);
    expect(result).toBe(resolve(TMP, '.studio'));
  });

  it('finds .studio/ in a parent directory', async () => {
    await mkdir(resolve(TMP, '.studio'), { recursive: true });
    const nested = resolve(TMP, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });
    const result = await findStudioDir(nested);
    expect(result).toBe(resolve(TMP, '.studio'));
  });

  it('returns null when .studio/ is not found', async () => {
    // Use a path with no .studio/ anywhere above it (use /tmp directly)
    const result = await findStudioDir('/tmp');
    expect(result).toBeNull();
  });
});

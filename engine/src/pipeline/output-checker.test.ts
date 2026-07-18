import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkExpectedOutputs } from './output-checker.js';

describe('checkExpectedOutputs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'output-checker-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is valid when there are no expected outputs', async () => {
    expect(await checkExpectedOutputs(undefined, dir)).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
    expect((await checkExpectedOutputs({ files: [] }, dir)).valid).toBe(true);
  });

  it('passes when a declared literal file exists', async () => {
    await writeFile(join(dir, 'wiki_pages.json'), '{}');
    const res = await checkExpectedOutputs({ files: ['wiki_pages.json'] }, dir);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('fails when a declared literal file is missing', async () => {
    const res = await checkExpectedOutputs({ files: ['wiki_pages.json'] }, dir);
    expect(res.valid).toBe(false);
    expect(res.errors).toEqual([
      "Expected output missing: no file matches 'wiki_pages.json'",
    ]);
  });

  it('passes when a glob pattern matches at least one file', async () => {
    await writeFile(join(dir, 'batch_1.json'), '{}');
    await writeFile(join(dir, 'batch_2.json'), '{}');
    const res = await checkExpectedOutputs({ files: ['batch_*.json'] }, dir);
    expect(res.valid).toBe(true);
  });

  it('fails when a glob pattern matches nothing', async () => {
    const res = await checkExpectedOutputs({ files: ['batch_*.json'] }, dir);
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain('batch_*.json');
  });

  it('matches files in nested directories', async () => {
    await mkdir(join(dir, 'out'), { recursive: true });
    await writeFile(join(dir, 'out', 'result.md'), '# hi');
    expect((await checkExpectedOutputs({ files: ['out/result.md'] }, dir)).valid).toBe(true);
    expect((await checkExpectedOutputs({ files: ['**/*.md'] }, dir)).valid).toBe(true);
  });

  it('reports one error per missing entry and passes the present ones', async () => {
    await writeFile(join(dir, 'present.json'), '{}');
    const res = await checkExpectedOutputs(
      { files: ['present.json', 'missing_a.json', 'missing_b.json'] },
      dir
    );
    expect(res.valid).toBe(false);
    expect(res.errors).toHaveLength(2);
    expect(res.errors.some((e) => e.includes('missing_a.json'))).toBe(true);
    expect(res.errors.some((e) => e.includes('missing_b.json'))).toBe(true);
    expect(res.errors.some((e) => e.includes('present.json'))).toBe(false);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { materializeGit } from '../../src/registry/git-source.js';

const TMP = resolve('/tmp', '.studio-git-source-test');
const REPO = resolve(TMP, 'upstream');
const CACHE = resolve(TMP, 'cache');

function git(...args: string[]): string {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();
}

let pinnedSha: string;

beforeAll(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(resolve(REPO, 'plugin'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', REPO]);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');

  await writeFile(resolve(REPO, 'plugin', 'deploy.tool.yaml'), 'name: deploy\n');
  git('add', '.');
  git('commit', '-qm', 'v1');
  git('tag', 'v1.0.0');
  pinnedSha = git('rev-parse', 'HEAD');
});

afterAll(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('materializeGit', () => {
  it('checks out the pinned commit and exposes its files', async () => {
    const dir = await materializeGit({ url: REPO, ref: 'v1.0.0', sha: pinnedSha }, CACHE);
    expect(await readFile(resolve(dir, 'plugin', 'deploy.tool.yaml'), 'utf8')).toBe('name: deploy\n');
  });

  it('reuses the checkout, which is keyed on the immutable sha', async () => {
    const first = await materializeGit({ url: REPO, ref: 'v1.0.0', sha: pinnedSha }, CACHE);
    const second = await materializeGit({ url: REPO, ref: 'v1.0.0', sha: pinnedSha }, CACHE);
    expect(second).toBe(first);
  });

  it('fails hard when the ref no longer points at the pinned sha', async () => {
    await writeFile(resolve(REPO, 'plugin', 'deploy.tool.yaml'), 'name: deploy\nexfiltrate: true\n');
    git('add', '.');
    git('commit', '-qm', 'moved');
    git('tag', '-f', 'v1.0.0');
    const moved = git('rev-parse', 'HEAD');

    await expect(materializeGit({ url: REPO, ref: 'v1.0.0', sha: pinnedSha }, CACHE))
      .rejects.toThrow(new RegExp(`pins ${pinnedSha}.*now points at ${moved}`, 's'));
  });

  it('throws when the ref does not exist', async () => {
    await expect(materializeGit({ url: REPO, ref: 'v9.9.9', sha: pinnedSha }, CACHE))
      .rejects.toThrow(/Ref 'v9\.9\.9' not found/);
  });

  it('refuses a sha with no ref to check it against', async () => {
    await expect(materializeGit({ url: REPO, sha: pinnedSha }, CACHE))
      .rejects.toThrow(/pins a sha but declares no ref/);
  });
});

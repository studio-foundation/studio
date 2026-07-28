import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const run = promisify(execFile);

/** How long an unpinned clone (a marketplace repo) is reused before refetching. */
const HEAD_TTL_MS = 24 * 60 * 60 * 1000;

export interface GitCheckout {
  url: string;
  /** Branch or tag. Required alongside `sha`, so the pin can be checked against it. */
  ref?: string;
  /** Commit the entry pins. Absent for a marketplace repo, which tracks its branch. */
  sha?: string;
}

function cacheRoot(): string {
  return resolve(homedir(), '.cache', 'studio', 'git');
}

/** The commit `ref` points at upstream right now, peeling annotated tags. */
async function remoteSha(url: string, ref: string): Promise<string | null> {
  const { stdout } = await run('git', ['ls-remote', url, ref, `${ref}^{}`]);
  const lines = stdout.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  const peeled = lines.find((l) => l.endsWith('^{}'));
  return (peeled ?? lines[0]).split('\t')[0];
}

async function fetchPinned(url: string, ref: string, sha: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await run('git', ['init', '-q', dir]);
  await run('git', ['-C', dir, 'remote', 'add', 'origin', url]);
  try {
    await run('git', ['-C', dir, 'fetch', '-q', '--depth', '1', 'origin', sha]);
  } catch {
    // Servers that refuse a by-sha fetch still serve the ref; the checkout below
    // is what proves the sha is actually in what we got.
    await run('git', ['-C', dir, 'fetch', '-q', '--depth', '1', 'origin', ref]);
  }
  await run('git', ['-C', dir, 'checkout', '-q', sha]);
}

/**
 * Fetch a git-sourced package or marketplace and return the local directory.
 *
 * A pinned checkout is verified against its ref before anything is read: if the
 * upstream tag or branch no longer points at the recorded commit, the entry has
 * been changed under us and the install fails rather than resolving to either one.
 */
export async function materializeGit(target: GitCheckout, root = cacheRoot()): Promise<string> {
  if (target.sha) {
    if (!target.ref) throw new Error(`Git source for ${target.url} pins a sha but declares no ref.`);
    const upstream = await remoteSha(target.url, target.ref);
    if (!upstream) {
      throw new Error(`Ref '${target.ref}' not found in ${target.url}.`);
    }
    if (upstream !== target.sha) {
      throw new Error(
        `Pinned sha mismatch for ${target.url}: the entry pins ${target.sha}, ` +
        `but '${target.ref}' now points at ${upstream}. Refusing to install.`,
      );
    }

    const dir = resolve(root, target.sha);
    if (existsSync(dir)) return dir;

    const staging = `${dir}.partial`;
    await rm(staging, { recursive: true, force: true });
    try {
      await fetchPinned(target.url, target.ref, target.sha, staging);
      await rename(staging, dir);
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
    return dir;
  }

  const key = createHash('sha256').update(`${target.url}#${target.ref ?? ''}`).digest('hex').slice(0, 16);
  const dir = resolve(root, `head-${key}`);
  if (existsSync(dir)) {
    const age = Date.now() - (await stat(dir)).mtimeMs;
    if (age < HEAD_TTL_MS) return dir;
    await rm(dir, { recursive: true, force: true });
  }

  const staging = `${dir}.partial`;
  await rm(staging, { recursive: true, force: true });
  try {
    const branch = target.ref ? ['--branch', target.ref] : [];
    await run('git', ['clone', '-q', '--depth', '1', ...branch, target.url, staging]);
    await rename(staging, dir);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
  return dir;
}

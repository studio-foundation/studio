import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { RegistryIndex, PackageMetadata, PackageSource } from './types.js';
import {
  DEFAULT_MARKETPLACE_ENTRY,
  apiBaseOf,
  githubRepoOf,
  rawBaseOf,
  type Marketplace,
} from './marketplaces.js';
import { DEFAULT_MARKETPLACE } from './dependency-spec.js';
import { seedFile, seedFiles } from './seed.js';
import { materializeGit } from './git-source.js';

interface GitHubContentItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url: string | null;
}

export interface PayloadFile {
  path: string;
  content: string;
}

/** Fall back to the bundled snapshot when the live registry is unreachable. */
async function orSeeded<T>(fetchRemote: () => Promise<T>, seeded: () => T | null): Promise<T> {
  try {
    return await fetchRemote();
  } catch (err) {
    const fallback = seeded();
    if (fallback === null) throw err;
    return fallback;
  }
}

/** A 4xx from the registry, or a file absent from a checkout. */
function isMissing(err: unknown): boolean {
  if (err instanceof Error && /HTTP 4\d\d/.test(err.message)) return true;
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * A package directory, wherever it lives. Paths handed in and out are relative
 * to that directory, so the callers never learn which transport served them.
 */
interface SourceReader {
  read(relPath: string): Promise<string>;
  list(relPath?: string): Promise<PayloadFile[]>;
}

/**
 * The GitHub transport. `seeded` is on only for the default marketplace: the
 * bundled snapshot mirrors that one marketplace's layout, so serving it for
 * another would answer with someone else's file at the same path.
 */
function githubReader(repo: string, base: string, seeded: boolean): SourceReader {
  const at = (relPath: string) => (relPath ? `${base}/${relPath}` : base);
  const fromSeed = <T>(read: () => T | null) => (seeded ? read() : null);

  const remoteTree = async (dir: string, relPrefix: string): Promise<PayloadFile[]> => {
    const res = await fetch(`${apiBaseOf(repo)}/contents/${relPrefix ? `${dir}/${relPrefix}` : dir}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`Failed to list ${dir}: HTTP ${res.status}`);
    const items = (await res.json()) as GitHubContentItem[];

    const files: PayloadFile[] = [];
    for (const item of items) {
      const childPath = relPrefix ? `${relPrefix}/${item.name}` : item.name;
      if (item.type === 'dir') {
        files.push(...(await remoteTree(dir, childPath)));
      } else if (item.download_url) {
        const fileRes = await fetch(item.download_url);
        if (!fileRes.ok) throw new Error(`Failed to download ${item.path}`);
        files.push({ path: childPath, content: await fileRes.text() });
      }
    }
    return files;
  };

  return {
    read(relPath) {
      return orSeeded(
        async () => {
          const res = await fetch(`${rawBaseOf(repo)}/${at(relPath)}`);
          if (!res.ok) throw new Error(`Failed to fetch ${at(relPath)}: HTTP ${res.status}`);
          return res.text();
        },
        () => fromSeed(() => seedFile(at(relPath))),
      );
    },
    list(relPath = '') {
      return orSeeded(
        async () => (await remoteTree(at(relPath), '')).sort((a, b) => a.path.localeCompare(b.path)),
        () => fromSeed(() => {
          const files = seedFiles(at(relPath));
          return files.length > 0 ? files : null;
        }),
      );
    },
  };
}

function fsReader(dir: string): SourceReader {
  const list = async (relPath = ''): Promise<PayloadFile[]> => {
    const entries = await readdir(resolve(dir, relPath), { withFileTypes: true });
    const files: PayloadFile[] = [];
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const childPath = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push(...(await list(childPath)));
      } else {
        files.push({ path: childPath, content: await readFile(resolve(dir, childPath), 'utf8') });
      }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  };

  return {
    read: (relPath) => readFile(resolve(dir, relPath), 'utf8'),
    list,
  };
}

export class RegistryClient {
  constructor(private readonly marketplace: Marketplace = DEFAULT_MARKETPLACE_ENTRY) {}

  /** Network only — the seed is a fallback for the callers, never a cacheable index. */
  async fetchIndex(): Promise<RegistryIndex> {
    const repo = githubRepoOf(this.marketplace.url);
    if (repo) {
      const res = await fetch(`${rawBaseOf(repo)}/index.json`);
      if (!res.ok) throw new Error(`Failed to fetch registry index: HTTP ${res.status}`);
      return res.json() as Promise<RegistryIndex>;
    }
    const dir = await materializeGit({ url: this.marketplace.url });
    return JSON.parse(await readFile(resolve(dir, 'index.json'), 'utf8')) as RegistryIndex;
  }

  private async reader(source: PackageSource): Promise<SourceReader> {
    if (source.type === 'git') {
      return fsReader(resolve(await materializeGit(source), source.path ?? ''));
    }
    const repo = githubRepoOf(this.marketplace.url);
    if (repo) {
      return githubReader(repo, source.path, this.marketplace.name === DEFAULT_MARKETPLACE);
    }
    return fsReader(resolve(await materializeGit({ url: this.marketplace.url }), source.path));
  }

  async fetchMetadata(source: PackageSource, name: string): Promise<PackageMetadata> {
    let raw: string;
    try {
      raw = await (await this.reader(source)).read('metadata.json');
    } catch (err) {
      // A missing file means the package isn't there; anything else — DNS, a
      // failed clone — is the real reason and must not be masked as "not found".
      if (!isMissing(err)) throw err;
      throw new Error(`Package '${name}' not found in registry`, { cause: err });
    }
    return JSON.parse(raw) as PackageMetadata;
  }

  /**
   * Read every file of a package directory, recursively, without writing anything.
   * Paths are relative to the package directory, sorted. The caller decides where
   * each file lands — a plugin's payload is scattered across `.studio/` by content
   * kind, a template's is written as a tree.
   */
  async fetchDirectoryFiles(source: PackageSource, remotePath = ''): Promise<PayloadFile[]> {
    return (await this.reader(source)).list(remotePath);
  }

  /**
   * Write a package subtree to disk. The hash covers marketplace paths and
   * contents, so a package installed from the seed hashes like one fetched from
   * the network.
   */
  async downloadDirectory(
    source: PackageSource,
    remotePath: string,
    localDestDir: string,
  ): Promise<string> {
    const files = await this.fetchDirectoryFiles(source, remotePath);
    const prefix = [source.path, remotePath].filter(Boolean).join('/');
    const hash = createHash('sha256');

    for (const file of files) {
      const localPath = resolve(localDestDir, file.path);
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, file.content);
      hash.update(`${prefix}/${file.path}` + file.content);
    }
    return hash.digest('hex');
  }
}

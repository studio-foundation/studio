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

/**
 * A package directory, wherever it lives. Paths handed in and out are relative
 * to that directory, so the callers never learn which transport served them.
 */
interface SourceReader {
  read(relPath: string): Promise<string>;
  list(relPath?: string): Promise<PayloadFile[]>;
}

function githubReader(repo: string, base: string): SourceReader {
  const at = (relPath: string) => (relPath ? `${base}/${relPath}` : base);

  const list = async (relPath = ''): Promise<PayloadFile[]> => {
    const dir = at(relPath);
    const res = await fetch(`${apiBaseOf(repo)}/contents/${dir}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`Failed to list ${dir}: HTTP ${res.status}`);
    const items = (await res.json()) as GitHubContentItem[];

    const files: PayloadFile[] = [];
    for (const item of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
      const childPath = relPath ? `${relPath}/${item.name}` : item.name;
      if (item.type === 'dir') {
        files.push(...(await list(childPath)));
      } else if (item.download_url) {
        const fileRes = await fetch(item.download_url);
        if (!fileRes.ok) throw new Error(`Failed to download ${item.path}`);
        files.push({ path: childPath, content: await fileRes.text() });
      }
    }
    return files;
  };

  return {
    async read(relPath) {
      const res = await fetch(`${rawBaseOf(repo)}/${at(relPath)}`);
      if (!res.ok) throw new Error(`Failed to fetch ${at(relPath)}: HTTP ${res.status}`);
      return res.text();
    },
    list,
  };
}

function fsReader(dir: string): SourceReader {
  const list = async (relPath = ''): Promise<PayloadFile[]> => {
    const entries = await readdir(resolve(dir, relPath), { withFileTypes: true });
    const files: PayloadFile[] = [];
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const childPath = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push(...(await list(childPath)));
      } else {
        files.push({ path: childPath, content: await readFile(resolve(dir, childPath), 'utf8') });
      }
    }
    return files;
  };

  return {
    read: (relPath) => readFile(resolve(dir, relPath), 'utf8'),
    list,
  };
}

export class RegistryClient {
  constructor(private readonly marketplace: Marketplace = DEFAULT_MARKETPLACE_ENTRY) {}

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
    if (repo) return githubReader(repo, source.path);
    return fsReader(resolve(await materializeGit({ url: this.marketplace.url }), source.path));
  }

  async fetchMetadata(source: PackageSource, name: string): Promise<PackageMetadata> {
    let raw: string;
    try {
      raw = await (await this.reader(source)).read('metadata.json');
    } catch {
      throw new Error(`Package '${name}' not found in registry`);
    }
    return JSON.parse(raw) as PackageMetadata;
  }

  /**
   * Read every file of a package directory, recursively, without writing anything.
   * Paths are relative to the package directory. The caller decides where each
   * file lands — a plugin's payload is scattered across `.studio/` by content kind.
   */
  async fetchDirectoryFiles(source: PackageSource, remotePath = ''): Promise<PayloadFile[]> {
    return (await this.reader(source)).list(remotePath);
  }

  /**
   * Download a directory package (template, plugin).
   * Returns SHA256 of all file paths and contents concatenated (sorted by path).
   */
  async downloadDirectory(
    source: PackageSource,
    remotePath: string,
    localDestDir: string,
  ): Promise<string> {
    const files = await this.fetchDirectoryFiles(source, remotePath);
    const hash = createHash('sha256');
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const localPath = resolve(localDestDir, file.path);
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, file.content);
      hash.update(file.path + file.content);
    }
    return hash.digest('hex');
  }
}

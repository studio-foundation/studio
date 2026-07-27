import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { RegistryIndex, PackageMetadata, PackageSource } from './types.js';
import { REGISTRY_RAW_BASE, REGISTRY_API_BASE } from './types.js';
import { seedFile, seedFiles } from './seed.js';

interface GitHubContentItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url: string | null;
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

export class RegistryClient {
  /** Network only — the seed is a fallback for the callers, never a cacheable index. */
  async fetchIndex(): Promise<RegistryIndex> {
    const res = await fetch(`${REGISTRY_RAW_BASE}/index.json`);
    if (!res.ok) throw new Error(`Failed to fetch registry index: HTTP ${res.status}`);
    return res.json() as Promise<RegistryIndex>;
  }

  async fetchMetadata(source: PackageSource, name: string): Promise<PackageMetadata> {
    const path = `${source.path}/metadata.json`;
    return orSeeded(
      async () => {
        const res = await fetch(`${REGISTRY_RAW_BASE}/${path}`);
        if (!res.ok) throw new Error(`Package '${name}' not found in registry`);
        return res.json() as Promise<PackageMetadata>;
      },
      () => {
        const raw = seedFile(path);
        return raw ? (JSON.parse(raw) as PackageMetadata) : null;
      },
    );
  }

  /**
   * Read every file of a package directory, recursively, without writing anything.
   * Paths are relative to the package directory, sorted. The caller decides where
   * each file lands — a plugin's payload is scattered across `.studio/` by content
   * kind, a template's is written as a tree.
   */
  async fetchDirectoryFiles(
    source: PackageSource,
    remotePath = '',
  ): Promise<Array<{ path: string; content: string }>> {
    const dir = remotePath ? `${source.path}/${remotePath}` : source.path;
    return orSeeded(
      async () => (await this.fetchRemoteTree(dir, '')).sort((a, b) => a.path.localeCompare(b.path)),
      () => {
        const files = seedFiles(dir);
        return files.length > 0 ? files : null;
      },
    );
  }

  private async fetchRemoteTree(
    dir: string,
    relPrefix: string,
  ): Promise<Array<{ path: string; content: string }>> {
    const res = await fetch(
      `${REGISTRY_API_BASE}/contents/${relPrefix ? `${dir}/${relPrefix}` : dir}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) throw new Error(`Failed to list ${dir}: HTTP ${res.status}`);
    const items = (await res.json()) as GitHubContentItem[];

    const files: Array<{ path: string; content: string }> = [];
    for (const item of items) {
      const relPath = relPrefix ? `${relPrefix}/${item.name}` : item.name;
      if (item.type === 'dir') {
        files.push(...(await this.fetchRemoteTree(dir, relPath)));
      } else if (item.download_url) {
        const fileRes = await fetch(item.download_url);
        if (!fileRes.ok) throw new Error(`Failed to download ${item.path}`);
        files.push({ path: relPath, content: await fileRes.text() });
      }
    }
    return files;
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
    const hash = createHash('sha256');

    for (const file of files) {
      const localPath = resolve(localDestDir, file.path);
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, file.content);
      hash.update(`${source.path}/${remotePath}/${file.path}` + file.content);
    }

    return hash.digest('hex');
  }
}

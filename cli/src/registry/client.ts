import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { RegistryIndex, PackageMetadata, PackageSource } from './types.js';
import { REGISTRY_RAW_BASE, REGISTRY_API_BASE } from './types.js';

interface GitHubContentItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url: string | null;
}

export class RegistryClient {
  async fetchIndex(): Promise<RegistryIndex> {
    const res = await fetch(`${REGISTRY_RAW_BASE}/index.json`);
    if (!res.ok) throw new Error(`Failed to fetch registry index: HTTP ${res.status}`);
    return res.json() as Promise<RegistryIndex>;
  }

  async fetchMetadata(source: PackageSource, name: string): Promise<PackageMetadata> {
    const res = await fetch(`${REGISTRY_RAW_BASE}/${source.path}/metadata.json`);
    if (!res.ok) throw new Error(`Package '${name}' not found in registry`);
    return res.json() as Promise<PackageMetadata>;
  }

  /**
   * Read every file of a package directory, recursively, without writing anything.
   * Paths are relative to the package directory. The caller decides where each
   * file lands — a plugin's payload is scattered across `.studio/` by content kind.
   */
  async fetchDirectoryFiles(
    source: PackageSource,
    remotePath = '',
  ): Promise<Array<{ path: string; content: string }>> {
    const dir = remotePath ? `${source.path}/${remotePath}` : source.path;
    const res = await fetch(
      `${REGISTRY_API_BASE}/contents/${dir}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) throw new Error(`Failed to list ${dir}: HTTP ${res.status}`);
    const items = (await res.json()) as GitHubContentItem[];

    const files: Array<{ path: string; content: string }> = [];
    for (const item of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = remotePath ? `${remotePath}/${item.name}` : item.name;
      if (item.type === 'dir') {
        files.push(...(await this.fetchDirectoryFiles(source, relPath)));
      } else if (item.download_url) {
        const fileRes = await fetch(item.download_url);
        if (!fileRes.ok) throw new Error(`Failed to download ${item.path}`);
        files.push({ path: relPath, content: await fileRes.text() });
      }
    }
    return files;
  }

  /**
   * Download a directory package (template, plugin) via GitHub API.
   * Returns SHA256 of all file contents concatenated (sorted by path).
   */
  async downloadDirectory(
    source: PackageSource,
    remotePath: string,
    localDestDir: string,
  ): Promise<string> {
    const res = await fetch(
      `${REGISTRY_API_BASE}/contents/${source.path}/${remotePath}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) throw new Error(`Failed to list directory: HTTP ${res.status}`);
    const items = (await res.json()) as GitHubContentItem[];

    const hash = createHash('sha256');
    const sortedItems = [...items].sort((a, b) => a.path.localeCompare(b.path));

    for (const item of sortedItems) {
      const localPath = resolve(localDestDir, item.name);
      if (item.type === 'dir') {
        await this.downloadDirectory(source, `${remotePath}/${item.name}`, localPath);
      } else if (item.download_url) {
        const fileRes = await fetch(item.download_url);
        if (!fileRes.ok) throw new Error(`Failed to download ${item.path}`);
        const content = await fileRes.text();
        await mkdir(dirname(localPath), { recursive: true });
        await writeFile(localPath, content);
        hash.update(item.path + content);
      }
    }

    return hash.digest('hex');
  }
}

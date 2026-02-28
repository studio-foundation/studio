import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { RegistryIndex, PackageMetadata, PackageType } from './types.js';
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

  async fetchMetadata(type: PackageType, name: string): Promise<PackageMetadata> {
    const res = await fetch(`${REGISTRY_RAW_BASE}/${type}s/${name}/metadata.json`);
    if (!res.ok) throw new Error(`Package '${name}' not found in registry`);
    return res.json() as Promise<PackageMetadata>;
  }

  /**
   * Download a single-file package (tool, pipeline, integration, agent, skill).
   * Returns { destPath, sha256 }.
   */
  async downloadFile(
    type: PackageType,
    name: string,
    filename: string,
    destDir: string,
  ): Promise<{ destPath: string; sha256: string }> {
    const url = `${REGISTRY_RAW_BASE}/${type}s/${name}/${filename}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${filename}: HTTP ${res.status}`);
    const content = await res.text();
    const destPath = resolve(destDir, filename);
    await mkdir(destDir, { recursive: true });
    await writeFile(destPath, content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    return { destPath, sha256 };
  }

  /**
   * Download a directory package (template, plugin) via GitHub API.
   * Returns SHA256 of all file contents concatenated (sorted by path).
   */
  async downloadDirectory(
    type: PackageType,
    name: string,
    remotePath: string,
    localDestDir: string,
  ): Promise<string> {
    const res = await fetch(
      `${REGISTRY_API_BASE}/contents/${type}s/${name}/${remotePath}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) throw new Error(`Failed to list directory: HTTP ${res.status}`);
    const items = (await res.json()) as GitHubContentItem[];

    const hash = createHash('sha256');
    const sortedItems = [...items].sort((a, b) => a.path.localeCompare(b.path));

    for (const item of sortedItems) {
      const localPath = resolve(localDestDir, item.name);
      if (item.type === 'dir') {
        await this.downloadDirectory(type, name, `${remotePath}/${item.name}`, localPath);
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

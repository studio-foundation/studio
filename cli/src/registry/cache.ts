import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { RegistryIndex } from './types.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CachedIndex extends RegistryIndex {
  _cached_at: string;
}

export class RegistryCache {
  private cacheDir: string;
  private cachePath: string;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir ?? resolve(homedir(), '.studio', 'registry');
    this.cachePath = resolve(this.cacheDir, 'index.json');
  }

  async read(): Promise<RegistryIndex | null> {
    let raw: string;
    try {
      raw = await readFile(this.cachePath, 'utf8');
    } catch {
      return null;
    }

    const data = JSON.parse(raw) as CachedIndex;
    const age = Date.now() - new Date(data._cached_at).getTime();
    if (age > CACHE_TTL_MS) return null;

    const { _cached_at: _, ...index } = data;
    return index as RegistryIndex;
  }

  async write(index: RegistryIndex): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const data: CachedIndex = { ...index, _cached_at: new Date().toISOString() };
    await writeFile(this.cachePath, JSON.stringify(data, null, 2) + '\n');
  }

  async isFresh(): Promise<boolean> {
    return (await this.read()) !== null;
  }
}

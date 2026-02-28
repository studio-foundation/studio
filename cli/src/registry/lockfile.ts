import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Lockfile, LockfileEntry } from './types.js';

export class RegistryLockfile {
  private lockPath: string;
  private studioDir: string;

  constructor(studioDir: string) {
    this.studioDir = studioDir;
    this.lockPath = resolve(studioDir, 'registry.lock.json');
  }

  async read(): Promise<Lockfile> {
    try {
      const raw = await readFile(this.lockPath, 'utf8');
      return JSON.parse(raw) as Lockfile;
    } catch {
      return { installed: {} };
    }
  }

  private async write(data: Lockfile): Promise<void> {
    await mkdir(this.studioDir, { recursive: true });
    await writeFile(this.lockPath, JSON.stringify(data, null, 2) + '\n');
  }

  async add(name: string, entry: LockfileEntry): Promise<void> {
    const data = await this.read();
    data.installed[name] = entry;
    await this.write(data);
  }

  async remove(name: string): Promise<void> {
    const data = await this.read();
    delete data.installed[name];
    await this.write(data);
  }

  async get(name: string): Promise<LockfileEntry | null> {
    const data = await this.read();
    return data.installed[name] ?? null;
  }

  async list(): Promise<Array<{ name: string } & LockfileEntry>> {
    const data = await this.read();
    return Object.entries(data.installed).map(([name, entry]) => ({ name, ...entry }));
  }

  async addRequiredBy(name: string, requiredBy: string): Promise<void> {
    const data = await this.read();
    const entry = data.installed[name];
    if (!entry) return;
    const existing = entry.required_by ?? [];
    if (!existing.includes(requiredBy)) {
      data.installed[name] = { ...entry, required_by: [...existing, requiredBy] };
      await this.write(data);
    }
  }

  async removeRequiredBy(name: string, requiredBy: string): Promise<void> {
    const data = await this.read();
    const entry = data.installed[name];
    if (!entry) return;
    data.installed[name] = { ...entry, required_by: (entry.required_by ?? []).filter(r => r !== requiredBy) };
    await this.write(data);
  }
}

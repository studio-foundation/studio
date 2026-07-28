import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_MARKETPLACE } from './dependency-spec.js';
import { REGISTRY_REPO } from './types.js';

export interface Marketplace {
  name: string;
  url: string;
}

export const DEFAULT_MARKETPLACE_ENTRY: Marketplace = {
  name: DEFAULT_MARKETPLACE,
  url: `https://github.com/${REGISTRY_REPO}.git`,
};

/**
 * A marketplace is a property of the machine, not of a checkout: the same private
 * marketplace serves every project on it, and a project must not be able to point
 * its own installs at an unreviewed source.
 */
export function marketplacesPath(): string {
  return resolve(homedir(), '.studio', 'marketplaces.json');
}

interface MarketplaceFile {
  marketplaces: Marketplace[];
}

/** The default marketplace first, then whatever the user registered. */
export async function loadMarketplaces(file = marketplacesPath()): Promise<Marketplace[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [DEFAULT_MARKETPLACE_ENTRY];
  }
  const data = JSON.parse(raw) as MarketplaceFile;
  const registered = (data.marketplaces ?? []).filter((m) => m.name !== DEFAULT_MARKETPLACE);
  return [DEFAULT_MARKETPLACE_ENTRY, ...registered];
}

export async function findMarketplace(name: string, file?: string): Promise<Marketplace> {
  const found = (await loadMarketplaces(file)).find((m) => m.name === name);
  if (!found) {
    throw new Error(
      `Marketplace '${name}' is not registered. Run: studio marketplace add <url> --name ${name}`,
    );
  }
  return found;
}

export async function addMarketplace(entry: Marketplace, file = marketplacesPath()): Promise<void> {
  if (entry.name === DEFAULT_MARKETPLACE) {
    throw new Error(`'${DEFAULT_MARKETPLACE}' is the default marketplace and is always available.`);
  }
  const existing = (await loadMarketplaces(file)).find((m) => m.name === entry.name);
  if (existing && existing.url !== entry.url) {
    throw new Error(
      `Marketplace '${entry.name}' is already registered as ${existing.url}. ` +
      `Remove it first, or add this one under another name with --name.`,
    );
  }
  const others = (await loadMarketplaces(file)).filter(
    (m) => m.name !== DEFAULT_MARKETPLACE && m.name !== entry.name,
  );
  await mkdir(dirname(file), { recursive: true });
  const data: MarketplaceFile = { marketplaces: [...others, entry] };
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
}

export async function removeMarketplace(name: string, file = marketplacesPath()): Promise<void> {
  if (name === DEFAULT_MARKETPLACE) {
    throw new Error(`'${DEFAULT_MARKETPLACE}' is the default marketplace and cannot be removed.`);
  }
  const registered = (await loadMarketplaces(file)).filter((m) => m.name !== DEFAULT_MARKETPLACE);
  if (!registered.some((m) => m.name === name)) {
    throw new Error(`Marketplace '${name}' is not registered.`);
  }
  await mkdir(dirname(file), { recursive: true });
  const data: MarketplaceFile = { marketplaces: registered.filter((m) => m.name !== name) };
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
}

/** `owner/repo` when the URL is a GitHub remote, else null — the raw/API fast path. */
export function githubRepoOf(url: string): string | null {
  const match = /^(?:https?:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? match[1] : null;
}

export function rawBaseOf(repo: string): string {
  return `https://raw.githubusercontent.com/${repo}/main`;
}

export function apiBaseOf(repo: string): string {
  return `https://api.github.com/repos/${repo}`;
}

/** Default name for `studio marketplace add <url>`: the repository name. */
export function marketplaceNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1).trim();
  if (!name) throw new Error(`Cannot derive a marketplace name from '${url}' — pass --name.`);
  return name;
}

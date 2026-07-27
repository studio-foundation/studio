import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  addMarketplace,
  findMarketplace,
  githubRepoOf,
  loadMarketplaces,
  marketplaceNameFromUrl,
  removeMarketplace,
} from '../../src/registry/marketplaces.js';

const TMP = resolve('/tmp', '.studio-marketplaces-test');
const FILE = resolve(TMP, 'marketplaces.json');

const ACME = { name: 'acme-corp', url: 'https://github.com/acme/studio-marketplace.git' };

beforeEach(async () => { await mkdir(TMP, { recursive: true }); });
afterEach(async () => { await rm(TMP, { recursive: true, force: true }); });

describe('loadMarketplaces', () => {
  it('returns the default marketplace when nothing is registered', async () => {
    expect(await loadMarketplaces(FILE)).toEqual([
      { name: 'studio-community', url: 'https://github.com/studio-foundation/studio-community.git' },
    ]);
  });

  it('lists the default first, then registered ones', async () => {
    await addMarketplace(ACME, FILE);
    expect((await loadMarketplaces(FILE)).map(m => m.name)).toEqual(['studio-community', 'acme-corp']);
  });
});

describe('addMarketplace', () => {
  it('refuses a second URL under a name already registered', async () => {
    await addMarketplace(ACME, FILE);
    await expect(addMarketplace({ ...ACME, url: 'https://github.com/impostor/x.git' }, FILE))
      .rejects.toThrow(/already registered as/);
  });

  it('is idempotent for the same name and URL', async () => {
    await addMarketplace(ACME, FILE);
    await addMarketplace(ACME, FILE);
    expect(await loadMarketplaces(FILE)).toHaveLength(2);
  });

  it('refuses to shadow the default marketplace', async () => {
    await expect(addMarketplace({ name: 'studio-community', url: 'https://github.com/x/y.git' }, FILE))
      .rejects.toThrow(/default marketplace/);
  });
});

describe('removeMarketplace', () => {
  it('unregisters a marketplace', async () => {
    await addMarketplace(ACME, FILE);
    await removeMarketplace('acme-corp', FILE);
    expect((await loadMarketplaces(FILE)).map(m => m.name)).toEqual(['studio-community']);
  });

  it('refuses to remove the default marketplace', async () => {
    await expect(removeMarketplace('studio-community', FILE)).rejects.toThrow(/cannot be removed/);
  });

  it('throws for an unregistered name', async () => {
    await expect(removeMarketplace('ghost', FILE)).rejects.toThrow(/not registered/);
  });
});

describe('findMarketplace', () => {
  it('resolves the default without registration', async () => {
    expect((await findMarketplace('studio-community', FILE)).url).toMatch(/studio-community\.git$/);
  });

  it('points at the command that would register an unknown one', async () => {
    await expect(findMarketplace('acme-corp', FILE)).rejects.toThrow(/studio marketplace add/);
  });
});

describe('githubRepoOf', () => {
  it.each([
    ['https://github.com/acme/studio-legal.git', 'acme/studio-legal'],
    ['https://github.com/acme/studio-legal', 'acme/studio-legal'],
    ['git@github.com:acme/studio-legal.git', 'acme/studio-legal'],
  ])('reads %s as %s', (url, repo) => {
    expect(githubRepoOf(url)).toBe(repo);
  });

  it('returns null for a non-GitHub remote, which is fetched over git instead', () => {
    expect(githubRepoOf('https://gitlab.internal/acme/studio-marketplace.git')).toBeNull();
  });
});

describe('marketplaceNameFromUrl', () => {
  it('defaults to the repository name', () => {
    expect(marketplaceNameFromUrl('https://gitlab.internal/acme/studio-marketplace.git')).toBe('studio-marketplace');
  });
});

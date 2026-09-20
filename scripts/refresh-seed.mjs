#!/usr/bin/env node
// Refreshes cli/templates/seed/ — the pre-fetched snapshot of the official
// marketplace that makes `studio init` work on a machine with no network.
//
// The snapshot is data, not code: it mirrors the marketplace layout verbatim
// (index.json plus each package's `source.path` tree) so nothing in the kernel
// has to know a package name. Anything installed from it is an ordinary
// package — removable, overridable, and replaced by the live registry as soon
// as one is reachable.
//
//   node scripts/refresh-seed.mjs                  # from the published marketplace
//   node scripts/refresh-seed.mjs ../studio-community   # from a local checkout

import { readdir, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_DIR = join(ROOT, 'cli', 'templates', 'seed');
const REGISTRY_REPO = 'studio-foundation/studio-community';
const RAW_BASE = `https://raw.githubusercontent.com/${REGISTRY_REPO}/main`;
const API_BASE = `https://api.github.com/repos/${REGISTRY_REPO}`;

async function fetchJson(url) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      `GitHub API rate limit (HTTP ${res.status}) on ${url}. Set GITHUB_TOKEN, or refresh from a local checkout: node scripts/refresh-seed.mjs ../studio-community`,
    );
  }
  if (!res.ok) throw new Error(`GET ${url} — HTTP ${res.status}`);
  return res.json();
}

/** Every file under `dir`, as { path (relative to the marketplace root), content }. */
async function readRemoteTree(dir) {
  const items = await fetchJson(`${API_BASE}/contents/${dir}`);
  const files = [];
  for (const item of items) {
    if (item.type === 'dir') {
      files.push(...(await readRemoteTree(item.path)));
    } else if (item.download_url) {
      const res = await fetch(item.download_url);
      if (!res.ok) throw new Error(`GET ${item.download_url} — HTTP ${res.status}`);
      files.push({ path: item.path, content: await res.text() });
    }
  }
  return files;
}

async function readLocalTree(root, dir) {
  const files = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await readLocalTree(root, rel)));
    else files.push({ path: rel, content: await readFile(join(root, rel), 'utf-8') });
  }
  return files;
}

const localRoot = process.argv[2] ? resolve(process.argv[2]) : null;
if (localRoot && !(await stat(localRoot).catch(() => null))) {
  throw new Error(`No such marketplace checkout: ${localRoot}`);
}

const index = localRoot
  ? JSON.parse(await readFile(join(localRoot, 'index.json'), 'utf-8'))
  : await fetchJson(`${RAW_BASE}/index.json`);

// Everything is read before the seed is touched, so a failed fetch leaves the previous one intact.
const files = [{ path: 'index.json', content: JSON.stringify(index, null, 2) + '\n' }];
for (const pkg of index.packages) {
  files.push(
    ...(localRoot ? await readLocalTree(localRoot, pkg.source.path) : await readRemoteTree(pkg.source.path)),
  );
}

await rm(SEED_DIR, { recursive: true, force: true });
for (const file of files) {
  const dest = join(SEED_DIR, file.path);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, file.content, 'utf-8');
}

console.log(
  `${relative(ROOT, SEED_DIR)} — ${index.packages.length} packages, ${files.length} files`,
);

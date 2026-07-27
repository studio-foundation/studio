#!/usr/bin/env node
// INV-11: the kernel ships no tool it does not implement.
//
// Domain tools live in the marketplace (STU-695). The bundled seed under
// cli/templates/seed/ is exempt: it is a pre-fetched blob the kernel carries
// without interpreting, so the names inside it are data, not code.
//
// Editing BUILTIN_TOOLS here is the point — a new kernel builtin has to be an
// explicit decision, not a file someone dropped into runner/templates/.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['contracts', 'anonymizer', 'ralph', 'runner', 'engine', 'api', 'cli'];
const BUILTIN_TOOLS = ['repo-manager', 'shell'];

/** Tool actions the kernel no longer implements — a reference means a stale caller. */
const MARKETPLACE_ACTIONS =
  /\b(?:git-(?:checkout|commit|push|pull|status|diff)|search-search_codebase|web_search-search)\b/g;
const MARKETPLACE_FACTORIES = /\bcreate(?:Git|Search|WebSearch)Tools\b/g;

const violations = [];

async function walk(dir, exempt = []) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    if (exempt.includes(relative(ROOT, full))) continue;
    if (entry.isDirectory()) out.push(...(await walk(full, exempt)));
    else out.push(full);
  }
  return out;
}

const listing = async (dir) => {
  try {
    return await walk(dir, ['cli/templates/seed']);
  } catch {
    return [];
  }
};

// --- Bundled templates: only the builtins, and never an integration ---
for (const pkg of PACKAGES) {
  for (const file of await listing(join(ROOT, pkg, 'templates'))) {
    const rel = relative(ROOT, file);
    if (file.endsWith('.integration.yaml')) {
      violations.push(`${rel} — the kernel bundles no integration`);
    } else if (file.endsWith('.tool.yaml')) {
      const name = file.slice(file.lastIndexOf('/') + 1, -'.tool.yaml'.length);
      if (!BUILTIN_TOOLS.includes(name)) {
        violations.push(`${rel} — '${name}' is not a kernel builtin`);
      }
    }
  }
}

// --- Source: no reference to a tool that left the kernel ---
let scanned = 0;
for (const pkg of PACKAGES) {
  for (const file of await listing(join(ROOT, pkg, 'src'))) {
    if (!file.endsWith('.ts')) continue;
    scanned++;
    const lines = (await readFile(file, 'utf-8')).split('\n');
    for (const pattern of [MARKETPLACE_ACTIONS, MARKETPLACE_FACTORIES]) {
      lines.forEach((line, i) => {
        for (const match of line.matchAll(pattern)) {
          violations.push(`${relative(ROOT, file)}:${i + 1} — "${match[0]}" left the kernel`);
        }
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`INV-11: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error('\nMove the capability to a marketplace plugin, or seed it under cli/templates/seed/.');
  process.exit(1);
}

console.log(`INV-11: ${scanned} kernel source files clean, only ${BUILTIN_TOOLS.join(' and ')} bundled.`);

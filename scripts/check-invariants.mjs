#!/usr/bin/env node
// Mechanical enforcement for the invariants that a grep can settle.
//
// INV-02, INV-03, INV-08 and INV-09 are absent on purpose: they are properties
// of type signatures and call graphs, not of text.
// INV-10's import direction is enforced by ESLint (ALLOWED_INTERNAL_IMPORTS in
// eslint.config.mjs); this script adds the manifest side, which ESLint never reads.
// INV-11 has its own script, check-kernel-domain-free.mjs.

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The DAG, as manifests must declare it. Mirrors ALLOWED_INTERNAL_IMPORTS. */
const DAG = {
  contracts: [],
  anonymizer: [],
  ralph: ['contracts'],
  runner: ['contracts', 'anonymizer'],
  engine: ['contracts', 'ralph', 'runner'],
  api: ['contracts', 'engine', 'runner'],
  cli: ['contracts', 'engine', 'runner', 'api'],
};

/**
 * A name a config author writes in `.studio/`. The kernel must never hardcode
 * one: doing so makes a project inherit another project's vocabulary.
 */
const CONFIG_ARTIFACT = [
  /\bfeature-builder\b|\bbrief-analysis\b|\bimplementation-plan\b|\bcode-generation\b|\bqa-review\b/,
  'hardcodes a pipeline, contract or stage name',
];

/**
 * Domain vocabulary the engine must not name, on top of the above. Every
 * pattern is narrow enough that a hit is a violation, not a colliding word.
 */
const ENGINE_DOMAIN = [
  CONFIG_ARTIFACT,
  [/\bgit\s+(?:clone|commit|push|pull|checkout|status|diff|add)\b/, 'shells out to git'],
  [/\bqa\b/i, "names 'QA'"],
  [/\brepo_manager\b|\bshell-run_command\b|\bstudio_run-/, 'names a builtin tool'],
];

const violations = [];

async function walkTs(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    if (entry.isDirectory()) out.push(...(await walkTs(full)));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Report every line of `files` matching `pattern`, prefixed with `label`. */
async function forbid(files, pattern, label) {
  for (const file of files) {
    const lines = (await readFile(file, 'utf-8')).split('\n');
    lines.forEach((line, i) => {
      if (pattern.test(line)) {
        violations.push(`${label}: ${relative(ROOT, file)}:${i + 1} — ${line.trim()}`);
      }
    });
  }
}

// --- INV-10: every manifest declares exactly the internal deps the DAG allows ---
for (const [pkg, allowed] of Object.entries(DAG)) {
  const manifest = JSON.parse(await readFile(join(ROOT, pkg, 'package.json'), 'utf-8'));
  const declared = Object.keys(manifest.dependencies ?? {})
    .filter((d) => d.startsWith('@studio-foundation/'))
    .map((d) => d.slice('@studio-foundation/'.length));
  for (const dep of declared) {
    if (!allowed.includes(dep)) {
      violations.push(
        `INV-10: ${pkg}/package.json depends on ${dep}, which the DAG does not allow. ` +
          `Either the dependency is inverted, or DAG in this file and ALLOWED_INTERNAL_IMPORTS ` +
          `in eslint.config.mjs need the new edge documented in INVARIANTS.md.`
      );
    }
  }
}

// --- INV-04: the engine names no domain ---
const engineSrc = await walkTs(join(ROOT, 'engine', 'src'));
for (const [pattern, what] of ENGINE_DOMAIN) {
  await forbid(engineSrc, pattern, `INV-04: the engine ${what}`);
}

// --- INV-12: the API never chooses what to run ---
// `integrations/` is deliberately included: that is where the last hardcoded
// default lived. Shelling out to git in utils/repo-resolver.ts is allowed —
// resolving the workspace is the caller responsibility INV-04 keeps out of the
// engine — so only the config-artifact pattern applies here.
const apiSrc = await walkTs(join(ROOT, 'api', 'src'));
await forbid(apiSrc, CONFIG_ARTIFACT[0], `INV-12: the API ${CONFIG_ARTIFACT[1]}`);

// --- INV-05: the tool runtime lives in runner ---
if (await exists(join(ROOT, 'engine', 'src', 'tools'))) {
  violations.push('INV-05: engine/src/tools/ exists — the tool runtime belongs to runner');
}
if (!(await exists(join(ROOT, 'runner', 'src', 'tools', 'tool-registry.ts')))) {
  violations.push('INV-05: runner/src/tools/tool-registry.ts is missing');
}

// --- INV-06: the prompt is assembled in runner, and only there ---
if (!(await exists(join(ROOT, 'runner', 'src', 'prompt-builder.ts')))) {
  violations.push('INV-06: runner/src/prompt-builder.ts is missing');
}
for (const file of engineSrc) {
  if (file.includes('prompt-builder')) {
    violations.push(`INV-06: ${relative(ROOT, file)} — prompt assembly belongs to runner`);
  }
}
await forbid(
  engineSrc,
  /\bsystem_prompt\s*(?:=[^=]|\+=)/,
  'INV-06: the engine assembles a system prompt (pass the content to runAgent instead)'
);

if (violations.length > 0) {
  console.error(`Invariants: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error('\nFix the code, not the check. Each rule is stated in INVARIANTS.md.');
  process.exit(1);
}

console.log(
  `Invariants: ${engineSrc.length + apiSrc.length} source files and ` +
    `${Object.keys(DAG).length} manifests clean.`
);

import { CONTENT_EXTENSIONS, contentKindOf, type PackageProvides } from './types.js';
import type { PayloadFile } from './client.js';

/**
 * Enough of each license's text to tell it apart from the others. A payload may
 * ship any wording it likes as long as it is the license the entry declares —
 * the index says what users are agreeing to, and review only ever sees the index.
 */
const LICENSE_SIGNATURES: Record<string, RegExp> = {
  'MIT': /MIT License|Permission is hereby granted, free of charge/i,
  'ISC': /ISC License|Permission to use, copy, modify, and\/or distribute/i,
  'Apache-2.0': /Apache License[\s\S]{0,80}Version 2\.0/i,
  'AGPL-3.0': /GNU AFFERO GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 3/i,
  'GPL-3.0': /GNU GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 3/i,
  'LGPL-3.0': /GNU LESSER GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 3/i,
  'MPL-2.0': /Mozilla Public License Version 2\.0/i,
  'BSD-3-Clause': /Redistribution and use in source and binary forms[\s\S]*?Neither the name/i,
  'BSD-2-Clause': /Redistribution and use in source and binary forms/i,
};

const LICENSE_FILE = /^LICEN[SC]E(\.[\w-]+)?$/i;

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `coder.agent.yaml` → `coder`, the name `provides` lists it under. */
function payloadName(filename: string): string | null {
  for (const ext of Object.keys(CONTENT_EXTENSIONS)) {
    if (filename.endsWith(ext)) return filename.slice(0, -ext.length);
  }
  return null;
}

function checkLicense(files: PayloadFile[], license: string): string[] {
  const file = files.find((f) => LICENSE_FILE.test(baseName(f.path)));
  if (!file) return [`declares license '${license}' but ships no LICENSE file`];

  const spdx = license.replace(/-(only|or-later)$/, '');
  const signature = LICENSE_SIGNATURES[spdx];
  if (!signature) return [];
  return signature.test(file.content)
    ? []
    : [`ships a LICENSE file that is not '${license}'`];
}

function checkProvides(files: PayloadFile[], provides: PackageProvides): string[] {
  const actual: Record<string, Set<string>> = {};
  for (const file of files) {
    const filename = baseName(file.path);
    const kind = contentKindOf(filename);
    const name = payloadName(filename);
    if (!kind || !name) continue;
    (actual[`${kind}s`] ??= new Set()).add(name);
  }

  const problems: string[] = [];
  for (const [kind, names] of Object.entries(provides)) {
    for (const name of names ?? []) {
      if (!actual[kind]?.has(name)) problems.push(`declares ${kind} '${name}', absent from the payload`);
    }
  }
  for (const [kind, names] of Object.entries(actual)) {
    const declared = new Set(provides[kind as keyof PackageProvides] ?? []);
    for (const name of names) {
      if (!declared.has(name)) problems.push(`ships undeclared ${kind.replace(/s$/, '')} '${name}'`);
    }
  }
  return problems;
}

export interface VerifiableEntry {
  name: string;
  license: string;
  provides?: PackageProvides;
}

/**
 * Assert a fetched payload against what its index entry claims. Only meaningful
 * for sources hosted outside the marketplace repo, where review sees a URL and
 * never the files (ADR 0001).
 */
export function verifyPayload(files: PayloadFile[], entry: VerifiableEntry): string[] {
  return [
    ...checkLicense(files, entry.license),
    ...(entry.provides ? checkProvides(files, entry.provides) : []),
  ];
}

export function assertPayload(files: PayloadFile[], entry: VerifiableEntry): void {
  const problems = verifyPayload(files, entry);
  if (problems.length > 0) {
    throw new Error(
      `Package '${entry.name}' does not match its registry entry:\n` +
      problems.map((p) => `  - ${p}`).join('\n'),
    );
  }
}

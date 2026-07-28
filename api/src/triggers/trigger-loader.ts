import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { resolveEnvVars } from '@studio-foundation/engine';
import type { TriggerDef } from '@studio-foundation/contracts';

/**
 * Load all `.trigger.yaml` files from a project's triggers directory.
 * Returns an empty array if the directory does not exist.
 */
export async function loadProjectTriggers(triggersDir: string): Promise<TriggerDef[]> {
  if (!existsSync(triggersDir)) return [];

  let files: string[];
  try {
    files = (await readdir(triggersDir)).filter(f => f.endsWith('.trigger.yaml'));
  } catch {
    return [];
  }

  const triggers: TriggerDef[] = [];
  for (const file of files.sort()) {
    const content = await readFile(resolve(triggersDir, file), 'utf-8');
    const def = yaml.load(resolveEnvVars(content)) as TriggerDef | undefined;
    if (!def?.name) throw new Error(`Trigger '${file}' is missing 'name'`);
    if (!def.pipeline) throw new Error(`Trigger '${def.name}' is missing 'pipeline'`);
    // An unset ${VAR} resolves to nothing, which YAML reads as null. Refusing here
    // is the point: a trigger that declares hmac and silently stops verifying
    // accepts unsigned deliveries from anyone who knows the URL.
    if (def.webhook?.hmac && !def.webhook.hmac.secret) {
      throw new Error(`Trigger '${def.name}' declares webhook.hmac but its secret resolved to nothing`);
    }
    triggers.push(def);
  }
  return triggers;
}

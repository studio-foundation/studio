# STU-184 Integration Plugins Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a plugin-based integration system via `.integration.yaml` files, mirroring the existing `.tool.yaml` pattern, with full CLI management commands.

**Architecture:** Three packages are touched in dependency order — `@studio-foundation/contracts` (types), `@studio-foundation/runner` (bundled YAML templates + loader), `@studio-foundation/cli` (commands). No changes to `@studio-foundation/engine` or `@studio-foundation/api`. The hardcoded `linear-notifier.ts` / `webhook-dispatcher.ts` are left untouched (separate ticket).

**Tech Stack:** TypeScript, js-yaml, vitest, @inquirer/prompts, chalk, ora, Node.js fs/promises

---

## Task 1: `@studio-foundation/contracts` — `IntegrationPluginDef` types

**Files:**
- Create: `contracts/src/integration-plugin.ts`
- Modify: `contracts/src/index.ts`

**Step 1: Create the types file**

```typescript
// contracts/src/integration-plugin.ts

export interface IntegrationPluginDef {
  name: string;
  version: number;
  description?: string;
  config?: {
    required?: string[];
    optional?: Record<string, unknown>;
  };
  events?: {
    consumes?: string[];
    emits?: string[];
  };
  test?: {
    type: 'http';
    endpoint: string;
    method?: 'GET' | 'POST';
    /** e.g. "bearer:${LINEAR_API_KEY}" — resolved before use */
    auth?: string;
    body?: string;
    expect?: { status?: number };
  };
}

/** Interfaces for future API-side runtime implementation (not implemented in STU-184) */
export interface IntegrationRuntimeContext {
  event: string;
  data: unknown;
  config: Record<string, string>;
}

export interface IntegrationRuntimeHandler {
  name: string;
  plugin: IntegrationPluginDef;
  handleEvent(ctx: IntegrationRuntimeContext): Promise<void>;
}
```

**Step 2: Export from barrel**

In `contracts/src/index.ts`, add at the end:
```typescript
export * from './integration-plugin.js';
```

**Step 3: Build and verify**

```bash
pnpm --filter @studio-foundation/contracts build
```
Expected: build succeeds with no errors.

**Step 4: Commit**

```bash
git add contracts/src/integration-plugin.ts contracts/src/index.ts
git commit -m "feat(contracts): add IntegrationPluginDef and runtime interface types"
```

---

## Task 2: `@studio-foundation/runner` — Bundled integration YAML templates

**Files:**
- Create: `runner/templates/integrations/linear.integration.yaml`
- Create: `runner/templates/integrations/slack.integration.yaml`
- Create: `runner/templates/integrations/webhook.integration.yaml`

**Step 1: Create `runner/templates/integrations/` directory and `linear.integration.yaml`**

```yaml
name: linear
version: 1
description: "Linear webhook trigger + issue status sync"

config:
  required:
    - LINEAR_API_KEY
    - LINEAR_WEBHOOK_SECRET
  optional:
    autoTrigger: false

events:
  consumes:
    - linear.issue.in_progress
  emits:
    - pipeline.complete
    - pipeline.failed

test:
  type: http
  endpoint: https://api.linear.app/graphql
  method: POST
  auth: bearer:${LINEAR_API_KEY}
  body: '{"query":"{ viewer { id name } }"}'
  expect:
    status: 200
```

**Step 2: Create `slack.integration.yaml`**

```yaml
name: slack
version: 1
description: "Slack notifications for pipeline events"

config:
  required:
    - SLACK_BOT_TOKEN
  optional:
    channel: "#studio-runs"

events:
  emits:
    - pipeline.complete
    - pipeline.failed

test:
  type: http
  endpoint: https://slack.com/api/auth.test
  method: POST
  auth: bearer:${SLACK_BOT_TOKEN}
  expect:
    status: 200
```

**Step 3: Create `webhook.integration.yaml`**

```yaml
name: webhook
version: 1
description: "Generic HTTP webhook notifications for pipeline events"

config:
  optional:
    url: ""
    events: "pipeline.complete,pipeline.failed"
    secret: ""

events:
  emits:
    - pipeline.complete
    - pipeline.failed
    - pipeline.start
    - stage.complete
    - stage.failed
```

**Step 4: Commit**

```bash
git add runner/templates/integrations/
git commit -m "feat(runner): add bundled integration plugin templates (linear, slack, webhook)"
```

---

## Task 3: `@studio-foundation/runner` — Integration loader

**Files:**
- Create: `runner/src/integrations/integration-loader.ts`
- Create: `runner/src/integrations/integration-loader.test.ts`
- Modify: `runner/src/index.ts`

**Step 1: Write the failing tests**

```typescript
// runner/src/integrations/integration-loader.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getBundledIntegrationTemplate,
  listAvailableIntegrationTemplates,
  loadProjectIntegrations,
} from './integration-loader.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'studio-integration-loader-test-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('getBundledIntegrationTemplate', () => {
  it('returns YAML content for a known bundled integration', async () => {
    const content = await getBundledIntegrationTemplate('linear');
    expect(content).not.toBeNull();
    expect(content).toContain('name: linear');
  });

  it('returns null for unknown integration name', async () => {
    const content = await getBundledIntegrationTemplate('doesnotexist');
    expect(content).toBeNull();
  });
});

describe('listAvailableIntegrationTemplates', () => {
  it('returns at least linear, slack, webhook', async () => {
    const templates = await listAvailableIntegrationTemplates();
    const names = templates.map(t => t.name);
    expect(names).toContain('linear');
    expect(names).toContain('slack');
    expect(names).toContain('webhook');
  });

  it('each entry has name and description', async () => {
    const templates = await listAvailableIntegrationTemplates();
    for (const t of templates) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
    }
  });
});

describe('loadProjectIntegrations', () => {
  it('returns empty array when directory does not exist', async () => {
    const result = await loadProjectIntegrations('/nonexistent/path');
    expect(result).toEqual([]);
  });

  it('loads valid .integration.yaml files', async () => {
    const intDir = join(tmpDir, 'integrations');
    await mkdir(intDir, { recursive: true });
    await writeFile(join(intDir, 'test.integration.yaml'), `
name: test
version: 1
description: "Test integration"
config:
  required:
    - TEST_API_KEY
test:
  type: http
  endpoint: https://api.test.com/health
  expect:
    status: 200
`);
    const result = await loadProjectIntegrations(intDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('test');
    expect(result[0]!.config?.required).toEqual(['TEST_API_KEY']);
  });

  it('ignores non-.integration.yaml files', async () => {
    const intDir = join(tmpDir, 'integrations-mixed');
    await mkdir(intDir, { recursive: true });
    await writeFile(join(intDir, 'readme.txt'), 'hello');
    await writeFile(join(intDir, 'other.yaml'), 'name: other\nversion: 1');
    const result = await loadProjectIntegrations(intDir);
    expect(result).toHaveLength(0);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter @studio-foundation/runner test
```
Expected: FAIL — module `./integration-loader.js` not found.

**Step 3: Implement `integration-loader.ts`**

```typescript
// runner/src/integrations/integration-loader.ts
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { IntegrationPluginDef } from '@studio-foundation/contracts';

const BUNDLED_INTEGRATION_TEMPLATES_DIR = resolve(
  __dirname,
  '../../templates/integrations'
);

export async function getBundledIntegrationTemplate(name: string): Promise<string | null> {
  const filePath = resolve(BUNDLED_INTEGRATION_TEMPLATES_DIR, `${name}.integration.yaml`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function listAvailableIntegrationTemplates(): Promise<{ name: string; description: string }[]> {
  let files: string[];
  try {
    files = (await readdir(BUNDLED_INTEGRATION_TEMPLATES_DIR))
      .filter(f => f.endsWith('.integration.yaml'))
      .sort();
  } catch {
    return [];
  }
  const result: { name: string; description: string }[] = [];
  for (const file of files) {
    const content = await readFile(resolve(BUNDLED_INTEGRATION_TEMPLATES_DIR, file), 'utf-8');
    const def = yaml.load(content) as IntegrationPluginDef;
    result.push({ name: file.replace('.integration.yaml', ''), description: def.description ?? '' });
  }
  return result;
}

export async function loadProjectIntegrations(integrationsDir: string): Promise<IntegrationPluginDef[]> {
  if (!existsSync(integrationsDir)) return [];

  let files: string[];
  try {
    files = (await readdir(integrationsDir)).filter(f => f.endsWith('.integration.yaml'));
  } catch {
    return [];
  }

  const result: IntegrationPluginDef[] = [];
  for (const file of files.sort()) {
    const content = await readFile(resolve(integrationsDir, file), 'utf-8');
    result.push(yaml.load(content) as IntegrationPluginDef);
  }
  return result;
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/runner test
```
Expected: all integration-loader tests PASS.

**Step 5: Export from `runner/src/index.ts`**

Add after the existing tool exports:
```typescript
export {
  getBundledIntegrationTemplate,
  listAvailableIntegrationTemplates,
  loadProjectIntegrations,
} from './integrations/integration-loader.js';
export type { IntegrationPluginDef } from '@studio-foundation/contracts';
```

**Step 6: Build**

```bash
pnpm --filter @studio-foundation/runner build
```
Expected: build succeeds.

**Step 7: Commit**

```bash
git add runner/src/integrations/ runner/src/index.ts
git commit -m "feat(runner): add integration plugin loader with bundled template support"
```

---

## Task 4: `@studio-foundation/cli` — `StudioConfig.integrations` + command skeleton

**Files:**
- Modify: `cli/src/config.ts`
- Create: `cli/src/commands/integrations.ts`
- Modify: `cli/src/index.ts`

**Step 1: Add `integrations` field to `StudioConfig`**

In `cli/src/config.ts`, add `integrations` to the `StudioConfig` interface:

```typescript
export interface StudioConfig {
  providers?: { ... };  // existing fields unchanged
  paths?: { ... };
  defaults?: { ... };
  api?: { ... };
  integrations?: Record<string, Record<string, unknown>>;  // ADD THIS
  resolvedStudioDir?: string;
}
```

**Step 2: Create the command skeleton**

```typescript
// cli/src/commands/integrations.ts
import chalk from 'chalk';

export async function integrationsCommand(
  action: string,
  args: string[],
  options: Record<string, string | boolean | undefined>
): Promise<void> {
  try {
    switch (action) {
      case 'install':
      case 'list':
      case 'remove':
      case 'test':
      case 'set':
        throw new Error(`Not implemented yet: ${action}`);
      default:
        console.error(`Unknown integrations action: ${action}. Available: install, list, remove, test, set`);
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      console.log('\nAborted.');
      process.exit(0);
    }
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
```

**Step 3: Register in `cli/src/index.ts`**

Add import and command registration:

```typescript
import { integrationsCommand } from './commands/integrations.js';

// After the existing 'tools' command registration:
program
  .command('integrations <action> [args...]')
  .description('Manage Studio integrations (install, list, remove, test, set)')
  .action((action: string, args: string[], options: Record<string, string>) => {
    void integrationsCommand(action, args, options);
  });
```

**Step 4: Build and verify**

```bash
pnpm --filter @studio-foundation/cli build && node cli/dist/index.js integrations list
```
Expected: `Error: Not implemented yet: list` (confirms routing works).

**Step 5: Commit**

```bash
git add cli/src/config.ts cli/src/commands/integrations.ts cli/src/index.ts
git commit -m "feat(cli): scaffold integrations command + add StudioConfig.integrations field"
```

---

## Task 5: `@studio-foundation/cli` — `integrations install`

**Files:**
- Modify: `cli/src/commands/integrations.ts`
- Create: `cli/src/commands/integrations.test.ts`

**Step 1: Write the failing tests for `install`**

```typescript
// cli/src/commands/integrations.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We'll test the helper functions directly
import { installIntegration, resolveIntegrationsDir } from './integrations.js';

let studioDir: string;
let integrationsDir: string;

beforeEach(async () => {
  studioDir = await mkdtemp(join(tmpdir(), 'studio-int-test-'));
  integrationsDir = join(studioDir, 'integrations');
  await mkdir(integrationsDir, { recursive: true });
});

afterEach(async () => {
  await rm(studioDir, { recursive: true, force: true });
});

describe('installIntegration — bundled source', () => {
  it('installs a known bundled integration by @studio/integration-<name>', async () => {
    await installIntegration('@studio/integration-linear', integrationsDir);
    const destPath = join(integrationsDir, 'linear.integration.yaml');
    await expect(access(destPath)).resolves.toBeUndefined();
    const content = await readFile(destPath, 'utf-8');
    expect(content).toContain('name: linear');
  });

  it('throws if integration name is unknown', async () => {
    await expect(
      installIntegration('@studio/integration-doesnotexist', integrationsDir)
    ).rejects.toThrow("Unknown integration 'doesnotexist'");
  });

  it('throws if already installed', async () => {
    await installIntegration('@studio/integration-linear', integrationsDir);
    await expect(
      installIntegration('@studio/integration-linear', integrationsDir)
    ).rejects.toThrow("'linear' already installed");
  });
});

describe('installIntegration — local path', () => {
  it('installs from a local .integration.yaml file', async () => {
    const localFile = join(studioDir, 'my-custom.integration.yaml');
    await writeFile(localFile, 'name: my-custom\nversion: 1\ndescription: "Custom"');

    await installIntegration(localFile, integrationsDir);
    const destPath = join(integrationsDir, 'my-custom.integration.yaml');
    await expect(access(destPath)).resolves.toBeUndefined();
  });

  it('throws if local file does not exist', async () => {
    await expect(
      installIntegration('/nonexistent/file.integration.yaml', integrationsDir)
    ).rejects.toThrow('File not found');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter @studio-foundation/cli test
```
Expected: FAIL — `installIntegration` not exported from `./integrations.js`.

**Step 3: Implement `install` in `integrations.ts`**

Add helper functions and the install case. The source can be:
- `@studio/integration-<name>` → bundled template
- A local file path (starts with `.` or `/`)

```typescript
import { readFile, writeFile, mkdir, access, copyFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import * as yaml from 'js-yaml';
import chalk from 'chalk';
import ora from 'ora';
import { findStudioDir } from '../studio-dir.js';
import { getBundledIntegrationTemplate, listAvailableIntegrationTemplates, loadProjectIntegrations } from '@studio-foundation/runner';
import type { IntegrationPluginDef } from '@studio-foundation/contracts';

export function getIntegrationsDir(studioDir: string): string {
  return resolve(studioDir, 'integrations');
}

async function resolveStudioDir(): Promise<string> {
  const studioDir = (await import('../config.js').then(m => m.loadConfig())).resolvedStudioDir;
  if (!studioDir) {
    console.error("Error: No .studio/ directory found. Run 'studio init' first.");
    process.exit(1);
  }
  return studioDir;
}

export async function resolveIntegrationsDir(): Promise<string> {
  const studioDir = await resolveStudioDir();
  return getIntegrationsDir(studioDir);
}

export async function installIntegration(source: string, integrationsDir: string): Promise<string> {
  await mkdir(integrationsDir, { recursive: true });

  let name: string;
  let content: string;

  if (source.startsWith('@studio/integration-')) {
    // Bundled registry
    name = source.replace('@studio/integration-', '');
    const bundled = await getBundledIntegrationTemplate(name);
    if (!bundled) {
      const available = await listAvailableIntegrationTemplates();
      throw new Error(
        `Unknown integration '${name}'. Available: ${available.map(t => t.name).join(', ')}`
      );
    }
    content = bundled;
  } else {
    // Local path
    try {
      content = await readFile(source, 'utf-8');
    } catch {
      throw new Error(`File not found: ${source}`);
    }
    const def = yaml.load(content) as IntegrationPluginDef;
    name = def.name;
  }

  const destPath = join(integrationsDir, `${name}.integration.yaml`);
  const alreadyExists = await access(destPath).then(() => true).catch(() => false);
  if (alreadyExists) {
    throw new Error(
      `'${name}' already installed. Run: studio integrations remove ${name}`
    );
  }

  await writeFile(destPath, content, 'utf-8');
  return name;
}
```

In the `switch` block, implement `install`:

```typescript
case 'install': {
  const source = args[0];
  if (!source) {
    console.error('Usage: studio integrations install <source>');
    console.error('  <source> can be @studio/integration-<name> or a local file path');
    process.exit(1);
  }
  const studioDir = await resolveStudioDir();
  const intDir = getIntegrationsDir(studioDir);
  const spinner = ora(`Installing ${source}...`).start();
  try {
    const name = await installIntegration(source, intDir);
    spinner.succeed(chalk.green(`✓ Integration '${name}' installed`));
    console.log(`\n  Configure with: ${chalk.cyan(`studio integrations set ${name}.<key> <value>`)}`);
    console.log(`  Test with:      ${chalk.cyan(`studio integrations test ${name}`)}\n`);
  } catch (err) {
    spinner.fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  break;
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/cli test
```
Expected: install tests PASS.

**Step 5: Commit**

```bash
git add cli/src/commands/integrations.ts cli/src/commands/integrations.test.ts
git commit -m "feat(cli): implement integrations install command"
```

---

## Task 6: `@studio-foundation/cli` — `integrations list`

**Files:**
- Modify: `cli/src/commands/integrations.ts`
- Modify: `cli/src/commands/integrations.test.ts`

**Step 1: Write failing tests for `list`**

Add to `integrations.test.ts`:

```typescript
import { getIntegrationStatus } from './integrations.js';

describe('getIntegrationStatus', () => {
  it('returns configured=true when all required vars are set in config', () => {
    const plugin: IntegrationPluginDef = {
      name: 'linear',
      version: 1,
      config: { required: ['LINEAR_API_KEY', 'LINEAR_WEBHOOK_SECRET'] },
    };
    const config = {
      LINEAR_API_KEY: 'abc',
      LINEAR_WEBHOOK_SECRET: 'secret',
    };
    expect(getIntegrationStatus(plugin, config)).toBe('configured');
  });

  it('returns not-configured when a required var is missing', () => {
    const plugin: IntegrationPluginDef = {
      name: 'linear',
      version: 1,
      config: { required: ['LINEAR_API_KEY', 'LINEAR_WEBHOOK_SECRET'] },
    };
    const config = { LINEAR_API_KEY: 'abc' }; // missing WEBHOOK_SECRET
    expect(getIntegrationStatus(plugin, config)).toBe('not-configured');
  });

  it('returns configured when plugin has no required vars', () => {
    const plugin: IntegrationPluginDef = { name: 'webhook', version: 1 };
    expect(getIntegrationStatus(plugin, {})).toBe('configured');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter @studio-foundation/cli test
```
Expected: FAIL — `getIntegrationStatus` not exported.

**Step 3: Implement `getIntegrationStatus` and `list` case**

```typescript
export function getIntegrationStatus(
  plugin: IntegrationPluginDef,
  config: Record<string, unknown>
): 'configured' | 'not-configured' {
  const required = plugin.config?.required ?? [];
  const allSet = required.every(key => key in config && config[key] !== '');
  return allSet ? 'configured' : 'not-configured';
}
```

In the `switch` block, implement `list`:

```typescript
case 'list': {
  const studioDir = await resolveStudioDir();
  const intDir = getIntegrationsDir(studioDir);
  const plugins = await loadProjectIntegrations(intDir);

  if (plugins.length === 0) {
    console.log(chalk.yellow('\nNo integrations installed.'));
    console.log(`  Run: ${chalk.cyan('studio integrations install @studio/integration-<name>')}\n`);
    break;
  }

  const config = await loadRawIntegrationsConfig(studioDir);
  console.log('');
  for (const plugin of plugins) {
    const pluginConfig = (config[plugin.name] ?? {}) as Record<string, unknown>;
    const status = getIntegrationStatus(plugin, pluginConfig);
    const dot = status === 'configured' ? chalk.green('●') : chalk.gray('○');
    const statusLabel = status === 'configured'
      ? chalk.green('configured')
      : chalk.gray('not configured');
    const extras = formatExtras(plugin, pluginConfig);
    const version = `v${plugin.version}`;
    console.log(`${plugin.name.padEnd(12)} ${dot} ${statusLabel.padEnd(20)} ${extras.padEnd(20)} ${chalk.gray(version)}`);
  }
  console.log('');
  break;
}
```

Also add the config reader helper:

```typescript
async function loadRawIntegrationsConfig(studioDir: string): Promise<Record<string, Record<string, unknown>>> {
  const configFile = join(studioDir, 'config.yaml');
  try {
    const raw = await readFile(configFile, 'utf-8');
    const { resolveEnvVars } = await import('../config.js');
    const parsed = (await import('js-yaml')).default.load(resolveEnvVars(raw)) as Record<string, unknown>;
    return (parsed?.['integrations'] ?? {}) as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
}

function formatExtras(plugin: IntegrationPluginDef, config: Record<string, unknown>): string {
  if (plugin.name === 'linear') {
    const autoTrigger = config['autoTrigger'] ?? plugin.config?.optional?.['autoTrigger'] ?? false;
    return `auto-trigger: ${autoTrigger ? 'on' : 'off'}`;
  }
  if (plugin.name === 'slack') {
    const channel = config['channel'] ?? plugin.config?.optional?.['channel'] ?? '';
    return channel ? `channel: ${channel}` : '';
  }
  return '';
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/cli test
```
Expected: all tests PASS.

**Step 5: Commit**

```bash
git add cli/src/commands/integrations.ts cli/src/commands/integrations.test.ts
git commit -m "feat(cli): implement integrations list command"
```

---

## Task 7: `@studio-foundation/cli` — `integrations remove` + `set`

**Files:**
- Modify: `cli/src/commands/integrations.ts`
- Modify: `cli/src/commands/integrations.test.ts`

**Step 1: Write failing tests for `remove` and `set`**

Add to `integrations.test.ts`:

```typescript
import { unlink } from 'node:fs/promises';

describe('remove', () => {
  it('removes an installed integration file', async () => {
    await installIntegration('@studio/integration-linear', integrationsDir);
    const destPath = join(integrationsDir, 'linear.integration.yaml');
    await expect(access(destPath)).resolves.toBeUndefined();

    await removeIntegration('linear', integrationsDir);
    await expect(access(destPath)).rejects.toThrow();
  });

  it('throws if integration is not installed', async () => {
    await expect(
      removeIntegration('doesnotexist', integrationsDir)
    ).rejects.toThrow("Integration 'doesnotexist' not found");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter @studio-foundation/cli test
```
Expected: FAIL — `removeIntegration` not exported.

**Step 3: Implement `removeIntegration`, the `remove` case, and the `set` case**

```typescript
export async function removeIntegration(name: string, integrationsDir: string): Promise<void> {
  const filePath = join(integrationsDir, `${name}.integration.yaml`);
  try {
    await unlink(filePath);
  } catch {
    throw new Error(`Integration '${name}' not found`);
  }
}
```

In the `switch` block, implement `remove`:

```typescript
case 'remove': {
  const name = args[0];
  if (!name) {
    console.error('Usage: studio integrations remove <name>');
    process.exit(1);
  }
  const studioDir = await resolveStudioDir();
  await removeIntegration(name, getIntegrationsDir(studioDir));
  console.log(chalk.green(`✓ Integration '${name}' removed`));
  break;
}
```

Implement `set` (write to `config.yaml` under `integrations.<name>.<key>`):

```typescript
case 'set': {
  // Usage: studio integrations set linear.autoTrigger true
  const dotPath = args[0];
  const value = args[1];
  if (!dotPath || value === undefined) {
    console.error('Usage: studio integrations set <name>.<key> <value>');
    process.exit(1);
  }
  const dotIndex = dotPath.indexOf('.');
  if (dotIndex === -1) {
    console.error('Error: path must be <integration-name>.<key> (e.g. linear.autoTrigger)');
    process.exit(1);
  }
  const integrationName = dotPath.slice(0, dotIndex);
  const key = dotPath.slice(dotIndex + 1);

  const studioDir = await resolveStudioDir();
  const intDir = getIntegrationsDir(studioDir);

  // Verify the integration is installed
  const pluginPath = join(intDir, `${integrationName}.integration.yaml`);
  const isInstalled = await access(pluginPath).then(() => true).catch(() => false);
  if (!isInstalled) {
    console.error(
      `Error: Integration '${integrationName}' not installed. ` +
      `Run: studio integrations install @studio/integration-${integrationName}`
    );
    process.exit(1);
  }

  // Read + update config.yaml
  const configFile = join(studioDir, 'config.yaml');
  const { setConfigValue } = await import('./config.js');
  const rawConfig = await loadRawFullConfig(configFile);
  setConfigValue(rawConfig, `integrations.${integrationName}.${key}`, value);
  await saveConfig(configFile, rawConfig);

  console.log(chalk.green(`✓ Set integrations.${integrationName}.${key} = ${value}`));
  break;
}
```

Add config helpers (reuse patterns from `commands/config.ts`):

```typescript
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

async function loadRawFullConfig(configFile: string): Promise<Record<string, unknown>> {
  const { resolveEnvVars } = await import('../config.js');
  try {
    const raw = await readFile(configFile, 'utf-8');
    const parsed = (await import('js-yaml')).default.load(resolveEnvVars(raw));
    return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function saveConfig(configFile: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true });
  const jsyaml = await import('js-yaml');
  await writeFile(configFile, jsyaml.default.dump(config), 'utf-8');
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/cli test
```
Expected: all tests PASS.

**Step 5: Commit**

```bash
git add cli/src/commands/integrations.ts cli/src/commands/integrations.test.ts
git commit -m "feat(cli): implement integrations remove and set commands"
```

---

## Task 8: `@studio-foundation/cli` — `integrations test`

**Files:**
- Modify: `cli/src/commands/integrations.ts`
- Modify: `cli/src/commands/integrations.test.ts`

**Step 1: Write failing tests for `test`**

Add to `integrations.test.ts`:

```typescript
import { runIntegrationTest } from './integrations.js';
import type { IntegrationPluginDef } from '@studio-foundation/contracts';

describe('runIntegrationTest', () => {
  it('resolves ${VAR} placeholders in endpoint and auth before making the request', async () => {
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    const mockFetch = async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response('{"data":{"viewer":{"id":"1","name":"Test"}}}', { status: 200 });
    };

    const plugin: IntegrationPluginDef = {
      name: 'linear',
      version: 1,
      test: {
        type: 'http',
        endpoint: 'https://api.linear.app/graphql',
        method: 'POST',
        auth: 'bearer:${LINEAR_API_KEY}',
        body: '{"query":"{ viewer { id name } }"}',
        expect: { status: 200 },
      },
    };
    const config = { LINEAR_API_KEY: 'my-api-key' };

    const result = await runIntegrationTest(plugin, config, mockFetch as typeof fetch);
    expect(result.success).toBe(true);
    expect(fetchCalls[0]!.url).toBe('https://api.linear.app/graphql');
    expect((fetchCalls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer my-api-key');
  });

  it('returns success=false when HTTP status does not match expect.status', async () => {
    const mockFetch = async () => new Response('Unauthorized', { status: 401 });
    const plugin: IntegrationPluginDef = {
      name: 'linear',
      version: 1,
      test: {
        type: 'http',
        endpoint: 'https://api.linear.app/graphql',
        method: 'POST',
        auth: 'bearer:my-key',
        body: '{"query":"{ viewer { id } }"}',
        expect: { status: 200 },
      },
    };
    const result = await runIntegrationTest(plugin, {}, mockFetch as typeof fetch);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it('throws when plugin has no test: block', async () => {
    const plugin: IntegrationPluginDef = { name: 'webhook', version: 1 };
    await expect(runIntegrationTest(plugin, {}, fetch)).rejects.toThrow(
      "Integration 'webhook' has no test: configuration"
    );
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter @studio-foundation/cli test
```
Expected: FAIL — `runIntegrationTest` not exported.

**Step 3: Implement `runIntegrationTest` and the `test` case**

```typescript
export interface IntegrationTestResult {
  success: boolean;
  statusCode?: number;
  body?: string;
  error?: string;
}

export async function runIntegrationTest(
  plugin: IntegrationPluginDef,
  config: Record<string, unknown>,
  fetcher: typeof fetch = fetch
): Promise<IntegrationTestResult> {
  const testDef = plugin.test;
  if (!testDef) {
    throw new Error(`Integration '${plugin.name}' has no test: configuration`);
  }

  // Resolve ${VAR} in auth using the config
  const resolveVar = (str: string) =>
    str.replace(/\$\{([^}]+)\}/g, (_, key: string) => String(config[key.trim()] ?? ''));

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (testDef.auth) {
    const resolvedAuth = resolveVar(testDef.auth);
    const colonIdx = resolvedAuth.indexOf(':');
    if (colonIdx !== -1) {
      const scheme = resolvedAuth.slice(0, colonIdx);
      const token = resolvedAuth.slice(colonIdx + 1);
      headers['Authorization'] = `${scheme.charAt(0).toUpperCase()}${scheme.slice(1)} ${token}`;
    }
  }

  try {
    const response = await fetcher(testDef.endpoint, {
      method: testDef.method ?? 'GET',
      headers,
      ...(testDef.body ? { body: testDef.body } : {}),
    });

    const body = await response.text().catch(() => '');
    const expectedStatus = testDef.expect?.status ?? 200;

    if (response.status !== expectedStatus) {
      return { success: false, statusCode: response.status, body };
    }
    return { success: true, statusCode: response.status, body };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

In the `switch` block, implement `test`:

```typescript
case 'test': {
  const name = args[0];
  if (!name) {
    console.error('Usage: studio integrations test <name>');
    process.exit(1);
  }
  const studioDir = await resolveStudioDir();
  const intDir = getIntegrationsDir(studioDir);
  const plugins = await loadProjectIntegrations(intDir);
  const plugin = plugins.find(p => p.name === name);

  if (!plugin) {
    console.error(
      `Error: '${name}' not installed. Run: studio integrations install @studio/integration-${name}`
    );
    process.exit(1);
  }

  if (!plugin.test) {
    console.error(`Error: Integration '${name}' has no test: configuration in its .integration.yaml`);
    process.exit(1);
  }

  // Check required vars
  const intConfig = await loadRawIntegrationsConfig(studioDir);
  const pluginConfig = intConfig[name] ?? {};
  const required = plugin.config?.required ?? [];
  const missing = required.filter(key => !pluginConfig[key] && !process.env[key]);
  if (missing.length > 0) {
    for (const key of missing) {
      console.error(
        `Error: ${key} not set. Run: studio integrations set ${name}.${key} <value>`
      );
    }
    process.exit(1);
  }

  const spinner = ora(`Testing ${name} connection...`).start();
  const result = await runIntegrationTest(plugin, pluginConfig as Record<string, unknown>);

  if (result.success) {
    spinner.succeed(chalk.green(`✓ ${name} connected`));
  } else {
    const detail = result.error ?? `HTTP ${result.statusCode}`;
    spinner.fail(chalk.red(`✗ ${name} error — ${detail}`));
    process.exit(1);
  }
  break;
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio-foundation/cli test
```
Expected: all tests PASS.

**Step 5: Commit**

```bash
git add cli/src/commands/integrations.ts cli/src/commands/integrations.test.ts
git commit -m "feat(cli): implement integrations test command with HTTP test runner"
```

---

## Task 9: Final build + end-to-end verification

**Step 1: Full monorepo build**

```bash
pnpm build
```
Expected: all 7 packages build with zero errors.

**Step 2: Smoke test the CLI**

```bash
# From a directory with .studio/ initialized
node cli/dist/index.js integrations list
# Expected: "No integrations installed."

node cli/dist/index.js integrations install @studio/integration-linear
# Expected: ✓ Integration 'linear' installed

node cli/dist/index.js integrations list
# Expected: linear  ○ not configured   auto-trigger: off   v1

node cli/dist/index.js integrations set linear.autoTrigger true
# Expected: ✓ Set integrations.linear.autoTrigger = true

node cli/dist/index.js integrations remove linear
# Expected: ✓ Integration 'linear' removed
```

**Step 3: Run all tests**

```bash
pnpm test
```
Expected: all tests pass across all packages.

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(stu-184): integration plugin system — .integration.yaml format, CLI commands, bundled templates"
```

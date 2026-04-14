# STU-39: `studio init` Phase 2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ajouter exists detection, `--force` avec backup, et direct mode (CI/CD-friendly) à `studio init`.

**Architecture:** `initCommand` orchestre 3 chemins : (1) exists sans force → message friendly + exit, (2) force → backup + continue, (3) wizard ou direct mode selon les flags. On extrait `backupStudioDir` et `directInit` comme fonctions exportées testables.

**Tech Stack:** TypeScript, `@inquirer/prompts` (confirm), `node:fs/promises` (rename), Commander.js

---

## Contexte

Phase 1 (STU-38) est complète. Les fonctions clés :
- `createStudioStructure(cwd, projectName?, templateName?)` — crée `.studio/`, throw si déjà initialisé
- `writeProviderToConfig(studioDir, provider, apiKey)` — écrit config.yaml
- `validateApiKeyFormat(provider, key)` — validation format clé API
- `initCommand(_options)` — wizard interactif (8 étapes)

Fichiers à modifier :
- `cli/src/index.ts:62-67` — définition commande init
- `cli/src/commands/init.ts` — toute la logique
- `cli/tests/commands/init.test.ts` — tests existants + nouveaux

---

## Task 1: Update CLI interface (index.ts)

**Files:**
- Modify: `cli/src/index.ts:62-67`

Pas de tests pour cette task (c'est juste de la config Commander).

**Step 1: Update the `init` command definition**

Remplacer le bloc `init` dans `cli/src/index.ts` :

```typescript
program
  .command('init [name]')
  .description('Initialize a new Studio project in the current directory')
  .option('--template <name>', 'Project template to use (e.g. software)')
  .option('--project <name>', 'Project name (defaults to directory name or "default")')
  .option('--provider <name>', 'LLM provider (anthropic, openai) — enables direct mode')
  .option('--api-key <key>', 'API key for the provider')
  .option('--force', 'Backup existing .studio/ and reinitialize')
  .option('--yes', 'Skip confirmation prompts (for CI/CD)')
  .action(initCommand);
```

**Step 2: Commit**

```bash
git add cli/src/index.ts
git commit -m "feat(cli): STU-39 — add --force, --api-key, --provider, --yes, [name] to init command"
```

---

## Task 2: `backupStudioDir` function (TDD)

**Files:**
- Modify: `cli/src/commands/init.ts` (add `backupStudioDir`, import `rename`)
- Modify: `cli/tests/commands/init.test.ts` (new test suite)

### Step 1: Write failing tests

Ajouter à `cli/tests/commands/init.test.ts` après les suites existantes :

```typescript
describe('backupStudioDir', () => {
  it('moves .studio/ to a backup directory', async () => {
    const { createStudioStructure, backupStudioDir } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const backupPath = await backupStudioDir(TMP);

    // Original .studio/ is gone
    expect(await exists(resolve(TMP, '.studio'))).toBe(false);
    // Backup dir exists
    expect(await exists(backupPath)).toBe(true);
  });

  it('backup directory name starts with .studio.backup-', async () => {
    const { createStudioStructure, backupStudioDir } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const backupPath = await backupStudioDir(TMP);
    const backupName = backupPath.split('/').at(-1)!;

    expect(backupName).toMatch(/^\.studio\.backup-\d{4}-\d{2}-\d{2}-\d{2}h\d{2}m\d{2}s$/);
  });

  it('backup preserves files from original .studio/', async () => {
    const { createStudioStructure, backupStudioDir } = await import('../../src/commands/init.js');
    await createStudioStructure(TMP);

    const backupPath = await backupStudioDir(TMP);

    expect(await exists(resolve(backupPath, 'config.yaml'))).toBe(true);
    expect(await exists(resolve(backupPath, 'registry.lock.json'))).toBe(true);
  });

  it('throws if .studio/ does not exist', async () => {
    const { backupStudioDir } = await import('../../src/commands/init.js');
    await expect(backupStudioDir(TMP)).rejects.toThrow();
  });
});
```

### Step 2: Run tests to verify they fail

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio-foundation/cli test
```

Attendu : 4 failures (`backupStudioDir is not a function` ou similaire).

### Step 3: Implement `backupStudioDir`

Ajouter dans `cli/src/commands/init.ts`, après les imports existants :

```typescript
import { mkdir, writeFile, readFile, access, cp, rename } from 'node:fs/promises';
```

Ajouter la fonction (après les constantes en haut du fichier, avant `createStudioStructure`) :

```typescript
function formatBackupTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}s`
  );
}

/**
 * Rename .studio/ to .studio.backup-<timestamp>/ in `cwd`.
 * Returns the absolute path to the backup directory.
 */
export async function backupStudioDir(cwd: string): Promise<string> {
  const studioDir = resolve(cwd, '.studio');
  const backupDir = resolve(cwd, `.studio.backup-${formatBackupTimestamp()}`);
  await rename(studioDir, backupDir);
  return backupDir;
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter @studio-foundation/cli test
```

Attendu : 4 new tests PASS, tous les anciens tests toujours PASS.

### Step 5: Commit

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "feat(cli): STU-39 — backupStudioDir with timestamp format"
```

---

## Task 3: `directInit` function (TDD)

**Files:**
- Modify: `cli/src/commands/init.ts` (export `directInit`)
- Modify: `cli/tests/commands/init.test.ts` (new test suite)

### Step 1: Write failing tests

Ajouter à `cli/tests/commands/init.test.ts` :

```typescript
describe('directInit', () => {
  it('creates structure and writes provider config', async () => {
    const { directInit } = await import('../../src/commands/init.js');
    await directInit(TMP, 'my-project', 'software', 'anthropic', 'sk-ant-test-key');

    expect(await exists(resolve(TMP, '.studio', 'projects', 'my-project', 'pipelines', 'feature-builder.pipeline.yaml'))).toBe(true);

    const raw = await readFile(resolve(TMP, '.studio', 'config.yaml'), 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.anthropic.apiKey).toBe('sk-ant-test-key');
  });

  it('skips writing config when provider is "later"', async () => {
    const { directInit } = await import('../../src/commands/init.js');
    await directInit(TMP, 'my-project', 'software', 'later', '');

    expect(await exists(resolve(TMP, '.studio'))).toBe(true);
    // Config.yaml exists (from template) but has no providers key written by directInit
    const raw = await readFile(resolve(TMP, '.studio', 'config.yaml'), 'utf-8');
    // The template config.yaml has anthropic placeholder but no actual key
    expect(raw).not.toContain('sk-ant-');
  });

  it('throws when template does not exist', async () => {
    const { directInit } = await import('../../src/commands/init.js');
    await expect(
      directInit(TMP, 'my-project', 'nonexistent', 'anthropic', 'sk-ant-key')
    ).rejects.toThrow("Template 'nonexistent' not found");
  });

  it('throws when .studio/ already exists', async () => {
    const { directInit } = await import('../../src/commands/init.js');
    await directInit(TMP, 'my-project', 'software', 'anthropic', 'sk-ant-key');
    await expect(
      directInit(TMP, 'my-project', 'software', 'anthropic', 'sk-ant-key')
    ).rejects.toThrow('already initialized');
  });

  it('works with force: backup then directInit succeeds', async () => {
    const { directInit, backupStudioDir } = await import('../../src/commands/init.js');
    // First init
    await directInit(TMP, 'my-project', 'software', 'anthropic', 'sk-ant-first');
    // Backup + reinit
    await backupStudioDir(TMP);
    await directInit(TMP, 'my-project', 'software', 'anthropic', 'sk-ant-second');

    const raw = await readFile(resolve(TMP, '.studio', 'config.yaml'), 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, { apiKey: string }>;
    expect(providers.anthropic.apiKey).toBe('sk-ant-second');
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter @studio-foundation/cli test
```

Attendu : 5 failures (`directInit is not a function`).

### Step 3: Implement `directInit`

Ajouter dans `cli/src/commands/init.ts`, après `writeProviderToConfig` et avant `validateApiKeyFormat` :

```typescript
/**
 * Direct init (non-interactive) — creates structure and writes config.
 * Used when all CLI flags are provided (CI/CD mode).
 */
export async function directInit(
  cwd: string,
  projectName: string,
  templateName: string,
  provider: string,
  apiKey: string
): Promise<void> {
  await createStudioStructure(cwd, projectName, templateName);
  if (provider !== 'later' && apiKey) {
    const studioDir = resolve(cwd, '.studio');
    await writeProviderToConfig(studioDir, provider, apiKey);
  }
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter @studio-foundation/cli test
```

Attendu : 5 new tests PASS, tous les anciens toujours PASS.

### Step 5: Commit

```bash
git add cli/src/commands/init.ts cli/tests/commands/init.test.ts
git commit -m "feat(cli): STU-39 — directInit function for non-interactive mode"
```

---

## Task 4: Update `initCommand` with exists detection, force, and direct mode

**Files:**
- Modify: `cli/src/commands/init.ts` (update InitOptions, initCommand)

Pas de nouveaux tests unitaires ici — le comportement de `initCommand` est testé via les sous-fonctions. Les tests de la Task 3 couvrent le cas `backupStudioDir + directInit` (le cas force).

### Step 1: Update imports and InitOptions

Dans `cli/src/commands/init.ts`, mettre à jour l'import de `@inquirer/prompts` :

```typescript
import { input, select, password, confirm } from '@inquirer/prompts';
```

Remplacer `interface InitOptions` :

```typescript
interface InitOptions {
  template?: string;
  project?: string;
  provider?: string;
  apiKey?: string;
  force?: boolean;
  yes?: boolean;
}
```

### Step 2: Update `initCommand` signature

Remplacer la signature :

```typescript
export async function initCommand(_options: InitOptions = {}): Promise<void> {
```

Par :

```typescript
export async function initCommand(nameArg?: string, options: InitOptions = {}): Promise<void> {
```

### Step 3: Rewrite `initCommand` body

Remplacer tout le corps de `initCommand` par :

```typescript
  try {
    const cwd = process.cwd();

    // ── Exists detection ──────────────────────────────────────────────
    const existing = await findStudioDir(cwd);

    if (existing && !options.force) {
      console.error(chalk.red('  ✗ Studio is already initialized in this directory.'));
      console.log('');
      console.log('To reconfigure:');
      console.log(`  ${chalk.cyan('studio config add-provider')}     # Add/update LLM provider`);
      console.log(`  ${chalk.cyan('studio tools add')}               # Install additional tools`);
      console.log(`  ${chalk.cyan('studio project add')}             # Create new project`);
      console.log('');
      console.log('To start fresh:');
      console.log(`  ${chalk.cyan('studio init --force')}            # ⚠ Backs up existing config`);
      process.exit(1);
    }

    // ── Force: backup existing .studio/ ──────────────────────────────
    if (existing && options.force) {
      if (!options.yes) {
        const confirmed = await confirm({
          message: '⚠ This will backup your existing .studio/ directory. Continue?',
          default: false,
        });
        if (!confirmed) {
          console.log('Aborted.');
          process.exit(0);
        }
      }
      const backupPath = await backupStudioDir(cwd);
      const backupName = backupPath.split('/').at(-1)!;
      console.log('');
      console.log(chalk.green(`  ✓ Backed up to ${backupName}/`));
      console.log('');
    }

    // ── Direct mode (all flags provided) vs Wizard ────────────────────
    const isDirectMode = !!(options.template && options.provider);

    if (isDirectMode) {
      // Validate required flags
      if (options.provider !== 'later' && !options.apiKey) {
        console.error('Error: --api-key is required when --provider is not "later"');
        process.exit(1);
      }
      if (options.provider !== 'later' && options.apiKey) {
        const validation = validateApiKeyFormat(options.provider!, options.apiKey);
        if (validation !== true) {
          console.error(`Error: ${validation}`);
          process.exit(1);
        }
      }

      const projectName = nameArg ?? options.project ?? basename(cwd);
      const spinner = ora('Creating project...').start();

      try {
        await directInit(cwd, projectName, options.template!, options.provider!, options.apiKey ?? '');
        spinner.stop();
      } catch (err) {
        spinner.fail('Failed');
        throw err;
      }

      console.log(chalk.green(`  ✓ .studio/config.yaml`));
      console.log(chalk.green(`  ✓ .studio/projects/${projectName}/`));
      console.log(chalk.green(`  ✓ Applied template: ${options.template}`));
      console.log(chalk.green(`  ✓ Updated .gitignore`));
      console.log('');

      const templates = await listTemplates();
      const selectedTemplate = templates.find((t) => t.name === options.template);
      const firstPipeline = selectedTemplate?.pipelines?.[0] ?? 'your-pipeline';

      console.log(chalk.bold('Done! Run your first pipeline:'));
      console.log(`  ${chalk.cyan(`studio run ${projectName}/${firstPipeline} --input "..."`)}`);
      if (options.provider === 'later') {
        console.log('');
        console.log('Set your API key first:');
        console.log(
          `  ${chalk.cyan('studio config set provider anthropic --api-key $ANTHROPIC_API_KEY')}`
        );
      }
      console.log('');
      return;
    }

    // ── Wizard mode ───────────────────────────────────────────────────
    console.log('');
    console.log(chalk.bold('  ╭─────────────────────────────────╮'));
    console.log(chalk.bold('  │  Studio — Pipeline Creator      │'));
    console.log(chalk.bold('  ╰─────────────────────────────────╯'));
    console.log('');

    // Step 1: Project name
    const defaultName = nameArg ?? options.project ?? basename(cwd);
    const rawName = await input({
      message: 'Project name:',
      default: defaultName,
    });
    const projectName = rawName.trim() || defaultName;

    // Step 2: Description (optional, not persisted)
    await input({
      message: 'Description (optional, press Enter to skip):',
    });

    // Step 3: Template
    const templates = await listTemplates();
    const templateChoices = templates.map((t) => ({
      value: t.name,
      name: `${t.name} — ${t.description}`,
    }));

    const templateName = await select({
      message: 'Choose a starter template:',
      choices: templateChoices,
    });

    // Step 4: Provider
    const provider = await select<string>({
      message: 'LLM Provider:',
      choices: [
        { value: 'anthropic', name: 'Anthropic (Claude)' },
        { value: 'openai', name: 'OpenAI (GPT)' },
        { value: 'later', name: 'Configure later' },
      ],
    });

    // Step 5: API Key
    let apiKey: string | undefined;
    if (provider !== 'later') {
      const providerLabel = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
      apiKey = await password({
        message: `${providerLabel} API Key:`,
        validate: (value: string) => validateApiKeyFormat(provider, value),
      });
    }

    // Step 6: Create structure
    console.log('');
    const spinner = ora('Creating project...').start();

    const studioDir = resolve(cwd, '.studio');

    try {
      await createStudioStructure(cwd, projectName, templateName);

      if (provider !== 'later' && apiKey) {
        await writeProviderToConfig(studioDir, provider, apiKey);
      }

      spinner.stop();
    } catch (err) {
      spinner.fail('Failed');
      throw err;
    }

    // Step 7: Success output
    console.log(chalk.green(`  ✓ .studio/config.yaml`));
    console.log(chalk.green(`  ✓ .studio/projects/${projectName}/`));
    console.log(chalk.green(`  ✓ Copied template files`));
    console.log(chalk.green(`  ✓ Updated .gitignore`));
    console.log('');

    // Step 8: Next steps
    const selectedTemplate = templates.find((t) => t.name === templateName);
    const firstPipeline = selectedTemplate?.pipelines?.[0] ?? 'your-pipeline';

    console.log(chalk.bold('Done! Run your first pipeline:'));
    console.log(
      `  ${chalk.cyan(`studio run ${projectName}/${firstPipeline} --input "..."`)}`
    );
    if (provider === 'later') {
      console.log('');
      console.log('Set your API key first:');
      console.log(
        `  ${chalk.cyan('studio config set provider anthropic --api-key $ANTHROPIC_API_KEY')}`
      );
    }
    console.log('');
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      console.log('\nAborted.');
      process.exit(0);
    }
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
```

### Step 4: Build to check types

```bash
pnpm build
```

Attendu : Build réussit sans erreurs TypeScript.

### Step 5: Run all tests

```bash
pnpm --filter @studio-foundation/cli test
```

Attendu : tous les tests passent (anciens + nouveaux).

### Step 6: Commit

```bash
git add cli/src/commands/init.ts
git commit -m "feat(cli): STU-39 — exists detection, --force backup, direct mode in initCommand"
```

---

## Task 5: Full build + test verification

**Step 1: Build from root**

```bash
pnpm build
```

Attendu : `Build complete.` sans erreurs.

**Step 2: Run all tests from root**

```bash
pnpm test
```

Attendu : tous les tests passent dans tous les packages.

**Step 3: Manual smoke test (direct mode)**

```bash
cd /tmp
mkdir studio-test-direct && cd studio-test-direct
node /home/arianeguay/dev/src/Studio/cli/dist/index.js init my-project \
  --template software \
  --provider anthropic \
  --api-key sk-ant-fake-key-for-smoke-test
```

Attendu :
```
  ✓ .studio/config.yaml
  ✓ .studio/projects/my-project/
  ✓ Applied template: software
  ✓ Updated .gitignore

Done! Run your first pipeline:
  studio run my-project/feature-builder --input "..."
```

**Step 4: Manual smoke test (exists detection)**

```bash
node /home/arianeguay/dev/src/Studio/cli/dist/index.js init
```

Attendu :
```
  ✗ Studio is already initialized in this directory.

To reconfigure:
  studio config add-provider
  ...

To start fresh:
  studio init --force
```

**Step 5: Manual smoke test (--force --yes)**

```bash
node /home/arianeguay/dev/src/Studio/cli/dist/index.js init my-project \
  --template software \
  --provider anthropic \
  --api-key sk-ant-fake-key-for-smoke-test \
  --force --yes
```

Attendu :
```
  ✓ Backed up to .studio.backup-2026-02-18-XXhXXmXXs/

  ✓ .studio/config.yaml
  ✓ .studio/projects/my-project/
  ...
```

**Step 6: Cleanup smoke test**

```bash
rm -rf /tmp/studio-test-direct
```

---

## Task 6: PR

**Step 1: Push branch and create PR**

```bash
git push -u origin HEAD
gh pr create \
  --title "feat(cli): STU-39 — studio init phase 2 (direct mode, --force, exists detection)" \
  --body "$(cat <<'EOF'
## Summary

- **Exists detection**: `studio init` affiche un message friendly avec alternatives si `.studio/` existe déjà
- **`--force` flag**: backup `.studio/` vers `.studio.backup-<timestamp>/` avant réinitialisation, avec confirmation (bypassable via `--yes`)
- **Direct mode**: `studio init [name] --template <t> --provider <p> --api-key <k>` crée sans wizard — pour CI/CD

## Packages touchés

- `@studio-foundation/cli` — `init.ts`, `index.ts`, `init.test.ts`

## Comment tester

```bash
cd /tmp && mkdir test-init && cd test-init

# Direct mode
studio init my-project --template software --provider anthropic --api-key sk-ant-xxx

# Exists detection
studio init  # → message friendly

# Force + direct
studio init my-project --template software --provider anthropic --api-key sk-ant-yyy --force --yes
```

## Tests

```bash
pnpm --filter @studio-foundation/cli test
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" \
  --base main
```

---

## Acceptance Criteria Checklist

### Mode direct
- [ ] `studio init <name> --template <t> --provider <p> --api-key <k>` fonctionne
- [ ] Validation API key même en mode direct
- [ ] Pas de questions interactives si tous les args fournis
- [ ] Erreur claire si `--api-key` manquant avec `--provider`

### Détection exists
- [ ] Si `.studio/` existe → message friendly (pas de wizard)
- [ ] Message liste les commandes alternatives
- [ ] Suggestion `--force` pour restart

### Force flag
- [ ] `--force` demande confirmation
- [ ] `--force --yes` skip confirmation
- [ ] Backup créé dans `.studio.backup-<timestamp>/`
- [ ] Backup inclut tout le contenu original
- [ ] Après backup, wizard OU direct mode selon flags
- [ ] Message affiche backup location

### Tests
- [ ] `backupStudioDir` — 4 tests
- [ ] `directInit` — 5 tests
- [ ] Tests STU-38 toujours verts

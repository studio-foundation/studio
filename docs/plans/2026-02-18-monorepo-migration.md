# Monorepo Migration Implementation Plan (STU-36)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fusionner les 5 sub-repos git imbriqués (contracts, ralph, runner, engine, cli) en un seul monorepo pnpm workspaces, puis créer le repo `code-builder` séparé avec les configs de test.

**Architecture:** Migration en 3 phases — (1) git subtree add --squash pour chaque sub-repo, (2) setup pnpm workspaces + mise à jour des deps internes, (3) création du repo code-builder avec migration des configs.

**Tech Stack:** git subtree, pnpm workspaces, Node.js 22, TypeScript

---

## Contexte critique

- Studio root : `/home/arianeguay/dev/src/Studio`
- Sub-repos imbriqués : `contracts/`, `ralph/`, `runner/`, `engine/`, `cli/` — chacun a son propre `.git/`
- `.gitignore` root ignore explicitement ces 5 répertoires
- Deps internes actuelles : `file:../contracts` etc. (npm)
- `pnpm` pas encore installé (npm@10.9.4, node@22.22.0)
- Configs de test à migrer : `engine/configs/software/`, `engine/configs/cuisine/`
- Target code-builder : `/home/arianeguay/dev/src/code-builder`

---

## Task 1: Préparer le backup et mettre à jour .gitignore

**Files:**
- Modify: `.gitignore`

**Step 1: Créer le répertoire de backup**

```bash
mkdir -p /tmp/studio-migration
```

**Step 2: Copier les 5 sub-repos dans le backup (inclut leur .git/)**

```bash
cp -r /home/arianeguay/dev/src/Studio/contracts /tmp/studio-migration/contracts
cp -r /home/arianeguay/dev/src/Studio/ralph /tmp/studio-migration/ralph
cp -r /home/arianeguay/dev/src/Studio/runner /tmp/studio-migration/runner
cp -r /home/arianeguay/dev/src/Studio/engine /tmp/studio-migration/engine
cp -r /home/arianeguay/dev/src/Studio/cli /tmp/studio-migration/cli
```

Vérifier que chaque backup a bien un `.git/` :
```bash
ls /tmp/studio-migration/contracts/.git /tmp/studio-migration/ralph/.git
```
Expected: Les répertoires existent.

**Step 3: Retirer les 5 entrées du .gitignore**

Dans `.gitignore`, supprimer ces lignes :
```
# Sub-repos (each has own git)
/contracts/
/ralph/
/runner/
/engine/
/cli/
```

**Step 4: Commit la mise à jour du .gitignore**

```bash
cd /home/arianeguay/dev/src/Studio
git add .gitignore
git commit -m "chore: remove sub-repo gitignore entries for monorepo migration"
```

---

## Task 2: git subtree add — contracts

**Files:** Ajoute `contracts/` au root repo via git subtree.

**Step 1: Supprimer le répertoire original (physiquement)**

```bash
rm -rf /home/arianeguay/dev/src/Studio/contracts
```

**Step 2: git subtree add depuis le backup**

```bash
cd /home/arianeguay/dev/src/Studio
git subtree add --prefix=contracts /tmp/studio-migration/contracts HEAD --squash
```

Expected output :
```
git fetch /tmp/studio-migration/contracts HEAD
...
Added dir 'contracts'
```

**Step 3: Vérifier**

```bash
ls /home/arianeguay/dev/src/Studio/contracts/src
git log --oneline -3
```

Expected: Le répertoire `contracts/src/` existe, le log montre 2 nouveaux commits ("Squashed 'contracts/' content..." et "Merge commit...").

---

## Task 3: git subtree add — ralph

**Step 1: Supprimer le répertoire original**

```bash
rm -rf /home/arianeguay/dev/src/Studio/ralph
```

**Step 2: git subtree add**

```bash
cd /home/arianeguay/dev/src/Studio
git subtree add --prefix=ralph /tmp/studio-migration/ralph HEAD --squash
```

**Step 3: Vérifier**

```bash
ls /home/arianeguay/dev/src/Studio/ralph/src
git log --oneline -3
```

---

## Task 4: git subtree add — runner

**Step 1: Supprimer le répertoire original**

```bash
rm -rf /home/arianeguay/dev/src/Studio/runner
```

**Step 2: git subtree add**

```bash
cd /home/arianeguay/dev/src/Studio
git subtree add --prefix=runner /tmp/studio-migration/runner HEAD --squash
```

**Step 3: Vérifier**

```bash
ls /home/arianeguay/dev/src/Studio/runner/src
git log --oneline -3
```

---

## Task 5: git subtree add — engine

**Step 1: Supprimer le répertoire original**

```bash
rm -rf /home/arianeguay/dev/src/Studio/engine
```

**Step 2: git subtree add**

```bash
cd /home/arianeguay/dev/src/Studio
git subtree add --prefix=engine /tmp/studio-migration/engine HEAD --squash
```

**Step 3: Vérifier**

```bash
ls /home/arianeguay/dev/src/Studio/engine/src
git log --oneline -3
```

---

## Task 6: git subtree add — cli

**Step 1: Supprimer le répertoire original**

```bash
rm -rf /home/arianeguay/dev/src/Studio/cli
```

**Step 2: git subtree add**

```bash
cd /home/arianeguay/dev/src/Studio
git subtree add --prefix=cli /tmp/studio-migration/cli HEAD --squash
```

**Step 3: Vérifier**

```bash
ls /home/arianeguay/dev/src/Studio/cli/src
git log --oneline -5
```

Expected: 10 commits au total pour les 5 subtree adds (2 par package).

**Step 4: Vérifier l'état global du repo**

```bash
git status
```

Expected: "nothing to commit, working tree clean"

---

## Task 7: Installer pnpm et créer pnpm-workspace.yaml

**Files:**
- Create: `pnpm-workspace.yaml`

**Step 1: Installer pnpm**

```bash
npm install -g pnpm
pnpm --version
```

Expected: Version s'affiche (ex: `9.x.x`).

**Step 2: Créer `pnpm-workspace.yaml` à la racine**

Créer `/home/arianeguay/dev/src/Studio/pnpm-workspace.yaml` :
```yaml
packages:
  - 'contracts'
  - 'ralph'
  - 'runner'
  - 'engine'
  - 'cli'
```

**Step 3: Commit**

```bash
cd /home/arianeguay/dev/src/Studio
git add pnpm-workspace.yaml
git commit -m "chore: add pnpm-workspace.yaml"
```

---

## Task 8: Mettre à jour le root package.json

**Files:**
- Modify: `package.json`

**Step 1: Remplacer le contenu de `package.json`**

```json
{
  "name": "studio-workspace",
  "version": "0.1.0",
  "private": true,
  "description": "Studio v7 — Agentic pipeline orchestrator (monorepo)",
  "scripts": {
    "build": "pnpm --filter @studio/contracts build && pnpm --filter @studio/ralph build && pnpm --filter @studio/runner build && pnpm --filter @studio/engine build && pnpm --filter @studio/cli build",
    "clean": "pnpm -r run clean",
    "test": "pnpm -r run test"
  }
}
```

**Step 2: Commit**

```bash
cd /home/arianeguay/dev/src/Studio
git add package.json
git commit -m "chore: update root package.json for pnpm workspaces"
```

---

## Task 9: Mettre à jour les dépendances internes (file:../ → workspace:*)

**Files:**
- Modify: `ralph/package.json`
- Modify: `runner/package.json`
- Modify: `engine/package.json`
- Modify: `cli/package.json`

**Step 1: Mettre à jour `ralph/package.json`**

Remplacer :
```json
"@studio/contracts": "file:../contracts"
```
Par :
```json
"@studio/contracts": "workspace:*"
```

**Step 2: Mettre à jour `runner/package.json`**

Remplacer :
```json
"@studio/contracts": "file:../contracts"
```
Par :
```json
"@studio/contracts": "workspace:*"
```

**Step 3: Mettre à jour `engine/package.json`**

Remplacer :
```json
"@studio/contracts": "file:../contracts",
"@studio/ralph": "file:../ralph",
"@studio/runner": "file:../runner"
```
Par :
```json
"@studio/contracts": "workspace:*",
"@studio/ralph": "workspace:*",
"@studio/runner": "workspace:*"
```

**Step 4: Mettre à jour `cli/package.json`**

Remplacer :
```json
"@studio/contracts": "file:../contracts",
"@studio/engine": "file:../engine",
"@studio/ralph": "file:../ralph",
"@studio/runner": "file:../runner"
```
Par :
```json
"@studio/contracts": "workspace:*",
"@studio/engine": "workspace:*",
"@studio/ralph": "workspace:*",
"@studio/runner": "workspace:*"
```

**Step 5: Commit**

```bash
cd /home/arianeguay/dev/src/Studio
git add ralph/package.json runner/package.json engine/package.json cli/package.json
git commit -m "chore: replace file:../ deps with workspace:* for pnpm"
```

---

## Task 10: Supprimer les anciens node_modules / lockfiles, lancer pnpm install et pnpm build

**Step 1: Supprimer les node_modules et lockfiles individuels**

```bash
cd /home/arianeguay/dev/src/Studio
rm -rf contracts/node_modules contracts/package-lock.json
rm -rf ralph/node_modules ralph/package-lock.json
rm -rf runner/node_modules runner/package-lock.json
rm -rf engine/node_modules engine/package-lock.json
rm -rf cli/node_modules cli/package-lock.json
rm -rf node_modules
```

**Step 2: pnpm install depuis la racine**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm install
```

Expected: Résout toutes les dépendances, crée un `pnpm-lock.yaml` à la racine, crée des symlinks dans `node_modules/.pnpm/`.

Si erreur : vérifier que chaque `package.json` a bien `"name": "@studio/<pkg>"`.

**Step 3: pnpm build**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm build
```

Expected: Build contracts → ralph → runner → engine → cli dans l'ordre, sans erreur.

Si erreur de build : c'est probablement un problème de `tsconfig.json` dans un package (les chemins peuvent référencer des paths anciens). Vérifier le `tsconfig.json` du package qui échoue.

**Step 4: Mettre à jour .gitignore pour pnpm**

Ajouter dans `.gitignore` :
```
# pnpm
pnpm-lock.yaml
```

Note : `pnpm-lock.yaml` peut être commité ou ignoré selon la préférence. Pour un outil publié sur npm, on le commite généralement.

Si on veut le commiter, ne pas l'ignorer et l'ajouter au commit suivant.

**Step 5: Commit**

```bash
cd /home/arianeguay/dev/src/Studio
git add pnpm-lock.yaml .gitignore
git commit -m "chore: add pnpm-lock.yaml, remove individual lockfiles"
```

---

## Task 11: Créer le repo code-builder

**Step 1: Créer la structure**

```bash
mkdir -p /home/arianeguay/dev/src/code-builder/.studio/projects
mkdir -p /home/arianeguay/dev/src/code-builder/src
cd /home/arianeguay/dev/src/code-builder
git init
```

**Step 2: Créer `.gitignore`**

Créer `/home/arianeguay/dev/src/code-builder/.gitignore` :
```
# Studio runtime (local only)
.studio/runs/
.studio/config.yaml

# Node
node_modules/
*.log

# Env
.env
```

**Step 3: Créer `package.json`**

```json
{
  "name": "code-builder",
  "version": "0.1.0",
  "private": true,
  "description": "Studio code-builder project — premier client de Studio",
  "dependencies": {
    "@studio/cli": "workspace:*"
  }
}
```

Note : Pour l'instant, `@studio/cli` sera référencé via un lien local (ou npm global via `npm install -g`). On peut ajuster selon comment Studio est installé.

**Step 4: Premier commit**

```bash
cd /home/arianeguay/dev/src/code-builder
git add .gitignore package.json
git commit -m "chore: init code-builder repo"
```

---

## Task 12: Migrer les configs software/ et cuisine/ vers code-builder

**Step 1: Copier les configs depuis engine/configs/**

```bash
cp -r /home/arianeguay/dev/src/Studio/engine/configs/software /home/arianeguay/dev/src/code-builder/.studio/projects/software
cp -r /home/arianeguay/dev/src/Studio/engine/configs/cuisine /home/arianeguay/dev/src/code-builder/.studio/projects/cuisine
```

**Step 2: Vérifier la structure**

```bash
ls /home/arianeguay/dev/src/code-builder/.studio/projects/software/
```

Expected: `agents/  contracts/  inputs/  pipelines/` (et `context-packs/` si présent).

**Step 3: Commit dans code-builder**

```bash
cd /home/arianeguay/dev/src/code-builder
git add .studio/projects/
git commit -m "feat: migrate software and cuisine configs from Studio engine"
```

---

## Task 13: Supprimer engine/configs/ de Studio

**Step 1: Supprimer engine/configs/**

```bash
rm -rf /home/arianeguay/dev/src/Studio/engine/configs
```

**Step 2: Vérifier que le code du engine n'a plus de référence hardcodée à ./configs**

```bash
grep -r "engine/configs\|./configs" /home/arianeguay/dev/src/Studio/engine/src/ --include="*.ts"
```

Si des références existent : le engine doit lire le path depuis la config `.studiorc.yaml` ou l'argument `--config`. Vérifier que `findStudioDir()` dans le CLI gère le fallback correctement.

**Step 3: Commit dans Studio**

```bash
cd /home/arianeguay/dev/src/Studio
git add engine/configs
git commit -m "chore: remove engine/configs (migrated to code-builder repo)"
```

---

## Task 14: Configuration .studiorc.yaml pour code-builder et vérification end-to-end

**Step 1: Créer `.studiorc.yaml` dans code-builder**

Créer `/home/arianeguay/dev/src/code-builder/.studiorc.yaml` :
```yaml
providers:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
  openai:
    apiKey: ${OPENAI_API_KEY}

paths:
  projects_dir: ./.studio/projects

defaults:
  provider: openai
  model: gpt-4o-mini
```

**Step 2: Vérifier que studio CLI est accessible**

```bash
which studio || node /home/arianeguay/dev/src/Studio/cli/dist/index.js --version
```

Si `studio` n'est pas dans le PATH : installer globalement depuis le monorepo :
```bash
cd /home/arianeguay/dev/src/Studio
pnpm build
cd cli && npm link
```

**Step 3: Lancer un run depuis code-builder**

```bash
cd /home/arianeguay/dev/src/code-builder
ANTHROPIC_API_KEY=... studio run software/feature-builder --input "Add a simple hello world function"
```

Expected: Le pipeline démarre, exécute les stages, produit un résultat.

**Step 4: Commit .studiorc.yaml dans code-builder**

```bash
cd /home/arianeguay/dev/src/code-builder
git add .studiorc.yaml
git commit -m "chore: add .studiorc.yaml for code-builder"
```

---

## Acceptance Criteria (STU-36)

- [ ] Un seul repo Git avec les 5 packages (plus de sub-repos `.git/`)
- [ ] `pnpm-workspace.yaml` configuré
- [ ] `pnpm install` à la racine fonctionne sans erreur
- [ ] `pnpm build` build tous les packages dans le bon ordre
- [ ] Imports `@studio/*` fonctionnent entre packages
- [ ] Repo `code-builder` créé à `/home/arianeguay/dev/src/code-builder`
- [ ] Configs `software/` et `cuisine/` dans `code-builder/.studio/projects/`
- [ ] `engine/configs/` supprimé de Studio
- [ ] `studio run software/feature-builder` fonctionne depuis `code-builder`

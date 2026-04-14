# Design : Migration Monorepo pnpm workspaces (STU-36)

**Date :** 2026-02-18
**Issue :** STU-36 — Fusionner 6 repos → 1 monorepo Git avec pnpm workspaces

## Contexte

Studio est actuellement splitté en 6 repos Git imbriqués :
- 1 root repo (`Studio/`) qui gitignore les 5 sub-repos
- 5 sub-repos (`contracts/`, `ralph/`, `runner/`, `engine/`, `cli/`) avec chacun leur `.git/`
- Dépendances internes via `file:../` (npm), chacun avec son propre `node_modules/` et `package-lock.json`
- `pnpm` non installé

Objectif : 2 repos finaux — `Studio` (monorepo pnpm) et `code-builder` (projet client séparé).

## Section 1 : Migration git (préservation d'historique avec --squash)

**Approche choisie :** `git subtree add --squash` pour chaque sub-repo.

Résultat : 1 squash commit + 1 merge commit par package (10 commits au total), historique complet référencé, root repo propre.

**Procédure par package** (dans l'ordre des dépendances) :

```bash
# 1. Backup du sub-repo hors du répertoire Studio
cp -r /home/arianeguay/dev/src/Studio/contracts /tmp/studio-migration/contracts
# Répéter pour ralph, runner, engine, cli

# 2. Supprimer le répertoire original (temporairement)
rm -rf /home/arianeguay/dev/src/Studio/contracts

# 3. git subtree add depuis le backup
git subtree add --prefix=contracts /tmp/studio-migration/contracts HEAD --squash
# Répéter pour chaque package dans l'ordre : contracts → ralph → runner → engine → cli
```

**Cleanup post-migration :**
- Retirer `/contracts/`, `/ralph/`, `/runner/`, `/engine/`, `/cli/` du `.gitignore`
- Supprimer les `.git/` des sub-repos (les backups dans /tmp)
- Supprimer les `node_modules/` individuels et `package-lock.json` de chaque package

## Section 2 : pnpm workspaces

**Installer pnpm :**
```bash
npm install -g pnpm
```

**Créer `pnpm-workspace.yaml`** à la racine :
```yaml
packages:
  - 'contracts'
  - 'ralph'
  - 'runner'
  - 'engine'
  - 'cli'
```

**Mettre à jour le root `package.json`** :
```json
{
  "name": "studio-workspace",
  "private": true,
  "scripts": {
    "build": "pnpm --filter @studio-foundation/contracts build && pnpm --filter @studio-foundation/ralph build && pnpm --filter @studio-foundation/runner build && pnpm --filter @studio-foundation/engine build && pnpm --filter @studio-foundation/cli build",
    "clean": "pnpm -r run clean"
  }
}
```

**Mettre à jour les dépendances internes** dans chaque `package.json` — remplacer `file:../` par `workspace:*` :

| Package | Dépendance → avant | → après |
|---------|-------------------|---------|
| ralph | `@studio-foundation/contracts: "file:../contracts"` | `"workspace:*"` |
| runner | `@studio-foundation/contracts: "file:../contracts"` | `"workspace:*"` |
| engine | `@studio-foundation/contracts`, `@studio-foundation/ralph`, `@studio-foundation/runner` | `"workspace:*"` |
| cli | `@studio-foundation/contracts`, `@studio-foundation/engine`, `@studio-foundation/ralph`, `@studio-foundation/runner` | `"workspace:*"` |

**Supprimer** tous les `node_modules/` individuels et `package-lock.json`.

**Vérification :**
```bash
pnpm install   # à la racine
pnpm build     # build tous les packages dans le bon ordre
```

## Section 3 : Repo `code-builder`

**Créer `/home/arianeguay/dev/src/code-builder/`** comme nouveau repo git :

```
code-builder/
├── .studio/
│   └── projects/
│       └── software/          ← copié depuis engine/configs/software/
│           ├── pipelines/
│           ├── agents/
│           ├── contracts/
│           ├── tools/
│           └── inputs/
├── src/                       ← code cible (vide pour l'instant)
├── .gitignore                 ← ignorer .studio/runs/, .studio/config.yaml
└── package.json               ← dépend de @studio-foundation/cli
```

**Migration :**
- `engine/configs/software/` → `code-builder/.studio/projects/software/`
- `engine/configs/cuisine/` → `code-builder/.studio/projects/cuisine/`
- Supprimer `engine/configs/` du repo Studio (ne doit contenir que du code)

**Vérification end-to-end :**
```bash
cd /home/arianeguay/dev/src/code-builder
studio run software/feature-builder --input "Add dark mode"
```

## Acceptance criteria (STU-36)

- [ ] Un seul repo Git avec les 5 packages
- [ ] pnpm workspaces configuré
- [ ] `pnpm install` à la racine fonctionne
- [ ] `pnpm build` build tous les packages dans le bon ordre
- [ ] Imports `@studio/*` fonctionnent entre packages
- [ ] Repo `code-builder` créé séparément
- [ ] Configs `software/` et `cuisine/` migrées dans `code-builder`
- [ ] `engine/configs/` supprimé de Studio
- [ ] `studio run` fonctionne depuis `code-builder`

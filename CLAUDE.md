# CLAUDE.md — Studio v7

Studio est un orchestrateur de pipelines agentiques. Il exécute des workflows multi-stages en utilisant des LLMs, avec validation stricte et retry automatique. Il est **domain-agnostic** — le engine ne sait pas ce qu'est du code, un fichier, ou du QA. Tout le domaine vient des configs YAML.

**Positionnement :** Studio est le `git` des orchestrateurs de pipelines d'agents. Un outil invisible qui vit dans `.studio/`, qu'on installe globalement et qu'on utilise au quotidien. Pas un framework, pas une plateforme — un outil de dev.

## Modèle de distribution

Studio est un **outil qu'on installe**, pas un repo qu'on fork. Comme `git`.

```bash
npm install -g @studio/cli       # Installer pour usage régulier
npx @studio/cli init             # Ou essayer sans installer

cd my-project/
studio init --template software  # Crée .studio/ (comme git init crée .git/)
studio run software/feature-builder --input "Add dark mode"
```

```
git init          →  studio init
.git/             →  .studio/
git commit        →  studio run
git push          →  (API hosted, plus tard)
GitHub            →  Studio Cloud (produit commercial)
git hooks         →  Tool plugins (.tool.yaml)
GitHub Actions    →  Community registry
```

**2 repos :**
- **Repo Studio** — le produit (publié sur npm). Contient les 5 packages + templates built-in.
- **Repos utilisateurs** — les projets qui UTILISENT Studio (ex: code-builder). Contiennent `.studio/` avec leurs configs.

## Architecture — 5 packages, 1 monorepo

```
Studio/                         # UN repo git, pnpm workspaces
├── contracts/                  # @studio/contracts — types, interfaces (ZERO dépendances)
│   └── package.json
├── ralph/                      # @studio/ralph — retry loop + validation
│   └── package.json
├── runner/                     # @studio/runner — tool plugin runtime, LLM providers
│   └── package.json
├── engine/                     # @studio/engine — pipeline orchestration, state machine
│   └── package.json
├── cli/                        # @studio/cli — interface terminal
│   └── package.json
├── templates/                  # Templates built-in (software, content, etc.)
├── package.json                # Root workspace
├── pnpm-workspace.yaml
└── CLAUDE.md
```

```
@studio/cli          → Interface terminal (studio run, studio config, etc.)
    │
@studio/engine       → Orchestration pipeline, state machine, persistence SQLite
    │
    ├── @studio/ralph    → RALPH loop : execute → validate → retry si fail
    │
    └── @studio/runner   → Tool plugin runtime, appels LLM, multi-provider
    │
@studio/contracts    → Types partagés (ZERO dépendances, ZERO logique)
```

**Dépendances strictes :** contracts est un leaf package. ralph et runner dépendent UNIQUEMENT de contracts. engine dépend de ralph + runner + contracts. cli dépend de engine + contracts.

**Jamais de dépendance inversée.** ralph ne connaît pas runner. runner ne connaît pas engine. Si tu te retrouves à importer un package "vers le haut", c'est une erreur d'architecture.

**pnpm workspaces :** Les dépendances internes utilisent `workspace:*`. Un seul `pnpm install` à la racine, un seul `pnpm build`.

## Structure `.studio/` (côté utilisateur)

Quand un utilisateur fait `studio init` dans son projet, tout vit dans `.studio/` :

```
my-project/                           # Le repo de l'utilisateur
├── .studio/                          # Tout Studio vit ici (comme .git/)
│   ├── config.yaml                   # Providers, defaults (gitignored)
│   ├── projects/
│   │   └── <project>/
│   │       ├── pipelines/            # *.pipeline.yaml
│   │       ├── agents/               # *.agent.yaml
│   │       ├── contracts/            # *.contract.yaml
│   │       ├── tools/                # *.tool.yaml (tool plugins)
│   │       └── inputs/               # *.input.yaml
│   ├── registry.lock.json            # Versions tools installés (commité)
│   └── runs/                         # Données runtime (gitignored)
│       ├── runs.db                   # SQLite
│       └── logs/                     # JSONL
├── src/                              # Le code du user
└── .gitignore
```

**Git strategy :**
- **Commité :** `.studio/projects/`, `.studio/registry.lock.json`
- **Gitignored :** `.studio/config.yaml` (API keys), `.studio/runs/`

`findStudioDir()` remonte les dossiers parents jusqu'à trouver `.studio/`, exactement comme `git` cherche `.git/`.

**Backward compat :** Si `.studio/` n'existe pas, le engine fallback sur `engine/configs/`.

## CLI vs API

Le CLI et l'API sont deux interfaces distinctes sur le même engine. Comme `git` et GitHub.

```
CLI = usage direct (humain devant un terminal)
  studio init              → crée .studio/
  studio config set        → modifie config.yaml
  studio tools add         → installe un tool
  studio run               → lance un pipeline ← USAGE QUOTIDIEN
  studio status            → check un run
  studio validate          → dry-run

API = usage programmatique (machine-to-machine)
  Linear webhook → POST /runs    → auto-trigger sans humain
  CI/CD → POST /runs             → pipeline dans GitHub Actions
  Slack bot → POST /runs         → lance depuis Slack
  Dashboard → GET /runs          → affichage web
```

`studio run` est une commande de première classe — un dev qui utilise code-builder au quotidien fait `studio run` dans son terminal. L'API c'est pour quand il n'y a pas d'humain devant le terminal.

Le CLI est gratuit forever (comme `git`). L'API hosted est le produit monétisable (comme GitHub).

## Concepts clés

**Pipeline** — Séquence de stages définie en YAML. Le engine la charge et l'exécute.

**Stage** — Une étape dans un pipeline. Chaque stage a un agent, un output contract, et des settings RALPH. Le engine ne connaît pas le "kind" du stage — c'est une string libre.

**RALPH loop** — Execute → validate contre le contract → retry avec feedback enrichi si fail → repeat jusqu'à succès ou max attempts. "Recursive Automated Loop for Persistent Handling."

**Output contract** — Schema JSON + contraintes qui définissent ce qu'un stage DOIT produire. La validation est binaire : pass ou fail.

**Anti-théâtre** — Si un contract exige `tool_calls.minimum: 1` et que l'agent a fait 0 tool calls, c'est un échec peu importe ce que l'agent prétend dans son output. Les tool calls réels sont trackés par le runner. Le contract peut aussi exiger des tools spécifiques via `tools.required: [repo_manager-write_file]` dans le stage YAML. Si le stage complète sans appeler ces tools, validation fail.

**Post-validation rejection** — Le engine peut détecter qu'un stage a répondu correctement (format OK) mais que le verdict est négatif (ex: QA qui rejette). Status = `rejected`, pas `failed`. Configuré via le contract YAML, pas hardcodé.

**Groups** — Boucles de feedback multi-stages. Un group contient plusieurs stages qui s'exécutent en itérations. Si le dernier stage du groupe rejette (via `post_validation.rejection_detection`), le group redémarre depuis le début avec le feedback accumulé. Maximum d'itérations configuré via `max_iterations`. Les stages dans un group peuvent accéder au `group_feedback` via leur context.

**Context propagation** — Chaque stage peut configurer exactement quel contexte il reçoit via `context.include: [...]`. Options disponibles : `input` (input initial du pipeline), `previous_stage_output` (output du stage précédent), `all_stage_outputs` (outputs de tous les stages précédents), `group_feedback` (feedback accumulé dans le group), `repo_files` (fichiers du repo si applicable).

**Tool plugin** — Un fichier `.tool.yaml` qui définit des commandes disponibles aux agents. Chaque plugin contient ses paramètres, sa logique d'exécution (shell ou builtin), un prompt snippet auto-injecté, et ses contraintes. Créer un tool = juste du YAML, pas de code.

## State machine

```
pending → running → success
                  → failed
                  → rejected
                  → skipped
```

`deriveStageStatus(ralphResult)` dans `engine/src/state/status-derivation.ts` est LA fonction critique. Elle mappe directement le résultat RALPH au status du stage : ralph 'success' → stage 'success', ralph 'exhausted' → stage 'failed'. Simple et déterministe.

## Règles NON-NÉGOCIABLES

1. **Le engine est domain-agnostic.** Pas de référence à "code", "file", "git", "QA" dans le engine. Tout le domaine vient des YAML.

2. **ralph ne connaît pas runner.** ralph prend un `executor: () => Promise<T>` générique. Il ne sait pas que c'est un LLM derrière.

3. **runner ne valide pas, ne retry pas.** Il exécute et retourne un AgentRun. La validation et le retry sont le job de ralph.

4. **contracts est un leaf package.** Zéro dépendance interne. Si tu ajoutes un import vers un autre package dans contracts, c'est une erreur.

5. **Les tools sont dans runner, pas dans engine.** Le engine passe les configs au runner. Le runner exécute les tools. Le engine ne sait pas ce qu'est `repo_manager-write_file`.

6. **Les prompts sont dans runner.** `prompt-builder.ts` assemble le system prompt + context. Le engine ne construit pas de prompts.

## Tools

Les tools sont des plugins YAML (`.tool.yaml`). Le runner est un tool plugin runtime.

**Builtins actuels :**

| Tool | Description |
|------|-------------|
| `repo_manager-read_file` | Lire un fichier du workspace |
| `repo_manager-write_file` | Écrire/créer un fichier |
| `repo_manager-list_files` | Lister les fichiers |
| `shell-run_command` | Exécuter une commande shell |
| `search-search_codebase` | Rechercher dans le code |

**Format des tools :** Les noms utilisent des tirets (`-`), pas des points (`.`). Exemple : `repo_manager-write_file`, pas `repo_manager.write_file`.

**Pour ajouter un tool :** Créer un `.tool.yaml` dans `.studio/projects/<projet>/tools/`. Le runner le charge automatiquement.

## Configs YAML — source de vérité

Les configs sont organisées par projet : `.studio/projects/<projet>/` (côté utilisateur) ou `templates/<projet>/` (templates built-in dans le monorepo).

**Pipelines :** `<projet>/pipelines/*.pipeline.yaml` — séquence de stages, ralph settings par stage.

**Contracts :** `<projet>/contracts/*.contract.yaml` — JSON schema + contraintes (tool_calls minimum, rejection detection).

**Agents :** `<projet>/agents/*.agent.yaml` — provider, model, temperature, tools autorisés, system prompt.

**Tools :** `<projet>/tools/*.tool.yaml` — tool plugins (commandes, paramètres, prompt snippet, contraintes).

**Inputs :** `<projet>/inputs/*.input.yaml` — fichiers d'input exemple.

**Ne hardcode JAMAIS dans le code ce qui peut être dans un YAML.** Si tu te retrouves à écrire `if (stage.kind === 'qa')` dans le engine, c'est une erreur — ça devrait être dans le contract.

## Format rejection detection (post_validation)

Exemple de contract avec rejection detection (qa-review.contract.yaml) :

```yaml
post_validation:
  rejection_detection:
    field: status                # Champ à vérifier dans l'output
    approved_values:             # Valeurs qui signifient "accepté"
      - approved
      - approved_with_notes
      - success
    rejected_values:             # Valeurs qui signifient "rejeté"
      - rejected
      - failed
      - implementation_incomplete
    details_field: issues        # Champ contenant les détails du rejet
    summary_field: summary       # Champ contenant le résumé
```

Si l'output a `status: rejected`, le stage passe en status `rejected` (pas `failed`), ce qui peut déclencher un retry du group parent.

## Pipeline de référence : software/feature-builder

```yaml
stages:
  - brief-analysis     → agent: analyst, contract: brief-analysis
  - implementation-plan → agent: analyst, contract: implementation-plan
  - group: implementation-review
    max_iterations: 3
    stages:
      - code-generation    → agent: coder, contract: code-generation
      - qa-review          → agent: analyst, contract: qa-review
```

2 stages linéaires + 1 group de 2 stages. Le group implementation-review peut itérer jusqu'à 3 fois si QA rejette. Le stage code-generation a accès au `group_feedback` qui contient les rejets précédents de QA.

## Commandes

```bash
# Usage quotidien
studio run <projet/pipeline> --input "..."       # Lancer un pipeline
studio run <projet/pipeline> --input-file X.yaml # Lancer avec input YAML
studio status [run-id]                           # Vérifier le status
studio list projects                             # Lister les projets
studio list pipelines                            # Lister les pipelines

# Configuration
studio init                                      # Créer .studio/ (wizard interactif)
studio config set provider anthropic --api-key $KEY  # Configurer un provider
studio config set default.model claude-haiku-4-20250514
studio config list                               # Voir la config (API keys masquées)

# Tools
studio tools list                                # Tools du projet actif
studio tools add git --project software          # Installer un tool
studio tools remove nutrition                    # Supprimer un tool
studio tools info git                            # Détail d'un tool

# Validation
studio validate <contract> <output.json>         # Valider sans LLM
```

## Format .studio/config.yaml

```yaml
# Généré par studio config, éditable aussi à la main
providers:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
  openai:
    apiKey: ${OPENAI_API_KEY}

defaults:
  provider: anthropic
  model: claude-sonnet-4-20250514
```

Les API keys peuvent utiliser des variables d'environnement : `${VAR_NAME}`. Ce fichier est gitignored — ne commit jamais les API keys.

---

## Exemples de Contracts (Schemas de Validation)

### Contract Simple (brief-analysis)

```yaml
name: brief-analysis
version: 1
schema:
  required_fields:
    - summary
    - requirements
    - acceptance_criteria
```

### Contract avec Anti-théâtre (code-generation)

```yaml
name: code-generation
version: 1
schema:
  required_fields:
    - summary
    - files_changed
tool_calls:
  minimum: 1
  required_tools:
    - repo_manager.write_file       # Format avec point dans le YAML
```

**Important :** Dans les contracts YAML, les tools utilisent le format `repo_manager.write_file` (point), mais les tools réels dans le code utilisent `repo_manager-write_file` (tiret). Le engine fait la transformation.

### Contract avec Rejection Detection (qa-review)

Voir section "Format rejection detection (post_validation)" plus haut.

---

## Format des Inputs (.input.yaml)

Format libre — du YAML arbitraire passé aux stages.

```yaml
brief_summary: "Ajouter une section FAQ simple a la page About."
target_page: "src/pages/about.tsx"
acceptance_criteria:
  - "La section FAQ apparait sur la page About sans casser la mise en page."
  - "Le style est coherent avec le design existant."
```

---

## Système d'Events (Observabilité)

Le engine émet des events à chaque étape du pipeline. Définis dans `engine/src/events.ts`.

| Event | Quand | Données |
|-------|-------|---------|
| `onPipelineStart` | Pipeline démarre | `pipeline_name`, `run_id` |
| `onPipelineComplete` | Pipeline termine | `status`, `duration_ms`, `total_tokens`, `total_tool_calls` |
| `onStageStart` | Stage démarre | `stage_name`, `stage_index`, `total_stages` |
| `onStageComplete` | Stage termine | `status`, `attempts`, `duration_ms`, `output`, `tool_calls`, `token_usage`, `rejection_reason` |
| `onTaskRetry` | Stage retry | `stage`, `attempt`, `failures`, `tool_calls_count` |
| `onGroupStart` | Group démarre | `group_name`, `max_iterations` |
| `onGroupIteration` | Group itère | `iteration`, `max_iterations` |
| `onGroupFeedback` | Group rejette | `rejection_reason`, `rejection_details` |
| `onGroupComplete` | Group termine | `iterations`, `status` |

---

## Common Pitfalls (Erreurs Fréquentes)

### 1. Oublier de rebuild après modification

`pnpm build` à la racine du monorepo rebuild tout dans le bon ordre.

### 2. Dépendance inversée accidentelle

Vérifie le graphe : `contracts` → rien, `ralph` → contracts, `runner` → contracts, `engine` → ralph + runner + contracts, `cli` → engine + contracts.

### 3. Format des tools incohérent

Dans les **agent YAML**, format tiret : `repo_manager-write_file`. Dans les **contract YAML** (`required_tools`), format point : `repo_manager.write_file` (le engine transforme).

### 4. Oublier `context.include` dans un stage

Si `context` n'est pas spécifié, le stage n'a accès à rien. Spécifie explicitement dans le pipeline YAML.

### 5. Groups sans rejection detection

Le **dernier stage** du group doit avoir `post_validation.rejection_detection` dans son contract pour que le group puisse itérer.

### 6. API keys non configurées

`studio config set provider anthropic --api-key $ANTHROPIC_API_KEY`

---

## Debugging Tips

```bash
DEBUG=studio:* studio run software/feature-builder --input "..."   # Events détaillés
studio validate software/code-generation output.json               # Valider sans LLM
```

---

## Logs de Run

`.studio/runs/logs/<timestamp>-<pipeline>-<id>.jsonl` (un JSON par ligne, format JSONL).

---

## Git Workflow — Règles obligatoires

**Tu ne push JAMAIS sur `main` ou `master`. Jamais. Aucune exception.**

**Monorepo = 1 repo git, 1 branche par feature, 1 PR.**

### Workflow

```bash
# 1. Branche
git checkout -b <type>/<description-courte>

# 2. Commits atomiques
git commit -m "feat(runner): integrate tool plugin loader"

# 3. Build
pnpm build

# 4. Push + PR
git push -u origin <branch-name>
gh pr create --title "<titre>" --body "<description>" --base main
```

### Checklist de fin de task

```
[ ] Branche créée (pas sur main)
[ ] Commits atomiques avec messages conventionnels
[ ] pnpm build passe
[ ] PR créée (Quoi, Pourquoi, Packages touchés, Comment tester)
```

### Interdit

- `git push origin main` — NON
- `git commit` directement sur main — NON
- `git push --force` — NON
- PR sans build — NON

## Avant de modifier du code

1. **Identifie dans quel package tu es.** Respecte les frontières.
2. **Vérifie les dépendances.** Ne crée jamais de dépendance inverse.
3. **Vérifie les YAML.** Si ta feature peut être configurée en YAML plutôt que codée, fais-le en YAML.
4. **`pnpm build` après.** Un seul build à la racine.
5. **Le engine est domain-agnostic.** Si tu mets du jargon métier dans le engine, c'est faux.
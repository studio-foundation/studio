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
studio run feature-builder --input "Add dark mode"
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

**2 types de repos :**
- **Repo Studio** — le kernel (publié sur npm). Contient les 5 packages + templates architecturaux.
- **Repos utilisateurs** — les projets/apps qui UTILISENT Studio (ex: `code-builder`, `adhd-finance`). Contiennent `.studio/` avec leurs configs.

## Architecture — 7 packages, 1 monorepo

```
Studio/                         # UN repo git, pnpm workspaces
├── contracts/                  # @studio/contracts — types, interfaces (ZERO dépendances)
│   └── package.json
├── anonymizer/                 # @studio/anonymizer — anonymisation PII avant envoi LLM
│   └── package.json
├── ralph/                      # @studio/ralph — retry loop + validation
│   └── package.json
├── runner/                     # @studio/runner — tool plugin runtime, LLM providers
│   └── package.json
├── engine/                     # @studio/engine — pipeline orchestration, state machine
│   └── package.json
├── api/                        # @studio/api — HTTP REST API (Fastify)
│   └── package.json
├── cli/                        # @studio/cli — interface terminal
│   └── package.json
├── templates/                  # Templates architecturaux (voir TEMPLATES.md)
│   ├── software/
│   ├── finance/
│   ├── analysis/
│   ├── data/
│   └── conversation/
├── package.json                # Root workspace
├── pnpm-workspace.yaml
└── CLAUDE.md
```

```
@studio/cli          → Interface terminal (studio run, studio config, etc.)
    │
@studio/api          → HTTP REST API (Fastify + Swagger UI)
    │
@studio/engine       → Orchestration pipeline, state machine, persistence SQLite
    │
    ├── @studio/ralph      → RALPH loop : execute → validate → retry si fail
    │
    ├── @studio/runner     → Tool plugin runtime, appels LLM, multi-provider
    │
    └── @studio/anonymizer → Middleware PII : remplace les données sensibles par tokens
    │
@studio/contracts    → Types partagés (ZERO dépendances, ZERO logique)
```

**Dépendances strictes :** contracts est un leaf package. ralph, runner et anonymizer dépendent UNIQUEMENT de contracts. engine dépend de ralph + runner + anonymizer + contracts. cli et api dépendent de engine + contracts.

**Jamais de dépendance inversée.** ralph ne connaît pas runner. runner ne connaît pas engine. Si tu te retrouves à importer un package "vers le haut", c'est une erreur d'architecture.

**pnpm workspaces :** Les dépendances internes utilisent `workspace:*`. Un seul `pnpm install` à la racine, un seul `pnpm build`.

## Templates — Patterns Architecturaux

**Les templates ne sont PAS des produits finaux.** Ce sont des **patterns architecturaux** pour différents types d'apps.

| Template | Use cases | Exemples de produits |
|----------|-----------|---------------------|
| `software/` | Code generation, refactoring, git operations | Code Builder, Git Butler, API Generator |
| `finance/` | Transaction analysis, budget management | ADHD Finance, Invoicing Tools, Portfolio Managers |
| `analysis/` | Content extraction, entity recognition, structuring | Wiki Creator, Voice Training, Legal Analyzers |
| `data/` | Validation, transformation, compliance checking | GrayOS Compliance, ETL Auditors, Data Cleaners |
| `conversation/` | Dialogue management, memory, feedback loops | Therapy Chatbots, Learning Assistants |

### Qu'est-ce qu'un template ?

Un template fournit un **starter fonctionnel** pour un type d'app :

- **Pipelines de base** pour le pattern (ex: `content-extraction`, `entity-recognition` pour `analysis/`)
- **Tools adaptés** (ex: `repo_manager-*` pour `software/`, `text-processor` pour `analysis/`)
- **Contracts types** (schemas de validation pour ce domaine)
- **Agents configurés** (analyzer, coder, etc. selon le pattern)
- **DB schema starter** (Prisma schema adapté au use case)
- **Code minimal** (structure de dossiers, fichiers de base)

**Important :** Les templates génèrent des apps **fonctionnelles out-of-the-box**. Comme `create-react-app`, pas comme un fichier vide.

### Workflow développeur

```bash
# Créer une app basée sur un template
studio init --template analysis --name wiki-creator
cd wiki-creator

# L'app est générée avec :
# - .studio/ (pipelines/, contracts/, agents/, tools/ — flat)
# - src/ (code starter)
# - prisma/schema.prisma (DB schema)
# - package.json

# Installer et run
npm install
npm run dev

# Ça marche immédiatement
studio run content-extraction --input "..."

# Puis customize selon tes besoins
# - Ajouter des pipelines spécifiques
# - Étendre le DB schema
# - Ajouter du code métier
```

### Produits vs Templates

**Code Builder** (produit) utilise le template `software/`  
**ADHD Finance** (produit) utilise le template `finance/`  
**Wiki Creator** (produit) utilise le template `analysis/`  
**Voice Training** (produit) utilise le template `analysis/` aussi  
**GrayOS Compliance** (produit) utilise le template `data/`

Les templates sont **réutilisables** — plusieurs produits peuvent partir du même template et diverger complètement.

Voir **[TEMPLATES.md](TEMPLATES.md)** pour la documentation complète.

## Structure `.studio/` (côté utilisateur)

Quand un utilisateur fait `studio init` dans son projet, tout vit dans `.studio/` :

```
my-project/                           # Le repo de l'utilisateur
├── .studio/                          # Tout Studio vit ici (comme .git/)
│   ├── config.yaml                   # Providers, defaults (gitignored)
│   ├── pipelines/                    # *.pipeline.yaml
│   ├── agents/                       # *.agent.yaml
│   ├── contracts/                    # *.contract.yaml
│   ├── tools/                        # *.tool.yaml (tool plugins)
│   ├── inputs/                       # *.input.yaml
│   ├── registry.lock.json            # Versions tools installés (commité)
│   └── runs/                         # Données runtime (gitignored)
│       ├── runs.db                   # SQLite
│       └── logs/                     # JSONL
├── src/                              # Le code de l'app
├── prisma/                           # DB schema (étendu depuis le template)
└── .gitignore
```

**Git strategy :**
- **Commité :** `.studio/pipelines/`, `.studio/agents/`, `.studio/contracts/`, `.studio/tools/`, `.studio/registry.lock.json`, `src/`, `prisma/`
- **Gitignored :** `.studio/config.yaml` (API keys), `.studio/runs/`

`findStudioDir()` remonte les dossiers parents jusqu'à trouver `.studio/`, exactement comme `git` cherche `.git/`.

## CLI vs API

Le CLI et l'API sont deux interfaces distinctes sur le même engine. Comme `git` et GitHub.

```
CLI = usage direct (humain devant un terminal)
  studio init --template <type>  → génère une app complète
  studio config set              → modifie config.yaml
  studio tools add               → installe un tool
  studio run                     → lance un pipeline ← USAGE QUOTIDIEN
  studio status                  → check un run
  studio validate                → dry-run

API = usage programmatique (machine-to-machine)
  Linear webhook → POST /runs    → auto-trigger sans humain
  CI/CD → POST /runs             → pipeline dans GitHub Actions
  Slack bot → POST /runs         → lance depuis Slack
  Dashboard → GET /runs          → affichage web
```

`studio run` est une commande de première classe — un dev qui utilise code-builder au quotidien fait `studio run` dans son terminal. L'API c'est pour quand il n'y a pas d'humain devant le terminal.

Le CLI est gratuit forever (comme `git`). L'API hosted est le produit monétisable (comme GitHub).

### Endpoints REST (`@studio/api`)

L'API HTTP est un serveur Fastify. Elle s'active via `studio api start` ou en important `@studio/api` directement.

**Runs**

```
POST   /api/runs                → lancer un pipeline (fire-and-forget)
GET    /api/runs                → lister les runs (?status=&limit=)
GET    /api/runs/:id            → détail d'un run
GET    /api/runs/:id/logs       → logs JSONL bruts
GET    /api/runs/:id/stream     → SSE — événements live (?events=csv)
```

**Project**

```
GET    /api/projects            → projet courant (nom, id, pipelines_dir)
GET    /api/projects/:id/pipelines → liste des pipelines du projet
```

**Pipelines CRUD**

```
GET    /api/pipelines           → liste tous les noms de pipelines disponibles
GET    /api/pipelines/:name     → contenu parsé d'un pipeline (YAML → JSON)
PUT    /api/pipelines/:name     → créer ou modifier un pipeline (body: YAML ou JSON)
DELETE /api/pipelines/:name     → supprimer un pipeline
```

**Agents CRUD**

```
GET    /api/agents              → liste tous les noms d'agents disponibles
GET    /api/agents/:name        → contenu parsé d'un agent (YAML → JSON)
PUT    /api/agents/:name        → créer ou modifier un agent (body: JSON)
DELETE /api/agents/:name        → supprimer un agent
```

**Swagger UI (dev/local uniquement)**

```
GET    /api/docs                → Swagger UI interactif
GET    /api/docs/json           → spec OpenAPI raw (pour génération de client)
```

Swagger UI est désactivé en production (`NODE_ENV=production`). En dev, il est généré automatiquement depuis les schemas des routes — pas besoin de maintenir une spec manuelle.

**Règle obligatoire — schema complet sur chaque route :** Toute route Fastify dans `@studio/api` doit avoir un schema Swagger complet. Sans ça, la route n'apparaît pas correctement dans Swagger UI.

```typescript
fastify.get('/example/:name', {
  schema: {
    tags: ['group'],          // groupement dans Swagger UI — obligatoire
    summary: 'Une phrase',    // titre lisible — obligatoire
    params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    querystring: { ... },     // si query params
    body: { ... },            // si POST/PUT/PATCH
    response: {
      200: { ... },           // tous les status codes retournés
      404: errorSchema,       // y compris les erreurs
      204: { type: 'null', description: 'No content' },  // pour les 204
    },
  },
}, handler)
```

Pattern `errorSchema` réutilisé par fichier : `const errorSchema = { type: 'object', properties: { error: { type: 'string' } } }`

**Authentification :** optionnelle. Si `api.key` est défini dans `config.yaml`, toutes les routes exigent `Authorization: Bearer <key>`. Sans clé configurée, l'API est ouverte (usage local uniquement).

**Codes d'erreur courants :**
- `400` — YAML invalide (PUT /api/pipelines)
- `401` — clé API manquante ou incorrecte
- `404` — ressource introuvable

## Concepts clés

**Pipeline** — Séquence de stages définie en YAML. Le engine la charge et l'exécute.

**Stage** — Une étape dans un pipeline. Chaque stage a un agent, un output contract, et des settings RALPH. Le engine ne connaît pas le "kind" du stage — c'est une string libre.

**RALPH loop** — Execute → validate contre le contract → retry avec feedback enrichi si fail → repeat jusqu'à succès ou max attempts. "Recursive Automated Loop for Persistent Handling."

**Output contract** — Schema JSON + contraintes qui définissent ce qu'un stage DOIT produire. La validation est binaire : pass ou fail.

**Anti-théâtre** — Si un contract exige `tool_calls.minimum: 1` et que l'agent a fait 0 tool calls, c'est un échec peu importe ce que l'agent prétend dans son output. Les tool calls réels sont trackés par le runner. Le contract peut aussi exiger des tools spécifiques via `tools.required: [repo_manager-write_file]` dans le stage YAML. Si le stage complète sans appeler ces tools, validation fail.

**Post-validation rejection** — Le engine peut détecter qu'un stage a répondu correctement (format OK) mais que le verdict est négatif (ex: QA qui rejette). Status = `rejected`, pas `failed`. Configuré via le contract YAML, pas hardcodé.

**Groups** — Boucles de feedback multi-stages. Un group contient plusieurs stages qui s'exécutent en itérations. Si le dernier stage du groupe rejette (via `post_validation.rejection_detection`), le group redémarre depuis le début avec le feedback accumulé. Maximum d'itérations configuré via `max_iterations`. Les stages dans un group peuvent accéder au `group_feedback` via leur context.

**Context propagation** — Chaque stage peut configurer exactement quel contexte il reçoit via `context.include: [...]`. Options disponibles : `input` (input initial du pipeline), `previous_stage_output` (output du stage précédent), `all_stage_outputs` (outputs de tous les stages précédents), `group_feedback` (feedback accumulé dans le group), `repo_files` (fichiers du repo si applicable).

**on_pipeline_start** — Commandes shell exécutées au démarrage du pipeline avant tout stage. Leur stdout est injecté dans le contexte de chaque stage. Cas d'usage : git status, fichiers récemment modifiés, état du projet. Configuré dans le YAML du pipeline via `on_pipeline_start: [{command: "git status", inject_as: "git_status"}]`.

**Hooks de lifecycle** — Commandes shell configurables en YAML qui s'exécutent à des points déterministes du lifecycle. Inspirés des hooks Claude Code — la distinction clé : les YAML sont des suggestions, les hooks sont garantis. 4 types de hooks :
- `on_stage_start` — avant que le stage s'exécute (pas d'output disponible)
- `on_stage_complete` — après succès du stage (accès à `{{output.field}}`)
- `pre_tool_use` — avant un tool call spécifique (matcher exact sur le nom du tool, accès à `{{tool.argName}}`)
- `post_tool_use` — après un tool call spécifique

Chaque hook a un `on_failure`: `warn` (défaut, log et continue), `reject` (stage → rejected, triggerable group retry), `fail` (stage → failed, stop pipeline). Les hooks `pre_tool_use` avec `on_failure: reject` bloquent le tool call.

**Skills (.skill.md)** — Fichiers markdown dans `.studio/skills/` qui décrivent du contexte procédural (conventions, étapes, patterns d'architecture). Injectés automatiquement dans le system prompt des agents qui les déclarent via `skills: [name]` dans l'agent YAML. Pas de code — juste du markdown.

**Plugin Claude Code** — Studio supporte le format plugin Claude Code complet (`.mcp.json`, `skills/`, `agents/`). Un plugin Claude Code existant peut être utilisé dans Studio sans modification. Les agents déclarent les plugins via `plugins: [plugin-name]` dans l'agent YAML.

**PII Anonymization** — Middleware transparent qui remplace les données sensibles (noms, emails, données financières) par des tokens (`[PERSON_1]`, `[EMAIL_1]`) avant l'envoi au LLM. Keymap local stocké dans `.studio/runs/anonymization/<run-id>.keymap.json` pour reconstruire les vraies valeurs après le run. Activé via `--anonymize` sur `studio run`, ou `anonymize: true` dans l'agent YAML.

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

> Liste formelle et documentée : **[INVARIANTS.md](INVARIANTS.md)**

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

**Pour ajouter un tool :** Créer un `.tool.yaml` dans `.studio/tools/`. Le runner le charge automatiquement.

**Tools par template :** Chaque template inclut les tools appropriés pour son domaine. `software/` a `repo_manager-*`, `analysis/` a `text-processor`, `finance/` a `bank-api`, etc.

## Configs YAML — source de vérité

Les configs sont organisées directement dans `.studio/` dans le repo utilisateur (structure plate — pas de `projects/<nom>/`).

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
on_pipeline_start:
  - command: "git status --short"
    inject_as: git_status
  - command: "git log --oneline -5"
    inject_as: recent_commits

stages:
  - brief-analysis     → agent: analyst, contract: brief-analysis
  - implementation-plan → agent: analyst, contract: implementation-plan
  - group: implementation-review
    max_iterations: 3
    stages:
      - code-generation
          agent: coder
          contract: code-generation
          hooks:
            on_stage_complete:
              - command: "npx tsc --noEmit 2>&1 | head -20"
                on_failure: reject   # TypeScript errors → group retry
              - command: "grep -rn 'catch.*{\s*}' src/ | head -5"
                on_failure: warn     # Silent catch → avertissement
      - qa-review          → agent: analyst, contract: qa-review
```

2 stages linéaires + 1 group de 2 stages. Le group implementation-review peut itérer jusqu'à 3 fois si QA rejette. Le stage code-generation a accès au `group_feedback` qui contient les rejets précédents de QA. Les hooks `on_stage_complete` sur code-generation font de l'analyse statique déterministe avant que QA commence.

## Commandes

```bash
# Usage quotidien
studio run <pipeline> --input "..."              # Lancer un pipeline
studio run <pipeline> --input-file X.yaml        # Lancer avec input YAML
studio run <pipeline> --live                     # Streaming temps réel (tool calls visibles)
studio run <pipeline> --provider mock            # Run sans API keys (mock provider)
studio run <pipeline> --anonymize                # Anonymisation PII avant envoi au LLM
studio status [run-id]                           # Vérifier le status
studio list projects                             # Lister les projets
studio list pipelines                            # Lister les pipelines

# Configuration
studio init                                      # Wizard interactif (template, provider, tools)
studio init --template <type> --name <projet>    # Mode direct (CI/CD)
studio config add-provider                       # Ajouter un provider LLM
studio config set provider anthropic --api-key $KEY
studio config set default.model claude-haiku-4-20250514
studio config list                               # Voir la config (API keys masquées)

# Tools
studio tools list                                # Tools du projet actif
studio tools add git                             # Installer un tool (wizard interactif)
studio tools remove nutrition                    # Supprimer un tool
studio tools info git                            # Détail d'un tool

# Templates
studio template validate <path>                  # Valider la structure d'un template

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
| `onToolCallStart` | Tool call commence | `tool`, `params` |
| `onToolCallComplete` | Tool call termine | `tool`, `result`, `error` |
| `onAgentThinking` | Agent pense (streaming) | `stage`, `text` |
| `onAgentProgress` | Agent progresse | `stage`, `message` |
| `onAgentToken` | Token streamé | `stage`, `token` |

---

## Format Hooks (Lifecycle)

Exemple de stage avec hooks dans le pipeline YAML :

```yaml
stages:
  - name: code-generation
    agent: coder
    contract: code-generation
    hooks:
      on_stage_complete:
        - command: "npx tsc --noEmit 2>&1 | head -20"
          on_failure: reject         # TypeScript errors → group retry
        - command: "grep -r 'catch.*{}' {{output.files_changed}}"
          on_failure: warn           # Silent catch → log warning
      pre_tool_use:
        - matcher: repo_manager-write_file
          command: "echo 'Writing: {{tool.path}}'"
          on_failure: warn
      post_tool_use:
        - matcher: repo_manager-write_file
          command: "npx eslint --max-warnings 0 {{tool.path}} 2>&1 | head -10"
          on_failure: warn
```

**Substitutions disponibles :**
- `{{output.field}}` — champ de l'output du stage (dans `on_stage_complete`)
- `{{tool.argName}}` — argument du tool call (dans `pre_tool_use`, `post_tool_use`)
- Arrays → joint par espace pour les arguments CLI

**Note de sécurité :** Les valeurs sont substituées verbatim. Les hooks sont authored par les propriétaires du pipeline (trusted), pas par les end users.

## Format on_pipeline_start

```yaml
name: feature-builder
on_pipeline_start:
  - command: "git status --short"
    inject_as: git_status
  - command: "git diff --name-only HEAD~1"
    inject_as: recently_changed
stages:
  ...
```

Le stdout de chaque commande est injecté dans le contexte des stages sous la clé `inject_as`.

## Format Skills (.studio/skills/)

```markdown
# commit-conventions.skill.md
Commit messages follow conventional commits format:
- feat: new feature
- fix: bug fix
- refactor: code refactoring
Always include the package scope: feat(engine): ...
```

Dans l'agent YAML :
```yaml
name: coder
skills:
  - commit-conventions
  - react-patterns
```

Les fichiers `commit-conventions.skill.md` et `react-patterns.skill.md` sont auto-injectés dans le system prompt.

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
DEBUG=studio:* studio run feature-builder --input "..."   # Events détaillés
studio run feature-builder --input "..." --live           # Tool calls en temps réel
studio run feature-builder --provider mock                 # Sans API keys (mock provider)
studio validate software/code-generation output.json       # Valider sans LLM
```

---

## Logs de Run

`.studio/runs/logs/<timestamp>-<pipeline>-<id>.jsonl` (un JSON par ligne, format JSONL).

---

## Linear Issues — Règle obligatoire

**Tout ticket Linear = toujours un worktree. C'est la première étape, avant tout.**

```bash
# Première chose à faire quand tu reçois un ticket Linear
git worktree add .worktrees/<branch-name> -b <type>/<stu-xxx-description>
```

Utilise le skill `superpowers:using-git-worktrees` pour le setup complet.

`.worktrees/` est dans `.gitignore` — pas besoin de valider ou vérifier ça à chaque fois.

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

## Projets "Powered by Studio"

Un projet Powered by Studio est un **workspace** où Studio orchestre du travail via des pipelines.

### Anatomie

```
mon-projet/                      # Le workspace (repo git séparé)
├── .studio/                     # Studio vit ici (comme .git/)
│   ├── config.yaml              # Config locale (gitignored)
│   ├── pipelines/
│   ├── contracts/
│   ├── agents/
│   ├── tools/
│   └── runs/
│       └── runs.db              # État d'exécution (gitignored)
├── src/                         # Le code de l'app
├── prisma/                      # DB schema (étendu depuis template)
└── package.json
```

### Intégration

Studio s'intègre via les **tools** qui ont accès au workspace :

- `repo_manager-write_file` écrit dans `src/`
- `shell-run_command` exécute dans le workspace
- `search-search_codebase` cherche dans le workspace

Le kernel est agnostic du contenu du workspace — il orchestre simplement les transformations.

### Exemples concrets

**Code Builder** (repo séparé) :
- Généré avec `studio init --template software --name code-builder`
- Contient `.studio/pipelines/`, `.studio/agents/`, etc. (copié depuis template)
- Code custom dans `src/` (CLI wrapper, IDE extension, etc.)
- DB schema étendu pour tracking repos/features

**ADHD Finance** (repo séparé) :
- Généré avec `studio init --template finance --name adhd-finance`
- Contient `.studio/pipelines/`, `.studio/agents/`, etc. (copié depuis template)
- Code custom dans `src/` (Next.js app, Plaid integration, etc.)
- DB schema étendu pour users/accounts/transactions/budgets

**Wiki Creator** (repo séparé) :
- Généré avec `studio init --template analysis --name wiki-creator`
- Contient `.studio/pipelines/`, `.studio/agents/`, etc. (copié depuis template)
- Code custom dans `src/` (book parser, wiki generator, etc.)
- DB schema étendu pour books/wikis/pages/entities

### Local vs Remote (futur)

**Local** : Studio run dans le workspace sur ta machine  
**Remote** : Studio run dans un clone sur Studio Cloud

Le concept de "remote" (comme `git remote`) permettra de push/pull les configs et d'exécuter sur un serveur.

---

**Voir aussi :**
- **[TEMPLATES.md](TEMPLATES.md)** — Documentation complète des templates architecturaux
- **[INVARIANTS.md](INVARIANTS.md)** — Règles non-négociables du kernel
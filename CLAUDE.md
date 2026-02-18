# CLAUDE.md — Studio v7

Studio est un orchestrateur de pipelines agentiques. Il exécute des workflows multi-stages en utilisant des LLMs, avec validation stricte et retry automatique. Il est **domain-agnostic** — le engine ne sait pas ce qu'est du code, un fichier, ou du QA. Tout le domaine vient des configs YAML.

## Architecture — 5 packages

```
@studio/cli          → Interface terminal (commandes `studio run`, `studio status`)
    │
@studio/engine       → Orchestration pipeline, state machine, persistence SQLite
    │
    ├── @studio/ralph    → RALPH loop : execute → validate → retry si fail
    │
    └── @studio/runner   → Appels LLM, exécution tools, multi-provider
    │
@studio/contracts    → Types partagés (ZERO dépendances, ZERO logique)
```

**Dépendances strictes :** contracts est un leaf package. ralph et runner dépendent UNIQUEMENT de contracts. engine dépend de ralph + runner + contracts. cli dépend de engine + contracts.

**Jamais de dépendance inversée.** ralph ne connaît pas runner. runner ne connaît pas engine. Si tu te retrouves à importer un package "vers le haut", c'est une erreur d'architecture.

## Dossiers

```
Studio/
├── contracts/          # @studio/contracts — types, interfaces
├── ralph/              # @studio/ralph — retry loop + validation
├── runner/             # @studio/runner — LLM providers + tools
│   └── src/tools/builtin/   # repo-manager, shell, search
├── engine/             # @studio/engine — pipeline orchestration
│   └── src/state/           # state machine, status derivation
├── cli/                # @studio/cli — terminal interface
└── engine/configs/     # YAML configs organisés par projet
    ├── software/       # Projet "software" (feature-builder pipeline)
    │   ├── pipelines/  # Définitions de pipelines
    │   ├── agents/     # Profils d'agents LLM
    │   ├── contracts/  # Output contracts (schemas de validation)
    │   └── inputs/     # Fichiers d'input exemple
    └── cuisine/        # Projet "cuisine" (recipe-generator pipeline)
        ├── pipelines/
        ├── agents/
        ├── contracts/
        └── inputs/
```

Chaque projet est un dossier 100% autonome. Agents et contracts sont partagés entre les pipelines d'un même projet, jamais entre projets.

## Concepts clés

**Pipeline** — Séquence de stages définie en YAML. Le engine la charge et l'exécute.

**Stage** — Une étape dans un pipeline. Chaque stage a un agent, un output contract, et des settings RALPH. Le engine ne connaît pas le "kind" du stage — c'est une string libre.

**RALPH loop** — Execute → validate contre le contract → retry avec feedback enrichi si fail → repeat jusqu'à succès ou max attempts. "Recursive Automated Loop for Persistent Handling."

**Output contract** — Schema JSON + contraintes qui définissent ce qu'un stage DOIT produire. La validation est binaire : pass ou fail.

**Anti-théâtre** — Si un contract exige `tool_calls.minimum: 1` et que l'agent a fait 0 tool calls, c'est un échec peu importe ce que l'agent prétend dans son output. Les tool calls réels sont trackés par le runner. Le contract peut aussi exiger des tools spécifiques via `tools.required: [repo_manager-write_file]` dans le stage YAML. Si le stage complète sans appeler ces tools, validation fail.

**Post-validation rejection** — Le engine peut détecter qu'un stage a répondu correctement (format OK) mais que le verdict est négatif (ex: QA qui rejette). Status = `rejected`, pas `failed`. Configuré via le contract YAML, pas hardcodé.

**Groups** — Boucles de feedback multi-stages. Un group contient plusieurs stages qui s'exécutent en itérations. Si le dernier stage du groupe rejette (via `post_validation.rejection_detection`), le group redémarre depuis le début avec le feedback accumulé. Maximum d'itérations configuré via `max_iterations`. Les stages dans un group peuvent accéder au `group_feedback` via leur context. Implémenté dans software/feature-builder (implementation-review) et cuisine/recipe-generator (creation-review).

**Context propagation** — Chaque stage peut configurer exactement quel contexte il reçoit via `context.include: [...]`. Options disponibles : `input` (input initial du pipeline), `previous_stage_output` (output du stage précédent), `all_stage_outputs` (outputs de tous les stages précédents), `group_feedback` (feedback accumulé dans le group), `repo_files` (fichiers du repo si applicable).

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

## Tools (runner/src/tools/builtin/)

| Tool | Fichier | Description |
|------|---------|-------------|
| `repo_manager-read_file` | repo-manager.ts | Lire un fichier du workspace |
| `repo_manager-write_file` | repo-manager.ts | Écrire/créer un fichier |
| `repo_manager-list_files` | repo-manager.ts | Lister les fichiers |
| `shell-run_command` | shell.ts | Exécuter une commande shell |
| `search-search_codebase` | search.ts | Rechercher dans le code |

**Format des tools :** Les noms utilisent des tirets (`-`), pas des points (`.`). Exemple : `repo_manager-write_file`, pas `repo_manager.write_file`.

Pour ajouter un tool : créer un fichier dans `builtin/`, l'enregistrer dans le tool registry, l'ajouter à l'agent YAML.

## Configs YAML — source de vérité

Les configs sont organisées par projet : `engine/configs/<projet>/`.

**Pipelines :** `<projet>/pipelines/*.pipeline.yaml` — séquence de stages, ralph settings par stage.

**Contracts :** `<projet>/contracts/*.contract.yaml` — JSON schema + contraintes (tool_calls minimum, rejection detection).

**Agents :** `<projet>/agents/*.agent.yaml` — provider, model, temperature, tools autorisés, system prompt.

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
studio run <projet/pipeline> --input "..."       # Lancer un pipeline
studio run <projet/pipeline> --input-file X.yaml # Lancer avec input YAML
studio status [run-id]                           # Vérifier le status
studio list projects                             # Lister les projets
studio list pipelines                            # Lister les pipelines
studio list agents                               # Lister les agents
studio list runs                                 # Lister les runs (nécessite DB)
```

Exemples :
```bash
studio run software/feature-builder --input-file engine/configs/software/inputs/faq-about.input.yaml
studio run cuisine/recipe-generator --input-file engine/configs/cuisine/inputs/pad-thai.input.yaml
```

## Avant de modifier du code

1. **Identifie dans quel package tu es.** Respecte les frontières.
2. **Vérifie les dépendances.** Ne crée jamais de dépendance inverse.
3. **Vérifie les YAML.** Si ta feature peut être configurée en YAML plutôt que codée, fais-le en YAML.
4. **Rebuild le package après.** `cd <package> && npm run build`
5. **Le engine est domain-agnostic.** Si tu mets du jargon métier dans le engine, c'est faux.

---

## Format .studiorc.yaml (Configuration)

Le fichier `.studiorc.yaml` à la racine du projet configure les providers LLM et les chemins.

**Structure complète :**

```yaml
# Providers LLM (au moins un requis)
providers:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}    # Variable d'env ou valeur directe
  openai:
    apiKey: ${OPENAI_API_KEY}

# Chemins (optionnel si structure standard)
paths:
  configs: ./engine/configs          # Dossier racine des configs
  projects_dir: ${STUDIO_PROJECTS_DIR}  # Optionnel : dossier de repos externes

# Defaults (optionnel)
defaults:
  provider: anthropic                # Provider par défaut si non spécifié dans agent
  model: claude-sonnet-4-20250514    # Model par défaut
```

**Notes importantes :**
- Les API keys peuvent utiliser des variables d'environnement : `${VAR_NAME}`
- Si `paths.configs` n'est pas spécifié, le engine cherche dans `./engine/configs`
- Le `defaults.provider` est utilisé si l'agent YAML ne spécifie pas de provider
- Le fichier est dans le `.gitignore` — ne commit jamais les API keys

---

## Exemples de Contracts (Schemas de Validation)

### Contract Simple (brief-analysis)

```yaml
name: brief-analysis
version: 1
schema:
  required_fields:        # Champs obligatoires dans l'output JSON
    - summary
    - requirements
    - acceptance_criteria
```

L'agent doit retourner un JSON avec ces 3 champs. Si un champ manque, validation fail.

### Contract avec Anti-théâtre (code-generation)

```yaml
name: code-generation
version: 1
schema:
  required_fields:
    - summary
    - files_changed
tool_calls:
  minimum: 1                        # Au moins 1 tool call requis
  required_tools:                   # Tools spécifiques obligatoires
    - repo_manager.write_file       # Format avec point dans le YAML
```

**Important :** Dans les contracts YAML, les tools utilisent le format `repo_manager.write_file` (point), mais les tools réels dans le code utilisent `repo_manager-write_file` (tiret). Le engine fait la transformation.

Si l'agent complète sans appeler `repo_manager-write_file`, validation fail même si l'output JSON est correct.

### Contract avec Rejection Detection (qa-review)

Voir section "Format rejection detection (post_validation)" plus haut pour l'exemple complet.

---

## Format des Inputs (.input.yaml)

Les fichiers dans `<projet>/inputs/` définissent l'input initial du pipeline. Format libre — c'est du YAML arbitraire qui sera passé aux stages.

**Exemple (faq-about.input.yaml) :**

```yaml
brief_summary: "Ajouter une section FAQ simple a la page About, avec quelques questions/reponses, en respectant le style existant."
feature_brief: "Ajouter une section FAQ simple a la page About avec quelques questions/reponses en accord avec le style existant."
target_page: "src/pages/about.tsx"
acceptance_criteria:
  - "La section FAQ apparait sur la page About sans casser la mise en page."
  - "Chaque question est affichee comme un accordeon avec ouverture/fermeture."
  - "Le style (typographie, espacements, couleurs) est coherent avec le design existant."
  - "Aucune regression: build et tests passent."
sample_faq:
  - question: "C'est quoi ce projet?"
    answer: "Une breve description du site/projet."
  - question: "Comment me contacter?"
    answer: "Lien vers la page contact ou courriel."
```

**Usage :**

```bash
studio run software/feature-builder --input-file engine/configs/software/inputs/faq-about.input.yaml
```

Tout le contenu YAML est passé au premier stage via `context.include: [input]`. Structure ton input selon ce dont tes agents ont besoin.

---

## Système d'Events (Observabilité)

Le engine émet des events à chaque étape du pipeline. Définis dans `engine/src/events.ts`.

**Events disponibles :**

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

**Exemple d'utilisation (dans le CLI) :**

```typescript
const events: EngineEvents = {
  onStageComplete: (event) => {
    console.log(`✓ ${event.stage_name} (attempt ${event.attempts})`);
    if (event.rejection_reason) {
      console.log(`  ✗ Rejected: ${event.rejection_reason}`);
    }
  },
  onGroupFeedback: (event) => {
    console.log(`↻ Group ${event.group_name} iteration ${event.iteration}: ${event.rejection_reason}`);
  }
};

await engine.executePipeline(pipelineConfig, input, events);
```

Les events permettent d'afficher la progression, de logger, ou d'envoyer des métriques à un système externe.

---

## Common Pitfalls (Erreurs Fréquentes)

### 1. Oublier de rebuild après modification

**Symptôme :** Tes changements dans un package ne sont pas pris en compte.

**Solution :** Après toute modif dans `contracts/`, `ralph/`, `runner/`, ou `engine/`, fais :

```bash
cd <package>
npm run build
```

Les packages consomment les `.js` compilés dans `dist/`, pas les `.ts` sources.

### 2. Dépendance inversée accidentelle

**Symptôme :** Import error ou circular dependency.

**Erreur typique :** Importer `engine` depuis `ralph`, ou `runner` depuis `contracts`.

**Solution :** Vérifie le graphe de dépendances :
- `contracts` → rien (leaf package)
- `ralph` → `contracts` uniquement
- `runner` → `contracts` uniquement
- `engine` → `ralph`, `runner`, `contracts`
- `cli` → `engine`, `contracts`

Si tu dois partager un type, mets-le dans `contracts`.

### 3. Format des tools incohérent

**Symptôme :** Tool call fail avec "unknown tool".

**Erreur :** Utiliser `repo_manager.write_file` dans l'agent YAML au lieu de `repo_manager-write_file`.

**Solution :** Dans les **agent YAML**, utilise le format tiret :

```yaml
tools:
  - repo_manager-write_file
  - shell-run_command
```

Dans les **contract YAML** (`required_tools`), utilise le format point (le engine transforme).

### 4. Oublier `context.include` dans un stage

**Symptôme :** L'agent n'a pas accès à l'input ou aux outputs précédents.

**Solution :** Dans le pipeline YAML, spécifie explicitement :

```yaml
stages:
  - name: mon-stage
    context:
      include:
        - input                    # Input initial du pipeline
        - previous_stage_output    # Output du stage précédent
        - all_stage_outputs        # Tous les outputs précédents
        - group_feedback           # Feedback du group (si dans un group)
```

Si `context` n'est pas spécifié, le stage n'a accès à rien.

### 5. Contract trop strict ou trop lâche

**Symptôme :** Validation fail en boucle, ou agents qui fake work sans être détectés.

**Erreur :** Exiger `tool_calls.minimum: 10` pour un stage qui n'a besoin que de 1-2 calls, ou ne pas exiger de tool calls du tout pour un stage qui doit écrire des fichiers.

**Solution :** Balance entre strictness et flexibilité. Pour un code-generation stage :

```yaml
tool_calls:
  minimum: 1                        # Au moins 1 call
  required_tools:
    - repo_manager-write_file       # Tool spécifique requis
```

Pour un analysis stage (lecture seule), pas besoin de `tool_calls`.

### 6. Rejection detection mal configurée

**Symptôme :** QA rejette mais le pipeline avance quand même, ou inverse (faux positifs).

**Erreur :** `approved_values` et `rejected_values` qui se chevauchent, ou field name incorrect.

**Solution :** Vérifie que :
- `field` correspond au vrai champ dans l'output JSON de l'agent
- `approved_values` et `rejected_values` sont mutuellement exclusifs
- Le field existe toujours dans l'output (sinon le engine assume "not rejected")

### 7. API keys non configurées

**Symptôme :** "API key not found" ou "provider not configured".

**Solution :**
1. Crée un `.studiorc.yaml` à la racine
2. Ajoute au moins un provider avec une API key valide
3. Utilise des variables d'env : `apiKey: ${ANTHROPIC_API_KEY}`
4. Export la variable : `export ANTHROPIC_API_KEY=sk-...`

### 8. Groups sans rejection detection

**Symptôme :** Le group itère 1 fois puis s'arrête, même si QA rejette.

**Erreur :** Le dernier stage du group n'a pas de `post_validation.rejection_detection` configuré dans son contract.

**Solution :** Si tu veux que le group itère sur rejection, le **dernier stage** doit avoir rejection detection. Exemple : dans un group `[code-generation, qa-review]`, c'est le contract `qa-review` qui doit détecter rejection.

---

## Debugging Tips

**Voir les events détaillés :**

```bash
DEBUG=studio:* studio run software/feature-builder --input "..."
```

**Valider un contract sans LLM :**

```bash
studio validate software/code-generation output.json
```

**Tester un stage isolé :**

Crée un mini-pipeline avec 1 seul stage pour tester rapidement.

**Inspecter les tool calls :**

Les events `onStageComplete` incluent `tool_calls` avec le nom et les arguments de chaque call.

---

## Logs de Run

Les logs de run sont dans `.studio/runs/<timestamp>-<pipeline>-<id>.jsonl` (un JSON par ligne, format JSONL).

---

## Git Workflow — Règles obligatoires

**Tu ne push JAMAIS sur `main` ou `master`. Jamais. Aucune exception.**

**Structure importante — 5 repos git indépendants + 1 root :**

```
Studio/          ← repo git root (workspace)
├── contracts/   ← repo git indépendant
├── ralph/       ← repo git indépendant
├── runner/      ← repo git indépendant
├── engine/      ← repo git indépendant
└── cli/         ← repo git indépendant
```

La branche doit être créée **dans le repo du package touché**, pas dans Studio root. Si la tâche touche plusieurs packages, crée une branche dans chacun.

### Workflow obligatoire

**1. Créer une branche AVANT de toucher au code**

```bash
cd <package>   # le repo du package touché (runner/, engine/, etc.)
git checkout -b <type>/<description-courte>
# Si issue Linear : git checkout -b arianedguay/stu-28-description
```

Nommage : `feat/`, `fix/`, `refactor/`, `chore/`

**2. Commits atomiques**

```bash
git commit -m "feat(runner): integrate anonymizer before LLM calls"
```

Format : `<type>(<scope>): <description>` — Types : `feat`, `fix`, `refactor`, `test`, `chore`, `docs`

**3. Push + PR — une PR PAR repo touché**

```bash
git push -u origin <branch-name>
gh pr create --title "<titre>" --body "<description>" --base main
```

**Si la tâche touche N packages, il y a N PRs.** Une PR dans `runner`, une dans `contracts`, etc. Ne jamais finir une tâche avec un package modifié mais sans PR.

PR body doit contenir : **Quoi**, **Pourquoi**, **Packages touchés**, **Comment tester**.

**4. Rebuild avant la PR**

```bash
cd <package> && pnpm build   # Rebuild les packages touchés
pnpm build                   # Build global si plusieurs packages
```

### Checklist de fin de task

```
[ ] Branche créée dans chaque repo touché (pas sur main, pas dans Studio root)
[ ] Commits atomiques avec messages conventionnels
[ ] Packages touchés rebuildés
[ ] Build global passe
[ ] Branche pushée sur origin pour chaque repo touché
[ ] PR créée pour chaque repo touché (N packages = N PRs)
[ ] Chaque PR pointe vers main (--base main)
[ ] Chaque PR body contient : Quoi, Pourquoi, Packages touchés, Comment tester
```

### Interdit

- `git push origin main` — NON
- `git commit` directement sur main — NON
- `git push --force` — NON
- Créer une PR sans avoir buildé — NON
- Créer une PR dans Studio root au lieu du repo du package — NON
- Finir une tâche avec un package modifié mais sans PR — NON
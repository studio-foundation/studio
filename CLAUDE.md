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
│   └── src/tools/builtin/   # repo-manager, shell, search, patch
├── engine/             # @studio/engine — pipeline orchestration
│   └── src/state/           # state machine, status derivation
├── cli/                # @studio/cli — terminal interface
└── configs/            # YAML configs (PAS du code)
    ├── pipelines/      # Définitions de pipelines
    ├── contracts/      # Output contracts (schemas de validation)
    └── agents/         # Profils d'agents LLM
```

## Concepts clés

**Pipeline** — Séquence de stages définie en YAML. Le engine la charge et l'exécute.

**Stage** — Une étape dans un pipeline. Chaque stage a un agent, un output contract, et des settings RALPH. Le engine ne connaît pas le "kind" du stage — c'est une string libre.

**RALPH loop** — Execute → validate contre le contract → retry avec feedback enrichi si fail → repeat jusqu'à succès ou max attempts. "Recursive Automated Loop for Persistent Handling."

**Output contract** — Schema JSON + contraintes qui définissent ce qu'un stage DOIT produire. La validation est binaire : pass ou fail.

**Anti-théâtre** — Si un contract exige `tool_calls.minimum: 1` et que l'agent a fait 0 tool calls, c'est un échec peu importe ce que l'agent prétend dans son output. Les tool calls réels sont trackés par le runner.

**Post-validation rejection** — Le engine peut détecter qu'un stage a répondu correctement (format OK) mais que le verdict est négatif (ex: QA qui rejette). Status = `rejected`, pas `failed`. Configuré via le contract YAML, pas hardcodé.

## State machine

```
pending → running → success
                  → failed
                  → rejected
                  → skipped
```

`deriveStageStatusFromTasks()` dans engine est LA fonction critique. Elle dérive le status du stage depuis les status de ses tasks. Elle doit être déterministe.

## Règles NON-NÉGOCIABLES

1. **Le engine est domain-agnostic.** Pas de référence à "code", "file", "git", "QA" dans le engine. Tout le domaine vient des YAML.

2. **ralph ne connaît pas runner.** ralph prend un `executor: () => Promise<T>` générique. Il ne sait pas que c'est un LLM derrière.

3. **runner ne valide pas, ne retry pas.** Il exécute et retourne un AgentRun. La validation et le retry sont le job de ralph.

4. **contracts est un leaf package.** Zéro dépendance interne. Si tu ajoutes un import vers un autre package dans contracts, c'est une erreur.

5. **Les tools sont dans runner, pas dans engine.** Le engine passe les configs au runner. Le runner exécute les tools. Le engine ne sait pas ce qu'est `repo_manager.write_file`.

6. **Les prompts sont dans runner.** `prompt-builder.ts` assemble le system prompt + context. Le engine ne construit pas de prompts.

## Tools (runner/src/tools/builtin/)

| Tool | Fichier | Description |
|------|---------|-------------|
| `repo_manager.read_file` | repo-manager.ts | Lire un fichier du workspace |
| `repo_manager.write_file` | repo-manager.ts | Écrire/créer un fichier |
| `repo_manager.list_files` | repo-manager.ts | Lister les fichiers |
| `repo_manager.apply_patch` | patch.ts | Appliquer un unified diff |
| `shell.run_command` | shell.ts | Exécuter une commande shell |
| `search.search_codebase` | search.ts | Rechercher dans le code |

Pour ajouter un tool : créer un fichier dans `builtin/`, l'enregistrer dans le tool registry, l'ajouter à l'agent YAML.

## Configs YAML — source de vérité

**Pipelines :** `configs/pipelines/*.pipeline.yaml` — séquence de stages, ralph settings par stage.

**Contracts :** `configs/contracts/*.contract.yaml` — JSON schema + contraintes (tool_calls minimum, rejection detection).

**Agents :** `configs/agents/*.agent.yaml` — provider, model, temperature, tools autorisés, system prompt.

**Ne hardcode JAMAIS dans le code ce qui peut être dans un YAML.** Si tu te retrouves à écrire `if (stage.kind === 'qa')` dans le engine, c'est une erreur — ça devrait être dans le contract.

## Pipeline de référence : feature-builder

```yaml
stages:
  - brief-analysis     → agent: analyst, contract: brief-analysis
  - implementation-plan → agent: analyst, contract: implementation-plan
  - code-generation    → agent: coder, contract: code-generation
  - qa-review          → agent: analyst, contract: qa-review
```

4 stages. L'output de chaque stage devient le context du suivant.

## Commandes

```bash
studio run <pipeline> --input "..."       # Lancer un pipeline
studio run <pipeline> --input-file X.yaml # Lancer avec input YAML
studio status [run-id]                    # Vérifier le status
studio list pipelines                     # Lister les pipelines
studio list runs                          # Lister les runs
```

## Avant de modifier du code

1. **Identifie dans quel package tu es.** Respecte les frontières.
2. **Vérifie les dépendances.** Ne crée jamais de dépendance inverse.
3. **Vérifie les YAML.** Si ta feature peut être configurée en YAML plutôt que codée, fais-le en YAML.
4. **Rebuild le package après.** `cd <package> && npm run build`
5. **Le engine est domain-agnostic.** Si tu mets du jargon métier dans le engine, c'est faux.
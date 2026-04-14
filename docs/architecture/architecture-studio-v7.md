# Studio v7 — Architecture

> **Note historique :** Ce document a démarré comme design multi-repo à 5 packages. Studio est aujourd'hui un monorepo pnpm à 7 packages. L'essentiel des décisions philosophiques reste valide — seule l'organisation concrète a évolué.

---

## Décisions

| Décision | Choix |
|----------|-------|
| Organisation | Monorepo pnpm workspaces (un seul repo git) |
| DB runtime | Configurable : SQLite (défaut local) \| PostgreSQL (production) \| InMemory (tests) |
| Configs | Fichiers YAML versionnés dans `.studio/` |
| UI | CLI-first (`studio run`), API HTTP pour machine-to-machine |
| LLM | Multi-provider : Anthropic, OpenAI, OpenAI Responses API, Mock |
| Language | TypeScript |
| Build | `pnpm build` à la racine — un seul build pour tout |

---

## Monorepo — 7 packages

```
Studio/
├── contracts/     # @studio-foundation/contracts — types, interfaces (ZERO dépendances)
├── anonymizer/    # @studio-foundation/anonymizer — détection et anonymisation PII
├── ralph/         # @studio-foundation/ralph — retry loop + validation
├── runner/        # @studio-foundation/runner — LLM providers, tool plugin runtime
├── engine/        # @studio-foundation/engine — orchestration pipeline, state machine, persistence
├── api/           # @studio-foundation/api — HTTP REST API (Fastify + Swagger UI)
├── cli/           # @studio-foundation/cli — interface terminal (composition root)
├── templates/     # Templates architecturaux (software, finance, analysis, data, conversation)
├── package.json   # Root workspace
└── pnpm-workspace.yaml
```

---

## Responsabilités

| Package | Responsabilité | Dépend de |
|---------|---------------|-----------|
| `@studio-foundation/contracts` | Types & interfaces partagés | rien |
| `@studio-foundation/anonymizer` | Détection PII + tokenisation | rien |
| `@studio-foundation/ralph` | RALPH loop : execute → validate → retry | contracts |
| `@studio-foundation/runner` | LLM calls, tool execution, streaming | contracts |
| `@studio-foundation/engine` | Orchestration pipeline, hooks, groups, persistence | contracts, ralph, runner, anonymizer |
| `@studio-foundation/api` | HTTP REST API, SSE, webhooks, intégrations | engine, runner, contracts |
| `@studio-foundation/cli` | Interface terminal, composition root | engine, runner, api, contracts |

---

## Graphe de dépendances

```
@studio-foundation/contracts ←──────────────────────────────────────────┐
       ↑                                                      │
       │                                                      │
@studio-foundation/anonymizer   @studio-foundation/ralph   @studio-foundation/runner           │
                          ↑               ↑                   │
                          └───────┬───────┘                   │
                                  │                           │
                           @studio-foundation/engine ────────────────────┘
                                  ↑
                           @studio-foundation/api
                                  ↑
                           @studio-foundation/cli
```

Pas de dépendance circulaire. `contracts` est la feuille. `cli` est le sommet.

**Exception documentée (INVARIANTS.md) :** `cli` importe aussi de `runner` et `api` directement — il est le composition root et doit instancier `ToolRegistry`, `ProviderRegistry`, `MCPClient`.

---

## Structure `.studio/` (côté utilisateur)

```
my-project/
├── .studio/                     # Studio vit ici (comme .git/)
│   ├── config.yaml              # Providers, defaults (gitignored)
│   ├── pipelines/               # *.pipeline.yaml
│   ├── agents/                  # *.agent.yaml
│   ├── contracts/               # *.contract.yaml
│   ├── tools/                   # *.tool.yaml
│   ├── skills/                  # *.skill.md
│   ├── inputs/                  # *.input.yaml
│   ├── integrations/            # *.integration.yaml
│   ├── registry.lock.json       # Versions tools (commité)
│   └── runs/                    # Données runtime (gitignored)
│       ├── runs.db              # SQLite (si db.type: sqlite)
│       ├── logs/                # JSONL
│       └── anonymization/       # Keymaps PII
└── src/                         # Code de l'app
```

`findStudioDir()` remonte les dossiers parents jusqu'à trouver `.studio/` — exactement comme `git` cherche `.git/`.

---

## Pipeline YAML — Format de référence

```yaml
name: feature-builder
on_pipeline_start:
  - command: "git status --short"
    inject_as: git_status

stages:
  - name: brief-analysis
    agent: analyst
    contract: brief-analysis
    ralph:
      max_attempts: 3
      retry_strategy: exponential
    context:
      include: [input]

  - group: implementation-review
    max_iterations: 3
    stages:
      - name: code-generation
        agent: coder
        contract: code-generation
        tools:
          required: [repo_manager.write_file]
        context:
          include: [input, previous_stage_output, group_feedback]
        hooks:
          on_stage_complete:
            - command: "npx tsc --noEmit 2>&1 | head -20"
              on_failure: reject
      - name: qa-review
        agent: analyst
        contract: qa-review
        context:
          include: [input, all_stage_outputs, group_feedback]
```

---

## Output Contract YAML — Validation

```yaml
name: code-generation
version: 1

schema:
  required_fields:
    - summary
    - files_changed

tool_calls:
  minimum: 1                         # Anti-théâtre : 0 tool calls = FAIL
  required_tools:
    - repo_manager.write_file        # Format point dans les contracts YAML
  maximum: 15                        # Détection de boucle infinie

post_validation:
  rejection_detection:
    field: status
    approved_values: [approved, success]
    rejected_values: [rejected, failed]
    details_field: issues
```

---

## Agent Profile YAML

```yaml
name: coder
provider: anthropic
model: claude-sonnet-4-20250514
temperature: 0.2

skills:
  - commit-conventions    # .studio/skills/commit-conventions.skill.md
  - react-patterns

plugins:
  - my-plugin             # Claude Code plugin (.mcp.json + skills/)

tools:
  - repo_manager-read_file    # Format tiret dans les agent YAML
  - repo_manager-write_file
  - git-commit
  - git-push

anonymize: true           # Activer PII anonymization pour cet agent
```

---

## Concepts critiques

**RALPH loop** — Execute → validate contre le contract → retry avec feedback enrichi si fail → repeat. La garantie de qualité.

**Anti-théâtre** — Si le contract exige `tool_calls.minimum: 1` et que l'agent a fait 0 tool calls, c'est un échec peu importe ce qu'il prétend dans son output. Les tool calls réels sont trackés par le runner.

**Groups** — Boucles de feedback multi-stages. Si le dernier stage rejette, le group redémarre depuis le début avec le feedback accumulé (`group_feedback`).

**Hooks** — Commandes shell déterministes à 4 points du lifecycle. `on_stage_start`, `on_stage_complete`, `pre_tool_use`, `post_tool_use`. `on_failure: warn | reject | fail`.

**Skills** — Fichiers `.skill.md` injectés automatiquement dans le system prompt des agents qui les déclarent. Pas de code — juste du markdown.

**PII Anonymization** — Middleware transparent dans le runner. Replace les données sensibles par des tokens avant envoi au LLM. Keymap local pour reconstruction post-run.

**`studio_run` tool** — Permet aux agents de spawner des sous-pipelines et d'attendre leur résultat. Wired via `RunSpawner` dans `EngineConfig`.

---

## État machine d'un stage

```
pending → running → success
                  → failed     (ralph exhausted, hook on_failure: fail)
                  → rejected   (post_validation, hook on_failure: reject)
                  → skipped
                  → cancelled  (AbortSignal)
```

`deriveStageStatus()` dans `engine/src/state/status-derivation.ts` est LA fonction critique. Mapping déterministe, un seul endroit.

---

## Critère de succès (inchangé depuis v5)

```
$ studio run feature-builder --input "Add a FAQ section to the About page"

[1/4] brief-analysis ............ ✓ (attempt 1/3)
[2/4] implementation-plan ....... ✓ (attempt 1/3)
[3/4] code-generation ........... ✓ (attempt 2/5) ← théâtre détecté, retry
[4/4] qa-review ................. ✓ (attempt 1/3)

Pipeline completed in 4m32s
Files changed: src/pages/about.tsx (+47 lines)

Run this 10 times. It passes 10 times. That's the point.
```

---

## Invariants architecturaux

Voir **INVARIANTS.md** pour la liste formelle. Les 3 plus importants :

1. **`contracts` est un leaf package.** Zero dépendance `@studio/*`. Si tu importes autre chose, c'est une erreur.
2. **`ralph` ne connaît pas `runner`.** L'`executor` est `() => Promise<T>`. ralph est agnostique.
3. **Le engine est domain-agnostic.** `StageKind = string`. Pas de `if (stage.kind === 'qa')` dans le engine.

---

## Pourquoi ce design est AI-friendly

Chaque package tient dans une context window. Un agent qui ouvre `ralph/` voit ~6 fichiers — contexte complet. Un changement dans `runner/` ne touche pas `engine/`. Les frontières sont strictes et vérifiables (`pnpm build` échoue si une dépendance inversée est introduite).

Le YAML est la source de vérité du domaine. Un agent qui lit un `.pipeline.yaml` comprend ce que fait le pipeline sans lire le code du engine. C'est intentionnel.

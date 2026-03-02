# Design — Stage Executor `script` (STU-114)

**Date:** 2026-03-01
**Issue:** [STU-114](https://linear.app/studioag/issue/STU-114)
**Status:** Approved

## Contexte

Wiki Creator (projet Python) a besoin de stages déterministes sans LLM — parsing EPUB, extraction regex/NLP, transformation de données. Ce pattern est générique et doit être supporté au niveau kernel.

## Décisions clés

- **Dispatch dans le runner** (pas l'engine) : l'engine reste domain-agnostic. Il appelle une fonction unifiée du runner. Le runner dispatch en interne selon le type d'executor.
- **`AgentRunResult` réutilisé** : `runScript()` retourne le même type que `runAgent()` avec `tool_calls: []`, `token_usage: undefined`. Zéro changement dans RALPH, validation, contracts core.
- **Stage-level executor** : `executor`, `script`, `runtime` sont sur le stage directement (pas dans un agent YAML séparé).

## Schema YAML

```yaml
# Nouveau stage script
- name: epub-ingestion
  kind: ingestion
  executor: script
  script: scripts/parse-epub.py
  runtime: python            # python | node | shell
  contract: book-context
  context:
    include: [input]

# Stage LLM existant (inchangé)
- name: code-generation
  agent: coder
  contract: code-generation
```

Règles :
- `executor` absent → comportement LLM actuel inchangé
- `agent` absent + `executor: script` → script path
- `script` et `runtime` requis si `executor: script`

## Architecture

### Fichiers touchés

| Fichier | Changement |
|---------|-----------|
| `contracts/src/pipeline.ts` | Ajouter `executor?`, `script?`, `runtime?` à `StageDefinition` |
| `runner/src/executor.ts` | **Nouveau** — entry point unifié `executeStage()` |
| `runner/src/script-executor.ts` | **Nouveau** — logique `runScript()` |
| `engine/src/engine.ts` | Remplacer appel `runAgent()` par `executeStage()` dans le closure RALPH |
| `runner/src/__tests__/script-executor.test.ts` | **Nouveau** — tests unitaires |
| `engine/src/__tests__/engine.script-stage.test.ts` | **Nouveau** — tests end-to-end |

### Flow d'exécution

```
Engine.executeStage()
  │
  ├─ charge agentConfig si stageDef.agent défini (inchangé)
  │
  └─ RALPH loop
       └─ executor closure → runner.executeStage(config)
                                    │
                                    ├─ stageDef.agent défini → runAgent() [LLM, inchangé]
                                    └─ stageDef.agent absent → runScript()
                                                                    │
                                                                    ├─ setupRuntime() [venv/npm]
                                                                    ├─ spawn process
                                                                    ├─ stdin: JSON.stringify(context)
                                                                    ├─ stdout: parse JSON → output
                                                                    └─ return AgentRunResult
```

## Interface stdin/stdout

```
stdin  → JSON.stringify(agentContext)   # input + previous_stage_output + etc.
stdout → JSON valide (validé par contract)
stderr → loggé comme warning (jamais fatal)
exit 0 → succès
exit ≠ 0 → error dans AgentRunResult → RALPH retry
stdout non-JSON → error dans AgentRunResult → RALPH retry
```

## Runtimes

| `runtime` | Commande |
|-----------|----------|
| `python` | `python3 <script>` |
| `node` | `node <script>` |
| `shell` | `sh <script>` |

## Gestion des dépendances

Détection one-time avant le premier spawn (pas sur chaque retry) :

- **Python** : `venv/` ou `.venv/` → active le venv. Sinon `requirements.txt` → `pip install -r requirements.txt --quiet`.
- **Node** : `package.json` présent + `node_modules/` absent → `npm install --silent`.
- **Shell** : rien.

Working directory : racine du projet (là où `.studio/` est trouvé).

## Gestion d'erreurs & RALPH retry

| Cas | `error` dans AgentRunResult | Résultat RALPH |
|-----|----------------------------|----------------|
| exit code ≠ 0 | `"Script exited with code 1: <stderr>"` | retry |
| stdout non-JSON | `"Script output is not valid JSON: ..."` | retry |
| timeout | `"Script timed out after 30000ms"` | retry |
| contract validation fail | — (géré par validator) | retry |
| `max_attempts` atteint | — | stage `failed` |

Timeout configurable via `timeout_ms` sur le stage (défaut : 30 000 ms).

Sur retry, RALPH enrichit le contexte avec `previousFailures` — sérialisé dans stdin, le script peut adapter son comportement.

## Invariants respectés

- **INV-04** : engine domain-agnostic — `executor: script` est une string, l'engine ne l'interprète pas
- **INV-03** : runner exécute, ne valide pas — `runScript()` suit le même pattern que `runAgent()`
- **INV-07** : state machine déterministe — script exit 0 → success, exit ≠ 0 → failed (via RALPH exhausted)

## Tests

### `runner/src/__tests__/script-executor.test.ts`
- Script Python retourne JSON valide → output parsé correctement
- Script Node exit 1 → `error` défini dans result
- Stdout non-JSON → `error` défini
- Timeout → `error` timeout
- Détection venv Python (mock filesystem)
- Retry context passé en stdin sur 2e tentative

### `engine/src/__tests__/engine.script-stage.test.ts`
- Stage `executor: script` exécuté end-to-end (spawnProcess mocké)
- RALPH retry si script exit ≠ 0
- Contract validation sur output script
- Hooks `on_stage_complete` s'exécutent après succès script

Pas de tests d'intégration réels (pas de Python/Node requis en CI) — spawns mockés via vi.mock.

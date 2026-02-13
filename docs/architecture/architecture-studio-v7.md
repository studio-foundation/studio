# Studio v7 — Architecture from scratch

## Decisions

| Decision | Choice |
|----------|--------|
| Strategy | Rewrite from scratch |
| Repos | Multi-repo avec parent repo |
| DB runtime | SQLite (Prisma) |
| Configs | YAML files (git-versionable) |
| UI | CLI-first, UI plus tard |
| LLM | Multi-provider dès le start |
| Deps en dev | Locales (chemins relatifs), npm plus tard |
| Language | TypeScript |

---

## Repos

### Parent repo: `studio-workspace`

Le repo qui clone et groupe tous les autres. Les sub-repos sont dans le `.gitignore`.

```
studio-workspace/
├── .gitignore              # Ignore tous les sub-repos
├── README.md
├── setup.sh                # Clone tous les repos + npm install
├── package.json            # Scripts globaux (test:all, lint:all)
│
├── contracts/              → git clone studio-contracts
├── ralph/                  → git clone studio-ralph
├── runner/                 → git clone studio-runner
├── engine/                 → git clone studio-engine
└── cli/                    → git clone studio-cli
```

---

### Repo 1: `studio-contracts` — Les types partagés

Le package leaf. Zéro dépendance. Tout le monde en dépend.

```
studio-contracts/
├── package.json            # @studio/contracts
├── tsconfig.json
├── ARCHITECTURE.md         # Context file pour AI agents
├── src/
│   ├── index.ts            # Export barrel
│   │
│   ├── pipeline.ts         # PipelineDefinition, StageDefinition
│   ├── stage.ts            # StageStatus, StageKind, StageResult
│   ├── task.ts             # TaskStatus, TaskResult, TaskConfig
│   ├── agent.ts            # AgentConfig, AgentProfile, ToolCall
│   ├── run.ts              # PipelineRun, StageRun, TaskRun, AgentRun
│   ├── validation.ts       # OutputContract, ValidationResult, ValidationRule
│   ├── provider.ts         # LLMProvider, LLMRequest, LLMResponse, ToolDefinition
│   └── errors.ts           # StudioError, error codes enum
│
└── tests/
    └── types.test.ts       # Type-level tests (compile-time checks)
```

**Fichiers estimés : ~10**
**Ce que c'est :** Les interfaces TypeScript pures. Aucune logique. Juste les contrats entre tous les composants.

**Pourquoi un repo séparé :** Tout le monde en dépend. Si ça change, c'est une décision architecturale, pas un refactor random.

---

### Repo 2: `studio-ralph` — Le RALPH loop engine

Le cœur philosophique de Studio. Retry intelligent avec validation.

```
studio-ralph/
├── package.json            # @studio/ralph
├── tsconfig.json
├── ARCHITECTURE.md         # Context file pour AI agents
├── src/
│   ├── index.ts            # Export barrel
│   │
│   ├── loop.ts             # ralph() — la fonction principale
│   │                       #   Prend: executor, validator, config
│   │                       #   Retourne: result (success/exhausted)
│   │                       #   Fait: execute → validate → retry if fail
│   │
│   ├── validator.ts        # Validation engine
│   │                       #   - validateOutput(output, contract): ValidationResult
│   │                       #   - validateToolCalls(run, requirements): ValidationResult
│   │                       #   - compose(...validators): Validator
│   │
│   ├── contracts.ts        # Chargement et parsing des output contracts YAML
│   │                       #   - loadContract(path): OutputContract
│   │                       #   - contractFromYaml(yaml): OutputContract
│   │
│   ├── retry-strategy.ts   # Stratégies de retry
│   │                       #   - fixedDelay(ms)
│   │                       #   - exponentialBackoff(base, max)
│   │                       #   - withPromptEscalation(strategies[])
│   │
│   └── context-enricher.ts # Enrichir le contexte entre retries
│                           #   - addFailureContext(prevResult, attempt): EnrichedContext
│                           #   - escalatePrompt(basePrompt, failures): string
│
├── tests/
│   ├── loop.test.ts        # Tests du RALPH loop (mock executor)
│   ├── validator.test.ts   # Tests validation (schemas, tool calls)
│   └── retry.test.ts       # Tests stratégies retry
│
└── configs/
    └── examples/
        ├── code-generation.contract.yaml   # Exemple: doit avoir tool_calls > 0
        └── analysis.contract.yaml          # Exemple: doit avoir summary + recommendations
```

**Fichiers estimés : ~12**
**Dépendances : `@studio/contracts`**

**C'est quoi `ralph()` concrètement :**
```typescript
async function ralph<T>(config: {
  executor: () => Promise<T>,
  validator: (result: T) => ValidationResult,
  maxAttempts: number,
  retryStrategy: RetryStrategy,
  onRetry?: (attempt: number, lastResult: T, failures: string[]) => void,
}): Promise<RalphResult<T>>
// RalphResult = { status: 'success', result: T, attempts: number }
//             | { status: 'exhausted', lastResult: T, failures: string[] }
```

**Pourquoi un repo séparé :** RALPH est réutilisable en dehors de Studio. C'est un pattern générique. Tu pourrais l'utiliser pour la banque TDAH, pour du git butler, pour n'importe quoi.

---

### Repo 3: `studio-runner` — L'agent runner multi-provider

La couche qui parle aux LLMs et exécute les tools.

```
studio-runner/
├── package.json            # @studio/runner
├── tsconfig.json
├── ARCHITECTURE.md         # Context file pour AI agents
├── src/
│   ├── index.ts            # Export barrel
│   │
│   ├── runner.ts           # runAgent(config): AgentRun
│   │                       #   - Construit le prompt
│   │                       #   - Appelle le provider
│   │                       #   - Parse la réponse
│   │                       #   - Exécute les tool calls
│   │                       #   - Retourne AgentRun complet
│   │
│   ├── providers/
│   │   ├── provider.ts     # Interface LLMProvider (abstract)
│   │   ├── openai.ts       # OpenAI implementation
│   │   ├── anthropic.ts    # Claude implementation
│   │   └── registry.ts     # getProvider(name): LLMProvider
│   │
│   ├── tools/
│   │   ├── tool-executor.ts    # executeTool(call, registry): ToolResult
│   │   ├── tool-registry.ts    # ToolRegistry — register/get tools
│   │   └── builtin/
│   │       ├── repo-manager.ts # read_file, write_file, list_files
│   │       ├── shell.ts        # run_command (sandboxed)
│   │       └── search.ts       # search_codebase (grep/ripgrep)
│   │
│   ├── prompt-builder.ts   # Assemble system prompt + context + task
│   │                       #   - buildPrompt(agent, stage, context): Messages[]
│   │
│   └── context/
│       ├── context-pack.ts     # Construit le context window
│       └── context-sources.ts  # File reader, previous outputs, etc.
│
├── tests/
│   ├── runner.test.ts          # Test avec mock provider
│   ├── openai.test.ts          # Integration test OpenAI
│   ├── anthropic.test.ts       # Integration test Claude
│   ├── tool-executor.test.ts   # Tests execution tools
│   └── prompt-builder.test.ts  # Tests assemblage prompts
│
└── configs/
    └── agents/
        ├── generic.agent.yaml      # Agent générique (le défaut)
        ├── code-generator.agent.yaml   # Profil code generation
        └── analyst.agent.yaml      # Profil analysis
```

**Fichiers estimés : ~18**
**Dépendances : `@studio/contracts`**

**Pourquoi séparé de ralph :** Le runner sait parler aux LLMs et exécuter des tools. Il ne sait PAS retry ni valider. RALPH appelle le runner comme executor. Séparation propre.

---

### Repo 4: `studio-engine` — L'orchestrateur de pipelines

Le cerveau. Charge une pipeline YAML, exécute les stages en séquence, coordonne ralph + runner.

```
studio-engine/
├── package.json            # @studio/engine
├── tsconfig.json
├── ARCHITECTURE.md         # Context file pour AI agents
├── src/
│   ├── index.ts            # Export barrel
│   │
│   ├── engine.ts           # PipelineEngine — la classe principale
│   │                       #   - loadPipeline(path): Pipeline
│   │                       #   - run(pipeline, input): PipelineRun
│   │                       #   - Pour chaque stage:
│   │                       #     1. Résout les tasks du stage
│   │                       #     2. Pour chaque task: ralph(runner.run, validator)
│   │                       #     3. deriveStageStatus(tasks)
│   │                       #     4. Propage context au stage suivant
│   │
│   ├── state/
│   │   ├── state-machine.ts    # Stage lifecycle: pending → running → success/failed
│   │   ├── status-derivation.ts # deriveStageStatusFromTasks() — TA FIX CRITIQUE
│   │   └── run-store.ts        # Persistence des runs (SQLite via Prisma)
│   │
│   ├── pipeline/
│   │   ├── loader.ts           # Charge pipeline YAML → PipelineDefinition
│   │   ├── stage-resolver.ts   # Résout les stages (séquentiel pour v7)
│   │   └── context-propagation.ts  # Output stage N → Input stage N+1
│   │
│   ├── db/
│   │   ├── prisma/
│   │   │   └── schema.prisma   # Schema: PipelineRun, StageRun, TaskRun, AgentRun
│   │   ├── client.ts           # Prisma client SQLite
│   │   └── migrations/         # Prisma migrations
│   │
│   └── events.ts           # EventEmitter pour hooks (onStageStart, onTaskComplete, etc.)
│
├── tests/
│   ├── engine.test.ts          # E2E avec mock runner
│   ├── state-machine.test.ts   # Tests state transitions
│   ├── status-derivation.test.ts # LE TEST CRITIQUE — stage/task sync
│   ├── loader.test.ts          # Tests chargement YAML
│   └── e2e/
│       └── feature-v5.test.ts  # LE TEST: FAQ sur About.tsx, 10/10 passes
│
├── pipelines/
│   └── feature-builder.pipeline.yaml   # La pipeline de référence
│
└── prisma/
    └── schema.prisma
```

**Fichiers estimés : ~18**
**Dépendances : `@studio/contracts`, `@studio/ralph`, `@studio/runner`, `prisma`**

**C'est le seul repo qui a une DB.** Les autres sont stateless.

---

### Repo 5: `studio-cli` — L'interface

Le point d'entrée. Commandes simples qui appellent le engine.

```
studio-cli/
├── package.json            # @studio/cli (bin: "studio")
├── tsconfig.json
├── ARCHITECTURE.md         # Context file pour AI agents
├── src/
│   ├── index.ts            # Entry point — parse args, dispatch
│   │
│   ├── commands/
│   │   ├── run.ts          # studio run <pipeline> [--input "..."]
│   │   ├── validate.ts     # studio validate <contract> <output>
│   │   ├── list.ts         # studio list pipelines|agents|runs
│   │   ├── status.ts       # studio status [run-id]
│   │   └── init.ts         # studio init — setup un nouveau projet
│   │
│   ├── output/
│   │   ├── formatter.ts    # Pretty print pour terminal
│   │   ├── logger.ts       # Structured logging (JSON ou pretty)
│   │   └── progress.ts     # Progress bar / stage tracker
│   │
│   └── config.ts           # Charge .studiorc.yaml (providers, paths, etc.)
│
├── tests/
│   └── commands/
│       ├── run.test.ts
│       └── status.test.ts
│
└── templates/
    ├── .studiorc.yaml          # Template config
    └── pipelines/
        └── hello-world.pipeline.yaml   # Pipeline de démo
```

**Fichiers estimés : ~12**
**Dépendances : `@studio/contracts`, `@studio/engine`**

---

## Résumé des repos

| Repo | Package | Responsabilité | Dépend de | Fichiers |
|------|---------|---------------|-----------|----------|
| `studio-contracts` | `@studio/contracts` | Types & interfaces | rien | ~10 |
| `studio-ralph` | `@studio/ralph` | RALPH loop + validation | contracts | ~12 |
| `studio-runner` | `@studio/runner` | LLM calls + tool execution | contracts | ~18 |
| `studio-engine` | `@studio/engine` | Pipeline orchestration + DB | contracts, ralph, runner | ~18 |
| `studio-cli` | `@studio/cli` | Interface terminal | contracts, engine | ~12 |
| `studio-workspace` | — | Parent repo (groupe tout) | — | ~3 |

**Total estimé : ~73 fichiers** (vs 810 dans la v6)

---

## Graphe de dépendances

```
                    @studio/contracts
                    /       |        \
                   /        |         \
          @studio/ralph  @studio/runner  |
                   \        /            |
                    \      /             |
                  @studio/engine         |
                        |               /
                        |              /
                    @studio/cli ------
```

Pas de dépendance circulaire. Contracts est le leaf. Engine est le hub. CLI est le top.

---

## Pipeline YAML — Le format

```yaml
# pipelines/feature-builder.pipeline.yaml
name: feature-builder
description: Build a feature from A to Z
version: 1

stages:
  - name: brief-analysis
    kind: analysis
    agent: analyst
    contract: analysis.contract.yaml
    ralph:
      max_attempts: 3
      retry_strategy: exponential
    context:
      include:
        - input
        - repo_structure

  - name: architecture
    kind: planning
    agent: analyst
    contract: architecture.contract.yaml
    ralph:
      max_attempts: 3
    context:
      include:
        - input
        - previous_stage_output

  - name: code-generation
    kind: code_generation
    agent: code-generator
    contract: code-generation.contract.yaml
    ralph:
      max_attempts: 5            # Plus de retries — le théâtre est fréquent
      retry_strategy: prompt_escalation
    tools:
      required:                   # MANDATORY tool calls
        - repo_manager.write_file
    context:
      include:
        - input
        - previous_stage_output
        - repo_files

  - name: qa-validation
    kind: qa
    agent: analyst
    contract: qa.contract.yaml
    ralph:
      max_attempts: 3
    context:
      include:
        - input
        - all_stage_outputs
```

---

## Output Contract YAML — Validation

```yaml
# configs/contracts/code-generation.contract.yaml
name: code-generation
version: 1

schema:
  required_fields:
    - summary
    - files_changed
  files_changed:
    min_items: 1
    item_schema:
      required: [path, action, content]

tool_calls:
  minimum: 1
  required_tools:
    - repo_manager.write_file
  # Anti-théâtre: si l'agent dit avoir changé des fichiers
  # mais tool_calls = 0, c'est un FAIL automatique

custom_rules:
  - name: no-theatre
    description: "Agent must actually call tools, not just describe calling them"
    check: "tool_calls_count > 0 OR stage_kind != code_generation"
```

---

## Agent Profile YAML

```yaml
# configs/agents/code-generator.agent.yaml
name: code-generator
description: Generates and writes code to the repository
provider: anthropic    # ou openai — multi-provider
model: claude-sonnet-4-20250514

system_prompt: |
  You are a code generation agent. Your job is to write code to files.

  CRITICAL RULES:
  - You MUST use tool calls to write files. Do NOT describe what you would write.
  - Every file change MUST go through repo_manager.write_file
  - If you output files_changed without calling write_file, you have FAILED.
  - tool_calls = 0 on a code generation task is ALWAYS a failure.

tools:
  - repo_manager.read_file
  - repo_manager.write_file
  - repo_manager.list_files
  - shell.run_command
  - search.search_codebase

temperature: 0.2    # Low temperature pour code gen
max_tokens: 8000
```

---

## Ordre de build

```
Phase 1: Foundation          (semaine 1)
  → studio-contracts         Types, interfaces
  → studio-workspace         Parent repo setup

Phase 2: Core loop           (semaine 2)
  → studio-ralph             RALPH loop + validation
  → tests: loop avec mock executors

Phase 3: Agent execution     (semaine 3)
  → studio-runner            Multi-provider + tools
  → tests: runner avec mock LLM + real tool calls

Phase 4: Orchestration       (semaine 4)
  → studio-engine            Pipeline engine + SQLite
  → tests: engine avec mock runner

Phase 5: Integration         (semaine 5)
  → studio-cli               Interface terminal
  → test E2E: feature-v5 (FAQ sur About.tsx)
  → objectif: 10/10 passes
```

---

## Critère de succès

```
$ studio run feature-builder --input "Add a FAQ section to the About page"

[1/4] brief-analysis ............ ✓ (attempt 1/3)
[2/4] architecture .............. ✓ (attempt 1/3)
[3/4] code-generation ........... ✓ (attempt 2/5) ← 1 retry, anti-theatre caught
[4/4] qa-validation ............. ✓ (attempt 1/3)

Pipeline completed in 4m32s
Files changed: src/pages/About.tsx (+47 lines)

Run this 10 times. It passes 10 times.
```

---

## AI-First Iterability

### Pourquoi cette architecture est AI-friendly

**Problème v6 :** 810 fichiers, context window explosée, l'agent voit pas l'ensemble, génère du code qui casse des trucs ailleurs.

**Solution v7 :** Chaque repo tient dans une context window (~10-18 fichiers). L'agent voit TOUT le repo d'un coup. Pas d'angle mort.

### Workflow d'itération

**Changement dans un seul repo (90% des cas) :**
```
1. Ouvre le repo dans Cursor (ex: studio-ralph/)
2. Cursor voit ~12 fichiers — contexte complet
3. Itère, teste, commit
4. Feedback loop: secondes, pas minutes
```

**Changement cross-repo (10% des cas) :**
```
1. Ouvre studio-workspace/ dans Cursor
2. Cursor voit tous les sub-repos
3. Modifie contracts → update les consumers
4. Teste au niveau workspace (npm run test:all)
```

**Séparation interne/externe (préservée) :**
```
INTERNE (Claude pense) :
  → Analyse l'architecture
  → Identifie le problème
  → Produit un prompt Cursor précis
  → Le prompt est petit parce que le scope est petit

EXTERNE (Cursor exécute) :
  → Reçoit un prompt de 20 lignes (pas 200)
  → Voit tout le repo target
  → Exécute stupidement et fidèlement
  → Tests passent ou pas — feedback clair
```

### Règle : un prompt Cursor = un repo

Le multi-repo force une discipline naturelle : chaque prompt Cursor cible UN repo. Pas de "modifie 3 packages en même temps". Si un changement touche plusieurs repos, c'est plusieurs prompts séquentiels, chacun testable isolément.

### ARCHITECTURE.md — Le system prompt du repo

Chaque repo contient un `ARCHITECTURE.md` (~20 lignes) que Cursor/Claude Code lit EN PREMIER. C'est le briefing de l'agent avant qu'il touche au code.

---

## ARCHITECTURE.md Templates

### studio-contracts/ARCHITECTURE.md

```markdown
# @studio/contracts

Types et interfaces partagés par tous les packages Studio. ZERO logique.

## Règles
- Ce package n'a AUCUNE dépendance
- JAMAIS de logique, uniquement des types/interfaces/enums TypeScript
- Tout changement ici impacte TOUS les autres repos — être conservateur
- Exporter tout depuis index.ts

## Fichiers clés
- pipeline.ts — PipelineDefinition, StageDefinition
- stage.ts — StageStatus, StageKind, StageResult
- task.ts — TaskStatus, TaskResult
- agent.ts — AgentConfig, ToolCall
- run.ts — PipelineRun, StageRun, TaskRun, AgentRun
- validation.ts — OutputContract, ValidationResult
- provider.ts — LLMProvider, LLMRequest, LLMResponse
- errors.ts — StudioError, codes d'erreur

## Test
npm test → compile-time type checks uniquement
```

### studio-ralph/ARCHITECTURE.md

```markdown
# @studio/ralph

RALPH loop engine — retry intelligent avec validation.
"Recursive Automated Loop for Persistent Handling" (Ralph Wiggum approved)

## Concept
ralph() prend un executor et un validator. Il execute, valide, retry si fail.
C'est tout. C'est générique. Ça marche pour n'importe quoi, pas juste des LLMs.

## Règles
- ralph() est UNE fonction. Pas une classe, pas un framework.
- La validation est composable (compose(...validators))
- Les stratégies de retry sont pluggables
- JAMAIS de dépendance sur runner ou engine — ralph est agnostique
- Dépend UNIQUEMENT de @studio/contracts

## Fichiers clés
- loop.ts — ralph() la fonction principale
- validator.ts — moteur de validation + composition
- contracts.ts — chargement output contracts YAML
- retry-strategy.ts — fixed, exponential, prompt escalation
- context-enricher.ts — enrichir contexte entre retries

## Anti-patterns
- NE PAS mettre de logique LLM ici
- NE PAS importer @studio/runner
- NE PAS hardcoder des règles de validation — tout vient des contracts YAML
```

### studio-runner/ARCHITECTURE.md

```markdown
# @studio/runner

Agent runner multi-provider. Parle aux LLMs, exécute les tools.

## Concept
runAgent() prend un AgentConfig + context, appelle le LLM, exécute les tool calls,
retourne un AgentRun complet avec les vrais tool_calls trackés.

## Règles
- Multi-provider : OpenAI et Claude dès le start, même interface
- Les tools sont dans un registry pluggable
- CHAQUE tool call réel est tracké dans AgentRun.tool_calls
- Le runner ne valide PAS — c'est le job de ralph
- Le runner ne retry PAS — c'est le job de ralph
- Dépend UNIQUEMENT de @studio/contracts

## Fichiers clés
- runner.ts — runAgent() fonction principale
- providers/ — OpenAI, Anthropic, registry
- tools/ — tool executor, registry, builtins (repo_manager, shell, search)
- prompt-builder.ts — assemblage system prompt + context + task
- context/ — construction du context window

## Anti-pattern critique : LE THÉÂTRE
Le problème #1 de la v6 : les agents génèrent du JSON décrivant des actions
au lieu de FAIRE les actions (tool_calls: 0). Le runner DOIT tracker les
tool calls réels. La validation du théâtre est dans ralph, mais le runner
fournit les données (tool_calls count) pour que ralph puisse détecter.
```

### studio-engine/ARCHITECTURE.md

```markdown
# @studio/engine

Orchestrateur de pipelines. Le cerveau de Studio.

## Concept
Charge une pipeline YAML → exécute les stages en séquence →
pour chaque task: ralph(runner.run, validator) → persiste les runs en SQLite.

## Règles
- UN pipeline = séquence de stages (pas de DAG pour la v7, KISS)
- deriveStageStatusFromTasks() est LA fonction critique — elle doit être
  déterministe et testée exhaustivement
- La DB (SQLite) est UNIQUEMENT dans ce repo
- Context propagation : output stage N → input stage N+1
- Events (onStageStart, etc.) pour hooks futurs (UI, logging)

## Fichiers clés
- engine.ts — PipelineEngine, la classe principale
- state/state-machine.ts — lifecycle des stages
- state/status-derivation.ts — deriveStageStatusFromTasks() ← CRITIQUE
- state/run-store.ts — persistence SQLite via Prisma
- pipeline/loader.ts — charge YAML → PipelineDefinition
- pipeline/context-propagation.ts — passe le contexte entre stages

## Le test qui compte
tests/e2e/feature-v5.test.ts — FAQ sur About.tsx, doit passer 10/10.
Si ce test passe pas de façon fiable, rien d'autre compte.

## Dépendances
@studio/contracts, @studio/ralph, @studio/runner
```

### studio-cli/ARCHITECTURE.md

```markdown
# @studio/cli

Interface terminal pour Studio. Thin wrapper sur engine.

## Règles
- ZERO logique métier — tout est dans engine
- Pretty output pour humains, JSON pour machines (--json flag)
- Commandes simples et évidentes
- Dépend de @studio/contracts et @studio/engine (PAS de ralph/runner direct)

## Fichiers clés
- commands/run.ts — studio run <pipeline> [--input "..."]
- commands/validate.ts — studio validate <contract> <output>
- commands/list.ts — studio list pipelines|agents|runs
- commands/status.ts — studio status [run-id]
- commands/init.ts — studio init (setup nouveau projet)
- output/ — formatter, logger, progress bar

## Usage
$ studio run feature-builder --input "Add FAQ to About page"
$ studio status last
$ studio list runs --failed
```
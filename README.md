# Studio

**Studio runs AI pipelines. It knows nothing about your code, your domain, or your model. That's the design.**

A declarative YAML runtime for AI agents. Studio handles agent orchestration, structured output validation, parallel execution, and generation-validation loops from a config file — not yet another agent framework with Python decorators and graph builders. The engine doesn't care whether you're building software, parsing books, planning meals, or analyzing transactions: domain logic lives entirely in your configs.

```yaml
# pipelines/feature-builder.pipeline.yaml
name: feature-builder
stages:
  - name: brief-analysis
    agent: analyst
    contract: brief-analysis

  - group: implementation-review
    max_iterations: 3
    stages:
      - name: code-generation
        agent: coder
        contract: code-generation     # requires tool_calls.minimum: 1
      - name: qa-review
        agent: analyst
        contract: qa-review           # rejects → group restarts with feedback
```

```
$ studio run feature-builder --input "Add a FAQ section to the About page"

[1/2] brief-analysis ............ ✓ (attempt 1/3)
[2/2] implementation-review ..... ✓ (iteration 2/3)
       ├── code-generation ...... ✓ (attempt 2/5) ← retry: theatre detected
       └── qa-review ............ ✓ (attempt 1/2)

Pipeline completed in 4m32s
Files changed: src/pages/About.tsx (+47 lines)
```

Run it ten times, you get ten correct outputs. That's what the contracts and retries are for.

---

## Why Studio

The agent framework crowd — LangGraph, CrewAI, Autogen — all share a premise: agent orchestration is code. Studio's premise is the opposite. Trade-offs are explicit:

| Framework | Config surface | Validation | Parallelism | License |
|-----------|---------------|------------|-------------|---------|
| LangGraph | Python code (graph builders) | Custom per node | Manual via subgraphs | MIT |
| CrewAI | Python code (decorators, roles) | Ad-hoc | Built-in, sequential default | MIT |
| Autogen | Python code (conversation) | Ad-hoc | Conversation-driven | MIT |
| **Studio** | **YAML configs** | **Structured output contracts, binary pass/fail** | **Declarative parallel groups** | **AGPL-3.0** |

If your tool is one of the first three, you wrote code that constructs a graph or registers decorators. If your tool is Studio, you wrote a YAML file someone non-technical can read, audit, and modify without touching a programming environment. The trade-off is intentional, not accidental.

---

## Three patterns

The patterns below are why Studio exists. Each is declarative — you describe what you want in YAML, the engine handles the agent orchestration. Both [Wiki Creator](https://github.com/studio-foundation/wiki-creator) and [Little Chef](https://github.com/studio-foundation/little-chef-by-studio) lean on these in production.

### Generation-validation groups

One stage produces, another critiques. If the critic rejects, the group restarts from the top with accumulated feedback. Max N iterations. Anti-theatre applied to creativity itself: the generator can't claim success the reviewer didn't grant.

```yaml
- group: implementation-review
  max_iterations: 3
  stages:
    - name: code-generation
      agent: coder
      contract: code-generation
    - name: qa-review
      agent: reviewer
      contract: qa-review            # post_validation.rejection_detection
```

Rejection isn't a stage failure, it's a status — configured in the contract YAML, not hardcoded. The group restarts with `group_feedback` injected into the next iteration's context.

### Parallel groups

Fan-out / fan-in declared in YAML. Stages run concurrently, results are accumulated for the next stage.

```yaml
- group: enrichment
  mode: parallel
  stages:
    - name: extract-entities
      agent: nlp-worker
      contract: entities
    - name: extract-relations
      agent: nlp-worker
      contract: relations
    - name: extract-themes
      agent: nlp-worker
      contract: themes
```

No async/await boilerplate. No promise plumbing. The engine handles concurrency and result merging.

### Tool-call verification (anti-theatre)

Structured output validation, taken one step further. Tool calls are tracked by the runner, not self-reported by the agent. If a stage's contract says "must call `repo_manager.write_file` at least once" and the agent made zero such calls, the stage fails — regardless of what its output claims.

```yaml
# contracts/code-generation.contract.yaml
schema:
  required_fields: [summary, files_changed]

tool_calls:
  minimum: 1
  required_tools:
    - repo_manager.write_file
```

This catches the most common failure mode of agent pipelines: the model writes a summary that says "I created `src/foo.ts`" when it never made the tool call. Studio rejects that output. The retry attempt receives the failure as feedback.

---

## How it works

A pipeline is a YAML file. It declares stages and groups. Each stage references an **agent** (a runtime config — which model, which system prompt, which tools) and an **output contract** (a JSON schema plus optional constraints like tool-call minimums).

The engine executes each stage through the **RALPH loop**: execute → validate → pass advances, fail retries with enriched feedback, bounded by `max_attempts`. No stage advances until its contract passes.

```
Pipeline (YAML)
  ├── Stage → execute → validate → pass? next : retry
  └── Group → iterate stages → check rejection → restart? : exit
```

State machine: `pending → running → success | failed | rejected | skipped`. The distinction between `failed` (contract validation failed) and `rejected` (contract validated but the verdict is negative, e.g. QA rejected) is configured in the contract, not hardcoded.

---

## Quick start

```bash
npm install -g @studio-foundation/cli@beta

# Create a project directory and initialize from a template
mkdir my-builder && cd my-builder
studio init --template software --name my-builder
```

`studio init` generates the full project structure: `.studio/` with pipelines, contracts, agents, and tools, plus the app scaffold (`src/`, `package.json`) from the template. It initializes git and updates `.gitignore`.

```bash
# Configure your provider
studio config set provider anthropic --api-key $ANTHROPIC_API_KEY

# Install dependencies and run
npm install
studio run software/feature-builder --input "Add dark mode support"
```

---

## Architecture

```
@studio-foundation/cli          → Terminal interface
    │
@studio-foundation/api          → HTTP REST API (Fastify)
    │
@studio-foundation/engine       → Pipeline orchestration, state machine
    │
    ├── @studio-foundation/ralph        → Execute, validate, retry
    ├── @studio-foundation/runner       → LLM calls, tool plugin runtime
    └── @studio-foundation/anonymizer   → PII anonymization middleware
    │
@studio-foundation/contracts    → Shared types (zero dependencies)
```

Seven packages, one monorepo. Each fits in a single context window. Each is testable in isolation. ralph doesn't know runner. runner doesn't know engine. contracts is a leaf. The dependency graph is the architecture; the architecture is the project's politics.

**Build from source:**

```bash
git clone https://github.com/studio-foundation/studio
cd studio
pnpm install
pnpm build
```

---

## Commitments

These aren't features. They're constraints the project refuses to relax.

**Domain-agnostic.** The engine has zero knowledge of what domain it operates in. It doesn't know what "code" or "transactions" or "recipes" mean. All domain knowledge lives in YAML configs. No use case can claim ownership of the kernel.

**Provider-agnostic.** Anthropic, OpenAI, Mock — swappable per agent without touching pipeline logic. The orchestration layer doesn't depend on who does the work. It depends on the work being done correctly.

**AGPL-3.0.** You can build commercial products on Studio. Use it, extend it, sell what you build. If you modify Studio itself and run the modified version as a network service, you must publish your changes under the same license. Using Studio as a dependency does not require you to open-source your application — the AGPL applies to Studio's code, not to the configs and application code you write on top.

The kernel is a commons by design. The license is the mechanism that keeps it that way. See [PHILOSOPHY.md](./PHILOSOPHY.md) for the political grounding.

---

## Projects powered by Studio

| Project | What it does | Template |
|---------|-------------|----------|
| [Wiki Creator](https://github.com/studio-foundation/wiki-creator) | Extracts entities, relationships, and generates wiki pages from EPUB books using NLP + LLM pipelines | `analysis` |
| [Little Chef](https://github.com/studio-foundation/little-chef-by-studio) | AI meal planner: researches cuisines, develops recipes with nutritional profiles, generates grocery lists | `software` |

Both run a hybrid stack: domain logic in external scripts (Python for Wiki Creator, Next.js + Prisma for Little Chef) orchestrated by Studio pipelines. The engine stays domain-agnostic; the configs do the domain work.

---

## Documentation

| Document | Content |
|----------|---------|
| [CONCEPTS.md](./CONCEPTS.md) | RALPH loop, output contracts, anti-theatre, groups, hooks, skills, architecture deep dive |
| [TEMPLATES.md](./TEMPLATES.md) | The 5 architectural templates: software, finance, analysis, data, conversation |
| [CLI.md](./CLI.md) | All CLI commands, `.studio/` structure, config format |
| [API.md](./API.md) | HTTP endpoints, SSE streaming, webhooks |
| [INVARIANTS.md](./INVARIANTS.md) | Non-negotiable kernel rules |
| [PHILOSOPHY.md](./PHILOSOPHY.md) | Political anchoring, open source as structural choice, governance principles |

---

## Community registry

[studio-community](https://github.com/studio-foundation/studio-community) is the shared registry for tools, templates, pipelines, integrations, agents, plugins, and skills. Open publish, no review gate.

```bash
studio registry search <query>
studio registry install <name>
studio registry publish <path>      # forks the registry repo and opens a PR
```

---

## Status

**Studio is in beta (v0.4.0).** The core works (RALPH loop, pipeline engine, groups, hooks, tools, multi-provider, CLI, API) but expect rough edges, breaking changes, and missing pieces. The architecture is stable; the surface is still moving.

**Current priority:** Code Builder end-to-end, Linear webhook to pipeline run to commit + PR.

**Known limitations:**
- Only the `software` template is production-ready. `finance`, `analysis`, `data`, and `conversation` are structural starters with stub tools.
- No template upgrade path yet. Once generated, manual sync only.
- Error messages are sometimes cryptic. Improving progressively.
- Documentation may lag behind implementation.

If you hit something broken, that's expected at this stage. [Open an issue.](https://github.com/studio-foundation/studio/issues)

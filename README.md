# Studio

**Reliable AI pipelines for complex work.**

Studio is a governance framework that orchestrates AI agents into reliable, repeatable workflows. Define pipelines in YAML, plug in any LLM, and let Studio handle validation, retries, and quality enforcement. Not just for code — for any domain where AI needs to produce trustworthy results.

```
$ studio run software/feature-builder --input "Add a FAQ section to the About page"

[1/4] brief-analysis ............ ✓ (attempt 1/3)
[2/4] implementation-plan ....... ✓ (attempt 1/3)
[3/4] code-generation ........... ✓ (attempt 2/5) ← retry: theatre detected
[4/4] qa-review ................. ✓ (attempt 1/3)

Pipeline completed in 4m32s
Files changed: src/pages/About.tsx (+47 lines)
```

Run this 10 times. It passes 10 times. That's the point.

---

## `git` for AI pipelines

Studio is to AI orchestration what `git` is to version control: an invisible tool that lives in a dot-directory, installs globally, and does its job without being a platform.

```
git init          →  studio init
.git/             →  .studio/
git commit        →  studio run
git push          →  (API hosted, later)
GitHub            →  Studio Cloud (commercial product)
git hooks         →  Tool plugins (.tool.yaml)
GitHub Actions    →  Community registry
```

You install Studio. You run `studio init`. A `.studio/` directory appears. You configure your pipelines in YAML. You run them from the terminal. That's it.

No framework to learn. No platform to depend on. No repo to fork. Just a tool.

---

## The problem

AI agents are powerful but unreliable. They hallucinate results, skip steps they claim to have completed, and produce outputs that look correct but aren't. The industry's answer is either "trust the model" or "put a human on every step."

Studio takes a different position: **verify structurally, retry automatically, trust nothing.**

## How it works

Studio breaks work into **stages** with explicit **output contracts**. Each stage runs through a **RALPH loop** — execute, validate against the contract, retry with escalated feedback if validation fails. No stage advances until its output is proven correct.

```
Pipeline (YAML)
  └── Stage 1 → RALPH: execute → validate → pass? next : retry
  └── Stage 2 → RALPH: execute → validate → pass? next : retry
  └── Stage 3 → RALPH: execute → validate → pass? next : retry
  └── ...
```

The agents do the work. The kernel governs the work. The agents are never sovereign.

---

## Not just code

Studio is domain-agnostic. The pipeline engine doesn't care what the agents are doing — it cares that the output contracts are satisfied.

### Code Builder

Build features, fix bugs, extend existing code — with structural validation that catches agents faking work.

```yaml
# pipelines/feature-builder.pipeline.yaml
stages:
  - name: brief-analysis
    agent: analyst
    contract: brief-analysis
  - name: implementation-plan
    agent: analyst
    contract: implementation-plan
  - group: implementation-review
    max_iterations: 3
    stages:
      - name: code-generation
        agent: coder
        contract: code-generation
        tools:
          required: [repo_manager-write_file]
      - name: qa-review
        agent: analyst
        contract: qa-review
```

### Recipe Generator

Create recipes from user descriptions, with iterative critique and refinement. Uses a feedback loop group to ensure quality.

```yaml
# pipelines/recipe-generator.pipeline.yaml
stages:
  - name: ingredient-analysis
    agent: chef
    contract: ingredient-check
  - name: recipe-plan
    agent: chef
    contract: recipe-plan
  - group: creation-review
    max_iterations: 3
    stages:
      - name: recipe-creation
        agent: chef
        contract: recipe-output
      - name: recipe-critique
        agent: chef
        contract: recipe-critique
```

### What else can you build?

Studio is a pipeline creator. Anyone can add new pipelines for any domain:

- **Git Butler** — Rewrite messy git history into clean, reviewable commits. Analyze diffs, identify logical boundaries, rebase automatically, validate integrity.
- **ADHD Finance** — Help neurodivergent people manage money by automating categorization, splitting accounts, and ensuring bills are covered before impulse spending happens.
- **Wiki Creator** — Analyze books and build structured wikis. Extract entities, map relationships, generate cross-referenced pages.
- **Legal Document Analyzer** — Parse contracts, identify clauses, flag risks, generate summaries.
- **Data Pipeline Validator** — Analyze ETL jobs, validate transformations, ensure data integrity.

Same engine. Different pipelines. Different contracts. Different agents. Studio doesn't care about the domain — it cares that the output is proven correct.

---

## Quick start

```bash
npm install -g @studio/cli

cd your-project
studio init --template software
studio config set provider anthropic --api-key $ANTHROPIC_API_KEY

studio run software/feature-builder --input "Add dark mode support"
```

### Project structure

After `studio init`, everything lives in `.studio/` — just like `.git/`:

```
your-project/
├── .studio/                          # All Studio config lives here
│   ├── config.yaml                   # Provider config (gitignored)
│   ├── projects/
│   │   └── <project>/
│   │       ├── pipelines/            # Pipeline definitions (YAML)
│   │       ├── contracts/            # Output contracts (YAML)
│   │       ├── agents/               # Agent profiles (YAML)
│   │       ├── tools/                # Tool plugins (YAML)
│   │       └── inputs/               # Input file examples (YAML)
│   ├── registry.lock.json            # Tool versions (committed)
│   └── runs/                         # Runtime data (gitignored)
├── src/                              # Your project files
└── ...
```

Studio finds `.studio/` by walking up the directory tree, just like `git` finds `.git/`.

---

## Core concepts

**Pipeline** — A sequence of stages that transforms input into validated output. Defined in YAML. Versioned in Git. Domain-agnostic.

**Stage** — One step in a pipeline. Each stage has an agent, an output contract, and RALPH retry settings.

**Output contract** — A structural schema that defines what a stage must produce. Validation is binary: pass or fail.

**RALPH loop** — The retry engine. Execute → validate → retry with escalated feedback → repeat until pass or max attempts.

**Agent** — An LLM configuration: provider, model, tools, system prompt. Agents are interchangeable and never sovereign.

**Anti-theatre** — Validation constraints that catch agents faking work. If a code generation stage claims to have written files but made zero tool calls, it fails regardless of what it says in its output.

**Kernel** — The governance layer. The kernel decides, the agents execute. The kernel is a constitution, not an implementation.

**Groups** — Multi-stage feedback loops within a pipeline. A group contains multiple stages (e.g., code-generation + qa-review) that execute in iterations. If the last stage rejects (via post-validation), the group reruns from the start with accumulated feedback. Maximum iterations set via `max_iterations`. Groups enable creation-critique-revision workflows without manual intervention.

**Tool Plugin** — A `.tool.yaml` file that defines a set of commands available to agents. Each plugin contains its parameters, execution logic (shell or builtin), a prompt snippet, and its constraints. The prompt snippet is automatically injected into the agent's system prompt — the tool documents itself. Creating a tool requires no code — just YAML.

---

## Tool Plugins

Tool plugins are the extension system. Any capability an agent needs — calling an API, running a script, querying a database — can be packaged as a self-contained `.tool.yaml` file. Like git hooks, but for AI agents.

```yaml
# .studio/projects/cuisine/tools/nutrition.tool.yaml
name: nutrition
description: Nutritional analysis tools
version: 1

commands:
  - name: nutrition-analyze
    description: Analyze nutritional content of a recipe
    parameters:
      ingredients:
        type: array
        items: string
        required: true
      servings:
        type: integer
        required: false
    execute:
      type: shell
      command: |
        echo '{{ingredients | json}}' | nutrition-api --servings={{servings}}
      parse_output: json

prompt_snippet: |
  You have access to nutrition tools. Always verify nutritional content before finalizing a recipe.

constraints:
  requires_binaries: [nutrition-api]
```

Three things make this powerful:

**Self-documenting.** The `prompt_snippet` is automatically injected into the system prompt of any agent that has access to the tool. The tool explains itself. Zero config on the pipeline side.

**Project-scoped.** Each project has its own `tools/` folder. The cuisine project has nutrition tools. The software project has git tools. They never cross. Agents only access what their project allows.

**Double-gated.** The project authorizes which tool groups are available. The agent YAML authorizes which specific tools it can call. Two layers of access control, both declarative.

---

## Provider-agnostic

```yaml
# .studio/config.yaml
providers:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
  openai:
    apiKey: ${OPENAI_API_KEY}

defaults:
  provider: anthropic
  model: claude-sonnet-4-20250514
```

Different agents can use different providers. Switch models without changing pipeline logic. The orchestration layer doesn't depend on who does the work — it depends on the work being done correctly.

---

## Architecture

```
@studio/cli          → User interface (terminal)
    │
@studio/engine       → Pipeline orchestration, state, governance
    │
    ├── @studio/ralph    → Execute, validate, retry
    │
    └── @studio/runner   → LLM calls, tool plugin runtime, multi-provider
    │
@studio/contracts    → Shared types (zero dependencies)
```

Five packages in a single monorepo. Each fits in a single context window. Each is testable in isolation. The runner is a tool plugin runtime — it loads `.tool.yaml` files and executes them alongside LLM calls. The engine never touches tool logic directly.

---

## CLI

The CLI is the primary interface. Like `git`, it handles both setup and daily use.

```bash
# Daily use
studio run <project/pipeline> --input "..."     # Run a pipeline
studio run <project/pipeline> --dry-run         # Validate without calling LLMs
studio status [run-id]                          # Check run status
studio list pipelines                           # List available pipelines
studio validate <contract> <output>             # Validate output against contract

# Setup & config
studio init                                     # Initialize .studio/ in current directory
studio config set provider anthropic --api-key $KEY
studio config list                              # Show config (API keys masked)
studio tools list                               # List tools in current project
studio tools add git --project software         # Install a tool plugin
studio tools info git                           # Show tool details
```

---

## API

The API is for machine-to-machine usage — when there's no human at the terminal. Same engine, different interface. Like GitHub is to `git`.

- **Linear** — Drag an issue to "In Progress" → Studio auto-launches the matching pipeline → results posted as comment → issue moves to "Done"
- **CI/CD** — Trigger pipelines from GitHub Actions
- **Webhooks** — Receive HTTP notifications on pipeline events (start, complete, reject, fail)
- **SSE** — Stream pipeline progress in real-time to dashboards or bots

The CLI is free forever (like `git`). The hosted API is the monetizable product (like GitHub).

---

## Philosophy

Studio is an explicitly political project.

The productivity gains from AI are real. But left unchecked, they follow the same pattern as post-industrial automation: the value concentrates at the top, the tools become proprietary, and the people who need them most are priced out.

Studio exists to redistribute cognitive capacity. The kernel is open source — a common good, not a product. The agents are interchangeable. The framework belongs to no one.

The long-term vision: reduce the cost of building software and automating complex work to the point where a single person — neurodivergent, disabled, an artist, anyone — can create and operate products that generate real value. Not by coding everything themselves, but by orchestrating AI agents with structural guarantees of quality.

This is a contribution, however indirect, toward a world where universal basic income becomes not just possible but obvious — because the machines are already doing the work, and the frameworks to govern them are free.

### Structure

Studio follows a tripartite architecture designed to prevent capture:

**Open Source Kernel** — The tool itself. Common good. Non-negotiable. Protected by constitutional invariants. No commercial entity has authority over it. Like `git`.

**Support Core** — Hosting, maintenance, documentation. Generates revenue subordinate to the common good. Like the Linux Foundation.

**Products Powered by Studio** — Specialized tools (Code Builder, ADHD Finance, Git Butler, Wiki Creator). Commercial entities that can appear or disappear. They never dictate kernel evolution. Like GitHub, GitLab, Bitbucket are to `git`.

### Anti-drift

Ideological drift rarely happens through open conflict. It happens through accumulation of "reasonable" decisions. Studio integrates mechanisms for deceleration, traceability, and veto. Any evolution that improves performance at the cost of increasing inequality is a regression.

### Governance

Decision-making power must be held primarily by the people directly affected by the inequalities the project aims to reduce. Diversity is not symbolic — it is decisional.

---

## Status

Studio v7 is in active development. The RALPH loop, pipeline engine, CLI, group-based feedback loops, and YAML tool plugin system are functional. Two reference pipelines are implemented: `software/feature-builder` (code generation with QA feedback loops) and `cuisine/recipe-generator` (recipe creation with iterative critique).

Current priority: **Code Builder that works end-to-end.** Everything else follows from that.

---

## License

[TBD — transitioning from proprietary to an open-source license that protects against commercial capture]

---

> Studio is not built to be fast. It is built to last.
>
> Nothing in this project is for sale.
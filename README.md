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

## Templates — Build apps powered by AI pipelines

Studio isn't just a tool you add to your project. It's a **generator for complete AI-powered applications**.

```bash
studio init --template software --name code-builder
cd code-builder
npm install
studio run software/feature-builder --input "Add dark mode"
```

This generates a **full working app** with:
- Complete pipeline definitions for code generation + QA
- Tools for file operations, git, shell commands
- Database schema for tracking repos and features
- Starter code structure ready to extend

### Templates are architectural patterns

| Template | Use cases | Example products |
|----------|-----------|------------------|
| `software` | Code generation, refactoring, git operations | Code Builder, Git Butler, API generators |
| `finance` | Transaction analysis, budget management | ADHD Finance, invoicing tools, portfolio managers |
| `analysis` | Content extraction, entity recognition | Wiki Creator, Voice Training, legal analyzers |
| `data` | Validation, transformation, compliance | ETL auditors, data cleaners, schema validators |
| `conversation` | Dialogue management, memory systems | Chatbots, learning assistants, therapy tools |

Each template includes:
- **Pipelines** for common workflows in that domain
- **Tools** specific to the use case (file ops, text processing, APIs)
- **Contracts** defining what valid output looks like
- **Agents** configured for the domain (coder, analyst, etc.)
- **Database schema** starter (Prisma)
- **Code structure** that works out-of-the-box

Then you customize for your specific product.

---

## Real examples

### Code Builder (built with `software` template)

Generate features, fix bugs, refactor code — with structural validation that catches agents faking work.

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

**Anti-theatre validation:** If the code-generation stage claims to have written files but made zero tool calls, it fails. No exceptions.

### ADHD Finance (built with `finance` template)

Help neurodivergent people manage money by automating transaction categorization, splitting accounts, and ensuring bills are covered before impulse spending happens.

Uses pipelines like:
- `transaction-analysis` — Categorize transactions with context
- `budget-planning` — Generate budget recommendations
- `account-splitting` — Auto-split paychecks across accounts

Integrates with Plaid for bank connections, scheduled jobs for automation.

### Wiki Creator (built with `analysis` template)

Analyze books and build structured wikis. Extract entities, map relationships, generate cross-referenced pages.

Pipelines:
- `book-analysis` — Extract structure and themes
- `entity-extraction` — Identify characters, places, concepts
- `wiki-generation` — Generate interconnected pages

### Voice Training (also built with `analysis` template)

Help trans women improve their voice with structured exercises and AI-powered feedback. Like Duolingo but for voice feminization.

Pipelines:
- `voice-analysis` — Analyze pitch, resonance, articulation
- `feedback-generation` — Generate personalized coaching
- `progress-tracking` — Monitor improvement over time

Same template (`analysis`), completely different product.

---

## Quick start

```bash
# Install Studio globally
npm install -g @studio/cli

# Create a new app from a template
studio init --template software --name my-builder
cd my-builder

# Configure your LLM provider
studio config set provider anthropic --api-key $ANTHROPIC_API_KEY

# Install dependencies
npm install

# Run a pipeline
studio run software/feature-builder --input "Add dark mode support"
```

### What gets generated

```
my-builder/
├── .studio/                          # Studio config (like .git/)
│   ├── config.yaml                   # Provider config (gitignored)
│   ├── pipelines/                    # Pipeline definitions (YAML)
│   ├── contracts/                    # Output contracts (YAML)
│   ├── agents/                       # Agent profiles (YAML)
│   ├── tools/                        # Tool plugins (YAML)
│   ├── inputs/                       # Input examples (YAML)
│   ├── skills/                       # .skill.md files (optional)
│   ├── registry.lock.json            # Tool versions (committed)
│   └── runs/                         # Runtime data (gitignored)
├── src/                              # Your app code
│   ├── index.ts
│   └── lib/
├── prisma/                           # Database schema
│   └── schema.prisma
├── package.json
└── README.md
```

Studio finds `.studio/` by walking up the directory tree, just like `git` finds `.git/`.

The pipelines, tools, and contracts are **versioned with your code** in git. Your team shares the same configurations.

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

**Lifecycle Hooks** — Shell commands configurable in YAML that run at deterministic lifecycle points: `on_stage_start`, `on_stage_complete`, `pre_tool_use`, `post_tool_use`. Hooks can block tool calls, trigger group retries (via `on_failure: reject`), or fail pipelines (via `on_failure: fail`). Template variable substitution: `{{output.field}}` for stage output, `{{tool.argName}}` for tool arguments. This is how you add static analysis, linting, or custom validation without touching TypeScript.

**on_pipeline_start** — Shell commands that run before any stage and inject dynamic context (git status, recent changes, environment state) into every stage's context. The structural guarantee of always-fresh context at pipeline start.

**Skills (.skill.md)** — Markdown files in `.studio/skills/` that describe procedural context (conventions, architectural patterns, step-by-step guides). Auto-injected into the system prompt of agents that declare them via `skills: [name]`. Creating a skill requires no code — just markdown.

**PII Anonymization** — Transparent middleware that replaces sensitive data (names, emails, financial data) with tokens before sending to the LLM. A local keymap in `.studio/runs/anonymization/` lets you reconstruct the original values. Activated via `--anonymize` on `studio run`, or `anonymize: true` in agent YAML.

**Tool Plugin** — A `.tool.yaml` file that defines a set of commands available to agents. Each plugin contains its parameters, execution logic (shell or builtin), a prompt snippet, and its constraints. The prompt snippet is automatically injected into the agent's system prompt — the tool documents itself. Creating a tool requires no code — just YAML.

**Templates** — Architectural patterns that generate complete application starters. Each template provides pipelines, tools, contracts, agents, and code structure for a specific type of app (software, finance, analysis, data, conversation).

---

## Tool Plugins

Tool plugins are the extension system. Any capability an agent needs — calling an API, running a script, querying a database — can be packaged as a self-contained `.tool.yaml` file.

```yaml
# .studio/tools/nutrition.tool.yaml
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

**Self-documenting:** The `prompt_snippet` is automatically injected into the system prompt. The tool explains itself.

**Project-scoped:** Each project has its own `tools/` folder. The cuisine project has nutrition tools. The software project has git tools. They never cross.

**Double-gated:** The project authorizes which tool groups are available. The agent YAML authorizes which specific tools it can call. Two layers of access control.

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
@studio/api          → HTTP REST API (Fastify + Swagger UI)
    │
@studio/engine       → Pipeline orchestration, state, governance
    │
    ├── @studio/ralph        → Execute, validate, retry
    │
    ├── @studio/runner       → LLM calls, tool plugin runtime, multi-provider
    │
    └── @studio/anonymizer   → PII anonymization middleware
    │
@studio/contracts    → Shared types (zero dependencies)

Templates/           → Architectural patterns
    ├── software/
    ├── finance/
    ├── analysis/
    ├── data/
    └── conversation/
```

Seven packages in a single monorepo. Each fits in a single context window. Each is testable in isolation. The runner is a tool plugin runtime — it loads `.tool.yaml` files and executes them alongside LLM calls. The engine never touches tool logic directly.

**Build from source:**

```bash
git clone https://github.com/arianeguay/studio-workspace
cd studio-workspace
pnpm install
pnpm build
```

---

## CLI

The CLI is the primary interface. Like `git`, it handles both setup and daily use.

```bash
# Generate a new app (interactive wizard)
studio init
# Or direct mode
studio init --template <type> --name <project>

# Daily use
studio run <pipeline> --input "..."            # Run a pipeline
studio run <pipeline> --live                   # Stream tool calls in real-time
studio run <pipeline> --provider mock          # Test without API calls
studio run <pipeline> --anonymize              # Anonymize PII before sending to LLM
studio status [run-id]                         # Check run status
studio logs [run-id]                           # View run logs
studio list pipelines                          # List available pipelines
studio validate <contract> <output>            # Validate output against contract

# Setup & config
studio config add-provider                     # Add an LLM provider (wizard)
studio config set provider anthropic --api-key $KEY
studio config list                             # Show config (API keys masked)
studio tools list                              # List tools in current project
studio tools add git                           # Install a tool plugin (wizard)
studio tools info git                          # Show tool details

# Registry
studio registry install <name>                 # Install a tool from the registry
studio registry search <query>                 # Search available tools
studio registry update                         # Update installed tools

# Templates & integrations
studio templates                               # List available templates
studio template validate <path>               # Validate a template structure
studio integrations                            # Manage integrations (Linear, etc.)

# API server
studio api start                               # Start the HTTP REST API
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

**Products Powered by Studio** — Specialized applications built from templates. Can be open source or commercial. Can appear or disappear. They never dictate kernel evolution. Each product starts from a template and customizes for its specific use case.

Examples:
- Code Builder (from `software` template)
- ADHD Finance (from `finance` template)
- Wiki Creator (from `analysis` template)
- Voice Training (from `analysis` template)

Like GitHub, GitLab, Bitbucket are to `git` — products built on a shared foundation.

### Anti-drift

Ideological drift rarely happens through open conflict. It happens through accumulation of "reasonable" decisions. Studio integrates mechanisms for deceleration, traceability, and veto. Any evolution that improves performance at the cost of increasing inequality is a regression.

### Governance

Decision-making power must be held primarily by the people directly affected by the inequalities the project aims to reduce. Diversity is not symbolic — it is decisional.

---

## Status

Studio v7 is in active development.

**What's functional:**
- RALPH loop, pipeline engine, group-based feedback loops
- YAML tool plugin system (`repo_manager`, `shell`, `search`, `git`, `patch`, `studio_run`)
- Lifecycle hooks (`on_stage_start`, `on_stage_complete`, `pre_tool_use`, `post_tool_use`)
- Dynamic pipeline startup context (`on_pipeline_start` commands)
- Skills system (`.skill.md` files auto-injected into agent prompts)
- PII anonymization middleware (`--anonymize`)
- Real-time streaming CLI (`--live` with token streaming and animated spinners)
- `studio init` interactive wizard (template selection, provider config, tool selection)
- `studio init --template` direct mode (CI/CD-friendly)
- Template system (`software` template complete with full Code Builder pipeline)
- Multi-provider (Anthropic with prompt caching, OpenAI, OpenAI Responses API, Mock)
- HTTP REST API (`@studio/api` — Fastify + Swagger UI, SSE streaming, webhook support)
- Linear integration (webhook handler → auto-launch pipeline on issue status change)
- Registry system (`studio registry install/remove/search/publish` + `registry.lock.json`)
- Sub-pipeline spawning (`studio_run` tool + `RunSpawner` interface)
- PostgreSQL persistence (`PgRunStore` via `@studio/engine`)
- `pnpm monorepo` with `contracts`, `ralph`, `runner`, `anonymizer`, `engine`, `api`, `cli`

**Current priority:** Code Builder end-to-end validation — Linear webhook → pipeline run → commit + PR creation.

Roadmap:
1. ✅ Kernel (engine, ralph, runner, contracts, cli)
2. ✅ `software` template with feature-builder pipeline
3. ✅ Lifecycle hooks (configurable YAML)
4. ✅ Skills (.skill.md context injection)
5. ✅ PII anonymization middleware
6. ✅ Real-time streaming CLI
7. 🚧 Code Builder end-to-end (Linear webhook → PR)
8. 📋 Other templates (`finance`, `analysis`, `data`)
9. 📋 Community registry for custom templates
10. 📋 Studio Cloud (hosted API)

---

## License

[TBD — transitioning from proprietary to an open-source license that protects against commercial capture]

---

> Studio is not built to be fast. It is built to last.
>
> Nothing in this project is for sale.
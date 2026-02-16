# Studio

**Reliable AI pipelines for complex work.**

Studio is a governance framework that orchestrates AI agents into reliable, repeatable workflows. Define pipelines in YAML, plug in any LLM, and let Studio handle validation, retries, and quality enforcement. Not just for code — for any domain where AI needs to produce trustworthy results.

```
$ studio run feature-builder --input "Add a FAQ section to the About page"

[1/4] brief-analysis ............ ✓ (attempt 1/3)
[2/4] implementation-plan ....... ✓ (attempt 1/3)
[3/4] code-generation ........... ✓ (attempt 2/5) ← retry: theatre detected
[4/4] qa-review ................. ✓ (attempt 1/3)

Pipeline completed in 4m32s
Files changed: src/pages/About.tsx (+47 lines)
```

Run this 10 times. It passes 10 times. That's the point.

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
  - name: code-generation
    agent: coder
    contract: code-generation
    tools:
      required: [repo_manager.write_file]
  - name: qa-review
    agent: analyst
    contract: qa-review
```

### Git Butler

Rewrite messy git history into clean, reviewable commits. Analyze diffs, identify logical boundaries, rebase automatically, validate integrity.

```yaml
# pipelines/git-butler.pipeline.yaml
stages:
  - name: history-analysis
    agent: analyst
    contract: history-analysis
  - name: commit-boundary-detection
    agent: analyst
    contract: commit-boundaries
  - name: rewrite-plan
    agent: planner
    contract: rewrite-plan
  - name: execute-rebase
    agent: git-operator
    contract: rebase-execution
    tools:
      required: [git.rebase, git.commit]
  - name: integrity-check
    agent: analyst
    contract: integrity-validation
```

### ADHD Finance

Help neurodivergent people manage money by automating categorization, splitting accounts, and ensuring bills are covered before impulse spending happens.

```yaml
# pipelines/budget-builder.pipeline.yaml
stages:
  - name: parse-statements
    agent: finance-reader
    contract: parsed-transactions
  - name: categorize
    agent: finance-analyst
    contract: categorized-transactions
  - name: compute-allocations
    agent: finance-planner
    contract: allocation-plan
  - name: validate-budget
    agent: finance-auditor
    contract: budget-balance
```

### Wiki Creator

Analyze books and build structured wikis — extract entities, map relationships, generate cross-referenced pages.

```yaml
# pipelines/wiki-builder.pipeline.yaml
stages:
  - name: extract-structure
    agent: reader
    contract: book-structure
  - name: identify-entities
    agent: analyst
    contract: entity-map
  - name: build-knowledge-graph
    agent: analyst
    contract: knowledge-graph
  - name: generate-pages
    agent: writer
    contract: wiki-pages
  - name: cross-reference
    agent: auditor
    contract: cross-reference-validation
```

Same engine. Different pipelines. Different contracts. Different agents. Studio doesn't care about the domain — it cares that the output is proven correct.

---

## Quick start

```bash
npm install -g @studio/cli

cd your-project
studio init
# Edit .studiorc.yaml with your provider API key

studio run feature-builder --input "Add dark mode support"
```

### Project structure

```
your-project/
├── .studiorc.yaml                  # Provider config
├── configs/
│   ├── pipelines/                  # Pipeline definitions (YAML)
│   ├── contracts/                  # Output contracts (YAML)
│   └── agents/                     # Agent profiles (YAML)
└── ...                             # Your project files
```

---

## Core concepts

**Pipeline** — A sequence of stages that transforms input into validated output. Defined in YAML. Versioned in Git. Domain-agnostic.

**Stage** — One step in a pipeline. Each stage has an agent, an output contract, and RALPH retry settings.

**Output contract** — A structural schema that defines what a stage must produce. Validation is binary: pass or fail.

**RALPH loop** — The retry engine. Execute → validate → retry with escalated feedback → repeat until pass or max attempts.

**Agent** — An LLM configuration: provider, model, tools, system prompt. Agents are interchangeable and never sovereign.

**Anti-theatre** — Validation constraints that catch agents faking work. If a code generation stage claims to have written files but made zero tool calls, it fails regardless of what it says in its output.

**Kernel** — The governance layer. The kernel decides, the agents execute. The kernel is a constitution, not an implementation.

---

## Provider-agnostic

```yaml
# .studiorc.yaml
providers:
  anthropic:
    api_key: ${ANTHROPIC_API_KEY}
    default_model: claude-sonnet-4-20250514
  openai:
    api_key: ${OPENAI_API_KEY}
    default_model: gpt-4.1
```

Different agents can use different providers. Switch models without changing pipeline logic. The orchestration layer doesn't depend on who does the work — it depends on the work being done correctly.

---

## Architecture

```
@studio/cli          → User interface
    │
@studio/engine       → Pipeline orchestration, state, governance
    │
    ├── @studio/ralph    → Execute, validate, retry
    │
    └── @studio/runner   → LLM calls, tools, multi-provider
    │
@studio/contracts    → Shared types (zero dependencies)
```

Five packages. Each fits in a single context window. Each is testable in isolation.

---

## CLI

```bash
studio run <pipeline> --input "..."     # Run a pipeline
studio run <pipeline> --dry-run         # Validate without calling LLMs
studio status [run-id]                  # Check run status
studio list pipelines                   # List available pipelines
studio validate <contract> <output>     # Validate output against contract
studio init                             # Initialize in current directory
```

---

## Philosophy

Studio is an explicitly political project.

The productivity gains from AI are real. But left unchecked, they follow the same pattern as post-industrial automation: the value concentrates at the top, the tools become proprietary, and the people who need them most are priced out.

Studio exists to redistribute cognitive capacity. The kernel is open source — a common good, not a product. The agents are interchangeable. The framework belongs to no one.

The long-term vision: reduce the cost of building software and automating complex work to the point where a single person — neurodivergent, disabled, an artist, anyone — can create and operate products that generate real value. Not by coding everything themselves, but by orchestrating AI agents with structural guarantees of quality.

This is a contribution, however indirect, toward a world where universal basic income becomes not just possible but obvious — because the machines are already doing the work, and the frameworks to govern them are free.

### Structure

Studio follows a tripartite architecture designed to prevent capture:

**Open Source Kernel** — The governance engine. Common good. Non-negotiable. Protected by constitutional invariants. No commercial entity has authority over it.

**Support Core** — Hosting, maintenance, documentation. Generates revenue subordinate to the common good.

**Products Powered by Studio** — Specialized tools (Code Builder, ADHD Finance, Git Butler, Wiki Creator). Commercial entities that can appear or disappear. They never dictate kernel evolution.

### Anti-drift

Ideological drift rarely happens through open conflict. It happens through accumulation of "reasonable" decisions. Studio integrates mechanisms for deceleration, traceability, and veto. Any evolution that improves performance at the cost of increasing inequality is a regression.

### Governance

Decision-making power must be held primarily by the people directly affected by the inequalities the project aims to reduce. Diversity is not symbolic — it is decisional.

---

## Status

Studio v7 is in active development. The RALPH loop, pipeline engine, and CLI are functional. The `feature-builder` pipeline is the reference implementation.

---

## License

[TBD — transitioning from proprietary to an open-source license that protects against commercial capture]

---

> Studio is not built to be fast. It is built to last.
> 
> Nothing in this project is for sale.
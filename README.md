# Studio

**Reliable AI pipelines for software development.**

Studio is an orchestration framework that makes AI agents produce working code — not just plausible code. Define pipelines in YAML, plug in any LLM, and let Studio handle validation, retries, and quality enforcement automatically.

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

AI coding tools are impressive but unreliable. They hallucinate file changes they never made, skip steps they claim to have completed, and produce outputs that look correct but aren't. The current fix is a human watching every step. Studio replaces that with structural validation.

## How it works

Studio breaks AI work into **stages** with explicit **output contracts**. Each stage runs through a **RALPH loop** (Retry with Automated Logic for Persistent Handling): execute, validate against the contract, retry with escalated feedback if validation fails. No stage advances until its output is proven correct.

```
Pipeline (YAML)
  └── Stage 1: brief-analysis
        └── RALPH loop:
              execute (LLM) → validate (contract) → pass? next : retry
  └── Stage 2: implementation-plan
        └── RALPH loop: ...
  └── Stage 3: code-generation
        └── RALPH loop: ...
  └── Stage 4: qa-review
        └── RALPH loop: ...
```

### Anti-theatre detection

Studio catches agents that *describe* work without *doing* it. If a code generation stage returns `files_changed: 3` but made zero tool calls to actually write files, validation fails and the agent retries with explicit feedback about what went wrong. This is baked into the output contracts, not an afterthought.

---

## Quick start

```bash
# Install
npm install -g @studio/cli

# Initialize a project
cd your-project
studio init

# Configure your LLM provider
# Edit .studiorc.yaml with your API key

# Run a pipeline
studio run feature-builder --input "Add dark mode support"
```

### Project structure after `studio init`

```
your-project/
├── .studiorc.yaml              # Provider config (API keys, model preferences)
├── configs/
│   ├── pipelines/
│   │   └── feature-builder.pipeline.yaml
│   ├── contracts/
│   │   ├── brief-analysis.contract.yaml
│   │   ├── implementation-plan.contract.yaml
│   │   ├── code-generation.contract.yaml
│   │   └── qa-review.contract.yaml
│   └── agents/
│       ├── analyst.agent.yaml
│       └── coder.agent.yaml
└── src/                        # Your code (Studio reads and writes here)
```

---

## Define your own pipeline

Pipelines are YAML. No code required.

```yaml
# configs/pipelines/feature-builder.pipeline.yaml
name: feature-builder
description: Build a feature from a user description
version: 1

stages:
  - name: brief-analysis
    agent: analyst
    contract: brief-analysis
    ralph:
      max_attempts: 3

  - name: implementation-plan
    agent: analyst
    contract: implementation-plan
    ralph:
      max_attempts: 3

  - name: code-generation
    agent: coder
    contract: code-generation
    ralph:
      max_attempts: 5
    tools:
      required:
        - repo_manager.write_file

  - name: qa-review
    agent: analyst
    contract: qa-review
    ralph:
      max_attempts: 3
```

### Output contracts

Contracts define what a stage *must* produce to pass validation.

```yaml
# configs/contracts/code-generation.contract.yaml
name: code-generation
version: 1

schema:
  type: object
  required: [files_changed, summary]
  properties:
    files_changed:
      type: array
      minItems: 1
      items:
        type: object
        required: [path, action]
    summary:
      type: string
      minLength: 20

constraints:
  tool_calls:
    minimum: 1           # Must actually call tools — no theatre
  files_changed:
    must_exist: true      # Referenced files must exist on disk
```

### Agent profiles

Agents are LLM configurations with constraints.

```yaml
# configs/agents/coder.agent.yaml
name: coder
description: Writes and modifies code
provider: anthropic          # or openai, local, etc.
model: claude-sonnet-4-20250514
temperature: 0.2

tools:
  - repo_manager.read_file
  - repo_manager.write_file
  - repo_manager.list_files
  - shell.run_command

system_prompt: |
  You are a code generation agent.
  You MUST use repo_manager.write_file for every file change.
  Never describe what you would write — actually write it.
```

---

## Provider-agnostic

Studio doesn't care which LLM you use. Configure providers in `.studiorc.yaml`:

```yaml
providers:
  anthropic:
    api_key: ${ANTHROPIC_API_KEY}
    default_model: claude-sonnet-4-20250514
  openai:
    api_key: ${OPENAI_API_KEY}
    default_model: gpt-4.1
```

Different agents can use different providers. Your analyst can run on Claude while your coder runs on GPT. Switch models without changing pipeline logic.

---

## Key concepts

**Pipeline** — A sequence of stages that transform a user request into working code. Defined in YAML. Versioned in Git.

**Stage** — One step in a pipeline (analysis, planning, code generation, QA). Each stage has an agent, an output contract, and RALPH retry settings.

**Output contract** — A structural schema that defines what a stage must produce. Validation is binary: pass or fail. No ambiguity.

**RALPH loop** — The retry engine. Execute → validate → retry with feedback → repeat until pass or max attempts. Prompt escalation between retries gives the agent increasingly specific instructions about what went wrong.

**Agent** — An LLM configuration: which model, what tools, what system prompt. Agents are stateless — all context comes from the pipeline.

**Anti-theatre** — Validation constraints that catch agents faking work. If `tool_calls.minimum: 1` and the agent made zero tool calls, it failed regardless of what it claims in its output.

---

## CLI reference

```bash
studio run <pipeline> --input "..."     # Run a pipeline
studio run <pipeline> --dry-run         # Validate config without calling LLMs
studio status [run-id]                  # Check run status
studio list pipelines                   # List available pipelines
studio list runs                        # List recent runs
studio validate <contract> <output>     # Validate an output against a contract
studio init                             # Initialize Studio in current directory
```

---

## Architecture

```
@studio/cli          → User interface (terminal)
    │
@studio/engine       → Pipeline orchestration, state management
    │
    ├── @studio/ralph    → RALPH loop: execute, validate, retry
    │
    └── @studio/runner   → LLM calls, tool execution, multi-provider
    │
@studio/contracts    → Shared types (zero dependencies, zero logic)
```

Five packages. Each fits in a single context window. Each is testable in isolation.

---

## Why not just use Claude Code / Cursor / Devin?

Those tools are great at executing single tasks interactively. Studio solves a different problem:

| | Claude Code / Cursor | Studio |
|---|---|---|
| Validation | Human reviews output | Structural contracts, automatic |
| Retries | Human re-prompts | Automatic with escalated feedback |
| Reproducibility | Varies by session | Same input → same quality, every time |
| Multi-step | Conversational | Formal pipeline with stage gates |
| Provider lock-in | Tied to one provider | Any LLM, swap freely |
| Theatre detection | Hope the model is honest | Prove it with tool call verification |

Studio doesn't replace these tools — it can *use* them as runners. Studio is the orchestration layer that ensures the output is reliable, regardless of which LLM does the work.

---

## Status

Studio v7 is in active development. The core RALPH loop and pipeline engine work. The built-in `feature-builder` pipeline is the reference implementation.

**Working:** CLI, pipeline engine, RALPH loop, output contract validation, multi-provider support, anti-theatre detection.

**Coming soon:** Plugin system for custom tools, pipeline marketplace, cloud-hosted runs, observability dashboard.

---

## Contributing

Studio is open source under [LICENSE]. Contributions welcome.

The project follows a validation-first philosophy: every feature must be provably correct, not just plausibly correct. Tests verify invariants, not implementations.

---

## License

[TBD]
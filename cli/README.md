# @studio-foundation/cli

**Studio** is a declarative YAML runtime for AI agents. It orchestrates multi-stage agent workflows with structured output validation and automatic retry. Pipelines are defined in YAML, every stage output is validated against a contract, and failures are retried with escalated feedback — no stage advances until its output is structurally proven correct.

This package is the **CLI**: the `studio` binary. It reads your config, wires up providers and tools, delegates execution to the engine, and renders progress to your terminal.

- Homepage: https://github.com/studio-foundation/studio
- Full docs: [README](https://github.com/studio-foundation/studio#readme) · [CONCEPTS](https://github.com/studio-foundation/studio/blob/main/CONCEPTS.md) · [PHILOSOPHY](https://github.com/studio-foundation/studio/blob/main/PHILOSOPHY.md)

## Why Studio

If you've ever wrapped the Anthropic or OpenAI API in a script and watched it claim success while silently skipping steps, Studio is for you. You get:

- **Structured output validation**: every stage output is checked against a JSON-schema contract. Binary pass/fail.
- **Automatic retry with feedback**: failures are re-run with the validation error injected into the prompt, up to `max_attempts`.
- **Tool-call verification (anti-theatre)**: if an agent claims to have written a file but made zero tool calls, it fails. Tool calls are tracked by the runner, not self-reported.
- **Observability out of the box**: stream every tool call, retry, and rejection in real time with `--live`.
- **Deterministic config**: pipelines, contracts, agents and tools are YAML. The engine is domain-agnostic; the behavior lives in the files.
- **TypeScript and YAML, no Python**: declarative configs, no decorators or graph builders. A LangGraph or CrewAI alternative for teams that prefer their orchestration in config files.

## Install

```bash
npm install -g @studio-foundation/cli
# or
pnpm add -g @studio-foundation/cli
```

This installs a `studio` binary on your `PATH`.

```bash
studio --version
```

## Quick start

```bash
# 1. Scaffold a project (interactive wizard: template, provider, tools)
studio init

# 2. Run a pipeline with live output
studio run feature-builder --input "Add a FAQ section to the About page" --live

# 3. Inspect the result
studio status
studio logs
```

No API key yet? Try the mock provider, no network calls, no cost:

```bash
studio run feature-builder --input "..." --provider mock
```

## What you'll see

`studio run --live` streams each stage, every tool call, and every retry:

```
[1/4] Analyzing brief...
  ✔ 🔍 repo_manager-list_files(src/pages) → 3 files
  ✔ 📖 repo_manager-read_file(src/pages/about.tsx) → 247 lines
  ✓ (1 attempt, 8s)

[2/4] Creating implementation plan...
  ✓ (1 attempt, 12s)

[3/4] Generating code...
  ✔ 📖 repo_manager-read_file(src/pages/about.tsx) → 247 lines
  ✔ ✏️  repo_manager-write_file(src/pages/about.tsx) → written
  ↺ Retry 2/5 — TypeScript error: Property 'items' does not exist
  ✔ ✏️  repo_manager-write_file(src/pages/about.tsx) → written
  ✓ (2 attempts, 38s)

[4/4] QA review...
  ✓ approved (1 attempt, 15s)

Pipeline completed in 1m13s
```

The `studio init` wizard:

```
$ studio init

What type of app are you building?
  ❯ software  — Code generation, git operations
    finance   — Transaction analysis, budget management
    analysis  — Content extraction, entity recognition
    data      — Validation, transformation, compliance
    conversation — Dialogue management, memory systems

Project name? my-code-builder

Which LLM provider?
  ❯ Anthropic (Claude)
    OpenAI (GPT)

Anthropic API Key: sk-ant-... ✓ Valid

Install default tools for this template?
  ❯ ☑ repo-manager (file operations)
    ☑ shell (run commands)
    ☑ git (version control)
    ☑ search (codebase search)

✓ Created my-code-builder/.studio/
✓ Copied software template
✓ Installed 4 tools
✓ Configured Anthropic provider
```

## Commands

```bash
# Daily use
studio run <pipeline> --input "..."            # Run a pipeline
studio run <pipeline> --input-file input.yaml  # Run with a YAML input file
studio run <pipeline> --live                   # Stream tool calls in real time
studio run <pipeline> --provider mock          # Run with the mock provider (no API calls)
studio run <pipeline> --anonymize              # Anonymize PII before sending to LLM
studio status [run-id]                         # Check run status (latest if no ID)
studio logs [run-id]                           # View JSONL logs for a run
studio replay [run-id]                         # Replay a completed run
studio list projects                           # List available projects
studio list pipelines                          # List available pipelines

# Init (interactive wizard)
studio init                                    # Full interactive wizard
studio init --template software --name my-app  # Direct mode (CI/CD-friendly)
studio init --force                            # Re-initialize (backup + recreate)

# Config
studio config add-provider                     # Add an LLM provider (wizard)
studio config set provider anthropic --api-key $KEY
studio config set default.model claude-haiku-4-20250514
studio config list                             # Show config (API keys masked)

# Tools
studio tools list                              # List tools in current project
studio tools add                               # Add tools (interactive wizard)
studio tools add git                           # Add a specific tool
studio tools remove <name>                     # Remove a tool
studio tools info <name>                       # Show tool details

# Registry
studio registry install <name>                 # Install a tool from the registry
studio registry remove <name>                  # Remove a registry-installed tool
studio registry search <query>                 # Search available tools
studio registry publish <path>                 # Publish a tool to the registry
studio registry audit                          # Audit installed tools for updates/issues
studio registry sync                           # Sync registry.lock.json with installed tools
studio registry update [name]                  # Update installed tools (all or specific)

# Templates
studio templates                               # List available templates
studio template validate <path>                # Validate a template structure

# Integrations
studio integrations                            # Manage integrations (Linear, etc.)

# Project
studio project                                 # Project management

# API server
studio api start                               # Start the HTTP REST API server

# Validation
studio validate <contract> <output.json>       # Validate output against a contract (no LLM)
```

## Config

`studio` looks for `.studio/config.yaml` by walking up the directory tree from the current working directory, same mechanism as `git` finding `.git/`. Run `studio` from anywhere inside your project and it'll find the config.

```yaml
# .studio/config.yaml
providers:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}   # Env var substitution supported
  openai:
    apiKey: ${OPENAI_API_KEY}

defaults:
  provider: anthropic
  model: claude-sonnet-4-20250514
```

This file is gitignored by the scaffold. Never commit API keys.

## Architecture

```
user → studio run feature-builder --input "..." → cli → engine → ralph / runner
```

`cli` is the human-facing layer. It reads input, resolves `.studio/config.yaml`, wires up the provider and tool registries, delegates to `engine`, and renders progress to the terminal. It's part of a 7-package monorepo, see the [main README](https://github.com/studio-foundation/studio#readme) for the full picture.

Sister packages:

- [`@studio-foundation/engine`](https://www.npmjs.com/package/@studio-foundation/engine) — pipeline orchestration
- [`@studio-foundation/ralph`](https://www.npmjs.com/package/@studio-foundation/ralph) — retry loop + validation
- [`@studio-foundation/runner`](https://www.npmjs.com/package/@studio-foundation/runner) — tool plugin runtime, LLM providers
- [`@studio-foundation/anonymizer`](https://www.npmjs.com/package/@studio-foundation/anonymizer) — PII anonymization middleware
- [`@studio-foundation/api`](https://www.npmjs.com/package/@studio-foundation/api) — HTTP REST API
- [`@studio-foundation/contracts`](https://www.npmjs.com/package/@studio-foundation/contracts) — shared types

## For contributors

Working on the CLI itself, not just using it:

```bash
# From the Studio monorepo root
pnpm install
pnpm build                          # Builds all packages, including cli
node cli/dist/index.js run ...      # Run directly without linking

# Or link globally
cd cli && npm link
studio --version
```

Internal rules:

- `cli` is the composition root, it imports from `engine`, `runner` (ToolRegistry, ProviderRegistry, MCPClient), and `api` (for `studio api start`). This is a documented exception to the package DAG (see [INVARIANTS.md](https://github.com/studio-foundation/studio/blob/main/INVARIANTS.md)).
- `cli` never contains business logic, it wires dependencies and delegates.
- All output rendering is in `output/`, display logic stays separate from command logic.
- `findStudioDir()` walks up the directory tree, tests must use `/tmp` as base, never a subdirectory of the Studio repo (the repo itself has a `.studio/` at its root).

## License

AGPL-3.0-only

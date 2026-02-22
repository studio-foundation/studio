# @studio/cli

The terminal interface for Studio. `studio run`, `studio init`, `studio config`, and more.

## Role

cli is the human-facing layer. It reads user input, loads config from `.studio/config.yaml`, wires up the provider and tool registries, delegates to engine, and renders progress output to the terminal.

```
user → studio run feature-builder --input "..." → cli → engine → ...
```

## Commands

```bash
# Daily use
studio run <pipeline> --input "..."            # Run a pipeline
studio run <pipeline> --input-file input.yaml  # Run with YAML input file
studio run <pipeline> --live                   # Stream tool calls in real-time
studio run <pipeline> --provider mock          # Run with mock provider (no API calls)
studio run <pipeline> --anonymize              # Anonymize PII before sending to LLM
studio status [run-id]                         # Check run status
studio list projects                           # List available projects
studio list pipelines                          # List available pipelines

# Init (interactive wizard)
studio init                                    # Full interactive wizard: template, provider, tools
studio init --template software --name my-app # Direct mode (CI/CD-friendly)
studio init --force                            # Re-initialize (backup + recreate)

# Config
studio config add-provider                     # Add an LLM provider (wizard)
studio config set provider anthropic --api-key $KEY
studio config set default.model claude-haiku-4-20250514
studio config list                             # Show config (API keys masked)

# Tools
studio tools list                              # List tools in current project
studio tools add                               # Add tools (interactive wizard)
studio tools add git                           # Add specific tool
studio tools remove nutrition                  # Remove a tool
studio tools info git                          # Show tool details

# Templates
studio template validate <path>               # Validate a template structure

# Validation
studio validate <contract> <output.json>       # Validate output against contract without LLM
```

## Config resolution

cli looks for `.studio/config.yaml` by walking up the directory tree from the current working directory (via `findStudioDir()`). This is how running `studio run` from inside a user project finds its configuration — same mechanism as `git` finding `.git/`.

Format of `.studio/config.yaml`:

```yaml
providers:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}    # Env var substitution supported
  openai:
    apiKey: ${OPENAI_API_KEY}

defaults:
  provider: anthropic
  model: claude-sonnet-4-20250514
```

This file is gitignored — never commit API keys.

## `studio init` wizard flow

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

## `studio run --live` output

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

## Development

```bash
# From Studio monorepo root
pnpm build                          # Build all packages including cli
node cli/dist/index.js run ...      # Run directly

# Or link globally
cd cli && npm link
studio --version
```

## Rules

- cli depends on engine + contracts only (not ralph or runner directly).
- cli never contains business logic — it wires up dependencies and delegates.
- All output rendering is in `output/` — keep display logic separate from command logic.
- `findStudioDir()` walks up the directory tree — tests must use `/tmp` as base, never a subdirectory of the Studio repo (the repo itself has `.studio/` at its root).

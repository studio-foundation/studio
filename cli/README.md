# @studio/cli

The terminal interface for Studio. `studio run`, `studio init`, `studio config`, and more.

## Role

cli is the human-facing layer. It reads user input, loads config from `.studiorc.yaml`, wires up the provider and tool registries, delegates to engine, and renders progress output to the terminal.

```
user → studio run software/feature-builder --input "..." → cli → engine → ...
```

## Commands

```bash
# Daily use
studio run <project/pipeline> --input "..."      # Run a pipeline
studio run <project/pipeline> --provider mock    # Run with mock provider (no API calls)
studio status [run-id]                           # Check run status
studio list projects                             # List available projects
studio list pipelines                            # List available pipelines

# Setup
studio init                                      # Initialize .studio/ in current directory
studio config set provider anthropic --api-key $KEY
studio config list                               # Show config (API keys masked)

# Tools
studio tools list                                # List tools in current project
studio tools add git --project software
studio tools info git

# Validation
studio validate <contract> <output.json>         # Validate output against contract without LLM
```

## Config resolution

cli looks for `.studiorc.yaml` by walking up the directory tree from the current working directory. This is how running `studio run` from inside a user project (e.g. `code-builder/`) finds its configuration.

Required keys in `.studiorc.yaml`:

```yaml
paths:
  configs: .studio/projects       # Where to find pipelines, agents, contracts
  projects_dir: .studio/projects  # Where to clone repos and store run outputs
providers:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
defaults:
  provider: anthropic
  model: claude-sonnet-4-20250514
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

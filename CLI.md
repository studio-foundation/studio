# CLI

Studio's primary interface. Setup and daily use.

---

## Commands

### Daily use

```bash
studio run <pipeline> --input "..."              # Run a pipeline
studio run <pipeline> --input-file X.yaml        # Run with input from file
studio run <pipeline> --live                     # Stream tool calls in real-time
studio run <pipeline> --provider mock            # Test without API calls
studio run <pipeline> --anonymize                # Anonymize PII before sending to LLM
studio status [run-id]                           # Check status (last run if no ID)
studio logs [run-id]                             # View run logs (JSONL)
studio replay [run-id]                           # Replay a completed run
studio list projects                             # List projects
studio list pipelines                            # List available pipelines
studio validate <contract> <output.json>         # Validate output against contract
```

### Setup

```bash
studio init                                      # Interactive wizard (template, provider, tools)
studio init --template <type> --name <project>   # Direct mode (CI/CD-friendly)
studio config add-provider                       # Add an LLM provider (wizard)
studio config set provider anthropic --api-key $KEY
studio config set default.model claude-haiku-4-20250514
studio config list                               # Show config (API keys masked)
```

### Tools

```bash
studio tools list                                # Tools in the active project
studio tools add git                             # Install a tool (wizard)
studio tools remove nutrition                    # Remove a tool
studio tools info git                            # Tool details
```

### Registry

```bash
studio registry install <name>                   # Install from registry
studio registry remove <name>                    # Remove a registry tool
studio registry search <query>                   # Search the registry
studio registry publish <path>                   # Publish a tool
studio registry audit                            # Audit installed tools
studio registry sync                             # Sync registry.lock.json
studio registry update [name]                    # Update installed tools
```

### Templates

```bash
studio templates                                 # List available templates
studio template validate <path>                  # Validate a template structure
```

### Other

```bash
studio integrations                              # Manage integrations (Linear, etc.)
studio project                                   # Project management
studio api start                                 # Start the HTTP REST API
```

---

## `.studio/` directory structure

When you run `studio init`, everything lives in `.studio/`:

```
my-project/
├── .studio/
│   ├── config.yaml              # Provider config (gitignored)
│   ├── pipelines/               # *.pipeline.yaml
│   ├── agents/                  # *.agent.yaml
│   ├── contracts/               # *.contract.yaml
│   ├── tools/                   # *.tool.yaml
│   ├── skills/                  # *.skill.md (optional)
│   ├── inputs/                  # *.input.yaml
│   ├── invariants.md            # Project invariants (optional, committed)
│   ├── registry.lock.json       # Tool versions (committed)
│   └── runs/                    # Runtime data (gitignored)
│       ├── runs.db              # SQLite
│       └── logs/                # JSONL
├── src/
├── prisma/
└── .gitignore
```

**Committed:** `pipelines/`, `agents/`, `contracts/`, `tools/`, `skills/`, `inputs/`, `invariants.md`, `registry.lock.json`

**Gitignored:** `config.yaml` (API keys), `runs/`

Studio finds `.studio/` by walking up the directory tree from the current working directory.

---

## Config format

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

API keys can reference environment variables via `${VAR_NAME}`. This file is gitignored — never commit API keys.

---

## Debugging

```bash
DEBUG=studio:* studio run feature-builder --input "..."   # Detailed events
studio run feature-builder --input "..." --live           # Real-time tool calls
studio run feature-builder --provider mock                 # No API calls
studio validate software/code-generation output.json       # Validate without LLM
```

Run logs are stored in `.studio/runs/logs/<timestamp>-<pipeline>-<id>.jsonl` (one JSON object per line).

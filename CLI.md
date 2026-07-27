# CLI

Studio's primary interface for human use. For machine-to-machine usage (webhooks, CI/CD, bots), see [API.md](./API.md).

---

## Install

Two channels, same binary.

```bash
# Standalone binary — no Node.js required at runtime
curl -fsSL https://raw.githubusercontent.com/studio-foundation/studio/main/install.sh | sh

# npm — pulls the binary in as a per-platform optional dependency
npm install -g @studio-foundation/cli
```

On Windows, PowerShell:

```powershell
irm https://raw.githubusercontent.com/studio-foundation/studio/main/install.ps1 | iex
```

Both installers honour `STUDIO_VERSION` (a release tag, default: latest) and
`STUDIO_INSTALL_DIR` (default: `$HOME/.local/bin`, or `%LOCALAPPDATA%\Programs\studio` on
Windows). They verify the download against the release's `SHA256SUMS` before installing.
The Windows installer adds its install directory to your user `PATH`, which takes effect
in the next terminal you open.

Windows binaries are unsigned, so SmartScreen may warn the first time you run `studio`.
Choose "More info" → "Run anyway"; the checksum the installer verified is the integrity
guarantee.

Updating follows the channel it came from: `studio upgrade` for the binary,
`npm i -g @studio-foundation/cli@latest` for npm. See [Updating](#updating--studio-upgrade).

Binaries ship for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` (glibc and
musl each), and `win-x64`. On any other platform the npm package falls back to the
JavaScript build, which needs Node.js >= 22.13.

Building them locally needs [Bun](https://bun.sh):

```bash
pnpm build && pnpm build:binary          # every platform → dist-binaries/
pnpm build:binary linux-x64              # or just one
```

---

## The commands you'll use daily

```bash
studio run <pipeline> --input "..."              # Run a pipeline
studio init                                      # Bootstrap a new project (interactive)
studio doctor                                    # Can this machine run this project?
studio config set provider anthropic --api-key $KEY
studio status [run-id]                           # Check status (last run if no ID)
studio logs <run-id>                             # View run logs (JSONL)
```

---

## Run

```bash
studio run <pipeline> --input "..."              # Run a pipeline
studio run <pipeline> --input-file X.yaml        # Run with input from file
studio run <pipeline> --live                     # Stream tool calls in real-time
studio run <pipeline> --provider mock            # Test without API calls
studio run <pipeline> --anonymize                # Anonymize PII before sending to LLM
studio replay <run-id>                           # Replay a completed run
studio validate <contract> <output.json>         # Validate output against contract
studio list pipelines                            # List available pipelines (also: agents, runs)
```

## Setup

```bash
studio init                                      # Interactive wizard (template, provider, tools)
studio init <project> --template <type>          # Direct mode (CI/CD-friendly)
studio config add-provider                       # Add an LLM provider (wizard)
studio config set provider anthropic --api-key $KEY
studio config set defaults.model claude-haiku-4-20250514
studio config list                               # Show config (API keys masked)
```

### Bootstrap — from a fresh machine

Studio can't install itself: an empty machine has no Studio to run the config that would install Studio. The entry point is external and it needs no Node.js.

```bash
curl -fsSL https://raw.githubusercontent.com/studio-foundation/studio/main/install.sh | sh
studio doctor
```

Joining an existing project instead of creating one:

```bash
git clone <repo> && cd <repo>
npm install                                       # if the project has a package.json
cp .studio/config.example.yaml .studio/config.yaml
studio doctor                                     # fix whatever it prints, then run
```

`studio init` writes this same sequence into `ONBOARDING.md` at the project root, so a generated project carries its own setup path. The file is written once and never regenerated over — edit it as the project grows.

## Less frequent commands

### Tools

```bash
studio tools list                                # Tools in the active project
studio tools add git                             # Install a tool (wizard)
studio tools remove nutrition                    # Remove a tool
studio tools info git                            # Tool details
```

### Templates

```bash
studio templates list                            # List available templates
studio template validate <path>                  # Validate a template structure
```

### Plugins

```bash
studio plugin add <name>                         # Install a plugin into this project
studio plugin remove <name>                      # Uninstall a plugin
studio plugin list                               # List installed plugins
```

A marketplace publishes two kinds of package: a **template**, which starts a project (`studio init --template X`), and a **plugin**, which adds to one that exists (`studio plugin add X`). Everything else — tools, agents, skills, integrations, pipelines, contracts, inputs — is a *content kind* carried inside a plugin, dispatched on install to its `.studio/` subdirectory by filename suffix. Payload filenames are kept as published, because the agent and skill loaders resolve by filename.

### Registry

```bash
studio registry install <name>                   # Install a package (same as plugin add)
studio registry remove <name>                    # Uninstall a package
studio registry search <query>                   # Search the registry
studio registry publish <path>                   # Publish a package
studio registry audit                            # Verify installed packages
studio registry sync                             # Sync registry.lock.json
studio registry outdated                         # List packages with an update available
studio registry update <name>                    # Update to the highest version dependents accept
studio registry update <name> --latest           # Update to the newest published version
```

The registry is hosted at [studio-community](https://github.com/studio-foundation/studio-community). Open publish, no review gate — submit a PR to add a package.

`studio registry install` resolves by name, not by type, so it installs templates and plugins alike — `studio plugin add` is the documented verb, `install` is the one muscle memory reaches for.

`--type` on `search` filters by packaging type (`template`, `plugin`) or by provided content kind (`--type tool` still means "packages that give me a tool"). `browse` groups by what packages deliver rather than by packaging type, which would otherwise be a two-item listing.

#### Dependency resolution

`studio registry install` and `studio init` resolve a package's declared dependencies before it lands. Required ones install transitively and unconditionally; a required name absent from the index aborts the install with that name, rather than producing a project that dies at its first tool call. Recommended ones are prompted one by one, and skipped entirely when there is nothing to prompt (`--yes`, no TTY). Cycles are reported, not looped on. See [CONCEPTS.md](CONCEPTS.md#package-dependencies) for the declaration format.

`studio registry remove <name>` warns when another installed package required the one being removed, then removes it anyway. Studio validates tool availability at run time; a second gate here would be enforcement without authority.

#### Updates and ranges

Resolution doesn't end at install time. `registry.lock.json` records the range each dependent declared, so a package installed under `git@<2.0.0` stays known as constrained rather than as "whatever version happened to land":

```json
"git": { "version": "1.4.0", "required_by": ["software"], "constraints": { "software": "<2.0.0" } }
```

- **`studio registry update <name>`** moves to the highest published version satisfying every recorded range — not to `latest`. When nothing satisfies them, it names the conflicting pair instead of installing. `--latest` overrides the ranges, warning which dependents it breaks.
- **`studio registry outdated`** separates the two questions the same row used to conflate: `wanted` is the highest version the constraints accept, `latest` is the newest published. When they differ, the row says which range holds the package back.
- **`studio registry audit`** checks the installed graph, not just checksums: a version that no longer satisfies a recorded range reports `CONFLICT`. Both sides live in the lockfile, so the check is offline.

A `--force` reinstall rewrites the payload fields only — dependents and their ranges survive it.

Entries written before this existed carry no `constraints`, which reads as unconstrained: `update` behaves as it always did until the package is reinstalled through a dependent that declares a range.

### Cache

```bash
studio cache clean                               # Clear the whole map-stage resume cache
studio cache clean --pipeline my-pipeline        # Only that parent pipeline's entries
studio cache clean --dry-run                     # Show what would be cleared
```

The cache lives at `.studio/runs/map-cache/<pipeline>/<stage>/<sub-pipeline>/<item-input-hash>.json` — it's what makes `resume: true` on a `map:` stage skip items already completed in an earlier run. Entries are keyed on the item input, **not** on the provider or model, so a warm re-run under a different provider replays the previous provider's outputs. Clear the cache before any provider or model comparison.

### Other

```bash
studio integrations list                         # Manage integrations (install, list, remove, test, set)
studio api start                                 # Start the HTTP REST API (also: stop, status)
```

---

## `.studio/` directory structure

When you run `studio init`, the project layout looks like this:

```
my-project/
├── .studio/
│   ├── config.yaml              # Provider config (gitignored)
│   ├── config.example.yaml      # Config contract (committed)
│   ├── pipelines/               # *.pipeline.yaml
│   ├── agents/                  # *.agent.yaml
│   ├── contracts/               # *.contract.yaml
│   ├── tools/                   # *.tool.yaml
│   ├── skills/                  # *.skill.md (optional, user-created)
│   ├── inputs/                  # *.input.yaml
│   ├── registry.lock.json       # Tool versions (committed)
│   └── runs/                    # Runtime data (gitignored)
│       ├── runs.db              # SQLite
│       └── logs/                # JSONL
├── src/
├── prisma/
├── ONBOARDING.md                # Fresh-machine setup path (committed)
└── .gitignore
```

**Committed:** `config.example.yaml`, `pipelines/`, `agents/`, `contracts/`, `tools/`, `skills/`, `inputs/`, `registry.lock.json`, `ONBOARDING.md`

**Gitignored:** `config.yaml` (API keys), `runs/`

You can also drop a `.studio/invariants.md` file at the project root. When present, its content is auto-injected into every agent's system prompt at runtime. It is not generated by `studio init`; create it by hand when you need it.

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

API keys can reference environment variables via `${VAR_NAME}`. This file is gitignored. Never commit API keys.

### The config contract — `config.example.yaml`

`config.yaml` is gitignored, so a fresh clone has none. `.studio/config.example.yaml` is the committed twin that declares what `config.yaml` must contain:

```bash
cp .studio/config.example.yaml .studio/config.yaml
```

**Every key left uncommented in the example is required.** `studio run` and `studio api start` check `config.yaml` against it before doing any work and stop with the missing paths:

```
Error: /repo/.studio/config.yaml is missing required key:
  - providers.anthropic.apiKey
  See /repo/.studio/config.example.yaml for the full contract.
```

A missing `config.yaml` is reported the same way, with the `cp` command to run. Only presence is checked — the value can come from `${VAR}`. Comment a key out to make it optional; a project with no `config.example.yaml` declares no contract and is never blocked.

Secrets belong in `config.yaml` only. In the example, reference them as `${ANTHROPIC_API_KEY}`.

### Required binaries — `requires_binaries`

A pipeline that shells out to `git` or `gh` used to start and die at the first tool call. `requires_binaries` declares those dependencies up front, and `studio run` checks them before any stage.

```yaml
# .studio/config.yaml
requires_binaries:
  - git
  - gh
  - "node >=18 <=22"    # semver range — the version is checked too
```

An entry is a binary name, optionally followed by a semver range. Presence is checked with `which`; a range additionally runs `<binary> --version` and matches the first version it reports. Tool plugins declare their own under `constraints.requires_binaries` in `.tool.yaml`, and those are checked the same way for every plugin loaded by the run.

```
Error: required binaries are missing or unsupported:
  - gh — not found in PATH (required by this project)
  - node — requires <=22, found 24.3.0 (required by this project)
  Install them, or relax requires_binaries in the declaring file.
```

`studio registry install` reports the same failures as a warning rather than a block — a package can legitimately be installed before the binaries it drives.

### Pinning the Studio version — `studio_version`

A project declares which Studio versions it works with, the way `package.json` declares `engines`:

```yaml
# .studio/config.yaml
studio_version: ">=0.10.0"
```

`studio run` and `studio api start` compare the installed CLI against that range before touching a stage, and stop when it doesn't satisfy it:

```
Error: This project requires Studio >=0.10.0, but you have 0.9.0.
  Upgrade:  studio upgrade
```

The upgrade line names the channel this install came from — `studio upgrade` for a
standalone binary, `npm i -g @studio-foundation/cli@latest` for an npm install.

Any semver range works (`>=0.10.0`, `^0.10.0`, `0.10.x`). Without the key, no version check runs.

This exists because a too-old Studio doesn't always fail loudly — a config using a key that version doesn't understand can leave a stage silently no-op'ing while the run still reports success. The guard turns that into a startup error.

`studio registry install` applies the same check to a package's own `studio_version` and refuses to install one that needs a newer CLI.

---

## Preflight — `studio doctor`

The checks above each fire at `studio run`, one at a time, in the middle of starting a pipeline. `studio doctor` runs them all at once, before you commit to a run, and answers a single question: **can this machine run this project?**

```
studio doctor

  ✓ Studio version     0.10.0  (project requires >=0.9.0)
  ✗ Config             config.yaml missing 1 key: providers.anthropic.apiKey
  ✗ Required binaries  gh missing or unsupported
  ⚠ Env vars           ANTHROPIC_API_KEY unset — resolves to an empty value

  3 problems found — fix before running:

  <the same actionable message each check prints at run>
```

| Check | What it verifies |
|---|---|
| Studio version | The installed CLI satisfies `studio_version` |
| Config | `config.yaml` has every key the `config.example.yaml` contract declares |
| Required binaries | Every `requires_binaries` entry — the project's and each tool plugin's — is on PATH and in range |
| Env vars | Every `${VAR}` referenced by `config.yaml` resolves to a value |

The env var check is the one `studio run` doesn't have: `${VAR}` with nothing behind it resolves to an **empty string**, so the key is present and the contract passes while the value is blank. It's a `⚠`, not a `✗` — a project can legitimately reference a key for a provider it isn't using.

Exit code is `1` when any `✗` check fails (a `⚠` alone exits `0`), so `studio doctor` works as a CI or bootstrap gate.

---

## Updating — `studio upgrade`

```bash
studio upgrade           # move to the latest release
studio upgrade v0.11.1   # install a specific release tag
```

Resolves the latest release, downloads the binary for this platform along with the
release's `SHA256SUMS`, verifies the checksum, and swaps the binary in place — the same
steps `install.sh` performs, without needing to remember where `install.sh` lives. It
says so and changes nothing when already on the target version.

The swap goes through a rename rather than an overwrite, because a running executable
cannot be overwritten on every platform.

**An npm install is not upgraded here.** npm owns those files and overwriting one breaks
the next `npm i -g`, so the command detects that install and prints the npm command
instead:

```
Studio 0.11.1 was installed through npm — npm owns the update.

Run:  npm i -g @studio-foundation/cli@latest
```

The `studio_version` mismatch error names whichever of the two applies to the running
install.

---

## Debugging

```bash
DEBUG=studio:* studio run feature-builder --input "..."   # Detailed events
studio run feature-builder --input "..." --live           # Real-time tool calls
studio run feature-builder --provider mock                 # No API calls
studio validate software/code-generation output.json       # Validate without LLM
```

Run logs are stored in `.studio/runs/logs/<timestamp>-<pipeline>-<id>.jsonl` (one JSON object per line).

# STU-89: CLI `studio ollama` + Hardware Detection in `studio init`

**Date:** 2026-03-05
**Status:** Approved

## Problem

Ollama is the default provider (STU-88), but there's no CLI surface for managing it, and `studio init` doesn't help users understand whether their hardware can run Ollama locally. First-run experience is broken: users pick Ollama, run a pipeline, get garbage output from a model too small for their hardware, and churn before seeing what Studio can do.

## Decisions

- `studio ollama` commands are **unmanaged** — Studio doesn't own the Ollama process lifecycle
- Native Ollama is checked first, Docker second (detection via `spawnSync`)
- Model pulls use **Ollama HTTP API** (`POST /api/pull`, streamed), not shell-out
- RAM detection uses `os.totalmem()` (total RAM, not free — total is the right signal for model capability)
- Hardware detection runs **silently before** the provider step in `studio init` — no new prompts, just shapes choices

## Architecture

### New file: `cli/src/commands/ollama.ts`

Pattern mirrors `cli/src/commands/api.ts`. Four exports:

```
ollamaStartCommand()   — check reachability, print instructions if not running
ollamaStopCommand()    — always print stop instructions (unmanaged)
ollamaStatusCommand()  — GET /api/tags, print models list
ollamaPullCommand(model) — POST /api/pull with streaming progress
```

Base URL: read from `config.yaml` `providers.ollama.baseUrl`, fallback `http://localhost:11434`.

Registered in `index.ts`:
```ts
program.command('ollama <action> [model]')
  .description('Manage Ollama (start, stop, status, pull <model>)')
  .action(ollamaCommand)
```

### Modified: `cli/src/commands/init.ts`

Hardware detection block inserted before the provider `select()` prompt:

```ts
const totalRamGb = os.totalmem() / (1024 ** 3);
const hasDocker = spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;
const hasNativeOllama = spawnSync('ollama', ['--version'], { stdio: 'ignore' }).status === 0;
const ollamaAvailable = hasDocker || hasNativeOllama;
```

Provider choices are built dynamically:
- If `ollamaAvailable && totalRamGb >= 16`: Ollama first, recommended label, set as default
- If `ollamaAvailable && totalRamGb < 16`: Ollama included with warning label; after selection show one-line RAM warning
- If `!ollamaAvailable`: Ollama omitted from choices; print info line about installing Docker/Ollama

When Ollama is selected, `writeProviderToConfig` writes:
```yaml
providers:
  ollama: {}
defaults:
  provider: ollama
  model: llama3.3
```
No API key prompt.

## Command Behaviour

### `studio ollama status`
1. `GET <baseUrl>/api/tags`
2. Running → print base URL + table of pulled models with size
3. Not running → print "Ollama not running" + how to start

### `studio ollama start`
Unmanaged check:
1. If already reachable → "Already running at `<url>`"
2. Else if native `ollama` found → print `ollama serve`
3. Else if `docker` found → print `docker run -d -p 11434:11434 ollama/ollama`
4. Else → "Neither Ollama nor Docker found" + links

### `studio ollama stop`
Always print: how to stop native (`Ctrl+C` or process kill) and Docker (`docker stop <container>`). No PID management.

### `studio ollama pull <model>`
1. Check Ollama reachable (same as status)
2. `POST <baseUrl>/api/pull` with `{ model, stream: true }`
3. Stream NDJSON lines → show ora spinner with progress status
4. On completion → "✓ Pulled `<model>`"
5. On `ECONNREFUSED` → "Ollama not running. Run: studio ollama start"

## Error Handling

| Situation | Behaviour |
|-----------|-----------|
| Ollama not reachable | Print instructions, exit 1 |
| Pull stream breaks mid-way | Print error, suggest retry |
| `spawnSync` not found | `status !== 0` or `null` — treated as not installed |
| Docker/ollama not found in init | Omit from choices, print info |

## Testing

**`cli/tests/commands/ollama.test.ts`** — unit tests with mocked `fetch` and `spawnSync`:
- `status`: running (with models), not running
- `start`: already running, native available, docker available, neither
- `stop`: always prints instructions
- `pull`: success with streaming, Ollama down

**`cli/tests/commands/init.test.ts`** additions — mock `os.totalmem` + `spawnSync`:
- `≥16GB + docker available` → Ollama first in choices
- `<16GB + ollama available` → warning label shown
- `no docker, no ollama` → Ollama absent from choices

## No New Dependencies

Uses `os` (built-in), `child_process` (built-in), `fetch` (Node 18+), `chalk`, `ora` — all already in `@studio-foundation/cli`.

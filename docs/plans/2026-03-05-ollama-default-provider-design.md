# Design: Ollama as Default Provider [STU-88]

## Context

Studio's ideological default is Ollama — no account, no credit card, no corporate dependency. This design makes `studio init` reflect that by detecting hardware reality and adapting the wizard accordingly.

## Decision Summary

- **Detection approach:** Inline (silent, before provider step) — no extra wizard step
- **RAM detection:** `os.totalmem()` with fallback to `false` on error (fail toward "limited hardware" warning)
- **RAM threshold:** 16GB
- **Default Ollama model:** `llama3.3`

## Detection Logic

Two helpers added to `cli/src/commands/init.ts`:

```typescript
function detectOllamaInstalled(): boolean {
  return spawnSync('ollama', ['--version'], { stdio: 'ignore' }).status === 0;
}

const RAM_16GB = 16 * 1024 ** 3;

function hasAdequateRam(): boolean {
  try {
    return os.totalmem() >= RAM_16GB;
  } catch {
    return false; // fail toward warning, not silent Ollama default
  }
}
```

Both are called once before the provider selection step.

## Provider Selection Step (Wizard)

### Case 1 — Ollama installed + RAM ≥ 16GB
Ollama pre-selected, shown first:
```
LLM Provider:
❯ Ollama (llama3.3) — runs locally, no API key needed
  Anthropic (Claude)
  OpenAI (GPT)
  Configure later
```

### Case 2 — Ollama installed + RAM < 16GB
Warning printed above the prompt, Anthropic pre-selected, Ollama available but labeled:
```
⚠ Ollama detected but your system has less than 16GB RAM.
  Results may be slow or limited for code generation.
  You can switch to Ollama later with: studio config set provider ollama

LLM Provider:
❯ Anthropic (Claude)
  OpenAI (GPT)
  Ollama (llama3.3) — installed but limited hardware
  Configure later
```

### Case 3 — Ollama not installed
Ollama shown as disabled (unselectable), Anthropic pre-selected:
```
LLM Provider:
  Ollama (not installed — run: ollama pull llama3.3)  [disabled]
❯ Anthropic (Claude)
  OpenAI (GPT)
  Configure later
```

## API Key + Model Steps

**When `provider === 'ollama'`:**
- API key step: skipped entirely
- Model step: plain `input` prompt with `default: 'llama3.3'` (no network call)

**Direct mode (`studio init --template x --provider ollama`):**
- `--api-key` flag becomes optional (no validation, no live check)

## `writeProviderToConfig` Signature Change

Current signature: `(studioDir, provider, apiKey, model?)`
New signature: `(studioDir, provider, credentials, model?)` where `credentials = { apiKey?: string; baseUrl?: string }`

Ollama passes `{}` or `{ baseUrl }`. Cloud providers pass `{ apiKey }`.

```typescript
// Ollama — write empty config or baseUrl
(parsed.providers as Record<string, unknown>)[provider] =
  credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {};

// Others — write apiKey
(parsed.providers as Record<string, unknown>)[provider] =
  { apiKey: credentials.apiKey };
```

## Config Template

`cli/templates/studio-config.yaml` switches to Ollama as ideological default:

```yaml
providers:
  ollama: {}
  # anthropic:
  #   apiKey: ${ANTHROPIC_API_KEY}
  # openai:
  #   apiKey: ${OPENAI_API_KEY}

defaults:
  provider: ollama
  model: llama3.3
```

## `DEFAULT_MODELS` Update

```typescript
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  ollama: 'llama3.3',
};
```

## Out of Scope

- Docker support (STU-89) — when Ollama is not installed, Docker is not offered yet
- Template agent YAMLs — agents inherit provider from `config.yaml` defaults, no hardcoding needed
- Runner/engine changes — Ollama provider already works (STU-87)

## Tests

- `detectOllamaInstalled` unit tests: mock `spawnSync` for installed/not-installed cases
- `hasAdequateRam` unit tests: mock `os.totalmem()` for ≥16GB, <16GB, and error cases
- `writeProviderToConfig` Ollama case: no `apiKey` written, correct defaults
- Wizard integration: three detection scenarios → verify correct `default` in provider `select`
- Direct mode: `--provider ollama` without `--api-key` succeeds

# Design: Ollama Provider Adapter in @studio/runner

**Ticket:** STU-87
**Date:** 2026-03-05
**Status:** Approved

## Context

Studio currently supports Anthropic, OpenAI, and OpenAI Responses API providers. To remove the hard dependency on cloud APIs at launch, we need a local provider backed by Ollama. Ollama exposes an OpenAI-compatible `/v1/chat/completions` endpoint, making this a thin adapter rather than a full reimplementation.

## Approach

Thin wrapper class (`OllamaProvider`) that uses the `openai` npm SDK pointed at Ollama's local server. Reuses all existing streaming and tool call accumulation logic. No new dependencies.

## Target Config

```yaml
providers:
  ollama:
    baseUrl: http://localhost:11434
defaults:
  provider: ollama
  model: llama3.2
```

## Architecture

### New file

**`runner/src/providers/ollama.ts`**

- Class `OllamaProvider implements Provider`
- `name = 'ollama'`
- Constructor: `baseUrl = 'http://localhost:11434'`
- Instantiates `openai` SDK with `baseURL = baseUrl + '/v1'` and `apiKey = 'ollama'` (SDK requires non-empty; Ollama ignores it)
- Same message building, streaming, and tool call accumulation as `OpenAIProvider`
- Key difference: streaming call omits `stream_options: { include_usage: true }` — older Ollama versions reject it
- Error handling: catch `ECONNREFUSED` → rethrow with human message:
  `"Ollama is not running at <baseUrl>. Start it with: ollama serve"`

### Modified files

| File | Change |
|------|--------|
| `runner/src/providers/registry.ts` | Add `ollama?: { baseUrl?: string }` to `createDefaultRegistry` config; instantiate `OllamaProvider` when present |
| `runner/src/index.ts` | Export `OllamaProvider` |
| `cli/src/config.ts` | Add `ollama?: { baseUrl?: string }` to `StudioConfig.providers` |
| `cli/src/commands/run.ts` | Pass `config.providers?.ollama` to `createDefaultRegistry` |
| `cli/src/commands/config.ts` | Rename `local` → `ollama` in PROVIDERS list; store `{ baseUrl }` (not `{ apiKey }`) for ollama entries |
| `api/src/bootstrap.ts` | Add `ollama` to `StudioApiConfig.providers`; pass to registry |

Engine, ralph, contracts — untouched. The multi-turn tool call loop in `runner.ts` is unchanged.

## Error Handling

- Ollama not running → clear message with `ollama serve` hint
- Usage stats will be `undefined` for Ollama (acceptable — observability only, not correctness)
- Tool calling requires a model that supports it (llama3.2, mistral-nemo, etc.) — user responsibility

## Testing

New file: `runner/src/providers/ollama.test.ts`

- `name === 'ollama'`
- Correct `baseURL` forwarded to SDK (default and custom)
- Tool calls parsed and returned correctly
- `ECONNREFUSED` → clear error with "ollama serve" hint
- Streaming path: verifies `stream_options` is NOT included in the request

No live integration test — requires local Ollama instance.

## What Does Not Change

- `@studio/engine` — domain-agnostic, agnostic of provider name
- `@studio/ralph` — takes a generic executor, no provider knowledge
- `@studio/contracts` — zero dependencies, zero changes
- Runner's multi-turn tool call loop — same path regardless of provider

# STU-49 Extension: Models Cache Design

**Goal:** Reuse the `/v1/models` validation call to populate an in-memory models cache, enabling smart model selection in wizards and `studio config set default.model`.

---

## Architecture

Two modules, one network call:

```
validateApiKeyLive()          ← called by init + config wizards
  └─ fetch /v1/models (200)
       └─ setCachedModels()   ← silently populates cache

getAvailableModels()          ← called by wizards for model list
  └─ getCachedModels()        ← warm cache → returns immediately
       └─ if miss → fetch /v1/models + setCachedModels + return
```

### `cli/src/models-cache.ts` (new)

In-memory `Map<cacheKey, { models: string[], fetchedAt: number }>`, TTL 24h.

Exports:
- `setCachedModels(provider, apiKey, models: string[]): void`
- `getCachedModels(provider, apiKey): string[] | null` — null on miss or expired
- `getAvailableModels(provider, apiKey): Promise<string[]>` — cache-or-fetch, never throws

### `cli/src/provider-validator.ts` (modified)

After a 200 response from `/v1/models`, parse `response.json()` and call `setCachedModels`. Public API (`ValidationResult`) unchanged.

---

## Filtering Heuristics

```typescript
// Anthropic: claude-* except claude-instant* and claude-2*
model.id.startsWith('claude-')
  && !model.id.startsWith('claude-instant')
  && !model.id.startsWith('claude-2')

// OpenAI: gpt-4*, o1*, o3*
model.id.startsWith('gpt-4')
  || model.id.startsWith('o1')
  || model.id.startsWith('o3')

// Unknown provider: show all
true
```

## Sorting

- If model object has `created` (UNIX timestamp) → sort descending
- Otherwise → lexicographic descending on ID

## Provider API Response Shapes

- Anthropic `GET /v1/models` → `{ data: [{ id: string, created_at: string }] }`
- OpenAI `GET /v1/models` → `{ data: [{ id: string, created: number }] }`
- Google: no standard `/v1/models` endpoint → does not populate cache (validation still works)
- Local/Ollama: not applicable

---

## UX

### Wizards (`studio init`, `studio config add-provider`)

After successful validation (cache already warm), replace the hardcoded default model input with a select:

```
? Anthropic API Key: ****
  Validating... ✓ Valid

? Default model:
❯ claude-sonnet-4-20250514
  claude-opus-4-20250514
  claude-haiku-4-20250514
  claude-3-7-sonnet-20250219
  ─────────────────────────
  Enter custom model ID
```

Fallback: if `getAvailableModels` returns empty array → `input` prompt with hardcoded default. No regression.

### `studio config set default.model` (no value = interactive)

```bash
studio config set default.model   # triggers interactive mode
```

1. Read configured provider + apiKey from `config.yaml`
2. Call `getAvailableModels` (cold cache → real network call here)
3. Show same select
4. If empty → error: `Error: could not fetch models for provider 'anthropic'. Provide the model ID directly: studio config set default.model <model-id>`

---

## Constraints

- `getAvailableModels` never throws — on any error, returns `[]`
- `validateApiKeyLive` public API unchanged (`ValidationResult` type)
- Cache key = `${provider}:${apiKey.slice(0, 8)}` (avoid storing full key as map key)
- TTL: 24h (effectively scoped to a single CLI invocation in practice)
- Google and Local providers: no model list, no cache entry, graceful fallback in wizards

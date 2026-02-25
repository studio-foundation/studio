# STU-144 — API: GET /runs/:id/logs

## Context

`GET /api/runs/:id/logs` is already partially implemented — it reads the JSONL log file and returns it as `text/plain`. This task completes the endpoint by:

1. Adding a structured JSON response (default)
2. Adding `?raw=true` for the existing raw behavior

## Response Formats

### Default — structured JSON

```json
{
  "run_id": "abc-123",
  "entries": [
    { "event": "onPipelineStart", "timestamp": "2026-01-01T10:00:00Z", "data": { "pipeline_name": "feature-builder" } },
    { "event": "onStageComplete", "timestamp": "2026-01-01T10:01:00Z", "data": { "stage_name": "code-generation", "status": "success" } }
  ]
}
```

Each JSONL line `{ "ts": "...", "event": "...", ...rest }` maps to:
- `timestamp` ← `ts` (empty string if absent)
- `event` ← `event`
- `data` ← all other fields (omitting `ts` and `event`)

Lines missing `event` are skipped silently. Malformed JSON lines are skipped silently.

### `?raw=true` — raw JSONL

Returns the file content as-is with `Content-Type: text/plain`. This is the current behavior.

## Error Handling (unchanged)

- `404` — run not found in store
- `404` — log path not registered for run (`"Log not yet available"`)
- `404` — log file missing on disk (`"Log file not found"`)

## Changes

### `api/src/routes/runs.ts`

- Add `Querystring: { raw?: string }` to the route generic
- Add `raw` to the schema querystring
- Parse JSONL into entries when `raw` is not `"true"`
- Return structured `{ run_id, entries }` as JSON (default)
- Return raw text when `raw=true`

### `api/tests/runs.test.ts`

New tests in `describe('GET /api/runs/:id/logs')`:
- Default response returns `{ run_id, entries }` with correct entry shape
- `?raw=true` returns `text/plain` with raw content
- Malformed JSONL lines are skipped silently in structured mode
- Lines without `event` field are skipped

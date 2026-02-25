# Design — GET /api/projects/:id/inputs (STU-136)

## Problem

The API exposes `GET /api/projects/:id/pipelines` to list pipeline files, but has no equivalent endpoint for input files. Callers (e.g. a CLI wizard, a dashboard) cannot enumerate available `.input.yaml` files via the REST API.

## Solution

Add `GET /api/projects/:id/inputs` following the exact same pattern as the pipelines endpoint.

## Route

```
GET /api/projects/:id/inputs
```

**Path param:** `id` — project ID (SHA-256 hash of `configsDir`, first 12 chars).

**Response 200:**
```json
{ "inputs": ["faq-about", "dark-mode-request"] }
```

**Response 404:** `{ "error": "Project not found" }` — when `id` doesn't match the current project.

## Behavior

1. Validate `id` matches the current project; return 404 otherwise.
2. Read `{configsDir}/inputs/` directory.
3. Filter entries ending in `.input.yaml`, strip the suffix.
4. Return `{ inputs: string[] }`.
5. If the `inputs/` directory is missing, return `{ inputs: [] }` (no error).

## Implementation

**File:** `api/src/routes/projects.ts`

Add a new `fastify.get<{ Params: { id: string } }>('/projects/:id/inputs', ...)` handler immediately after the existing `/projects/:id/pipelines` handler. Uses the same `readdir` + filter + map pattern. The `listResources` helper could be used but the inline pattern is consistent with the pipelines handler.

**File:** `api/tests/projects.test.ts`

Add a `describe('GET /api/projects/:id/inputs')` block. The existing `PROJECT_TMP` fixture already creates `inputs/faq-about.input.yaml`, so no additional fixtures needed. Test cases:
- Returns only `*.input.yaml` files as input names
- Returns 404 for unknown project id
- Returns empty array when inputs dir is missing

## Files touched

| File | Change |
|------|--------|
| `api/src/routes/projects.ts` | +~20 lines — new route handler |
| `api/tests/projects.test.ts` | +~25 lines — new describe block |

## Non-goals

- No pagination, sorting, or filtering
- No file content returned (list only)
- No CRUD — read-only list endpoint

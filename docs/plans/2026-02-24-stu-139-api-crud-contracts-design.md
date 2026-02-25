# Design — STU-139: API CRUD Contracts (GET, PUT, DELETE)

## Context

The CLI can read and modify contracts via the filesystem. A web interface needs to do the same via the API. This adds four REST endpoints for reading, creating, updating, and deleting contracts in `.studio/contracts/`.

## Endpoints

```
GET    /api/contracts           → list all available contract names
GET    /api/contracts/:name     → return parsed contract content (JSON)
PUT    /api/contracts/:name     → create or update a contract (body: JSON object)
DELETE /api/contracts/:name     → delete the contract file
```

## Architecture

**New file:** `api/src/routes/contracts.ts` — dedicated route file, following the existing pattern of `runs.ts` and `projects.ts`. Registered in `server.ts`.

**No new `ServerDeps` fields** — derives `contractsDir` as `join(configsDir, 'contracts')` from existing `configsDir`.

## Endpoint Details

### `GET /api/contracts`

- Reads `join(configsDir, 'contracts')` directory
- Filters files ending in `.contract.yaml`, strips suffix
- Returns `{ contracts: string[] }`
- Returns empty array if directory is missing (no error)

### `GET /api/contracts/:name`

- Reads `${name}.contract.yaml`
- Parses with `js-yaml.load()`
- Returns the parsed object as JSON
- Returns 404 `{ error: 'Contract not found' }` if file missing

### `PUT /api/contracts/:name`

- Accepts JSON body (the contract object)
- Validates: body must have `name` (string) and `version` fields — mirrors minimal validation in `engine/src/pipeline/contract-loader.ts`
- Converts to YAML with `js-yaml.dump()` and writes `${name}.contract.yaml`
- Creates the `contracts/` directory if absent (`mkdir -p`)
- Returns 200 + `{ name, content }` where `content` is the parsed object
- Returns 400 `{ error: '...' }` if validation fails

### `DELETE /api/contracts/:name`

- Deletes `${name}.contract.yaml`
- Returns 204 (no body)
- Returns 404 `{ error: 'Contract not found' }` if file missing

## Body Format for PUT

JSON object representing the contract:

```json
{
  "name": "code-generation",
  "version": 1,
  "schema": {
    "required_fields": ["summary", "files_changed"]
  },
  "tool_calls": {
    "minimum": 1
  }
}
```

Stored on disk as YAML (via `js-yaml.dump()`).

## Error Codes

| Code | Condition |
|------|-----------|
| 400  | Missing `name` or `version` in PUT body |
| 404  | Contract not found (GET, DELETE) |
| 204  | Successful DELETE |

## Testing

`api/tests/contracts.test.ts` — uses tmp dirs, `Fastify.inject()`, consistent with `projects.test.ts`:

- `GET /api/contracts` — lists only `*.contract.yaml` files, ignores others, empty array when dir missing
- `GET /api/contracts/:name` — returns parsed content, 404 for unknown
- `PUT /api/contracts/:name` — creates new file, updates existing, 400 on missing `name`, 400 on missing `version`
- `DELETE /api/contracts/:name` — deletes file, 404 for unknown

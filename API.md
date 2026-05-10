# API

HTTP REST API for machine-to-machine usage. Same engine, different interface, for when there's no human at the terminal.

Start the server:

```bash
studio api start
```

---

## Authentication

Optional. If `api.key` is defined in `config.yaml`, all routes require `Authorization: Bearer <key>`. Without a key, the API is open (local use only).

---

## Endpoints

### Runs

```
POST   /api/runs                → Launch a pipeline (fire-and-forget)
GET    /api/runs                → List runs (?status=&limit=)
GET    /api/runs/:id            → Run details
GET    /api/runs/:id/logs       → Raw JSONL logs
GET    /api/runs/:id/stream     → SSE — live events (?events=csv)
```

### Projects

```
GET    /api/projects            → Current project (name, id, pipelines_dir)
GET    /api/projects/:id/pipelines → Project pipelines
```

### Pipelines CRUD

```
GET    /api/pipelines           → List all pipeline names
GET    /api/pipelines/:name     → Parsed pipeline (YAML → JSON)
PUT    /api/pipelines/:name     → Create or update (body: YAML or JSON)
DELETE /api/pipelines/:name     → Delete
```

### Agents CRUD

```
GET    /api/agents              → List all agent names
GET    /api/agents/:name        → Parsed agent (YAML → JSON)
PUT    /api/agents/:name        → Create or update (body: JSON)
DELETE /api/agents/:name        → Delete
```

### Contracts CRUD

```
GET    /api/contracts           → List all contracts
GET    /api/contracts/:name     → Parsed contract (YAML → JSON)
PUT    /api/contracts/:name     → Create or update (body: JSON)
DELETE /api/contracts/:name     → Delete
```

### Skills CRUD

```
GET    /api/skills              → List all skills
GET    /api/skills/:name        → Skill content (.skill.md)
PUT    /api/skills/:name        → Create or update (body: markdown)
DELETE /api/skills/:name        → Delete
```

### Tools

```
GET    /api/tools               → List available tools (plugins + builtins)
```

### Validation

```
POST   /api/validate            → Validate JSON output against a contract
```

### Config

```
GET    /api/config              → Current config (API keys masked)
PUT    /api/config              → Update config
```

### Webhooks

```
POST   /api/webhooks            → Register a webhook (url + events)
GET    /api/webhooks            → List configured webhooks
DELETE /api/webhooks/:id        → Remove a webhook
```

---

## SSE streaming

`GET /api/runs/:id/stream` returns Server-Sent Events for live pipeline progress. Filter with `?events=onStageStart,onStageComplete,onToolCallStart`.

See [CONCEPTS.md](./CONCEPTS.md) for the full event list.

---

## Swagger UI

Available at `/api/docs` in development (`NODE_ENV !== production`). Generated automatically from route schemas, no manual spec maintenance.

Raw OpenAPI spec at `/api/docs/json` for client generation.

---

## Integrations

**Linear:** Webhook handler auto-launches pipelines on issue status changes. Drag an issue to "In Progress" → Studio runs the matching pipeline → results posted as comment → issue moves to "Done".

**CI/CD:** Trigger pipelines from GitHub Actions via `POST /api/runs`.

**Webhooks:** Register HTTP callbacks for pipeline events (start, complete, reject, fail).

---

## Error codes

| Code | Meaning |
|------|---------|
| `400` | Invalid YAML (PUT endpoints) |
| `401` | Missing or incorrect API key |
| `404` | Resource not found |

---

## Route schema requirement

Every Fastify route must have a complete Swagger schema: `tags`, `summary`, `params`, `querystring` (if applicable), `body` (if applicable), and `response` for all returned status codes including errors.

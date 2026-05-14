# API

HTTP REST API for machine-to-machine usage.

The API serves workflows where there's no human at the terminal — webhook-triggered runs from Linear, GitHub Actions, Slack bots, dashboards. Same engine as the CLI, different interface.

Start the server:

```bash
studio api start
```

---

## Authentication

Optional. If `api.key` is defined in `config.yaml`, all routes require `Authorization: Bearer <key>`. Without a key, the API is open.

> **Security:** the API binds to localhost by default. Do not expose it on a public interface without configuring `api.key`. An unauthenticated API exposes pipeline execution, config mutation, and SSE log streaming.

---

## Endpoints

### Runs

```
POST   /api/runs                → Launch a pipeline (fire-and-forget)
GET    /api/runs                → List runs (?status=&limit=)
GET    /api/runs/:id            → Run details
GET    /api/runs/:id/logs       → Raw JSONL logs
GET    /api/runs/:id/stream     → SSE — live events (?events=csv)
POST   /api/runs/:id/cancel     → Cancel a running pipeline
POST   /api/runs/:id/retry      → Retry a failed/cancelled run
DELETE /api/runs/:id            → Delete a run record
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

Available at `/api/docs` in development (`NODE_ENV !== production`). Generated automatically from route schemas.

Raw OpenAPI spec at `/api/docs/json` for client generation.

---

## Integrations

**Linear:** webhook handler auto-launches pipelines on issue status changes. Drag an issue to "In Progress" → Studio runs the matching pipeline → results posted as comment → issue moves to "Done".

**CI/CD:** trigger pipelines from GitHub Actions via `POST /api/runs`.

**Webhooks:** register HTTP callbacks for pipeline events (start, complete, reject, fail).

---

## Example: Linear webhook to PR

The current priority workflow: a Linear issue moves to "In Progress" and Studio runs `feature-builder`, commits the result, and opens a PR.

**1. Linear posts to Studio when an issue changes status:**

```http
POST /api/runs HTTP/1.1
Host: studio.example.internal
Authorization: Bearer $STUDIO_API_KEY
Content-Type: application/json

{
  "pipeline": "software/feature-builder",
  "input": {
    "title": "Add dark mode toggle",
    "description": "Toggle in the settings page, persisted to localStorage.",
    "linear_issue_id": "ENG-1234"
  }
}
```

**2. Studio responds immediately with a run id:**

```json
{ "run_id": "run_01HXY..." }
```

**3. Subscribe to live progress (optional):**

```bash
curl -N -H "Authorization: Bearer $STUDIO_API_KEY" \
  "https://studio.example.internal/api/runs/run_01HXY.../stream?events=onStageComplete,onPipelineComplete"
```

**4. On `onPipelineComplete`, the registered webhook fires** with the final status, files changed, and any artifacts produced by the pipeline. The webhook handler creates the commit and PR, and posts the link back to the Linear issue.

The hand-off between Studio and the surrounding system is the webhook contract. Studio runs the pipeline; what happens around it (PR creation, Slack notification, issue update) lives in the integration layer.

---

## Error codes

| Code | Meaning |
|------|---------|
| `400` | Invalid YAML (PUT endpoints) |
| `401` | Missing or incorrect API key |
| `404` | Resource not found |

# API

HTTP REST API for machine-to-machine usage.

The API serves workflows where there's no human at the terminal — webhook-triggered runs from an issue tracker, a CI job, a chat bot, a dashboard. Same engine as the CLI, different interface.

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
GET    /api/project             → Introspect the current Studio project
GET    /api/projects            → List projects served by this API instance
GET    /api/projects/:id/pipelines    → Project pipelines
GET    /api/projects/:id/inputs       → Project input templates
GET    /api/projects/:id/inputs/:name → One input file
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
POST   /api/contracts/:name/validate → Validate an output against this contract
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
GET    /api/tools/:name         → Tool definition
PUT    /api/tools/:name         → Create or update a custom tool (YAML text or JSON)
DELETE /api/tools/:name         → Delete a custom tool
POST   /api/tools/install       → Install a tool from the bundled registry (body: name)
```

### Users

```
POST   /api/users               → Create a user (body: email, plan?)
GET    /api/users               → List users
GET    /api/users/me            → Current authenticated user
GET    /api/users/:id           → User details
DELETE /api/users/:id           → Delete a user
```

### Validation

```
POST   /api/validate            → Validate JSON output against a contract
```

### Config

```
GET    /api/config              → Current config (API keys masked)
PATCH  /api/config              → Merge into config (defaults, providers)
POST   /api/config/providers    → Add or update a provider
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

## Triggers

A trigger is an inbound webhook that launches a run, declared in
`.studio/triggers/<name>.trigger.yaml`. The API serves one endpoint per file; everything
specific to the sending system — which deliveries count, how the payload becomes pipeline
input, what to run if the pipeline fails — is written in that YAML, not in Studio.

```
GET    /api/triggers/:name           — the trigger, its pipeline, and its recent deliveries
POST   /api/triggers/:name/webhook   — receive a delivery
```

`POST` verifies the `webhook.hmac` signature, evaluates every `webhook.when` condition
against `payload.<path>`, and either launches the run (`202`, with `run_id` and
`stream_url`) or reports why it did not (`200` with `ignored: true`, `401` on a bad
signature, `400` on a malformed body). Triggers are unauthenticated by design — the HMAC
signature is what authenticates the sender, so the API key is not required on these routes.

See CONCEPTS.md for the file format.

**Other ways in:** `POST /api/runs` for a caller that can hold an API key (CI, a script),
and outbound webhooks (`/api/webhooks`) for HTTP callbacks on pipeline events.

---

## Example: an issue tracker webhook to a PR

An issue moves to "In Progress", Studio runs `feature-builder`, commits the result, and
opens a PR. A trigger file does step 1; the example below shows the equivalent done by
hand through `POST /api/runs`.

**1. The tracker posts to Studio when an issue changes status:**

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
    "issue_id": "ENG-1234"
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

**4. On `onPipelineComplete`, the registered webhook fires** with the final status, files changed, and any artifacts produced by the pipeline. The receiving handler creates the commit and PR, and posts the link back to the issue.

The hand-off between Studio and the surrounding system is the webhook contract in both directions: a trigger brings work in, an outbound webhook or a tool reports it back out. Studio runs the pipeline; what happens around it lives outside the kernel.

---

## Error codes

| Code | Meaning |
|------|---------|
| `400` | Invalid YAML (PUT endpoints) |
| `401` | Missing or incorrect API key |
| `404` | Resource not found |

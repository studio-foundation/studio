# @studio/api

HTTP REST API for Studio. Same engine as the CLI, machine-to-machine interface. Like GitHub is to `git`.

## Role

api wraps the engine in a Fastify server. It handles fire-and-forget pipeline launches, real-time SSE streaming, webhook dispatch, and integration lifecycle (Linear, etc.). The CLI (`studio api start`) is the primary way to run it, but it can also be imported programmatically.

```
Linear webhook → POST /api/runs → launcher → engine → pipeline run → webhook dispatch
Slack bot      → POST /api/runs ↗
CI/CD          → POST /api/runs ↗
Dashboard      → GET  /api/runs/:id/stream (SSE)
```

## Starting the server

```bash
# Via CLI (recommended)
studio api start

# Standalone (PM2/systemd)
STUDIO_CWD=/path/to/project node node_modules/.bin/studio-api

# Programmatic
import { createApi } from '@studio/api';
const { server, cleanup } = await createApi({ cwd: '/path/to/project' });
await server.listen({ port: 3700 });
```

## Configuration

The server reads `.studio/config.yaml` from the project directory (or the first `.studio/` found walking up from `STUDIO_CWD`):

```yaml
api:
  key: my-secret-key   # Optional — enables Bearer auth. Omit for open local use.
  port: 3700           # Default: 3700

db:
  type: postgres       # 'sqlite' | 'postgres' | 'inmemory'. Default: 'sqlite'
  url: ${DATABASE_URL} # Required if type is postgres

providers:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
```

**Authentication:** If `api.key` is set, all routes require `Authorization: Bearer <key>`. Without a key, the API is open (local use only).

## Endpoints

### Runs

```
POST   /api/runs                → Launch a pipeline (fire-and-forget). Returns run ID immediately.
GET    /api/runs                → List runs (?status=&limit=)
GET    /api/runs/:id            → Run detail
GET    /api/runs/:id/logs       → Raw JSONL logs
GET    /api/runs/:id/stream     → SSE — live events (?events=csv filter)
DELETE /api/runs/:id            → Cancel a running pipeline
```

### Project

```
GET    /api/projects            → Current project (name, id, pipelines_dir)
GET    /api/projects/:id/pipelines → Pipelines for a project
```

### CRUD (Pipelines, Agents, Contracts, Skills)

```
GET    /api/pipelines           → List pipeline names
GET    /api/pipelines/:name     → Parsed pipeline (YAML → JSON)
PUT    /api/pipelines/:name     → Create or update a pipeline (body: YAML or JSON)
DELETE /api/pipelines/:name     → Delete a pipeline

GET    /api/agents              → List agent names
GET    /api/agents/:name        → Parsed agent
PUT    /api/agents/:name        → Create or update an agent
DELETE /api/agents/:name        → Delete an agent

GET    /api/contracts           → List contract names
GET    /api/contracts/:name     → Parsed contract
PUT    /api/contracts/:name     → Create or update a contract
DELETE /api/contracts/:name     → Delete a contract

GET    /api/skills              → List skill names
GET    /api/skills/:name        → Skill content (.skill.md)
PUT    /api/skills/:name        → Create or update a skill (body: markdown)
DELETE /api/skills/:name        → Delete a skill
```

### Tools, Config, Validation

```
GET    /api/tools               → Available tools (YAML plugins + builtins)

GET    /api/config              → Current config (API keys masked)
PUT    /api/config              → Update config

POST   /api/validate            → Validate a JSON output against a contract
```

### Webhooks

```
POST   /api/webhooks            → Register a webhook (url + events filter)
GET    /api/webhooks            → List webhooks
DELETE /api/webhooks/:id        → Delete a webhook
```

### Swagger UI

```
GET    /api/docs                → Swagger UI (dev only — disabled in NODE_ENV=production)
GET    /api/docs/json           → OpenAPI spec (for client generation)
```

## SSE streaming

Connect to `/api/runs/:id/stream` to receive live events:

```javascript
const es = new EventSource('/api/runs/run-123/stream');
es.addEventListener('stage_complete', (e) => console.log(JSON.parse(e.data)));
es.addEventListener('pipeline_complete', (e) => { es.close(); });

// Filter to specific event types:
// GET /api/runs/:id/stream?events=stage_complete,tool_call_complete
```

## Integrations

The API manages integration lifecycle (webhook routing, failure handling). Integrations are configured via `.studio/config.yaml` and declared via `.integration.yaml` files in `.studio/integrations/`.

**Linear integration** — drag an issue to "In Progress" → Studio receives the webhook → auto-launches the matching pipeline → posts results as a comment → moves the issue to "Done" on success.

## Sub-pipeline spawning

The API uses `HttpApiSpawner` — a self-referential `RunSpawner` that calls back into the same API to spawn child runs. This is how `studio_run` tool calls work when the engine is running behind the API.

## Bootstrap internals

`bootstrap(cwd)` is the composition root:
1. Finds `.studio/` by walking up from `cwd`
2. Loads `config.yaml` (with `${ENV_VAR}` substitution)
3. Creates `RunStore` based on `db.type` (`SQLiteRunStore` | `PgRunStore` | `InMemoryRunStore`)
4. Creates `ProviderRegistry`, `ToolRegistry` (loads `.tool.yaml` plugins)
5. Loads Claude Code plugins (`MCPClient` per server)
6. Creates `HttpApiSpawner`, `PipelineEngine`, `InProcessLauncher`
7. Creates `WebhookStore`, `IntegrationStore`, `IntegrationRuntime`
8. Returns `BootstrapResult` passed to `buildServer()`

## Rules

- **api depends on engine + runner.** It is a composition root, same as cli.
- **Routes must have complete Swagger schemas** — tags, summary, params, response codes. Without this, routes don't appear in Swagger UI.
- **The engine is the same.** The API doesn't bypass or wrap the engine — it delegates to `InProcessLauncher`, which calls `PipelineEngine.run()` directly.
- `studio api start` calls `bootstrap()` then `buildServer()`. The two steps are separate so programmatic users can customize between them.

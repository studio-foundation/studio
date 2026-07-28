# @studio-foundation/api

Serveur HTTP REST pour Studio. Même engine que le CLI, interface machine-to-machine.

## Concept

`bootstrap(cwd)` trouve `.studio/`, câble engine + store + launcher + triggers.
`buildServer()` crée le serveur Fastify avec toutes les routes et le Swagger UI.
Résultat : webhook entrant → pipeline run → SSE streaming → webhook dispatch.

## Règles

- Le API est aussi un **composition root** — même pattern que CLI, dépend de `@studio-foundation/engine` et `@studio-foundation/runner`
- Toute route Fastify **DOIT** avoir un schema Swagger complet (tags, summary, params, response). Sans ça, la route n'apparaît pas dans Swagger UI.
- Le engine est appelé via `InProcessLauncher` — pas de HTTP round-trip interne sauf pour `HttpApiSpawner`
- Swagger UI désactivé en production (`NODE_ENV=production`)
- Auth Bearer optionnelle : si `api.key` dans `config.yaml`, toutes les routes l'exigent
- DB configurable : `db.type: sqlite | postgres | inmemory` dans `config.yaml`

## Fichiers clés

- `bootstrap.ts` — `bootstrap(cwd)` : trouve `.studio/`, crée store + engine + launcher + triggers
- `server.ts` — `buildServer()` : Fastify factory, monte toutes les routes
- `launcher.ts` — `InProcessLauncher` : lance les pipelines en arrière-plan, publie sur le bus d'événements
- `event-bus.ts` — `RunEventBus` : bus interne SSE (run events → clients connectés)
- `routes/runs.ts` — `GET/POST /api/runs`, SSE `/api/runs/:id/stream`, cancel
- `routes/pipelines.ts`, `agents.ts`, `contracts.ts`, `skills.ts` — CRUD YAML
- `routes/tools.ts` — `GET /api/tools`
- `routes/projects.ts` — `GET /api/projects`
- `routes/config.ts` — `GET/PUT /api/config`
- `routes/validate.ts` — `POST /api/validate`
- `routes/webhooks.ts` — enregistrement webhooks
- `webhook-store.ts`, `webhook-dispatcher.ts` — persistence + dispatch webhooks
- `trigger-store.ts`, `trigger-runtime.ts` — endpoints entrants, journal des livraisons, `on_failure`
- `triggers/trigger-loader.ts`, `triggers/webhook.ts` — chargement des `.trigger.yaml`, HMAC + matching + templating
- `spawners/http-api-spawner.ts` — `HttpApiSpawner` : spawner auto-référentiel pour `studio_run`

## Séquence bootstrap

```
findStudioDir(cwd)
  → loadConfig (config.yaml + ${ENV_VAR} substitution)
  → createRunStore (SQLite | PostgreSQL | InMemory)
  → createProviderRegistry + ToolRegistry
  → loadProjectTools (.tool.yaml) + loadPlugins (MCP)
  → new HttpApiSpawner → EngineConfig → InProcessLauncher
  → WebhookStore + TriggerStore + TriggerRuntime
```

## Dépendances

`@studio-foundation/engine`, `@studio-foundation/runner`, `@studio-foundation/contracts`

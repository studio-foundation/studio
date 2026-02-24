# Design — STU-22 : @studio/api (Fastify REST Phase 1)

## Contexte

Création du package `@studio/api` avec Fastify. Endpoints REST de base pour lancer et consulter des runs. Le CLI et l'API sont deux interfaces indépendantes sur le même engine — pas de dépendance de `api` vers `cli`.

## Décisions clés

- **Single project** : l'API sert UN seul `.studio/` (celui du répertoire de travail). `GET /api/projects` retourne un seul projet.
- **Startup** : commande `studio api start` dans `@studio/cli`, mais `@studio/api` a son propre entrypoint standalone pour PM2/systemd.
- **Logs** : chemin du fichier JSONL stocké dans `RunStore` via nouvelles méthodes `saveLogPath` / `getLogPath`.
- **Store** : tout le code reçoit `RunStore` (interface), jamais `SQLiteRunStore` directement — bootstrap uniquement.

## Structure du package

```
api/
├── package.json          # @studio/api
├── tsconfig.json
└── src/
    ├── index.ts          # Entrypoint standalone (PM2/systemd)
    ├── server.ts         # buildServer(deps) → FastifyInstance
    ├── launcher.ts       # RunLauncher interface + InProcessLauncher
    ├── bootstrap.ts      # findStudioDir + loadConfig + createEngine
    ├── logger.ts         # JSONL logger adapté (même format que CLI)
    └── routes/
        ├── runs.ts       # POST /api/runs, GET /api/runs, GET /api/runs/:id, GET /api/runs/:id/logs
        └── projects.ts   # GET /api/projects, GET /api/projects/:id/pipelines
```

Dépendances de `@studio/api` :
- `@studio/engine`, `@studio/contracts`, `@studio/runner`
- `fastify`, `@fastify/cors`
- `js-yaml`

`pnpm-workspace.yaml` : ajouter `"api"`.

`@studio/cli` ajoute `@studio/api` comme dépendance pour `studio api start`.

## Extension RunStore

Deux nouvelles méthodes dans l'interface `RunStore` (engine) :

```typescript
saveLogPath(runId: string, logPath: string): void;
getLogPath(runId: string): string | null;
```

- `InMemoryRunStore` : `Map<string, string>` en mémoire
- `SQLiteRunStore` : colonne `log_path TEXT` ajoutée via `ALTER TABLE IF NOT EXISTS` dans `initSchema()`
- `PipelineRun` dans `@studio/contracts` ne change pas

## InProcessLauncher

```typescript
interface RunLauncher {
  launch(config: LaunchConfig): Promise<{ run_id: string }>;
  cancel(run_id: string): Promise<void>;
}

interface LaunchConfig {
  pipeline: string;
  input: Record<string, unknown>;
  configsDir: string;
  providerOverride?: string;
}
```

`InProcessLauncher` :
- Lance `engine.run(...)` en fire-and-forget (Promise non-awaited)
- `Map<run_id, AbortController>` pour le cancel
- Crée le logger JSONL, appelle `store.saveLogPath(runId, logPath)` immédiatement

## Bootstrap

`bootstrap.ts` (même pattern que CLI) :

1. `findStudioDir(cwd)` → localise `.studio/`
2. `loadConfig()` → lit `config.yaml`
3. `createDefaultRegistry()` + `loadProjectTools()` → tool registry
4. `new SQLiteRunStore(dbPath)` où `dbPath = .studio/runs/runs.db`
5. `new PipelineEngine({ configsDir, providerRegistry, toolRegistry, db: store })`

`index.ts` standalone : lit `process.env.STUDIO_CWD || process.cwd()`, bootstrap, démarre serveur.

## Extension StudioConfig

Dans `cli/src/config.ts`, ajout du champ `api?` :

```typescript
api?: {
  key?: string;   // Bearer token — absent = no auth (local dev)
  port?: number;  // Default 3700
}
```

## Endpoints

### POST /api/runs
```
Body: { pipeline: string, input: object, provider?: string }
→ 201 { run_id, status: "running", stream_url: "/api/runs/:id/stream" }
```
Fire-and-forget. Validation Fastify schema. `stream_url` présent pour préparer Phase 2.

### GET /api/runs
```
Query: status?, limit?
→ 200 { runs: PipelineRun[] }
```
Délégué à `store.listPipelineRuns({ status, limit })`.

### GET /api/runs/:id
```
→ 200 PipelineRun | 404
```

### GET /api/runs/:id/logs
```
→ 200 text/plain (JSONL) | 404 si run inconnu | 404 si log pas encore créé
```
`store.getLogPath(id)` puis lecture directe du fichier.

### GET /api/projects
```
→ 200 { projects: [{ id, name, pipelines_dir }] }
```
Retourne le projet unique servi par l'API.

### GET /api/projects/:id/pipelines
```
→ 200 { pipelines: string[] } | 404 si projet inconnu
```
Scan de `pipelines/` — noms sans extension `.pipeline.yaml`.

## Auth

Fastify hook `onRequest` global :

- `config.api?.key` absent → pas d'auth (local dev)
- `config.api?.key` présent → vérifie `Authorization: Bearer <key>`
  - Mismatch ou absent → `401 { error: "Unauthorized" }`

Aucune route exemptée en Phase 1.

## Tech

- Fastify (pas Express)
- Port par défaut : 3700
- `@fastify/cors` activé
- JSON schema validation Fastify natif sur les bodies/query params
- `server.ts` exporte `buildServer(deps)` — testable en isolation sans bootstrap

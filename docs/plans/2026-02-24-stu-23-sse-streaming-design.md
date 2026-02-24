# Design — STU-23 : SSE Streaming temps réel (GET /runs/:id/stream)

## Contexte

Phase 2 de `@studio/api`. Permet aux clients de suivre un run en temps réel via Server-Sent Events. Prérequis : STU-22 (scaffolding API) est terminé sur la branche `feat/stu-22-api`.

## Décisions clés

- **Approche A : per-run engine instances + RunEventBus.** Le `InProcessLauncher` crée une nouvelle instance `PipelineEngine` par `launch()` (pas par serveur). Zéro changement dans `@studio/engine`.
- **Replay + live.** Le SSE endpoint rejoue d'abord le JSONL historique, puis stream les events live. Un client qui se connecte en cours de run reçoit le tableau complet.
- **JSONL étendu.** Le logger écrit tous les events structurels (`stage_complete`, `stage_retry`, `group_feedback`, `pipeline_complete`, `pipeline_cancelled`). Les events verbeux (`onAgentToken`, `onAgentThinking`) sont exclus.
- **Filtrage côté route.** Le query param `?events=` est filtré dans la route SSE, pas dans le bus. Le bus émet tout.
- **Fix concurrence latent.** `this.pipelineTotals` était instance state partagé entre runs concurrents dans l'engine. Per-run engine instances corrige ce bug en même temps.

## Architecture

```
api/src/
├── event-bus.ts          # RunEventBus — pub/sub in-memory par run_id  [nouveau]
├── launcher.ts           # InProcessLauncher refactoré                  [modifié]
├── bootstrap.ts          # Passe EngineConfig + bus au launcher          [modifié]
├── logger.ts             # Étendu : tous les events structurels          [modifié]
└── routes/
    └── runs.ts           # + GET /api/runs/:id/stream                    [modifié]
```

## RunEventBus

`api/src/event-bus.ts` — pub/sub in-memory simple.

```typescript
type SseEventType =
  | 'stage_start' | 'stage_complete' | 'stage_retry'
  | 'group_start' | 'group_iteration' | 'group_feedback' | 'group_complete'
  | 'pipeline_complete' | 'pipeline_cancelled'
  | 'done';

interface BusEvent { type: SseEventType; data: unknown }
type Listener = (event: BusEvent) => void;

class RunEventBus {
  subscribe(runId: string, listener: Listener): () => void  // retourne unsubscribe
  emit(runId: string, type: SseEventType, data: unknown): void
  close(runId: string): void  // émet 'done' + delete Map entry
}
```

Complexité : O(1) lookup par run_id, O(n) emit (n = clients SSE sur ce run, typiquement 1).

## InProcessLauncher refactoré

```typescript
// Avant
constructor(private engine: PipelineEngine, private store: RunStore, private runsDir: string)

// Après
constructor(
  private engineConfig: EngineConfig,   // config partagée, engine créé par run
  private store: RunStore,
  private runsDir: string,
  private bus: RunEventBus,             // injecté depuis bootstrap
)
```

Dans `launch()`, création d'un engine par run avec callbacks capturant le `runId` :

```typescript
const perRunEvents: EngineEvents = {
  onStageStart:        (e) => { bus.emit(runId, 'stage_start', e);        logger.log({ event: 'stage_start', ...e }); },
  onStageComplete:     (e) => { bus.emit(runId, 'stage_complete', e);     logger.log({ event: 'stage_complete', ...e }); },
  onTaskRetry:         (e) => { bus.emit(runId, 'stage_retry', e);        logger.log({ event: 'stage_retry', ...e }); },
  onGroupStart:        (e) => { bus.emit(runId, 'group_start', e);        logger.log({ event: 'group_start', ...e }); },
  onGroupIteration:    (e) => { bus.emit(runId, 'group_iteration', e);    logger.log({ event: 'group_iteration', ...e }); },
  onGroupFeedback:     (e) => { bus.emit(runId, 'group_feedback', e);     logger.log({ event: 'group_feedback', ...e }); },
  onGroupComplete:     (e) => { bus.emit(runId, 'group_complete', e);     logger.log({ event: 'group_complete', ...e }); },
  onPipelineComplete:  (e) => { bus.emit(runId, 'pipeline_complete', e);  logger.log({ event: 'pipeline_complete', ...e }); bus.close(runId); },
  onPipelineCancelled: (e) => { bus.emit(runId, 'pipeline_cancelled', e); logger.log({ event: 'pipeline_cancelled', ...e }); bus.close(runId); },
  // onAgentToken, onAgentThinking : exclus du SSE et du JSONL (trop verbeux)
};
const engine = new PipelineEngine(this.engineConfig, perRunEvents);
```

`RunLauncher` interface : ajouter `subscribe(runId: string, listener: Listener): () => void`.

`bootstrap.ts` : ne crée plus d'engine — passe `engineConfig` et `bus` au launcher.

## Route SSE

`GET /api/runs/:id/stream?events=stage_complete,pipeline_complete`

```typescript
fastify.get('/runs/:id/stream', async (request, reply) => {
  const { id } = request.params;
  const filterParam = request.query.events;  // string | undefined
  const filter = filterParam ? filterParam.split(',') : null;

  // 1. Run inexistant → 404
  const run = store.getPipelineRun(id);
  if (!run) return reply.status(404).send({ error: 'Run not found' });

  // 2. Headers SSE
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const send = (type: string, data: unknown) => {
    if (filter && !filter.includes(type)) return;
    reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 3. Replay JSONL historique
  const logPath = store.getLogPath(id);
  if (logPath) await replayJsonl(logPath, send);

  // 4. Run déjà terminé → fermer
  const TERMINAL = ['success', 'failed', 'rejected', 'cancelled'];
  if (TERMINAL.includes(run.status)) {
    reply.raw.end();
    return;
  }

  // 5. Subscribe aux events live
  const unsub = launcher.subscribe(id, ({ type, data }) => send(type, data));

  // 6. Cleanup à la déconnexion
  reply.raw.on('close', unsub);
});
```

`replayJsonl(logPath, send)` : lit le fichier ligne par ligne, parse chaque JSON, appelle `send(line.event, line)`.

## Format SSE

```
event: stage_complete
data: {"stage":"brief-analysis","status":"success","attempts":1,"duration_ms":1200,"token_usage":{...}}

event: group_feedback
data: {"group_name":"creation-review","iteration":1,"rejection_reason":"issues non-empty"}

event: pipeline_complete
data: {"status":"success","duration_ms":60000,"total_tokens":12009}

event: done
data: {}
```

L'event `done` est émis par `bus.close()` — signal au client que le stream est terminé.

## Tests

| Fichier | Scope | Cas couverts |
|---------|-------|-------------|
| `event-bus.test.ts` | Unitaire | subscribe/emit/unsubscribe, close émet `done`, isolation par run_id |
| `launcher.test.ts` | Unitaire (étendu) | subscribe reçoit events, bus closé après pipeline_complete, deux runs concurrents isolés |
| `sse.test.ts` | Intégration Fastify | 404 run inconnu, terminé → replay + close, filtrage `?events=` |

Le flow live (POST /runs → GET /stream → events en temps réel) est validé manuellement via `--provider mock`.

## Performance

- **Instanciation engine par run** : quasi-free — le constructeur assigne des références, pas de copies. `providerRegistry` et `toolRegistry` sont partagés.
- **RunEventBus** : O(1) lookup, O(n) emit (n typiquement = 1 client SSE).
- **Replay JSONL** : lecture séquentielle < 10KB pour un run typique (events structurels seulement).
- **SSE write** : `reply.raw.write()` non-bloquant.
- **Edge case** : si un run exceptionnel produit des milliers de stages, le JSONL replay pourrait backpressurer. Un drain check sur `reply.raw.write()` est possible mais YAGNI pour l'instant.

## Fichiers touchés

| Fichier | Change |
|---------|--------|
| `api/src/event-bus.ts` | Nouveau |
| `api/src/launcher.ts` | Refactoring + subscribe() |
| `api/src/bootstrap.ts` | Passe engineConfig + bus |
| `api/src/logger.ts` | Écriture de tous les events structurels |
| `api/src/routes/runs.ts` | + GET /api/runs/:id/stream |
| `api/tests/event-bus.test.ts` | Nouveau |
| `api/tests/sse.test.ts` | Nouveau |
| `api/tests/launcher.test.ts` | Étendu |

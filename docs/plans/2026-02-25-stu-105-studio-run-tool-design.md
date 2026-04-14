# STU-105 — Tool plugin `studio-run` : spawner un run Studio depuis un pipeline

## Contexte

Certains pipelines doivent orchestrer d'autres runs Studio. Exemple : `meal-planner-weekly` qui génère 5 recettes en lançant 5 runs `recipe-developer` séquentiellement. Sans ce tool, il faudrait hardcoder le nombre de stages ou créer des méga-pipelines.

## Décisions d'architecture

| Question | Décision |
|---|---|
| Implémentation | TypeScript builtin (pas de YAML shell) |
| Child run fail | Throw error — l'agent parent voit un tool error, RALPH gère |
| Depth limit | Header HTTP `X-Studio-Depth` + check dans le tool avant appel |
| Parent run_id | Factory context — l'engine injecte le `currentRunId` |
| Wait (API mode) | `HttpApiSpawner` — POST /api/runs + SSE jusqu'à `pipeline_complete` |
| Wait (CLI mode) | `DirectEngineSpawner` — `await childEngine.run()` in-process |
| Token tracking | Chaque run compte ses propres tokens, pas d'agrégation |

## Architecture

### Interface `RunSpawner` (contracts)

```typescript
interface RunSpawner {
  spawnAndWait(config: {
    pipeline: string;
    input: object;
    parentRunId: string;
    depth: number;
  }): Promise<{ run_id: string; status: string; output: unknown }>;
}
```

Vit dans `@studio-foundation/contracts`. Les deux implémentations en dépendent.

### Builtin tool (runner)

```
runner/src/tools/builtin/studio-run.ts
```

Factory :

```typescript
export function createStudioRunTool(ctx: {
  spawner: RunSpawner;
  currentRunId: string;
  currentDepth: number;
  maxDepth: number;   // défaut: 3
}): Tool[]
```

Commande `run-pipeline` :

```typescript
// Paramètres (ce que l'agent LLM voit)
{
  pipeline: string;   // required
  input: object;      // required
  wait?: boolean;     // default: true
}

// Depth check (avant tout appel)
if (currentDepth + 1 > maxDepth) {
  throw new Error(
    `studio-run depth limit reached (max: ${maxDepth}). Current depth: ${currentDepth}.`
  );
}

// wait: true
const result = await spawner.spawnAndWait({
  pipeline, input,
  parentRunId: currentRunId,
  depth: currentDepth + 1,
});
return result; // { run_id, status, output }

// wait: false (fire and forget — pas encore implémenté v1, throw)
throw new Error('wait: false not supported in v1');
```

### `HttpApiSpawner` (api)

```
api/src/spawners/http-api-spawner.ts
```

```typescript
export class HttpApiSpawner implements RunSpawner {
  constructor(private apiUrl: string) {}

  async spawnAndWait({ pipeline, input, parentRunId, depth }) {
    const res = await fetch(`${this.apiUrl}/api/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Studio-Depth': String(depth),
        'X-Studio-Parent-Run-Id': parentRunId,
      },
      body: JSON.stringify({ pipeline, input }),
    });
    const { run_id } = await res.json();

    return new Promise((resolve, reject) => {
      const es = new EventSource(`${this.apiUrl}/api/runs/${run_id}/stream`);
      es.addEventListener('pipeline_complete', (e) => {
        es.close();
        const data = JSON.parse(e.data);
        if (data.status === 'failed' || data.status === 'rejected') {
          reject(new Error(`Child run ${run_id} ${data.status}: ${data.error ?? data.rejection_reason}`));
        } else {
          resolve({ run_id, status: data.status, output: data.output });
        }
      });
      es.onerror = () => {
        es.close();
        reject(new Error(`SSE connection lost for run ${run_id}`));
      };
    });
  }
}
```

### `DirectEngineSpawner` (engine)

```
engine/src/spawners/direct-engine-spawner.ts
```

```typescript
export class DirectEngineSpawner implements RunSpawner {
  constructor(private engineConfig: PipelineEngineConfig) {}

  async spawnAndWait({ pipeline, input, parentRunId, depth }) {
    const child = new PipelineEngine(this.engineConfig);
    const result = await child.run({
      pipeline,
      input,
      parentRunId,
      depth,
    });
    if (result.status === 'failed' || result.status === 'rejected') {
      throw new Error(`Child run ${result.id} ${result.status}`);
    }
    return { run_id: result.id, status: result.status, output: result.output };
  }
}
```

L'engine passe sa propre config (db, toolRegistry, providerRegistry) au child engine — les child runs partagent le même store SQLite et sont donc visibles dans `studio status`.

### Injection dans l'engine

Dans `engine.ts`, au moment de construire le ToolRegistry pour un run :

```typescript
if (this.config.spawner) {
  const studioRunTools = createStudioRunTool({
    spawner: this.config.spawner,
    currentRunId: pipelineRun.id,
    currentDepth: input.depth ?? 0,
    maxDepth: this.config.maxDepth ?? 3,
  });
  registry.registerPlugin('studio_run', studioRunTools, STUDIO_RUN_PROMPT_SNIPPET);
}
```

**CLI** injecte `new DirectEngineSpawner(engineConfig)` dans la config engine.
**API** injecte `new HttpApiSpawner(apiUrl)` dans la config engine (via le launcher).

## Modifications DB (engine)

Nouvelle colonne dans `pipeline_runs` :

```sql
ALTER TABLE pipeline_runs ADD COLUMN parent_run_id TEXT;
CREATE INDEX idx_pipeline_runs_parent ON pipeline_runs(parent_run_id);
```

Ajoutée au démarrage via `ALTER TABLE IF NOT EXISTS` (pattern déjà utilisé pour `log_path`).

## Modifications `PipelineRun` (contracts)

```typescript
interface PipelineRun {
  // ... champs existants ...
  parent_run_id?: string;  // ← nouveau
}
```

## Modifications `POST /api/runs` (api)

```typescript
// Lire les headers
const depth = parseInt(request.headers['x-studio-depth'] as string ?? '0', 10);
const parentRunId = request.headers['x-studio-parent-run-id'] as string | undefined;

// Passer au launcher
launcher.launch({ pipeline, input, provider, depth, parentRunId });
```

Le launcher les transmet au `RunInput` de l'engine.

## Modifications `RunInput` (engine)

```typescript
interface RunInput {
  // ... champs existants ...
  depth?: number;
  parentRunId?: string;
}
```

## Usage dans un pipeline YAML

L'agent doit déclarer `studio_run-run_pipeline` dans sa liste de tools :

```yaml
# .studio/agents/meal-planner.agent.yaml
name: meal-planner
provider: anthropic
model: claude-sonnet-4-20250514
tools:
  - studio_run-run_pipeline
system_prompt: |
  You are a meal planning assistant. Use studio_run-run_pipeline to launch
  recipe-developer pipelines for each recipe you need to generate.
```

Appel type que l'agent fait :

```json
{
  "tool": "studio_run-run_pipeline",
  "arguments": {
    "pipeline": "recipe-developer",
    "input": { "dish": "Pasta Carbonara", "servings": 4 },
    "wait": true
  }
}
```

## Critères d'acceptation

- [ ] `contracts` : `RunSpawner` interface + `parent_run_id` dans `PipelineRun`
- [ ] `engine` : `DirectEngineSpawner`, `RunInput` étendu, injection dans le ToolRegistry, migration DB
- [ ] `runner` : builtin `createStudioRunTool` avec depth check + throw on failure
- [ ] `api` : `HttpApiSpawner`, headers `X-Studio-Depth` + `X-Studio-Parent-Run-Id` sur `POST /api/runs`
- [ ] Child run visible dans `studio status` (via `parent_run_id` en DB)
- [ ] Depth limit enforced (défaut 3), erreur claire si dépassé
- [ ] Tests unitaires : depth limit, throw on child failure, spawner (mock)

## Hors scope v1

- `wait: false` (fire-and-forget depuis un tool)
- `GET /api/runs?parent_run_id=xxx` (liste des enfants)
- Agrégation de tokens parent ← enfants
- Annulation en cascade (parent annulé → enfants annulés)

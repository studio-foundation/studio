# PgRunStore Implementation Plan (STU-205)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `PgRunStore` to `@studio-foundation/engine` — une implémentation PostgreSQL d'`AsyncRunStore` qui utilise raw SQL (`pg`), crée sa propre table `studio_pipeline_runs`, et s'active via `db.type: postgres` dans `.studio/config.yaml`.

**Architecture:** `PgRunStore` vit dans `engine/src/state/run-store.ts` aux côtés de `SQLiteRunStore` et `InMemoryRunStore`. Elle utilise `pg` (Pool) directement, sans Prisma, et auto-migre son schéma au démarrage. `createRunStore` dans le CLI devient async et retourne `AnyRunStore` selon `config.db.type`.

**Tech Stack:** `pg` (node-postgres), TypeScript, vitest (tests intégration avec `TEST_DATABASE_URL`)

---

### Task 1: Créer le worktree

**Files:**
- Worktree: `.worktrees/stu-205-pg-run-store`

**Step 1: Vérifier .worktrees est ignoré**

```bash
git check-ignore -q .worktrees && echo "ignored" || echo "NOT ignored"
```
Expected: `ignored`

**Step 2: Créer le worktree**

```bash
git worktree add .worktrees/stu-205-pg-run-store -b feat/stu-205-pg-run-store
cd .worktrees/stu-205-pg-run-store
```

**Step 3: Installer les dépendances**

```bash
pnpm install
```

**Step 4: Vérifier que les tests passent (baseline)**

```bash
pnpm test
```
Expected: tous les tests passent, zéro failure.

---

### Task 2: Ajouter `pg` comme dépendance de `@studio-foundation/engine`

**Files:**
- Modify: `engine/package.json`

**Step 1: Ajouter pg**

```bash
cd engine && pnpm add pg && pnpm add -D @types/pg
```

**Step 2: Vérifier le package.json**

```bash
grep '"pg"' engine/package.json
```
Expected: `"pg": "^8.x.x"` dans dependencies, `"@types/pg": "^8.x.x"` dans devDependencies.

**Step 3: Commit**

```bash
git add engine/package.json pnpm-lock.yaml
git commit -m "feat(engine): add pg dependency for PgRunStore"
```

---

### Task 3: Écrire les tests pour `PgRunStore`

**Files:**
- Modify: `engine/src/state/run-store.test.ts`

Les tests PgRunStore sont des **tests d'intégration** qui nécessitent une vraie connexion Postgres. Ils sont skippés si `TEST_DATABASE_URL` n'est pas défini.

**Step 1: Ajouter les tests à la fin de `engine/src/state/run-store.test.ts`**

```typescript
import { PgRunStore } from './run-store.js';

const TEST_PG_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_PG_URL)('PgRunStore', () => {
  let store: PgRunStore;

  beforeEach(async () => {
    store = new PgRunStore(TEST_PG_URL!);
    // Clean table before each test
    await store.dangerouslyTruncateForTests();
  });

  afterEach(async () => {
    await store.close();
  });

  it('saves and retrieves a pipeline run', async () => {
    const run = makeSampleRun('pg-run-1');
    await store.savePipelineRun(run);
    const found = await store.getPipelineRun('pg-run-1');
    expect(found).toMatchObject({ id: 'pg-run-1', status: 'success' });
  });

  it('returns null for unknown id', async () => {
    const found = await store.getPipelineRun('doesnt-exist');
    expect(found).toBeNull();
  });

  it('updates an existing run (upsert)', async () => {
    const run = makeSampleRun('pg-run-2');
    await store.savePipelineRun(run);
    await store.savePipelineRun({ ...run, status: 'failed' });
    const found = await store.getPipelineRun('pg-run-2');
    expect(found?.status).toBe('failed');
  });

  it('lists runs with status filter', async () => {
    await store.savePipelineRun(makeSampleRun('pg-1', 'success'));
    await store.savePipelineRun(makeSampleRun('pg-2', 'failed'));
    const successes = await store.listPipelineRuns({ status: 'success' });
    expect(successes).toHaveLength(1);
    expect(successes[0].id).toBe('pg-1');
  });

  it('lists runs with limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.savePipelineRun(makeSampleRun(`pg-limit-${i}`));
    }
    const runs = await store.listPipelineRuns({ limit: 3 });
    expect(runs).toHaveLength(3);
  });

  it('getLatestRun returns most recent', async () => {
    await store.savePipelineRun(makeSampleRun('pg-old', 'success', '2024-01-01T00:00:00Z'));
    await store.savePipelineRun(makeSampleRun('pg-new', 'success', '2024-06-01T00:00:00Z'));
    const latest = await store.getLatestRun();
    expect(latest?.id).toBe('pg-new');
  });

  it('getLatestRun filters by pipeline name', async () => {
    await store.savePipelineRun(makeSampleRun('pg-a', 'success', undefined, 'pipeline-a'));
    await store.savePipelineRun(makeSampleRun('pg-b', 'success', undefined, 'pipeline-b'));
    const latest = await store.getLatestRun('pipeline-a');
    expect(latest?.id).toBe('pg-a');
  });

  it('saves and retrieves log path', async () => {
    await store.savePipelineRun(makeSampleRun('pg-log-1'));
    await store.saveLogPath('pg-log-1', '/tmp/test.jsonl');
    const path = await store.getLogPath('pg-log-1');
    expect(path).toBe('/tmp/test.jsonl');
  });

  it('returns null log path for unknown run', async () => {
    const path = await store.getLogPath('no-such-run');
    expect(path).toBeNull();
  });
});

// Helper (à ajouter dans les helpers existants du fichier)
function makeSampleRun(
  id: string,
  status: string = 'success',
  startedAt: string = new Date().toISOString(),
  pipelineName: string = 'test-pipeline'
) {
  return {
    id,
    pipeline_name: pipelineName,
    status,
    started_at: startedAt,
    stages: [],
  } as import('@studio-foundation/contracts').PipelineRun;
}
```

**Step 2: Vérifier que les tests sont skippés sans DB**

```bash
cd engine && pnpm test
```
Expected: tests PgRunStore marqués `skipped`, aucun failure.

---

### Task 4: Implémenter `PgRunStore`

**Files:**
- Modify: `engine/src/state/run-store.ts`

**Step 1: Ajouter PgRunStore à la fin du fichier**

```typescript
// PostgreSQL store — async implementation using raw pg (no Prisma)
// Creates its own `studio_pipeline_runs` table on first use.
// Uses the same serialization pattern as SQLiteRunStore: full PipelineRun as JSON in `result`.
export class PgRunStore implements AsyncRunStore {
  private pool: import('pg').Pool;
  private initialized = false;

  constructor(connectionString: string) {
    // Dynamic import to avoid loading pg when not needed
    const { Pool } = require('pg') as typeof import('pg');
    this.pool = new Pool({ connectionString });
  }

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS studio_pipeline_runs (
        id            TEXT PRIMARY KEY,
        pipeline_name TEXT NOT NULL,
        status        TEXT NOT NULL,
        result        TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        completed_at  TEXT,
        log_path      TEXT,
        parent_run_id TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_studio_pipeline_runs_status
        ON studio_pipeline_runs(status);
      CREATE INDEX IF NOT EXISTS idx_studio_pipeline_runs_created
        ON studio_pipeline_runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_studio_pipeline_runs_parent
        ON studio_pipeline_runs(parent_run_id);
    `);
    this.initialized = true;
  }

  async savePipelineRun(run: PipelineRun): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO studio_pipeline_runs
         (id, pipeline_name, status, result, started_at, completed_at, parent_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         pipeline_name = EXCLUDED.pipeline_name,
         status        = EXCLUDED.status,
         result        = EXCLUDED.result,
         started_at    = EXCLUDED.started_at,
         completed_at  = EXCLUDED.completed_at,
         parent_run_id = EXCLUDED.parent_run_id`,
      [
        run.id,
        run.pipeline_name,
        run.status,
        JSON.stringify(run),
        run.started_at,
        run.completed_at ?? null,
        run.parent_run_id ?? null,
      ]
    );
  }

  async getPipelineRun(id: string): Promise<PipelineRun | null> {
    await this.ensureSchema();
    const res = await this.pool.query<{ result: string }>(
      'SELECT result FROM studio_pipeline_runs WHERE id = $1',
      [id]
    );
    if (res.rows.length === 0) return null;
    return JSON.parse(res.rows[0].result) as PipelineRun;
  }

  async listPipelineRuns(options?: { limit?: number; status?: string }): Promise<PipelineRun[]> {
    await this.ensureSchema();
    const params: unknown[] = [];
    let sql = 'SELECT result FROM studio_pipeline_runs';

    if (options?.status) {
      params.push(options.status);
      sql += ` WHERE status = $${params.length}`;
    }

    sql += ' ORDER BY created_at DESC';

    if (options?.limit) {
      params.push(options.limit);
      sql += ` LIMIT $${params.length}`;
    }

    const res = await this.pool.query<{ result: string }>(sql, params);
    return res.rows.map((r) => JSON.parse(r.result) as PipelineRun);
  }

  async getLatestRun(pipelineName?: string): Promise<PipelineRun | null> {
    await this.ensureSchema();
    const params: unknown[] = [];
    let sql = 'SELECT result FROM studio_pipeline_runs';

    if (pipelineName) {
      params.push(pipelineName);
      sql += ` WHERE pipeline_name = $${params.length}`;
    }

    sql += ' ORDER BY created_at DESC LIMIT 1';

    const res = await this.pool.query<{ result: string }>(sql, params);
    if (res.rows.length === 0) return null;
    return JSON.parse(res.rows[0].result) as PipelineRun;
  }

  async saveLogPath(runId: string, logPath: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      'UPDATE studio_pipeline_runs SET log_path = $1 WHERE id = $2',
      [logPath, runId]
    );
  }

  async getLogPath(runId: string): Promise<string | null> {
    await this.ensureSchema();
    const res = await this.pool.query<{ log_path: string | null }>(
      'SELECT log_path FROM studio_pipeline_runs WHERE id = $1',
      [runId]
    );
    return res.rows[0]?.log_path ?? null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Test-only: wipe table contents. Never call in production. */
  async dangerouslyTruncateForTests(): Promise<void> {
    await this.ensureSchema();
    await this.pool.query('TRUNCATE TABLE studio_pipeline_runs');
  }
}
```

**Step 2: Vérifier les tests passent avec DB**

Si tu as un Postgres local :
```bash
TEST_DATABASE_URL=postgres://localhost/studio_test cd engine && pnpm test
```
Expected: tous les tests PgRunStore passent.

Sans Postgres :
```bash
cd engine && pnpm test
```
Expected: PgRunStore tests skipped, aucun failure.

**Step 3: Commit**

```bash
git add engine/src/state/run-store.ts engine/src/state/run-store.test.ts
git commit -m "feat(engine): implement PgRunStore with raw pg and auto-init schema"
```

---

### Task 5: Exporter `PgRunStore` depuis `@studio-foundation/engine`

**Files:**
- Modify: `engine/src/index.ts`
- Modify: `engine/src/db/client.ts`

**Step 1: Ajouter l'export dans `engine/src/index.ts`**

Trouver la ligne qui exporte `InMemoryRunStore, SQLiteRunStore` et ajouter `PgRunStore` :

```typescript
// Avant
export { InMemoryRunStore, SQLiteRunStore } from './state/run-store.js';
export type { RunStore, AsyncRunStore, AnyRunStore } from './state/run-store.js';

// Après
export { InMemoryRunStore, SQLiteRunStore, PgRunStore } from './state/run-store.js';
export type { RunStore, AsyncRunStore, AnyRunStore } from './state/run-store.js';
```

**Step 2: Ajouter l'export dans `engine/src/db/client.ts`**

```typescript
// Avant
export { SQLiteRunStore, InMemoryRunStore } from '../state/run-store.js';
export type { RunStore, AsyncRunStore, AnyRunStore } from '../state/run-store.js';

// Après
export { SQLiteRunStore, InMemoryRunStore, PgRunStore } from '../state/run-store.js';
export type { RunStore, AsyncRunStore, AnyRunStore } from '../state/run-store.js';
```

**Step 3: Build engine pour vérifier**

```bash
pnpm --filter @studio-foundation/engine build
```
Expected: build réussit, zéro erreur TypeScript.

**Step 4: Commit**

```bash
git add engine/src/index.ts engine/src/db/client.ts
git commit -m "feat(engine): export PgRunStore from public API"
```

---

### Task 6: Ajouter `db` à `StudioConfig`

**Files:**
- Modify: `cli/src/config.ts`

**Step 1: Ajouter le champ `db` à l'interface `StudioConfig`**

```typescript
export interface StudioConfig {
  // ... champs existants ...
  db?: {
    type?: 'sqlite' | 'postgres' | 'inmemory';
    url?: string;   // requis si type: 'postgres'
  };
  // ...
}
```

**Step 2: Vérifier que ça compile**

```bash
pnpm --filter @studio-foundation/cli build
```
Expected: zéro erreur.

**Step 3: Commit**

```bash
git add cli/src/config.ts
git commit -m "feat(cli): add db config to StudioConfig"
```

---

### Task 7: Mettre à jour `createRunStore` dans le CLI

**Files:**
- Modify: `cli/src/run-store-factory.ts`
- Modify: `cli/src/commands/run.ts`
- Modify: `cli/src/commands/status.ts`

`createRunStore` devient `async` et retourne `AnyRunStore`. Les appelants doivent `await`.

**Step 1: Réécrire `cli/src/run-store-factory.ts`**

```typescript
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { StudioConfig } from './config.js';
import { SQLiteRunStore, InMemoryRunStore, PgRunStore } from '@studio-foundation/engine';
import type { AnyRunStore } from '@studio-foundation/engine';

export async function createRunStore(config: StudioConfig): Promise<AnyRunStore> {
  const dbType = config.db?.type ?? 'sqlite';

  if (dbType === 'inmemory') {
    return new InMemoryRunStore();
  }

  if (dbType === 'postgres') {
    const url = config.db?.url;
    if (!url) throw new Error('db.url is required when db.type is postgres');
    return new PgRunStore(url);
  }

  // Default: sqlite
  const studioDir = config.resolvedStudioDir ?? join(process.cwd(), '.studio');
  mkdirSync(join(studioDir, 'runs'), { recursive: true });
  const dbPath = join(studioDir, 'runs', 'runs.db');
  return new SQLiteRunStore(dbPath);
}
```

Note: le path SQLite a changé de `studioDir/runs.db` → `studioDir/runs/runs.db` pour s'aligner avec l'API (qui utilise déjà `runs/runs.db`). Vérifier si l'ancien path était `studioDir/runs.db` ou `studioDir/runs/runs.db` avant de changer.

**Step 2: Mettre à jour `cli/src/commands/run.ts`**

Les changements à faire dans `run.ts` :
- `runStore: RunStore | null` → `runStore: AnyRunStore | null`
- `runStore = createRunStore(config)` → `runStore = await createRunStore(config)`
- `runStore.saveLogPath(...)` → `await runStore.saveLogPath(...)`
- Import: ajouter `AnyRunStore`, retirer `RunStore`

Localiser les lignes concernées (environ 188, 190, 415) et appliquer les changements.

**Step 3: Mettre à jour `cli/src/commands/status.ts`**

```typescript
// Avant (environ ligne 136-138)
const store = createRunStore(config);
run = runId ? store.getPipelineRun(runId) : store.getLatestRun();
store.close?.();

// Après
const store = await createRunStore(config);
run = runId ? await store.getPipelineRun(runId) : await store.getLatestRun();
await store.close?.();
```

**Step 4: Build CLI**

```bash
pnpm --filter @studio-foundation/cli build
```
Expected: zéro erreur TypeScript.

**Step 5: Commit**

```bash
git add cli/src/run-store-factory.ts cli/src/commands/run.ts cli/src/commands/status.ts
git commit -m "feat(cli): createRunStore async, support postgres and inmemory via config"
```

---

### Task 8: Mettre à jour `@studio-foundation/api` bootstrap

**Files:**
- Modify: `api/src/bootstrap.ts`

**Step 1: Remplacer l'instanciation SQLiteRunStore dans bootstrap.ts**

Localiser (environ ligne 102-104) :
```typescript
const dbPath = join(studioDir, 'runs', 'runs.db');
// ...
const store = new SQLiteRunStore(dbPath);
```

Remplacer par un appel à une factory identique à celle du CLI :

```typescript
import { SQLiteRunStore, InMemoryRunStore, PgRunStore, type AnyRunStore } from '@studio-foundation/engine';

// Dans la fonction bootstrap, remplacer la création du store :
const apiConfig = config as StudioApiConfig & { db?: { type?: string; url?: string } };
let store: AnyRunStore;

const dbType = apiConfig.db?.type ?? 'sqlite';
if (dbType === 'postgres') {
  const url = apiConfig.db?.url;
  if (!url) throw new Error('db.url is required when db.type is postgres');
  store = new PgRunStore(url);
} else if (dbType === 'inmemory') {
  store = new InMemoryRunStore();
} else {
  const dbPath = join(studioDir, 'runs', 'runs.db');
  store = new SQLiteRunStore(dbPath);
}
```

Mettre aussi à jour le type de `BootstrapResult.store` de `RunStore` → `AnyRunStore`.

**Step 2: Vérifier les usages de `store` dans l'API**

L'API accède à `store.listPipelineRuns()`, `store.getPipelineRun()`, `store.getLatestRun()` dans les routes. Ces appels utilisent déjà `await` ? Vérifier avec :

```bash
grep -n "store\." api/src/routes/*.ts 2>/dev/null | head -30
```

Si ces appels ne sont pas awaités mais que `store` peut être async, les wrapper avec `await`.

**Step 3: Build API**

```bash
pnpm --filter @studio-foundation/api build
```
Expected: zéro erreur TypeScript.

**Step 4: Commit**

```bash
git add api/src/bootstrap.ts api/src/server.ts
git commit -m "feat(api): support postgres and inmemory RunStore via config"
```

---

### Task 9: Build complet + tests

**Step 1: Build tout**

```bash
pnpm build
```
Expected: tous les packages buildent sans erreur.

**Step 2: Tests complets**

```bash
pnpm test
```
Expected: tous les tests passent. PgRunStore tests `skipped` si pas de `TEST_DATABASE_URL`.

**Step 3: Vérifier le smoke test SQLite (comportement existant inchangé)**

```bash
cd /tmp && mkdir smoke-pg-test && cd smoke-pg-test
studio init --template software --name smoke-test
# Pas de db config → SQLite par défaut
studio run feature-builder --provider mock --input "test"
```
Expected: run crée un fichier `.studio/runs/runs.db`, status fonctionne.

**Step 4: Commit final si nécessaire**

```bash
git add -A
git commit -m "chore: final build verification"
```

---

### Task 10: Push + PR

**Step 1: Push la branche**

```bash
git push -u origin feat/stu-205-pg-run-store
```

**Step 2: Créer la PR**

```bash
gh pr create \
  --title "[STU-205] feat(engine): PgRunStore — PostgreSQL persistence via raw pg" \
  --body "$(cat <<'EOF'
## Quoi

Ajoute `PgRunStore` à `@studio-foundation/engine` — une implémentation `AsyncRunStore` qui utilise PostgreSQL via raw SQL (pas Prisma).

## Pourquoi

Les apps déployées avec une base PostgreSQL (ex: Little Chef) peuvent maintenant pointer Studio sur leur base existante. Studio crée sa propre table `studio_pipeline_runs` au démarrage, sans toucher au schéma de l'app.

## Packages touchés

- `@studio-foundation/engine` — `PgRunStore` + dep `pg`
- `@studio-foundation/cli` — `createRunStore` async, lit `config.db.type`
- `@studio-foundation/api` — bootstrap supporte `db.type: postgres`

## Config utilisateur

\`\`\`yaml
# .studio/config.yaml
db:
  type: postgres
  url: ${DATABASE_URL}
\`\`\`

Sans `db` → SQLite (comportement existant inchangé).

## Comment tester

```bash
# Comportement SQLite inchangé
studio run <pipeline> --provider mock --input "test"
studio status

# Avec Postgres
export DATABASE_URL=postgres://localhost/myapp
# Ajouter db: type: postgres dans .studio/config.yaml
studio run <pipeline> --provider mock --input "test"
# → crée studio_pipeline_runs dans la DB existante
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```


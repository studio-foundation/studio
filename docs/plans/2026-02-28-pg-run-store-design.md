# Design — PgRunStore (STU-205)

**Date :** 2026-02-28
**Ticket :** STU-205
**Statut :** Approuvé

---

## Contexte

Le kernel Studio utilise `RunStore` comme interface d'abstraction pour la persistance des runs. L'implémentation de production actuelle est `SQLiteRunStore` (fichier local `.studio/runs/runs.db`). Pour les apps déployées avec une base PostgreSQL (ex: Little Chef), il faut une implémentation `PgRunStore` qui s'insère dans la base existante de l'app sans friction.

---

## Décisions de design

### 1. PgRunStore vit dans `@studio-foundation/engine`

Côte à côte avec `SQLiteRunStore` et `InMemoryRunStore` dans `engine/src/state/run-store.ts`. Pas de nouveau package. `pg` s'ajoute comme dépendance directe de `@studio-foundation/engine`, comme `better-sqlite3`.

**Pourquoi pas un package séparé ?** Over-engineering pour une seule classe. `better-sqlite3` est déjà une dep directe — `pg` suit le même pattern.

### 2. Raw SQL, pas Prisma

`PgRunStore` utilise `pg` (Pool) directement et appelle `initSchema()` au premier usage — exactement le même pattern que `SQLiteRunStore`. Aucune dépendance sur le `schema.prisma` de l'app utilisateur. Studio gère son propre schéma SQL indépendamment.

**Analogie git :** Git ne stocke pas ses données dans la base de l'app. Il gère son propre stockage (`.git/`). Studio fait pareil.

### 3. Une seule base de données pour l'utilisateur

`PgRunStore` s'insère dans la base PostgreSQL **existante** de l'app utilisateur. L'utilisateur pointe Studio sur la même `DATABASE_URL` que son app. Studio crée simplement sa table au démarrage.

La table s'appelle **`studio_pipeline_runs`** (préfixe `studio_`) pour éviter tout conflit avec les tables de l'app.

```
PostgreSQL database (Little Chef)
├── users
├── accounts
├── sessions
├── weekly_plans
└── studio_pipeline_runs   ← Studio gère ça lui-même
```

### 4. Configuration via `.studio/config.yaml`

Nouvelle clé `db` optionnelle. Sans elle, comportement actuel inchangé (SQLite).

```yaml
db:
  type: postgres          # sqlite (défaut) | postgres | inmemory
  url: ${DATABASE_URL}    # requis si type: postgres
```

### 5. Instanciation dans CLI et API

Le CLI (et l'API) lit `db.type` au démarrage et instancie le bon store :

| `db.type` | Store instancié |
|-----------|----------------|
| `sqlite` (défaut) | `SQLiteRunStore(dbPath)` |
| `postgres` | `PgRunStore(config.db.url)` |
| `inmemory` | `InMemoryRunStore()` |

Le engine reçoit le store via injection de dépendance (`db?: AnyRunStore`) — rien à changer dans `engine.ts`.

---

## Schema SQL

```sql
CREATE TABLE IF NOT EXISTS studio_pipeline_runs (
  id           TEXT PRIMARY KEY,
  pipeline_name TEXT NOT NULL,
  status       TEXT NOT NULL,
  result       TEXT NOT NULL,       -- PipelineRun complet sérialisé en JSON
  started_at   TEXT NOT NULL,
  completed_at TEXT,
  log_path     TEXT,
  parent_run_id TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_pipeline_runs_status
  ON studio_pipeline_runs(status);
CREATE INDEX IF NOT EXISTS idx_studio_pipeline_runs_created
  ON studio_pipeline_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_pipeline_runs_parent
  ON studio_pipeline_runs(parent_run_id);
```

Pattern de sérialisation identique à SQLite : le champ `result` stocke le `PipelineRun` complet en JSON. Les colonnes `status`, `pipeline_name` etc. sont dupliquées pour permettre les requêtes sans désérialiser.

---

## Packages touchés

| Package | Changement |
|---------|-----------|
| `@studio-foundation/engine` | + `PgRunStore`, + dep `pg` + `@types/pg` |
| `@studio-foundation/cli` | Lit `db.type` depuis config, instancie le bon store |
| `@studio-foundation/api` | Idem CLI |

---

## Ce qui NE change pas

- Interface `RunStore` (synchrone) — inchangée
- Interface `AsyncRunStore` — inchangée (déjà dans `engine/src/state/run-store.ts`)
- `AnyRunStore` — inchangé
- `engine.ts` — inchangé (DI déjà en place)
- `SQLiteRunStore` — inchangé
- `InMemoryRunStore` — inchangé

# STU-26 — Auth multi-user : per-user API keys, quotas, rate limiting

**Date:** 2026-03-02
**Status:** Validated
**Linear:** [STU-26](https://linear.app/studioag/issue/STU-26)

## Objectif

Remplacer le système d'API key globale unique par un système multi-user avec :
- Une API key statique par user (pas de JWT dans ce sprint)
- Des quotas par plan (runs_per_day, max_concurrent, max_tokens_per_run)
- Du rate limiting par user (requêtes par minute)
- Backward compat avec la clé globale existante (`api.key` en config)

## Architecture

### Approche choisie : `UserStore` dans `@studio/api`

Pattern identique à `WebhookStore` et `IntegrationStore`. L'engine reste domain-agnostic. Deux classes : `UserStore` (SQLite) et `PgUserStore` (PostgreSQL), même DB que le run store.

### Fichiers touchés

```
api/src/
  user-store.ts           ← nouveau (SQLite, WAL mode)
  user-store-pg.ts        ← nouveau (PostgreSQL)
  routes/
    users.ts              ← nouveau (REST /api/users)
  server.ts               ← modifié (auth hook + rate limit)
  bootstrap.ts            ← modifié (UserStore init + inject dans ServerDeps)

cli/src/
  commands/
    users.ts              ← nouveau (studio users list/add/remove/info)
  index.ts                ← modifié (enregistrer la commande users)
```

## Schema DB

Tables ajoutées dans `runs.db` (SQLite) ou la DB PostgreSQL :

```sql
CREATE TABLE IF NOT EXISTS users (
  id        TEXT PRIMARY KEY,
  email     TEXT UNIQUE NOT NULL,
  plan      TEXT NOT NULL DEFAULT 'free',
  api_key   TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  user_id   TEXT NOT NULL,
  date      TEXT NOT NULL,    -- YYYY-MM-DD
  runs_count INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
```

## UserStore Interface

```typescript
interface User {
  id: string;          // UUID v4
  email: string;
  plan: string;        // 'free' | 'pro' | 'unlimited' (extensible via config)
  api_key: string;     // crypto.randomBytes(32).toString('hex')
  created_at: string;  // ISO 8601
}

interface DailyUsage {
  user_id: string;
  date: string;
  runs_count: number;
  tokens_used: number;
}

interface AnyUserStore {
  getUserByApiKey(apiKey: string): User | null | Promise<User | null>;
  getUserById(id: string): User | null | Promise<User | null>;
  listUsers(): User[] | Promise<User[]>;
  saveUser(user: User): void | Promise<void>;
  deleteUser(id: string): void | Promise<void>;
  getDailyUsage(userId: string, date: string): DailyUsage | Promise<DailyUsage>;
  incrementRuns(userId: string, date: string): void | Promise<void>;
  incrementTokens(userId: string, date: string, tokens: number): void | Promise<void>;
  close?(): void | Promise<void>;
}
```

## Plans Config (`config.yaml`)

```yaml
plans:
  free:
    runs_per_day: 5
    max_concurrent: 1
    max_tokens_per_run: 50000
    rate_limit_per_minute: 10
  pro:
    runs_per_day: 100
    max_concurrent: 5
    max_tokens_per_run: 500000
    rate_limit_per_minute: 60
  unlimited:
    runs_per_day: -1      # -1 = no limit
    max_concurrent: 20
    max_tokens_per_run: -1
    rate_limit_per_minute: 300
```

Defaults intégrés dans le code si `plans` absent de `config.yaml`.

## Auth Hook (server.ts)

**Mode multi-user** activé automatiquement si `userStore` présent dans `ServerDeps`.

**Mode legacy** : si `api.key` est défini et que le token correspond → anonymous user avec plan `unlimited`.

```
Request → extract Bearer token
  ├─ token matches api.key (legacy) → LEGACY_USER (unlimited)
  ├─ token matches a user api_key   → request.user = User
  ├─ no users in DB + no api.key   → open (dev mode)
  └─ else                           → 401 Unauthorized
```

Routes exclues de l'auth : `/api/integrations/*` (HMAC own auth).

## Rate Limiting

- `@fastify/rate-limit` (in-memory, per-process — suffisant pour local et single-instance remote)
- `keyGenerator`: `request.user?.id ?? request.ip`
- `max`: dérivé du plan de l'user (`rate_limit_per_minute`)
- Headers exposés : `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- 429 si dépassé

Pour multi-instance distribué (futur) : swap du store `@fastify/rate-limit` vers Redis. Pas de refacto nécessaire.

## Quota Enforcement

Dans `InProcessLauncher.launch()` avant de démarrer le run, si `userStore` présent :

1. `getDailyUsage(userId, today())`
2. Si `runs_per_day !== -1` et `usage.runs_count >= limit` → throw `QuotaExceededError` (→ 429 avec body `{ error: 'Daily run limit exceeded', limit, used }`)
3. `incrementRuns(userId, today())`
4. Après le run, `incrementTokens(userId, today(), totalTokens)` (best-effort)

`max_concurrent` : compter les runs en status `running` pour cet user_id via `listPipelineRuns({ status: 'running', userId })`. Nécessite un champ `user_id` sur `PipelineRun` (nullable, backward compat).

## REST Routes (`/api/users`)

Toutes protégées par auth hook. Opérations admin (`POST`, `DELETE`, `GET /`) réservées aux users `unlimited` ou legacy key.

```
POST   /api/users              → créer un user   body: { email, plan? }
                                  → 201 { id, email, plan, api_key }   ← api_key visible UNE SEULE FOIS
GET    /api/users              → lister les users → 200 User[] (sans api_key)
GET    /api/users/me           → user courant     → 200 User + DailyUsage
GET    /api/users/:id          → détail user      → 200 User + DailyUsage
DELETE /api/users/:id          → supprimer        → 204
```

Chaque route a un schema Swagger complet (tag: `users`).

## CLI — `studio users`

```bash
studio users list                       # Tableau : id, email, plan, created_at
studio users add <email> [--plan pro]   # Crée le user, affiche l'API key (une seule fois)
studio users remove <email>             # Supprime le user
studio users info <email>               # User + usage du jour
```

Lit la config depuis `findStudioDir()`, instancie `UserStore` directement (pas via l'API HTTP).

## Packages touchés

| Package | Changement |
|---------|-----------|
| `@studio/api` | UserStore, PgUserStore, routes/users, auth hook, rate limit, bootstrap |
| `@studio/contracts` | Type `PipelineRun` : ajouter `user_id?: string` |
| `@studio/engine` | `RunStore.listPipelineRuns` : ajouter filtre `userId` optionnel |
| `@studio/cli` | Commande `studio users` |

## Backward Compat

- `api.key` dans config.yaml continue de fonctionner exactement comme avant
- Si pas d'users en DB + pas de `api.key` → mode dev ouvert (inchangé)
- `user_id` sur `PipelineRun` est nullable → les runs existants sans user ne cassent pas

## Ce que ce sprint NE fait PAS

- JWT tokens / login endpoint (prévu dans une phase ultérieure)
- OAuth
- Gestion des plans via API (pour l'instant, via CLI ou direct DB)
- UI de gestion des users
- Rate limiting distribué (Redis) — peut être ajouté plus tard sans refacto

## Tests

- `UserStore` unit tests : CRUD, quota counters, daily reset
- Auth hook tests : multi-user mode, legacy key mode, open dev mode
- Route tests : POST /users (admin), GET /users/me, quota exceeded 429
- CLI tests : `studio users add`, `studio users list`

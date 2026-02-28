# Design — STU-200 : Migration Linear vers `.integration.yaml`

**Date :** 2026-02-28
**Ticket :** [STU-200](https://linear.app/studioag/issue/STU-200)
**Dépend de :** STU-184 (système de plugins `.integration.yaml`)

---

## Problème

L'intégration Linear est hardcodée dans le core API :

- `api/src/linear-notifier.ts` — notification de failure via GraphQL Linear
- `api/src/linear-store.ts` — persistence SQLite spécifique à Linear
- `api/src/routes/linear-webhook.ts` — routes `/api/integrations/linear/*`
- `api/src/launcher.ts` — import direct de `notifyLinearFailure`

Ce couplage viole le principe d'integration-agnosticism de STU-184.

---

## Principe directeur

**YAML = contrat déclaratif (quels handlers). TypeScript = implémentation.**

Même modèle que `.tool.yaml` : le YAML déclare le tool, le TypeScript exécute la logique.
`notifyLinearFailure` fait des appels GraphQL complexes avec de la logique métier — ça ne s'encode pas en YAML sans créer un mini-langage de scripting déguisé.

---

## Architecture cible

### 1. Extension du contrat YAML (`IntegrationPluginDef`)

```typescript
// contracts/src/integration-plugin.ts
webhook?: {
  hmac?: {
    header: string;      // ex: 'linear-signature'
    secret_env: string;  // ex: 'LINEAR_WEBHOOK_SECRET' — résolu depuis integrations config
  };
  handler: string;       // ex: 'linear-webhook' — clé dans WEBHOOK_HANDLERS registry
};
on_failure?: {
  handler: string;       // ex: 'linear-failure' — clé dans FAILURE_HANDLERS registry
};
```

`runner/templates/integrations/linear.integration.yaml` mis à jour pour déclarer ces handlers.

### 2. Generic IntegrationStore

Remplace `LinearStore`. Tables SQLite renommées :

```
linear_config    → integration_config  (+ colonne integration_name TEXT PK)
linear_triggers  → integration_triggers (+ colonne integration_name TEXT)
```

API publique : `getConfig(name)`, `patchConfig(name, data)`, `insertTrigger(record)`, `listTriggers(name, limit)`.

### 3. Handler interfaces + implémentations Linear

```
api/src/
  integrations/
    types.ts              ← WebhookHandler, FailureHandler interfaces
    registry.ts           ← maps 'linear-webhook' → LinearWebhookHandler, etc.
    linear/
      webhook-handler.ts  ← logique de routes/linear-webhook.ts (déplacée, pas réécrite)
      failure-handler.ts  ← logique de linear-notifier.ts (déplacée, pas réécrite)
```

Interfaces :

```typescript
interface WebhookHandler {
  handle(ctx: WebhookHandlerContext, reply: FastifyReply): Promise<unknown>;
}
interface FailureHandler {
  handleFailure(ctx: FailureHandlerContext): Promise<void>;
}
```

`WebhookHandlerContext` : `rawBody`, `headers`, `integration: IntegrationPluginDef`, `store: IntegrationStore`, `launcher`, `configsDir`, `projectsDir`, `apiConfig`.
`FailureHandlerContext` : `runId`, `durationMs`, `meta`, `lastGroupFeedback`, `integration`.

### 4. IntegrationRuntime

```
api/src/integration-runtime.ts
```

Responsabilités :

1. **Setup** — charge les intégrations depuis `.studio/integrations/`, pour celles avec `on_failure.handler` souscrit au bus (remplace le code dans `launcher.ts`)
2. **registerRoutes(fastify)** — pour chaque intégration avec `webhook.handler`, enregistre dynamiquement :
   - `GET /api/integrations/{name}` — config + trigger log
   - `PATCH /api/integrations/{name}` — update config
   - `POST /api/integrations/{name}/webhook` — délègue au webhook handler

Le secret HMAC est résolu depuis `config.yaml#integrations.{name}.{secret_env}`, pas depuis `apiConfig` (qui perd son champ `linear_webhook_secret`).

### 5. Changements server / bootstrap / launcher

**`launcher.ts`** :
- Supprime `import { notifyLinearFailure }`
- Supprime le bloc `void notifyLinearFailure(...)` dans `onPipelineComplete`
- Supprime le tracking de `lastGroupFeedback` (déplacé dans le failure handler)

**`server.ts`** :
- `ServerDeps` : `linearStore: LinearStore` → `integrationStore: IntegrationStore` + `integrationRuntime: IntegrationRuntime`
- `ApiConfig` : supprime `linear_webhook_secret`
- Supprime `import { linearWebhookRoute }` et `fastify.register(linearWebhookRoute, ...)`
- Ajoute `await integrationRuntime.registerRoutes(fastify, '/api', deps)`

**`bootstrap.ts`** :
- Supprime `import { LinearStore }` et instanciation
- Supprime `linearStore.close()` dans cleanup
- Ajoute `new IntegrationStore(dbPath)`
- Crée `IntegrationRuntime`, appelle `setup(bus, launcher, configsDir, projectsDir, apiConfig)`

---

## Tests

| Avant | Après |
|-------|-------|
| `api/tests/linear-webhook.test.ts` | Migré — même comportement via HTTP inject, utilise `IntegrationStore` + `IntegrationRuntime`. Charge `linear.integration.yaml` comme fixture. |
| `api/tests/linear-notifier.test.ts` | → `api/tests/integrations/linear/failure-handler.test.ts` — tests directs sur `LinearFailureHandler.handleFailure()`, même logique de mock fetch. |
| _(nouveau)_ | `api/tests/integration-runtime.test.ts` — routes créées si intégration installée, non créées sinon. |

---

## Fichiers supprimés

- `api/src/linear-notifier.ts`
- `api/src/linear-store.ts`
- `api/src/routes/linear-webhook.ts`

---

## Critère de succès

```bash
grep -r "linear" api/src/ --include="*.ts"
# Ne retourne rien sauf api/src/integrations/linear/ (le plugin lui-même)
```

Comportement fonctionnel identique : webhook trigger, HMAC verification, failure notification.

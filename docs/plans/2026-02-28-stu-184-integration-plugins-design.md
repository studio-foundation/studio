# STU-184 — Système de plugins d'intégrations extensible (`.integration.yaml`)

**Date :** 2026-02-28
**Ticket :** [STU-184](https://linear.app/studioag/issue/STU-184/cli-systeme-de-plugins-dintegrations-extensible-integrationyaml)
**Milestone :** v0.2.0

---

## Contexte

Les intégrations (Linear, Slack, webhooks) ne peuvent pas être hardcodées dans le CLI. Studio est domain-agnostic et doit être integration-agnostic. L'approche hardcodée crée une dette architecturale en couplant le core à des intégrations spécifiques.

Les intégrations sont distinctes des MCP servers : les MCP donnent des *capacités aux agents* (tools synchrones), les intégrations gèrent les *événements système* entre Studio et le monde extérieur (déclencheurs entrants, notifications sortantes).

---

## Solution

Un système de plugins extensible, cohérent avec l'architecture `.tool.yaml` existante. Une intégration = un fichier `.integration.yaml` dans `.studio/integrations/`. Studio charge tous les plugins présents sans connaître leur contenu.

---

## Architecture

### Packages touchés

| Package | Changements |
|---------|-------------|
| `@studio-foundation/contracts` | Nouveau fichier `integration-plugin.ts` — types `IntegrationPluginDef` + `IntegrationRuntimeHandler` |
| `@studio-foundation/runner` | `runner/templates/integrations/` — bundled YAML plugins. Exports : `getBundledIntegrationTemplate()`, `listAvailableIntegrationTemplates()` |
| `@studio-foundation/cli` | `cli/src/commands/integrations.ts` — subcommands. `cli/src/config.ts` — champ `integrations`. `cli/src/index.ts` — enregistrement |

### Parallèle avec le système tools

| Tools | Integrations |
|-------|-------------|
| `.tool.yaml` | `.integration.yaml` |
| `.studio/tools/` | `.studio/integrations/` |
| `runner/templates/tools/` | `runner/templates/integrations/` |
| `studio tools add git` | `studio integrations install @studio/integration-linear` |
| `getBundledToolTemplate()` | `getBundledIntegrationTemplate()` |

---

## Format `.integration.yaml`

Défini dans `@studio-foundation/contracts/src/integration-plugin.ts`.

```yaml
name: linear
version: 1
description: "Linear webhook trigger + issue status sync"

config:
  required:
    - LINEAR_API_KEY
    - LINEAR_WEBHOOK_SECRET
  optional:
    autoTrigger: false

events:
  consumes:
    - linear.issue.in_progress
  emits:
    - pipeline.complete
    - pipeline.failed

test:
  type: http
  endpoint: https://api.linear.app/graphql
  method: POST
  auth: bearer:${LINEAR_API_KEY}
  body: '{"query":"{ viewer { id name } }"}'
  expect:
    status: 200
```

---

## Types TypeScript

### `@studio-foundation/contracts/src/integration-plugin.ts`

```typescript
export interface IntegrationPluginDef {
  name: string;
  version: number;
  description?: string;
  config?: {
    required?: string[];
    optional?: Record<string, unknown>;
  };
  events?: {
    consumes?: string[];
    emits?: string[];
  };
  test?: {
    type: 'http';
    endpoint: string;
    method?: 'GET' | 'POST';
    auth?: string;   // e.g. "bearer:${LINEAR_API_KEY}"
    body?: string;
    expect?: { status?: number };
  };
}

// Interfaces runtime — implémentation API-side hors scope STU-184
export interface IntegrationRuntimeContext {
  event: string;
  data: unknown;
  config: Record<string, string>;
}

export interface IntegrationRuntimeHandler {
  name: string;
  plugin: IntegrationPluginDef;
  handleEvent(ctx: IntegrationRuntimeContext): Promise<void>;
}
```

---

## Bundled Plugins

Trois fichiers dans `runner/templates/integrations/` :

- `linear.integration.yaml` — Linear webhook trigger + issue sync
- `slack.integration.yaml` — Slack notifications
- `webhook.integration.yaml` — Generic HTTP webhooks

Exports depuis `@studio-foundation/runner/src/tools/plugin-loader.ts` (ou fichier dédié) :

```typescript
getBundledIntegrationTemplate(name: string): Promise<string | null>
listAvailableIntegrationTemplates(): Promise<{ name: string; description: string }[]>
```

---

## Commandes CLI

### `studio integrations install <source>`

```bash
studio integrations install @studio/integration-linear     # bundled registry
studio integrations install @studio/integration-slack
studio integrations install @studio/integration-webhook
studio integrations install ./path/to/custom.integration.yaml  # local path
```

- `@studio/integration-<name>` → cherche dans `runner/templates/integrations/<name>.integration.yaml`
- Path local → copie vers `.studio/integrations/<name>.integration.yaml`
- Erreur si déjà installé

### `studio integrations list`

```
linear       ● configured    auto-trigger: off    v1
slack        ○ not configured                      v1
webhook      ● configured    1 endpoint            v1
```

- `●` vert = installé + required vars présentes dans config.yaml
- `○` gris = installé mais required vars manquantes
- Non installées = non affichées

### `studio integrations remove <name>`

Supprime `.studio/integrations/<name>.integration.yaml`. Ne touche pas `config.yaml`.

### `studio integrations test <name>`

Lit le bloc `test:` du plugin, substitue `${VAR}` depuis `config.yaml` + env, exécute la requête HTTP.

```
✓ linear connected — viewer: Ariane Guay
✗ slack error — 401 invalid_auth
```

### `studio integrations set <name>.<key> <value>`

```bash
studio integrations set linear.autoTrigger true
studio integrations set slack.channel "#prod-alerts"
```

Écrit dans `config.yaml` sous `integrations.<name>.<key>`. Erreur si plugin non installé.

---

## Config `.studio/config.yaml`

```yaml
integrations:
  linear:
    LINEAR_API_KEY: ${LINEAR_API_KEY}
    LINEAR_WEBHOOK_SECRET: ${LINEAR_WEBHOOK_SECRET}
    autoTrigger: false
  slack:
    SLACK_BOT_TOKEN: ${SLACK_BOT_TOKEN}
    channel: "#studio-runs"
```

Support `${VAR}` via `resolveEnvVars()` existant dans `cli/src/config.ts`.

### `StudioConfig` (ajout dans `cli/src/config.ts`)

```typescript
integrations?: Record<string, Record<string, unknown>>;
```

---

## Error Handling

| Situation | Comportement |
|-----------|-------------|
| `install` — source inconnue | `Error: Unknown integration 'foo'. Available: linear, slack, webhook` |
| `install` — déjà installé | `Error: 'linear' already installed. Run: studio integrations remove linear` |
| `remove` — pas installé | `Error: Integration 'linear' not found` |
| `test` — pas installé | `Error: 'linear' not installed. Run: studio integrations install @studio/integration-linear` |
| `test` — required var manquante | `Error: LINEAR_API_KEY not set. Run: studio integrations set linear.LINEAR_API_KEY <value>` |
| `test` — HTTP failure | Affiche status code + body, exit 1 |
| `set` — plugin pas installé | `Error: Integration 'linear' not installed` |

---

## Tests

Fichier : `cli/src/commands/integrations.test.ts`

- `install` : copie le bon fichier, erreur si doublon, erreur source inconnue
- `list` : liste les `.integration.yaml` présents, status config correct
- `remove` : supprime le fichier, erreur si absent
- `test` : mock fetch — substitution vars, header auth, lecture bloc `test:`
- `set` : écriture correcte dans config.yaml, erreur si plugin absent

---

## Hors scope (STU-184)

- Registry public npm pour les intégrations community
- Implémentation runtime API-side (dispatch events → integration handlers) — ticket séparé
- Remplacement des fichiers hardcodés `linear-notifier.ts`, `webhook-dispatcher.ts` — ticket séparé
- Intégrations MCP (protocole distinct)
- Studio Cloud integration sync

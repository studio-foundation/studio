# {{PROJECT_NAME}}

Generated from the `{{TEMPLATE_NAME}}` Studio template.

## Getting started

```bash
npm install
studio run {{PROJECT_NAME}}/feature-builder --input "Your task description"
```

## Pipelines

- **feature-builder** — Analyze a request and generate code changes
- **quick-edit** — Apply a focused single-file edit

## Configuration

Set your API key:

```bash
studio config set provider anthropic --api-key $ANTHROPIC_API_KEY
```

## Inbound webhooks

Studio serves no webhook: receiving one is the project's job, and Studio only exposes the CLI. `webhook/server.mjs` is a minimal receiver with no dependencies (Node 22): it verifies an HMAC-SHA256 signature, maps one field of the JSON payload to `--input` and runs `studio run`.

```bash
WEBHOOK_SECRET=change-me \
WEBHOOK_PIPELINE={{PROJECT_NAME}}/feature-builder \
WEBHOOK_INPUT_FIELD=issue.title \
node webhook/server.mjs
```

A bad or missing signature answers `401`, a payload without the field `422`, a launched run `202`. Sign a test delivery with:

```bash
body='{"issue":{"title":"Add a health endpoint"}}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac change-me -hex | sed 's/^.* //')
curl -i -X POST localhost:8787 -H "x-hub-signature-256: sha256=$sig" -d "$body"
```

Out of scope, and yours to add per provider: subscription renewal, health checks, alerting, and running under a supervisor (systemd, a container) with the secret in its environment.

# ADR 0004 — Triggers replace integrations

**Status:** Accepted
**Date:** 2026-07-28
**Affects:** `api/src/`, `contracts/src/`, `cli/src/commands/`, `studio-community`

---

## Context

An `.integration.yaml` declared four things: a config block, a `test:` endpoint, an
`events:` block, and a `webhook.handler` naming a TypeScript class. That last string was
looked up in a map compiled into the binary, so publishing an integration for a second
tracker meant a kernel PR and a release — exactly the coupling [ADR 0001](./0001-distribution-model.md)
and [ADR 0002](./0002-packaging-model.md) removed for tools. The leak reached the leaf
package: `contracts/src/integration-plugin.ts` documented a field as *"key in
WEBHOOK_HANDLERS registry"*.

Auditing what the surface actually bought:

| Key | Read by | Already covered by |
|---|---|---|
| `config.required` / `optional` | store, secret resolution | env vars + `studio doctor` |
| `test:` | `studio integrations test` only | a tool call |
| `events.emits` / `events.consumes` | **nothing** — all three shipped integrations declared it | — |
| `webhook.hmac` + `webhook.handler` | the runtime | **nothing — the only unique part** |
| `on_failure.handler` | the runtime | lifecycle hooks + a tool |

Two findings settled it.

**The kernel already ships a full MCP client** — `runner/src/plugins/` supports stdio,
http and OAuth, wired into `run`, `replay` and the API. Every *outbound* thing an
integration did — post a comment, move an issue, notify a channel — was already
expressible as an MCP server or a `.tool.yaml`: sandboxed, marketplace-installable, no
kernel release. The one shipped failure handler was 93 lines hand-rolling `fetch` against
a GraphQL endpoint, written as kernel code only because the integration concept offered no
way to say "call a tool here".

**Two of the three shipped integrations were inert.** `slack` and `webhook` declared
neither `webhook:` nor `on_failure:`, so the runtime registered no route and subscribed to
no event for them. They described capabilities nothing executed.

What was genuinely left is receiving an external POST and launching a run. MCP does not
cover it — MCP is outbound, this is inbound.

## Decision

Delete the integration concept. Split what it did by the direction of the call.

**Outbound → a tool or an MCP server.** No new mechanism; this already worked.

**Inbound → a trigger.** A `.trigger.yaml` in `.studio/triggers/`, served by
`studio api start` at `POST /api/triggers/<name>/webhook`. Stripped of vendor policy the
job is domain-free, and the kernel does exactly these four steps:

1. verify the HMAC signature over the raw body,
2. match the payload against `when:` conditions,
3. map the payload into pipeline input,
4. launch the pipeline.

The conditions reuse the stage `when:` evaluator over a `payload.` root, and the input map
reuses `{{...}}` interpolation, so neither side reimplements comparison or templating.

**`on_failure` → a shell command, not a handler.** It receives its values through the
environment (`STUDIO_TRIGGER`, `STUDIO_RUN_ID`, `STUDIO_RUN_STATUS`, `STUDIO_META`,
`STUDIO_REJECTION_REASON`, `STUDIO_REJECTION_DETAILS`) and never through interpolation into
the command string: the values come from a webhook payload, and interpolating them would
let the sender run anything.

Deleted rather than migrated: `api/src/integrations/` entirely, `api/src/integration-runtime.ts`,
`contracts/src/integration-plugin.ts`, `runner/src/integrations/`, `studio integrations`,
and the `slack` / `webhook` marketplace packages. `IntegrationStore` survives as
`TriggerStore` — it was already generic and partitioned by name.

## Consequences

**Every vendor convention moves into YAML the user can edit.** Which events count, which
transition starts a run, which state a failed issue returns to, which fields become which
input — all were hardcoded in the kernel, all are now lines in a `.trigger.yaml`. A team
using the same tracker differently edits a file instead of forking Studio.

**A new trigger is publishable with no kernel release**, which is the whole point.

**INV-11 gains a mechanical check and loses its known exception.** `check:kernel` now
fails on a kernel source path named after a product. It reads the path, not the contents —
grepping source text was tried and abandoned, because "linear" is an ordinary English
adjective and a fixture name in the MCP tests, so it fired on prose. A directory named
after a product is unambiguous, and it is the shape the violation actually took.

**Breaking for anyone consuming the `linear` integration package.** Nobody outside the
core does. Minor bump under the 0.x rule.

**`config.integrations` disappears from `config.yaml`.** A trigger's secrets are `${VAR}`
references resolved at load, which is where every other secret already lived.

**`studio integrations test` has no replacement.** It hit an endpoint declared in YAML to
confirm credentials worked. That is a tool call, or `curl` — a bespoke command for it was
half the reason two inert packages existed.

## Alternatives considered

**A small declarative matcher language, integrations otherwise unchanged.** Rejected: it
keeps four surfaces to serve one that carries weight, and leaves `on_failure` needing
kernel code anyway.

**Load third-party handler modules into the API process.** Rejected: a one-way trust
change — arbitrary code in the server process — bought to solve a problem that YAML plus
an existing tool runtime solves without it.

**Keep integrations, accept the kernel PR per vendor.** Zero work, and the coupling costs
nothing until someone outside the core publishes one. Rejected because the fix turned out
to be a net deletion of ~2,000 lines: the cheap moment to do it is while the only
consumers are ours.

## References

- [ADR 0001](./0001-distribution-model.md) — marketplace sourcing
- [ADR 0002](./0002-packaging-model.md) — content kinds inside a plugin
- [INVARIANTS.md](../../INVARIANTS.md) — INV-11
- STU-698 (this decision), STU-695 (tools out of the kernel), STU-697 (resolved by deletion)

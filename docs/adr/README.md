# Architecture Decision Records

Structural decisions are written down here. *A decision without trace did not happen*
([GOVERNANCE.md](../../GOVERNANCE.md#governance)).

An ADR is required when a change touches the distribution or packaging model, a package
boundary, an invariant, the licensing or governance posture, or picks one architecture
over a viable alternative. Everything else is a commit message.

To add one: copy [template.md](./template.md), take the next number, open it in the same
PR as the code it justifies. ADRs are append-only — a decision that no longer holds is
superseded by a new ADR, never edited away.

| # | Decision | Status |
|---|---|---|
| [0001](./0001-distribution-model.md) | Marketplace of pointers, not a content monorepo | Accepted |
| [0002](./0002-packaging-model.md) | Two packaging types: template and plugin | Accepted |
| [0003](./0003-contribution-rights.md) | DCO, no assignment, no relicensing | Accepted |

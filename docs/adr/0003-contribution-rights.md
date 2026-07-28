# ADR 0003 — Contribution rights: DCO, no assignment, no relicensing

**Status:** Accepted
**Date:** 2026-07-27
**Affects:** `CONTRIBUTING.md`, `DCO`, `LICENSE`, `GOVERNANCE.md`, `.github/workflows/dco.yml`

---

## Context

The copyright on Studio is personal: `LICENSE` names one natural person. No foundation
exists legally, although the GitHub organization and the npm scope are already called
`studio-foundation`, and [GOVERNANCE.md](../../GOVERNANCE.md) states that the kernel is
intended to be owned by a non-profit, non-transferable foundation.

Every merged external PR adds a copyright holder. Under AGPL-3.0 with no contributor
agreement, that is fine for *distribution* — the license already grants everything needed
to ship the combined work — but it decides, silently and permanently, what can be done
later: any relicensing would require the consent of every contributor, and a retroactive
consent hunt across an unbounded set of people is not a plan.

So the question is not "do we need paperwork". It is: **is Studio ever going to want to
relicense?** Everything else follows from that answer, and the answer has to be recorded
before the contributor set grows, not after.

## Decision

**No.** Studio will not be relicensed. The AGPL is
[Mechanism 1 of non-capture](../../GOVERNANCE.md#mechanism-1-agpl-30-license), not a
starting position — the ability to relicense is exactly the ability to capture the
project, and giving it up is the point.

Three consequences, adopted together:

**1. DCO, not a CLA.** Contributors sign off with `Signed-off-by` on every commit,
certifying they have the right to submit the work under AGPL-3.0. A `Signed-off-by`
trailer is a certification, not a transfer. CI enforces it on every pull request
([`scripts/check-dco.sh`](../../scripts/check-dco.sh)); an unsigned commit does not merge.

**2. No copyright assignment. Contributors keep their copyright.** The codebase becomes
legitimately multi-author, and stays that way. This is the Linux model, and it is the
model that makes the license practically irrevocable: no single party — founder or
foundation — can unilaterally change the terms.

**3. What transfers to the foundation is stewardship, not the codebase.** When the
foundation is incorporated, the founder assigns what she individually holds:

| Transfers | Stays where it is |
|---|---|
| The founder's own copyright in the code she wrote | Each contributor's copyright in their own commits |
| The `studio-foundation` GitHub organization | — |
| The `@studio-foundation` npm scope | — |
| The project name and any registered mark | — |
| Domains, infrastructure accounts, signing keys | — |

The foundation inherits an AGPL-3.0 codebase it cannot relicense. That is the intended
outcome, not a limitation to work around later.

## Consequences

**A contributor cannot be un-contributed.** A commit merged under AGPL-3.0 stays under
AGPL-3.0. If someone withdraws, the code remains; that is the same guarantee that lets
the founder step back without the system collapsing.

**Dual licensing is off the table.** Selling a proprietary exception to Studio would
require assignment from every contributor. Read as a loss, this closes a revenue path.
Read correctly, it is the promise the license makes: the
[revenue model](../../GOVERNANCE.md#revenue-model) funds the commons from the ecosystem,
never by selling exemptions from it.

**A future license change needs unanimity, so it will not happen.** Migrating to
AGPL-4.0, or any successor, would require consent from everyone. Studio does not use
"or any later version" wording implicitly; if that flexibility is ever wanted, it must be
a separate, deliberate ADR, decided while the contributor list is still small.

**Sign-off is a real barrier to a drive-by contribution.** A first-time contributor will
occasionally hit a red DCO check on a two-line typo fix. `git rebase --signoff main` is a
one-line fix and CI prints it, but the friction is real and accepted: the alternative is
a contribution whose provenance nobody can vouch for.

**The pseudonymity question is deferred.** The DCO asks for a real name. Some of the
people Studio is explicitly built for have reasons not to publish one. The current answer
is that a consistently used identity with a working email is accepted; hardening that
into a policy needs its own decision, and this ADR does not make it.

**Incorporation is out of scope here.** Jurisdiction, structure, and board composition
are a separate decision. This ADR only fixes what the foundation would receive, so that
merging external PRs in the meantime costs nothing later.

## Alternatives considered

**A CLA with copyright assignment** (the Apache/Canonical model). Consolidates ownership
in one holder, which makes relicensing and enforcement trivially easy. Rejected: it
recreates exactly the single point of capture the AGPL exists to prevent, and it asks
every contributor to sign a legal agreement with a natural person who, today, is the whole
project. High friction, wrong direction.

**A CLA with a license grant but no assignment** (the "CLA-lite" middle ground). Gets a
broader license grant than the DCO without moving ownership. Rejected: it buys flexibility
Studio has just decided not to want, at the cost of a signature step and a bot to track
who signed. Machinery for an option we are declining to keep.

**Nothing — keep merging PRs with no mechanism.** Zero work today. Rejected: it is not
"no decision", it is the same decision made implicitly and undocumented, with the
provenance record missing. The DCO costs one flag on `git commit`.

## References

- [Developer Certificate of Origin 1.1](../../DCO)
- [GOVERNANCE.md](../../GOVERNANCE.md) — the three mechanisms of non-capture
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — how to sign off
- STU-416

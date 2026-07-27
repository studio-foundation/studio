# Studio Charter

> This document describes what Studio is, what it is not, and how it is governed.
> It serves as a reference for contributors, users, and anyone wondering why Studio is structured the way it is.

---

## What Studio is

Studio is an orchestration system for AI agent pipelines. Technical work happens through declarative YAML configuration, validated by contracts, retried by a RALPH loop. The kernel knows nothing about the domain. All business content lives in configs.

Studio is designed on the model of `git`: a tool you install globally, that lives in a `.studio/` folder inside the user's project, that you use daily from the terminal. Not a framework to learn. Not a platform to join. A dev tool.

```
git init    →  studio init
.git/       →  .studio/
git commit  →  studio run
GitHub      →  Studio Cloud (future)
```

## What Studio is not

Studio is not an AI agent. Agents are secondary, interchangeable, fallible.

Studio is not a framework. You don't inherit from a class, you don't implement an interface, you don't learn a DSL. You write YAML.

Studio is not a platform. The kernel is open source, the hosted API (when it exists) will be optional, content stays in your repo.

Studio is not a commercial product. The kernel is and will remain a commons.

---

## Political position

Studio is a project explicitly anchored on the left. This mention is not a slogan added to a neutral product, it is the foundation of the project itself. Three principles structure technical and organizational decisions:

**Equity rather than abstract equality.** Tools do not serve everyone the same way. Studio is designed with first thought for people for whom current tooling is inadequate: neurodivergent people, precarious people, people excluded from centers of technical power.

**Redistribution rather than centralization.** The productivity gains that AI makes possible currently concentrate value at the top. Studio exists to make agent orchestration accessible without depending on a proprietary platform that captures the value produced.

**Sustainability rather than raw performance.** The project is designed to last, not to scale. Human pace takes precedence over the roadmap. The founder can step back without the system collapsing.

Ideological neutrality is neither sought nor claimed.

---

## Why a commons, not a startup

Studio could have been a startup. The product shape lends itself to it, the market exists, demand is rising. The opposite choice is deliberate: an AI agent orchestration kernel, captured by a company, becomes the bottleneck of everything that flows through it. Studio is designed so that it cannot be captured.

Three structural mechanisms ensure this non-capture.

### Mechanism 1: AGPL-3.0 license

Any modification of Studio used in production must be published under the same license. A company that forks Studio for internal proprietary use violates the license. This is the strategy the GNU project used to prevent commercial capture of free software, and it is deliberate.

### Mechanism 2: Ownership by a non-profit foundation

The kernel is intended to be owned by a non-profit, non-transferable foundation. The foundation bears the name of its founder as recognition of the initiative, without implying permanent or exclusive authority. The progressive withdrawal of the founder is part of the explicit goals of the project.

The foundation's governance is designed to give decision-making power to the people directly affected by the inequalities the project seeks to reduce. Diversity is not symbolic, it is decision-making.

### Mechanism 3: Three strictly separated layers

Studio is structured in three layers whose authorities are watertight:

**1. The open source kernel.** Commons. Non-transferable. Governed by constitutional invariants. Final authority on technical decisions.

**2. The support core.** Hosting, maintenance, documentation. Generates revenue subordinated to the commons. On the model of the Linux Foundation which funds Linux without controlling it.

**3. "Powered by Studio" products.** Applications built from templates. Can be open source or commercial. Can appear or disappear. Exercise no power over the kernel.

As GitHub, GitLab, and Bitbucket are to `git`: products built on a free tool without authority over it.

---

## Technical architecture

Studio is a monorepo of seven packages, plus a template system. All packages share one version, bumped in lockstep.

```
@studio-foundation/cli          Terminal interface
    │
    ├── @studio-foundation/api          HTTP REST API (Fastify)
    │
@studio-foundation/engine       Pipeline orchestration, state machine, persistence
    │
    ├── @studio-foundation/ralph        RALPH loop: execute → validate → retry if fail
    │
    ├── @studio-foundation/runner       Tool plugin runtime, LLM calls, multi-provider
    │
    └── @studio-foundation/anonymizer   PII anonymization before LLM calls
    │
@studio-foundation/contracts    Shared types (zero internal dependencies)
Templates/                      Architectural patterns, distributed through the registry
```

Five concepts differentiate Studio from other orchestrators:

**RALPH loop.** Execute, validate against the contract, retry with enriched feedback if fail, repeat until success or max attempts. This is what makes pipelines reliable. No stage advances until its output respects its contract.

**Output contracts.** Structural validation schemas. Validation is binary, pass or fail. No gray zone, no configurable acceptance score.

**Anti-theatre.** Detection of agents that pretend to have done the work without having done it. If a contract requires tool calls and the agent made none, the stage fails regardless of the quality of the text produced.

**Groups.** Multi-stage feedback loops. Creation, critique, revision automatic, without human intervention between iterations.

**Tool plugins.** `.tool.yaml` files that define capabilities for agents. Self-documenting (the prompt snippet is auto-injected into the agent's system prompt), project-scoped (each project has its tools), double-gated (the project authorizes the tools, the agent authorizes which it calls). Creating a tool requires no code.

Ten architectural invariants ensure the system remains coherent. They are the constitution of the kernel, written down in [INVARIANTS.md](./INVARIANTS.md) and enforced mechanically by the linter for the ones that can be:

1. `contracts` is a leaf package. Zero internal dependencies.
2. `ralph` does not know `runner`. The executor is generic.
3. `runner` only executes. It does not validate, does not retry.
4. The engine is domain-agnostic. All domain comes from YAML.
5. Tools are in `runner`, not in `engine`.
6. Prompts are in `runner`, not in `engine`.
7. The state machine is deterministic. Stage status derives from the RALPH result, never from output content.
8. Validation is binary: pass or fail. No score, no threshold.
9. A project is fully self-contained in its `.studio/` directory.
10. The dependency graph is a strict DAG. No upward imports.

If a feature can be configured in YAML rather than coded, it is in YAML. This is not a stylistic preference, it is a constitutional rule of the kernel.

---

## Templates

Templates are not finished products. They are architectural patterns that generate complete applications, like `create-react-app` or `create-next-app`, but for AI-orchestrated apps.

A template packages base pipelines for a domain, adapted tools (`.tool.yaml`), configured contracts and agents, and a workspace skeleton. `blank` ships inside the CLI; every other template is a registry package, installed on demand:

```bash
studio templates                 # bundled + registry templates
studio init --template <name> --name my-project
```

Templates are designed to be reusable. Several products can start from the same template and diverge completely — one analyzes books, another processes voice, both from a content-extraction template. It's the architectural pattern that is shared, not the domain.

Distribution through the registry is deliberate: it keeps the kernel small, and it makes a community template indistinguishable from an official one. The kernel governs the format, not the catalogue. See [TEMPLATES.md](./TEMPLATES.md).

---

## Revenue model

Inspired by the Linus Torvalds model: the tool is free, the ecosystem funds the development.

- **The kernel** is free, open source, forever
- **The official templates** are free, open source
- **The hosted API** (Studio Cloud, future) generates revenue via subscriptions
- **Specialized products** can be commercial or open source according to each team's choices
- **The foundation** is funded by the ecosystem of companies that depend on Studio

Linus never sold Linux or git. He is funded by the companies that depend on them, through the Linux Foundation. Studio follows the same model.

No commercial decision can take precedence over the kernel invariants. Any evolution that improves performance or monetization at the cost of worsening inequalities is considered a regression.

---

## Governance

The kernel is treated as a constitution, not as an implementation. Final authority over structural decisions belongs to the kernel and the foundation, not to agents, commercial products, or individual contributors.

Five operational principles:

**Governance before execution.** Not-acting is a valid decision. A feature that could be done does not have to be done.

**Agents never have final authority.** They execute, they do not govern.

**Written justification for sensitive decisions.** Structural choices are documented (Architecture Decision Records). A decision without trace did not happen.

**Ethical veto right.** Any evolution can be blocked if it compromises the political anchoring of the project, even if it improves performance.

**Primacy of affected people.** Governance decisions go in priority to the people the project seeks to serve, not to contributors with the most commits.

---

## Cadence

- Several products may run on the kernel at once — each one is a real-world test of it. Only one is promoted publicly at a time, so attention stays on one thing
- Refusal of artificial urgencies
- Any new idea passes through a latency period
- Human pace takes precedence over the roadmap
- Templates are created only after validation by a real product

Studio is not designed to scale fast. It is designed to last.

---

## Definition of success

Studio is healthy when:

- The kernel remains coherent over time
- Projects finish or stop explicitly, they do not die by abandonment
- The cognitive load of the founder and contributors decreases over time
- Decisions are traceable
- Adoption is slow but voluntary
- The founder can step back without system collapse
- Templates are reused by the community
- Several products live on the same template

Money is a means of sustainability, never an end.

---

## How to contribute

Studio is in active development, published on npm as `@studio-foundation/cli` and as standalone binaries. The version line is `0.x`: the YAML surface still moves, and `1.0` will only mean that an existing `.studio/` config keeps working until a major bump.

Three ways to participate now:

**Issues and discussions.** The repo welcomes questions, bug reports, improvement proposals, usage feedback. Topics that might interest others go on GitHub, the rest by email.

**Code contributions.** PRs are welcome, respecting the architectural invariants. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details (forthcoming).

**Tool plugins and templates.** `.tool.yaml` files are the main extension point of Studio. The community registry is open — publishing is a PR, with no review gate: `studio registry publish <path>`.

---

## Status

Studio is in pre-launch. The kernel is installable (npm, `curl | sh`, `irm | iex`), the registry is open, but there is no public promotion, no hosted API, and no version 1.0.

The move to "first public release" mode happens once a real product validates the kernel in production. Until then, interested users can install it and test locally. Bugs and incompatibilities are expected: in `0.x`, a config-breaking change costs a minor bump, not a major one.

---

> Final arbitration principle.
> Nothing in this document is for sale.

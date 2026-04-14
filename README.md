# Studio

**Agentic pipeline runtime with structural validation.**

```
$ studio run software/feature-builder --input "Add a FAQ section to the About page"

[1/4] brief-analysis ............ ✓ (attempt 1/3)
[2/4] implementation-plan ....... ✓ (attempt 1/3)
[3/4] code-generation ........... ✓ (attempt 2/5) ← retry: theatre detected
[4/4] qa-review ................. ✓ (attempt 1/3)

Pipeline completed in 4m32s
Files changed: src/pages/About.tsx (+47 lines)
```

Run this 10 times. It passes 10 times. That's the point.

---

## The problem

AI agents are unreliable. They hallucinate results, skip steps they claim to have completed, and produce outputs that look correct but aren't. The industry's answer is either "trust the model" or "put a human on every step."

Studio takes a different position: **verify structurally, retry automatically, trust nothing.**

## How it works

Studio breaks work into **stages** with explicit **output contracts** — JSON schemas that define what a stage must produce. Each stage runs through a **RALPH loop**: execute, validate against the contract, retry with escalated feedback if validation fails. No stage advances until its output is structurally proven correct.

```
Pipeline (YAML)
  └── Stage 1 → RALPH: execute → validate → pass? next : retry
  └── Stage 2 → RALPH: execute → validate → pass? next : retry
  └── Stage 3 → RALPH: execute → validate → pass? next : retry
```

Validation is binary. Pass or fail. Not vibes.

**Anti-theatre:** If a code generation stage claims to have written files but made zero tool calls, it fails — regardless of what it says in its output. Tool calls are tracked by the runner, not self-reported by the agent.

**Domain-agnostic:** The engine has zero knowledge of what domain it operates in. It doesn't know what "code" or "transactions" or "entities" mean. All domain knowledge lives in YAML configs — pipelines, contracts, agents, tools. This is an architectural commitment, not a feature.

**Provider-agnostic:** Anthropic, OpenAI, Mock — swappable per agent without touching pipeline logic. The orchestration layer doesn't depend on who does the work. It depends on the work being done correctly.

---

## Quick start

```bash
# Install
npm install -g @studio-foundation/cli@beta

# Create a new project from a template
studio init --template software --name my-builder
cd my-builder

# Configure your LLM provider
studio config set provider anthropic --api-key $ANTHROPIC_API_KEY

# Install dependencies
npm install

# Run a pipeline
studio run software/feature-builder --input "Add dark mode support"
```

---

## Open source

Studio is licensed under **AGPL-3.0-only**.

What this means concretely:

- **You can build commercial products on Studio.** Use it, extend it, sell what you build.
- **If you modify Studio itself and run the modified version as a network service**, you must publish your changes under the same license.
- **Using Studio as a dependency** in your application does not require you to open-source your application. The AGPL applies to Studio's code, not to the YAML configs and application code you write on top of it.

The kernel is a commons. The license is the mechanism that keeps it that way.

See [LICENSE](./LICENSE) for the full text.

---

## Philosophy

Studio is an explicitly political project. The AGPL is not a default — it is a structural choice against capture.

The engine is a commons by design. Domain-agnostic so no single use case can claim ownership. Provider-agnostic so no single vendor can lock it in. Open source so the tool belongs to the people who use it.

Governance keeps decision-making with the people most affected by the inequalities the project aims to reduce. Diversity is not symbolic — it is decisional.

The full governance model and foundational principles are documented internally.

See [PHILOSOPHY.md](./PHILOSOPHY.md) for the public-facing articulation.

---

## Architecture

```
@studio-foundation/cli          → Terminal interface
    │
@studio-foundation/api          → HTTP REST API (Fastify)
    │
@studio-foundation/engine       → Pipeline orchestration, state machine
    │
    ├── @studio-foundation/ralph        → Execute, validate, retry
    ├── @studio-foundation/runner       → LLM calls, tool plugin runtime
    └── @studio-foundation/anonymizer   → PII anonymization middleware
    │
@studio-foundation/contracts    → Shared types (zero dependencies)
```

Seven packages, one monorepo. Each fits in a single context window. Each is testable in isolation.

**Build from source:**

```bash
git clone https://github.com/studio-foundation/studio
cd studio
pnpm install
pnpm build
```

---

## Documentation

| Document | Content |
|----------|---------|
| [CONCEPTS.md](./CONCEPTS.md) | RALPH loop, output contracts, anti-theatre, groups, hooks, skills, architecture deep dive |
| [TEMPLATES.md](./TEMPLATES.md) | The 5 architectural templates — software, finance, analysis, data, conversation |
| [CLI.md](./CLI.md) | All CLI commands, `.studio/` structure, config format |
| [API.md](./API.md) | HTTP endpoints, SSE streaming, webhooks |
| [PHILOSOPHY.md](./PHILOSOPHY.md) | Political anchoring, open source as structural choice, governance principles |

---

## Projects powered by Studio

| Project | What it does | Template |
|---------|-------------|----------|
| [Wiki Creator](https://github.com/studio-foundation/wiki-creator) | Extracts entities, relationships, and generates wiki pages from EPUB books using NLP + LLM pipelines | `analysis` |
| [Little Chef](https://github.com/studio-foundation/little-chef-by-studio) | AI meal planner — researches cuisines, develops recipes with nutritional profiles, generates grocery lists | `software` |

---

## Status

**Studio is in beta (v0.3.0-beta).** The core works — RALPH loop, pipeline engine, groups, hooks, tools, multi-provider, CLI, API — but expect rough edges, breaking changes, and missing pieces. The architecture is stable; the surface is still moving.

**Current priority:** Code Builder end-to-end — Linear webhook to pipeline run to commit + PR.

**Known limitations:**
- Only the `software` template is production-ready. `finance`, `analysis`, `data`, and `conversation` are structural starters with stub tools.
- No template upgrade path yet — once generated, manual sync only.
- Community registry is not live. Tool sharing is via git repos for now.
- Error messages are sometimes cryptic. Improving progressively.
- Documentation may lag behind implementation.

If you hit something broken, that's expected at this stage. [Open an issue.](https://github.com/studio-foundation/studio/issues)

---

> Studio is not built to be fast. It is built to last.

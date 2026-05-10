# Concepts

How Studio works, from the inside out.

---

## RALPH loop

**Recursive Automated Loop for Persistent Handling.**

The core execution primitive. Every stage in a pipeline runs through RALPH:

1. **Execute**: the agent produces output
2. **Validate**: the output is checked against the stage's contract
3. **Pass?**: if yes, advance to the next stage
4. **Retry**: if no, feed the validation errors back to the agent and re-execute with escalated feedback
5. **Repeat** until success or max attempts exhausted

```
execute → validate → pass? → next stage
                   → fail? → enrich feedback → execute again
                   → exhausted? → stage failed
```

RALPH is a standalone package (`@studio-foundation/ralph`). It takes a generic `executor: () => Promise<T>` and a `validator: (result: T) => ValidationResult`. It does not know that an LLM is behind the executor. It does not know what domain the validation covers. It loops until the contract is satisfied or the budget runs out.

**ralph does not know runner.** This is a hard boundary. ralph receives an executor function, it never imports runner, never constructs LLM calls, never touches tool logic.

---

## Output contracts

A contract defines what a stage must produce. It is a YAML file containing a JSON schema plus optional constraints.

```yaml
name: code-generation
version: 1
schema:
  required_fields:
    - summary
    - files_changed
tool_calls:
  minimum: 1
  maximum: 15
  required_tools:
    - repo_manager.write_file
```

Validation is binary. The output either satisfies every constraint or it doesn't. There is no partial credit.

**`tool_calls.minimum`** catches agents that claim to have done work without actually doing it. If the contract requires at least 1 tool call and the agent made 0, the stage fails, regardless of what the agent wrote in its output.

**`tool_calls.maximum`** catches infinite loops. If an agent makes more tool calls than the cap, something is wrong.

**`required_tools`** enforces that specific tools were actually called. A code generation stage that never called `write_file` didn't generate code.

> In contract YAML, tools use dot notation (`repo_manager.write_file`). The engine transforms to dash notation (`repo_manager-write_file`) internally.

---

## Anti-theatre

The term for validation that catches agents faking work.

Agents are optimized to produce plausible output. An agent asked to write code can produce a convincing summary of what it "did" without ever calling a write tool. Anti-theatre validation checks what actually happened: tool calls made, files written, commands executed, against what the contract requires.

This is not a heuristic. It is structural. The runner tracks every tool call. The contract specifies what must have occurred. The engine compares the two. Theatre is caught mechanically.

---

## Post-validation rejection

A stage can produce structurally valid output that is semantically negative. A QA stage that returns `{ status: "rejected", issues: [...] }` passed its contract (the schema is satisfied) but the verdict is negative.

Post-validation rejection handles this. Configured in the contract:

```yaml
post_validation:
  rejection_detection:
    field: status
    approved_values: [approved, approved_with_notes]
    rejected_values: [rejected, failed, implementation_incomplete]
    details_field: issues
    summary_field: summary
```

When rejection is detected, the stage status becomes `rejected` (not `failed`). This distinction matters for groups.

---

## Groups

A group is a feedback loop containing multiple stages that execute in iterations.

```yaml
- group: implementation-review
  max_iterations: 3
  stages:
    - name: code-generation
      agent: coder
      contract: code-generation
    - name: qa-review
      agent: analyst
      contract: qa-review
```

If the last stage in the group rejects (via `rejection_detection`), the group restarts from the first stage with accumulated feedback. The `group_feedback` context carries rejection reasons from previous iterations, so each retry is informed by what went wrong before.

Groups enable creation-critique-revision workflows without manual intervention. The code generation stage writes code, the QA stage reviews it, and if QA rejects, code generation runs again with QA's feedback. Up to `max_iterations` times.

---

## Context propagation

Each stage declares exactly what context it receives:

```yaml
context:
  include:
    - input                    # Original pipeline input
    - previous_stage_output    # Output from the preceding stage
    - all_stage_outputs        # Outputs from all preceding stages
    - group_feedback           # Accumulated rejection feedback
    - repo_files               # Files from the workspace
```

If `context` is not specified, the stage receives nothing. This is explicit by design, no implicit state leakage between stages.

---

## on_pipeline_start

Shell commands that run before any stage and inject dynamic context:

```yaml
on_pipeline_start:
  - command: "git status --short"
    inject_as: git_status
  - command: "git log --oneline -5"
    inject_as: recent_commits
```

The stdout of each command becomes available in every stage's context under the `inject_as` key. This is how pipelines get fresh state (git status, environment info, recent changes) without hardcoding it.

---

## Lifecycle hooks

Shell commands that run at deterministic points in the pipeline lifecycle:

| Hook | When | Available data |
|------|------|----------------|
| `on_stage_start` | Before stage executes | — |
| `on_stage_complete` | After stage succeeds | `{{output.field}}` |
| `pre_tool_use` | Before a specific tool call | `{{tool.argName}}` |
| `post_tool_use` | After a specific tool call | `{{tool.argName}}` |

Each hook has an `on_failure` behavior:
- **`warn`** (default): log and continue
- **`reject`**: stage becomes `rejected`, can trigger group retry
- **`fail`**: stage becomes `failed`, pipeline stops

```yaml
hooks:
  on_stage_complete:
    - command: "npx tsc --noEmit 2>&1 | head -20"
      on_failure: reject
  pre_tool_use:
    - matcher: repo_manager-write_file
      command: "echo 'Writing: {{tool.path}}'"
      on_failure: warn
```

Hooks are how you add static analysis, linting, or custom validation without writing TypeScript. The YAML is the configuration surface. The shell is the execution surface.

---

## Skills

Markdown files (`.skill.md`) in `.studio/skills/` that describe procedural context: conventions, architectural patterns, step-by-step guides.

```markdown
# commit-conventions.skill.md
Commit messages follow conventional commits format:
- feat: new feature
- fix: bug fix
- refactor: code refactoring
Always include the package scope: feat(engine): ...
```

Agents declare which skills they use:

```yaml
name: coder
skills:
  - commit-conventions
  - react-patterns
```

The skill content is auto-injected into the agent's system prompt. No code involved, just markdown that becomes context.

---

## Tool plugins

A `.tool.yaml` file that defines commands available to agents:

```yaml
name: nutrition
description: Nutritional analysis tools
version: 1

commands:
  - name: nutrition-analyze
    description: Analyze nutritional content of a recipe
    parameters:
      ingredients:
        type: array
        items: string
        required: true
    execute:
      type: shell
      command: |
        echo '{{ingredients | json}}' | nutrition-api --servings={{servings}}
      parse_output: json

prompt_snippet: |
  You have access to nutrition tools. Always verify nutritional content before finalizing.

constraints:
  requires_binaries: [nutrition-api]
```

**Self-documenting:** The `prompt_snippet` is auto-injected into the agent's system prompt. The tool explains itself to the agent.

**Double-gated:** The project authorizes which tool groups are available. The agent YAML authorizes which specific tools it can call. Two layers of access control.

Tools live in runner, not engine. The engine passes configs to the runner. The runner executes the tools. The engine never touches tool logic directly.

---

## PII anonymization

Transparent middleware that replaces sensitive data with tokens before sending to the LLM:

- Names → `[PERSON_1]`, `[PERSON_2]`
- Emails → `[EMAIL_1]`
- Financial data → `[AMOUNT_1]`

A local keymap stored in `.studio/runs/anonymization/<run-id>.keymap.json` lets you reconstruct the original values after the run.

Activated via `--anonymize` on `studio run`, or `anonymize: true` in agent YAML.

---

## State machine

```
pending → running → success
                  → failed
                  → rejected
                  → skipped
```

`deriveStageStatus(ralphResult)` in `engine/src/state/status-derivation.ts` maps RALPH results to stage status. ralph `success` → stage `success`. ralph `exhausted` → stage `failed`. Simple and deterministic.

---

## Domain-agnostic engine

The engine does not know what domain it operates in. There are no references to "code", "file", "git", or "QA" anywhere in the engine package. All domain semantics come from YAML configs.

This is an architectural commitment enforced as an invariant. If you find yourself writing `if (stage.kind === 'qa')` in the engine, you've made an error, that logic belongs in the contract.

---

## Provider-agnostic runner

The runner supports multiple LLM providers. Different agents in the same pipeline can use different providers and models.

```yaml
# .studio/config.yaml
providers:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
  openai:
    apiKey: ${OPENAI_API_KEY}

defaults:
  provider: anthropic
  model: claude-sonnet-4-20250514
```

Switch models without changing pipeline logic. The orchestration layer depends on the work being done correctly, not on who does it.

---

## Package boundaries

```
@studio-foundation/contracts    → Types, interfaces. Zero dependencies. Leaf package.
@studio-foundation/ralph        → Retry loop + validation. Depends only on contracts.
@studio-foundation/runner       → Tool plugin runtime, LLM providers. Depends only on contracts.
@studio-foundation/anonymizer   → PII middleware. Depends only on contracts.
@studio-foundation/engine       → Pipeline orchestration. Depends on ralph + runner + anonymizer + contracts.
@studio-foundation/api          → HTTP REST API. Depends on engine + contracts.
@studio-foundation/cli          → Terminal interface. Depends on engine + contracts.
```

**No inverse dependencies.** ralph does not know runner. runner does not know engine. If you find yourself importing "upward," it's an architecture error.

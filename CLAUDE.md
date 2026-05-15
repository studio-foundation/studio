# CLAUDE.md — Studio v7

Studio is a declarative YAML runtime for AI agents. It orchestrates multi-stage agent workflows with structured output validation and automatic retry. The engine is domain-agnostic — it knows nothing about code, files, or QA. All domain comes from YAML configs.

## Architecture — 7 packages, 1 monorepo

```
Studio/
├── contracts/    # @studio-foundation/contracts — shared types, interfaces (ZERO deps)
├── anonymizer/   # @studio-foundation/anonymizer — PII anonymization before LLM calls
├── ralph/        # @studio-foundation/ralph — retry loop + validation
├── runner/       # @studio-foundation/runner — tool plugin runtime, LLM providers
├── engine/       # @studio-foundation/engine — pipeline orchestration, state machine
├── api/          # @studio-foundation/api — HTTP REST API (Fastify)
├── cli/          # @studio-foundation/cli — terminal interface
└── templates/    # Architectural templates (see TEMPLATES.md)
```

```
@studio-foundation/cli → @studio-foundation/api → @studio-foundation/engine
                                 ├── @studio-foundation/ralph
                                 ├── @studio-foundation/runner
                                 └── @studio-foundation/anonymizer
                             @studio-foundation/contracts (leaf — zero internal deps)
```

**Strict dependencies:** contracts is a leaf package. ralph, runner and anonymizer depend ONLY on contracts. engine depends on ralph + runner + anonymizer + contracts. cli and api depend on engine + contracts.

**No inverted dependencies.** ralph doesn't know runner. runner doesn't know engine. If you find yourself importing "upward", it's an architecture error.

**pnpm workspaces:** Internal deps use `workspace:*`. Single `pnpm install` at root, single `pnpm build`.

## Key Concepts

**Pipeline** — Sequence of stages defined in YAML. The engine loads and executes it.

**Stage** — A step in a pipeline. Each stage has an agent, an output contract, and RALPH settings. The engine doesn't know the "kind" of a stage — it's a free string.

**RALPH loop** — Execute → validate against contract → retry with enriched feedback if fail → repeat until success or max attempts. "Recursive Automated Loop for Persistent Handling."

**Output contract** — JSON schema + constraints defining what a stage MUST produce. Validation is binary: pass or fail.

**Anti-theatre** — If a contract requires `tool_calls.minimum: 1` and the agent made 0 tool calls, it fails regardless of what the agent claims in its output. Real tool calls are tracked by the runner.

**Post-validation rejection** — The engine can detect that a stage responded correctly (format OK) but the verdict is negative (e.g., QA rejects). Status = `rejected`, not `failed`. Configured via contract YAML, not hardcoded.

**Groups** — Multi-stage feedback loops. A group contains stages that execute in iterations. If the last stage rejects (via `post_validation.rejection_detection`), the group restarts from the beginning with accumulated feedback. Max iterations configured via `max_iterations`.

**Context propagation** — Each stage configures exactly what context it receives via `context.include: [...]`. Options: `input`, `previous_stage_output`, `all_stage_outputs`, `group_feedback`, `repo_files`.

**on_pipeline_start** — Shell commands executed at pipeline startup before any stage. Their stdout is injected into stage context.

**Lifecycle hooks** — Configurable shell commands in YAML that execute at deterministic lifecycle points: `on_stage_start`, `on_stage_complete`, `pre_tool_use`, `post_tool_use`. Each has `on_failure`: `warn` (default), `reject`, or `fail`.

**Skills (.skill.md)** — Markdown files in `.studio/skills/` describing procedural context. Auto-injected into agent system prompts via `skills: [name]` in agent YAML.

**Project Invariants (.studio/invariants.md)** — Optional markdown file documenting project domain invariants. Auto-injected into every agent's system prompt at runtime.

**PII Anonymization** — Transparent middleware replacing sensitive data with tokens before LLM calls. Enabled via `--anonymize` or `anonymize: true` in agent YAML.

**Tool plugin** — A `.tool.yaml` file defining commands available to agents. Creating a tool = just YAML, no code.

## State Machine

```
pending → running → success
                  → failed
                  → rejected
                  → skipped
```

`deriveStageStatus(ralphResult)` in `engine/src/state/status-derivation.ts` is the critical function.

## Non-Negotiable Rules

> Formal list: **[INVARIANTS.md](INVARIANTS.md)**

1. **The engine is domain-agnostic.** No reference to "code", "file", "git", "QA" in the engine.
2. **ralph doesn't know runner.** ralph takes a generic `executor: () => Promise<T>`.
3. **runner doesn't validate or retry.** It executes and returns an AgentRun.
4. **contracts is a leaf package.** Zero internal dependencies.
5. **Tools live in runner, not engine.** The engine passes configs to runner.
6. **Prompts live in runner.** `prompt-builder.ts` assembles system prompt + context.

## Tools

Tools are YAML plugins (`.tool.yaml`). The runner is a tool plugin runtime.

**Builtins:**

| Tool | Description |
|------|-------------|
| `repo_manager-read_file` | Read a workspace file |
| `repo_manager-write_file` | Write/create a file |
| `repo_manager-list_files` | List files |
| `shell-run_command` | Execute a shell command |
| `search-search_codebase` | Search code |
| `patch-apply_patch` | Apply a unified diff |
| `git-checkout` | Checkout or create a branch |
| `git-commit` | Create a commit |
| `git-push` | Push to remote |
| `git-pull` | Pull from remote |
| `git-status` | Show working tree status |
| `git-diff` | Show diffs |
| `studio_run` | Spawn a sub-pipeline |

**Tool name format:** Dashes (`-`), not dots (`.`). Example: `repo_manager-write_file`.

## YAML Configs — Source of Truth

**Pipelines:** `pipelines/*.pipeline.yaml`
**Contracts:** `contracts/*.contract.yaml`
**Agents:** `agents/*.agent.yaml`
**Tools:** `tools/*.tool.yaml`
**Inputs:** `inputs/*.input.yaml`

**Never hardcode in code what can be in YAML.**

## Contract Examples

### Simple (brief-analysis)

```yaml
name: brief-analysis
version: 1
schema:
  required_fields:
    - summary
    - requirements
    - acceptance_criteria
```

### With Anti-theatre (code-generation)

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
    - repo_manager.write_file    # Dot format in contract YAML
```

**Note:** Contract YAML uses dot format (`repo_manager.write_file`), runtime uses dash format (`repo_manager-write_file`). The engine transforms.

### With Rejection Detection (qa-review)

```yaml
post_validation:
  rejection_detection:
    field: status
    approved_values: [approved, approved_with_notes, success]
    rejected_values: [rejected, failed, implementation_incomplete]
    details_field: issues
    summary_field: summary
```

## Events System

| Event | When | Data |
|-------|------|------|
| `onPipelineStart` | Pipeline starts | `pipeline_name`, `run_id` |
| `onPipelineComplete` | Pipeline ends | `status`, `duration_ms`, `total_tokens`, `total_tool_calls` |
| `onStageStart` | Stage starts | `stage_name`, `stage_index`, `total_stages` |
| `onStageComplete` | Stage ends | `status`, `attempts`, `duration_ms`, `output`, `tool_calls`, `token_usage` |
| `onTaskRetry` | Stage retries | `stage`, `attempt`, `failures` |
| `onGroupStart` | Group starts | `group_name`, `max_iterations` |
| `onGroupIteration` | Group iterates | `iteration`, `max_iterations` |
| `onGroupFeedback` | Group rejects | `rejection_reason`, `rejection_details` |
| `onGroupComplete` | Group ends | `iterations`, `status` |
| `onToolCallStart` | Tool call starts | `tool`, `params` |
| `onToolCallComplete` | Tool call ends | `tool`, `result`, `error` |
| `onAgentThinking` | Agent thinking (streaming) | `stage`, `text` |
| `onAgentToken` | Token streamed | `stage`, `token` |

## Hook Format

```yaml
stages:
  - name: code-generation
    agent: coder
    contract: code-generation
    hooks:
      on_stage_complete:
        - command: "npx tsc --noEmit 2>&1 | head -20"
          on_failure: reject
      pre_tool_use:
        - matcher: repo_manager-write_file
          command: "echo 'Writing: {{tool.path}}'"
          on_failure: warn
```

**Substitutions:** `{{output.field}}` (in on_stage_complete), `{{tool.argName}}` (in pre/post_tool_use).

## Debugging

```bash
DEBUG=studio:* studio run feature-builder --input "..."   # Detailed events
studio run feature-builder --input "..." --live           # Real-time tool calls
studio run feature-builder --provider mock                 # No API keys needed
studio validate software/code-generation output.json       # Validate without LLM
```

---

**See also:**
- **[CONCEPTS.md](CONCEPTS.md)** — Core concepts explained
- **[CLI.md](CLI.md)** — CLI reference
- **[API.md](API.md)** — REST API reference
- **[TEMPLATES.md](TEMPLATES.md)** — Architectural templates
- **[INVARIANTS.md](INVARIANTS.md)** — Non-negotiable kernel rules
- **[PHILOSOPHY.md](PHILOSOPHY.md)** — Design principles

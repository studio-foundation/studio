# Design: Skills.md — Procedural Context Injected into Agents (STU-92)

## Overview

Support `.skill.md` files in `.studio/skills/` — markdown documents describing procedural context (conventions, workflows, patterns) that are injected into agent system prompts. Agents opt-in per skill via `skills: [...]` in their YAML config.

**Linear issue:** STU-92
**Scope:** `contracts`, `engine`, `cli/templates`

---

## Architecture

### Directory Structure

```
.studio/
└── skills/
    ├── git-workflow.skill.md
    └── react-conventions.skill.md
```

### Components

| File | Change |
|------|--------|
| `contracts/src/agent.ts` | Add `skills?: string[]` to `AgentConfig` |
| `engine/src/pipeline/skill-loader.ts` | New file: loads `.skill.md` files by name |
| `engine/src/engine.ts` | Inject skills into `system_prompt` in `executeStage` |
| `cli/templates/projects/software-full/skills/` | Add `git-workflow.skill.md` + `code-conventions.skill.md` |
| `cli/templates/projects/software-full/agents/coder.agent.yaml` | Add `skills: [git-workflow, code-conventions]` |

---

## Data Flow

```
.studio/skills/git-workflow.skill.md
         ↓
loadSkillFiles(['git-workflow'], join(configsDir, 'skills'))
         ↓
AgentConfig.system_prompt += "\n\n## Skill: git-workflow\n\n<content>"
         ↓
buildPrompt() → LLM receives procedural context
```

### Injection Format

```
## Skill: git-workflow

<content of git-workflow.skill.md>
```

Multiple skills are separated by `\n\n---\n\n` (consistent with plugin skills).

---

## Agent YAML

```yaml
name: coder
provider: anthropic
model: claude-sonnet-4-6
tools:
  - repo_manager-write_file
  - repo_manager-read_file
skills:
  - git-workflow
  - code-conventions
system_prompt: |
  You are an expert software developer...
```

---

## skill-loader.ts API

```typescript
export async function loadSkillFiles(
  names: string[],
  skillsDir: string
): Promise<{ name: string; content: string }[]>
```

- Reads `<skillsDir>/<name>.skill.md` for each name
- Missing skill file → `console.warn` + skip (non-fatal)
- Returns only found skills

---

## Error Handling

- Missing skill file: `console.warn` + skip silently. Stage still runs without that skill.
- Empty `skills: []`: no-op, no injection.
- `skillsDir` doesn't exist: return empty array.

---

## Testing

- `engine/src/pipeline/skill-loader.test.ts` — unit tests:
  - loads existing skill files
  - skips missing files (with warn)
  - returns empty array if dir missing
- `engine/src/engine.ts` injection: covered via existing engine integration tests (mock agent with `skills`)

---

## Acceptance Criteria (from STU-92)

- [x] A `.skill.md` in `.studio/skills/` is loaded and injected into system prompt
- [x] Agents specify `skills: [git-workflow]` in their config
- [x] Code Builder (`software-full` template) ships with `git-workflow` and `code-conventions` skills

---

## What This Is NOT

- Not a plugin (no MCP server, no tool registration)
- Not a replacement for `tool.prompt_snippet` (tools document themselves; skills document workflows)
- Not the placeholder `runner/src/tools/skills/skill-loader.ts` (that's for future tool-providing skills)

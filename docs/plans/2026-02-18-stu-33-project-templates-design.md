# Project Templates / Starters (STU-33) — Design

## Goal

Ship 4 built-in project templates (blank, software, content, document-analysis) that users can install via `studio init --template <name>`. Add `studio templates list` to discover them. Templates are simplified (single-stage pipeline) to validate the kernel before adding feedback loops in Phase 2.

## Decisions

| Question | Decision |
|----------|----------|
| Template storage | Plain directories in `cli/templates/projects/` |
| `templates list` command | New top-level `studio templates <action>` command |
| Template complexity | Simplified — 1 pipeline, 1 agent, 1 contract per template |
| metadata.json | Included in every template |
| Tool plugin format | Full STU-30 `.tool.yaml` format (already merged) |

## Directory Structure

```
cli/templates/
├── studio-config.yaml          (existing)
├── projects/                   (NEW)
│   ├── blank/
│   │   └── metadata.json
│   ├── software/
│   │   ├── metadata.json
│   │   └── project/
│   │       ├── pipelines/feature-builder.pipeline.yaml
│   │       ├── agents/coder.agent.yaml
│   │       ├── contracts/code-output.contract.yaml
│   │       ├── tools/repo-manager.tool.yaml
│   │       ├── tools/search.tool.yaml
│   │       ├── tools/shell.tool.yaml
│   │       └── inputs/example.input.yaml
│   ├── content/
│   │   ├── metadata.json
│   │   └── project/
│   │       ├── pipelines/content-creator.pipeline.yaml
│   │       ├── agents/writer.agent.yaml
│   │       ├── contracts/content-output.contract.yaml
│   │       ├── tools/search.tool.yaml
│   │       └── inputs/example.input.yaml
│   └── document-analysis/
│       ├── metadata.json
│       └── project/
│           ├── pipelines/analyzer.pipeline.yaml
│           ├── agents/analyst.agent.yaml
│           ├── contracts/analysis-output.contract.yaml
│           ├── tools/search.tool.yaml
│           └── inputs/example.input.yaml
```

The existing `cli/templates/pipelines/hello-world.pipeline.yaml` is removed (superseded by templates).

## metadata.json Shape

```json
{
  "name": "software",
  "version": "1.0.0",
  "description": "Code generation with repo, shell and search tools",
  "author": "studio-core",
  "tags": ["software", "code", "development"],
  "type": "template",
  "studio_version": ">=7.0.0",
  "pipelines": ["feature-builder"],
  "tools_included": ["repo-manager", "search", "shell"]
}
```

`blank` has only `name`, `version`, `description`, `type`.

## Template Content (simplified)

### software

**Pipeline** (`feature-builder.pipeline.yaml`): single stage `code-generation`, agent `coder`, 3 max attempts, context includes `input`.

**Agent** (`coder.agent.yaml`): anthropic/claude-sonnet-4-6, tools: read_file, write_file, list_files, run_command, search_codebase. System prompt: expert software developer, read files before writing.

**Contract** (`code-output.contract.yaml`): required fields `summary` + `files_changed`, `tool_calls.minimum: 1`.

**Input example**: `brief_summary` + `target_file`.

### content

**Pipeline** (`content-creator.pipeline.yaml`): single stage `content-generation`, agent `writer`.

**Agent** (`writer.agent.yaml`): anthropic/claude-sonnet-4-6, tools: search_codebase only.

**Contract** (`content-output.contract.yaml`): required fields `title` + `content` + `summary`.

**Input example**: `topic` + `format` + `tone`.

### document-analysis

**Pipeline** (`analyzer.pipeline.yaml`): single stage `analysis`, agent `analyst`.

**Agent** (`analyst.agent.yaml`): anthropic/claude-sonnet-4-6, tools: search_codebase only.

**Contract** (`analysis-output.contract.yaml`): required fields `summary` + `key_findings` + `recommendations`.

**Input example**: `document_path` + `analysis_goal`.

## CLI Changes

### `studio init` — updated behavior

```
studio init                         → blank structure, project = 'default' (no change)
studio init --template blank        → blank structure, project = 'blank'
studio init --template software     → copies template project/, project = 'software'
studio init --template software --project my-app  → copies template, project = 'my-app'
```

`createStudioStructure` gains a `templateName` parameter. If the template has a `project/` subdir, it's recursively copied instead of creating empty dirs. Config.yaml, registry.lock.json, runs/logs/, and .gitignore updates are unchanged.

Error when template not found:
```
Template 'xyz' not found. Run 'studio templates list' to see available templates.
```

### `studio templates list` — new command

New file: `cli/src/commands/templates.ts`

Registered in `index.ts`:
```typescript
program
  .command('templates <action> [args...]')
  .description('Manage Studio templates (list)')
  .action(templatesCommand);
```

Output of `studio templates list`:
```
Available templates:

  blank              Empty project structure
  software           Code generation with repo, shell and search tools
  content            Content creation and editing with search
  document-analysis  Document extraction and structured analysis

Run: studio init --template <name>
```

## Files Changed

| File | Action |
|------|--------|
| `cli/templates/projects/blank/metadata.json` | Create |
| `cli/templates/projects/software/metadata.json` | Create |
| `cli/templates/projects/software/project/**` | Create (5 subdirs + files) |
| `cli/templates/projects/content/metadata.json` | Create |
| `cli/templates/projects/content/project/**` | Create |
| `cli/templates/projects/document-analysis/metadata.json` | Create |
| `cli/templates/projects/document-analysis/project/**` | Create |
| `cli/templates/pipelines/hello-world.pipeline.yaml` | Delete |
| `cli/src/commands/init.ts` | Modify — add template copy logic |
| `cli/src/commands/templates.ts` | Create |
| `cli/src/index.ts` | Modify — register `templates` command |

## Testing

- Unit tests for `createStudioStructure` with a template that has a `project/` subdir
- Unit test for `templatesCommand('list', [])` — verifies it reads metadata.json and prints table
- No new packages, no new dependencies (uses `fs/promises` already imported in init.ts)

## Acceptance Criteria

- [ ] 4 templates created (blank, software, content, document-analysis)
- [ ] `studio init --template <name>` copies template and creates a functional project
- [ ] `studio templates list` shows available templates with descriptions
- [ ] Each template has an example input and works out of the box
- [ ] Templates include appropriate `.tool.yaml` files
- [ ] `metadata.json` present and standardized for each template

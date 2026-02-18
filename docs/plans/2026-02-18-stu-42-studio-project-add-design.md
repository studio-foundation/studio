# STU-42: `studio project add` wizard — Design

## Goal

Add `studio project add` to create a new project in an existing Studio workspace. This is the companion command to `studio init`: init creates the workspace, `project add` adds projects to it.

## CLI Interface

### Command registration (`index.ts`)

```typescript
program
  .command('project <action> [args...]')
  .description('Manage Studio projects (add)')
  .option('--template <name>', 'Template to use (blank, software, …)')
  .option('--description <desc>', 'Project description')
  .action(projectCommand);
```

Follows the existing `tools`/`config`/`templates`/`list` pattern — `<noun> <action> [args...]` — extensible for future `project list`, `project remove`.

### Invocation modes

**Wizard mode** (no name argument):
```bash
studio project add
```

**Direct mode** (name provided):
```bash
studio project add legal-analyzer --template blank --description "Analyze legal contracts"
```

## Architecture

### New file: `cli/src/commands/project.ts`

Exports:
- `createProjectDir(projectsDir, projectName, templateName?)` — core project creation logic
- `projectAddDirect(studioDir, name, template?, description?)` — non-interactive path
- `projectAddWizard(studioDir)` — interactive path
- `projectCommand(action, args, options)` — CLI dispatcher

### Refactor: `cli/src/commands/init.ts`

Extract project dir creation from `createStudioStructure` to call `createProjectDir` from `project.ts`. `createStudioStructure` continues to orchestrate workspace creation (runs/, registry.lock.json, config.yaml, .gitignore) and delegates project dir creation to `createProjectDir`.

**Dependency direction:** `init.ts` imports from `project.ts`. `project.ts` imports from `templates.ts` (for `listTemplates`). No circular deps.

## Component Design

### `createProjectDir(projectsDir, projectName, templateName?)`

```
projectsDir  = .studio/projects/   (already exists)
projectName  = 'legal-analyzer'
templateName = 'blank' | 'software' | ... | undefined
```

Behavior:
1. Throws if `<projectsDir>/<projectName>` already exists — "Project '<name>' already exists"
2. If `templateName` provided: verifies template exists in `cli/templates/projects/<t>/`, copies `project/` subdir into `<projectsDir>/<projectName>/`
3. If no template: creates empty `pipelines/`, `agents/`, `contracts/`, `tools/`, `inputs/`

### `projectAddWizard(studioDir)`

Interactive steps:
1. Ask project name — validates: `/^[a-z0-9][a-z0-9-]*$|^[a-z0-9]$/`
2. Ask description — optional, not persisted
3. Ask template — list from `listTemplates()`, blank listed first
4. Call `createProjectDir`
5. Print success + next steps

### `projectAddDirect(studioDir, name, template?, description?)`

Non-interactive:
1. Validate name format — throw on invalid
2. Resolve template: defaults to `'blank'` if not provided
3. Call `createProjectDir`
4. Print success + next steps

### `projectCommand(action, args, options)`

Dispatcher:
- Finds `.studio/` with `findStudioDir()` — exits with friendly error if not found
- action `'add'`:
  - If `args[0]` provided → direct mode
  - Otherwise → wizard mode
- Other actions: "Unknown project action: <x>. Available: add"

## UX

### Wizard mode

```
$ studio project add

? Project name: legal-analyzer
? Description (optional): Analyze legal contracts and flag risks

Choose a template:
  ❯ ○ blank — Empty project structure
    ○ software — Software development pipeline
    ○ content — Content creation pipeline
    ○ document-analysis — Document analysis pipeline

Creating project...
  ✓ .studio/projects/legal-analyzer/pipelines/
  ✓ .studio/projects/legal-analyzer/agents/
  ✓ .studio/projects/legal-analyzer/contracts/
  ✓ .studio/projects/legal-analyzer/tools/
  ✓ .studio/projects/legal-analyzer/inputs/

Done! Run your first pipeline:
  studio run legal-analyzer/your-pipeline --input "..."
```

### Direct mode

```
$ studio project add legal-analyzer --template blank

  ✓ .studio/projects/legal-analyzer/pipelines/
  ...

Done! Run your first pipeline:
  studio run legal-analyzer/your-pipeline --input "..."
```

## Error Cases

| Condition | Message |
|-----------|---------|
| `.studio/` not found | "Studio is not initialized in this directory.\nRun: studio init" |
| Project already exists | "Project 'legal-analyzer' already exists in .studio/projects/" |
| Invalid template | "Template 'xyz' not found. Run 'studio templates list' to see available templates." |
| Invalid name | "Project name must be lowercase alphanumeric with hyphens (e.g. my-project)" |
| Ctrl+C in wizard | "Aborted." (exit 0) |

## Project Name Validation

Regex: `/^[a-z0-9][a-z0-9-]*$|^[a-z0-9]$/`

- Lowercase alphanumeric + hyphens
- Cannot start or end with hyphen
- Single character allowed (e.g. `x`)
- Examples valid: `legal-analyzer`, `software`, `my-project-v2`
- Examples invalid: `-legal`, `legal-`, `Legal`, `my project`, `legal_analyzer`

## Files Touched

| File | Change |
|------|--------|
| `cli/src/commands/project.ts` | New file |
| `cli/src/commands/init.ts` | Extract project dir creation, import from project.ts |
| `cli/src/index.ts` | Register `project` command |
| `cli/tests/commands/project.test.ts` | New test file |

## Testing Strategy

TDD approach — tests before implementation for each exported function.

**`createProjectDir` tests:**
- Creates all 5 subdirs when no template
- Copies template files when template provided
- Throws "already exists" when project dir exists
- Throws "not found" when template is invalid

**`projectAddDirect` tests:**
- Creates project successfully with valid inputs
- Throws on invalid project name format
- Defaults to blank template when no template given

**Name validation tests:**
- Valid: `legal-analyzer`, `software`, `x`, `my-project-v2`
- Invalid: `-foo`, `foo-`, `Foo`, `foo bar`, `foo_bar`

## Dependencies

- STU-33 (templates) — templates already exist in `cli/templates/projects/`
- STU-38 (Phase 1) — `findStudioDir`, `createStudioStructure` already implemented

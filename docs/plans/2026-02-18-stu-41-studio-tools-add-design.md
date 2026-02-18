# STU-41: `studio tools add` wizard — Design

## Goal

Add wizard mode to `studio tools add` so users can interactively select and install tools from a checkbox menu. Also support multi-tool direct mode (`studio tools add git shell --project software`) and skip-if-installed behavior.

## CLI Interface

### Invocation modes

**Wizard mode** (no tool names provided):
```bash
studio tools add
```

**Direct mode** (tool names as positional args):
```bash
studio tools add git repo-manager --project software
```

No changes needed in `index.ts` — the existing registration passes `args` and `options` correctly.

### Dispatch logic

In the existing `'add'` case of `toolsCommand`:

```
if args.length === 0 → wizard mode
else                 → direct mode (args = tool names)
```

**Project resolution:**
- Direct mode: uses existing `resolveProjectToolsDir` — auto-selects if 1 project, errors if multiple and `--project` not specified
- Wizard mode: inline logic — auto-selects if 1 project, `select` prompt if multiple, errors if none

## Component Design

### New helpers in `cli/src/commands/tools.ts`

**`listAvailableTools(): Promise<{ name: string; description: string }[]>`**
- Reads `cli/templates/tools/*.tool.yaml`
- Parses `name` and `description` from each using `js-yaml`
- Returns sorted by name

**`toolsAddDirect(studioDir: string, project: string, toolNames: string[]): Promise<{ installed: string[]; skipped: string[] }>`**
- Creates tools dir if missing (`mkdir` recursive)
- For each tool name: checks template exists (throws if not), checks if already installed (`access` check → skip), copies to dest
- Returns `{ installed, skipped }` lists

### Modified in `cli/src/commands/tools.ts`

`'add'` case in `toolsCommand`:
- Empty `args` → wizard flow (inline):
  1. Discover projects in `.studio/projects/`
  2. If 0 projects → error "No projects found. Run 'studio project add' first."
  3. If 1 project → auto-select
  4. If >1 projects → `select` prompt
  5. `checkbox` prompt from `listAvailableTools()`
  6. If none selected → "No tools selected."
  7. Call `toolsAddDirect`, print results
- Non-empty `args` → direct flow: call `resolveProjectToolsDir` + `toolsAddDirect`

**No changes** to `list`, `remove`, `info` cases, `listTools`, `getToolsDir`, or `resolveProjectToolsDir`.

## UX

### Wizard mode

```
$ studio tools add

? Which project?
  ❯ software
    cuisine

? Select tools to install:
  ◉ git — Git version control operations
  ◯ repo-manager — Read and write files in the workspace
  ◉ shell — Execute shell commands in the workspace
  ◯ search — Search the codebase by content or file pattern

Installing tools...
  ✓ git.tool.yaml
  ✓ shell.tool.yaml

Done! 2 tools installed in 'software'.
```

Project selection is skipped (auto-selected) if only one project exists.

### Skip-if-installed

```
  ✓ git.tool.yaml
  ⚠ repo-manager already installed, skipping
```

### No tools selected

```
No tools selected.
```

### Direct mode

```
$ studio tools add git shell --project software
  ✓ git.tool.yaml
  ✓ shell.tool.yaml

Done! 2 tools installed in 'software'.
```

## Error Cases

| Condition | Message |
|-----------|---------|
| No `.studio/` found | Handled by existing `loadConfig` in `resolveProjectToolsDir` |
| No projects exist (wizard) | `"No projects found. Run 'studio project add' first."` |
| Unknown tool in direct mode | `"Unknown tool 'foo'. Available: git, repo-manager, search, shell"` |
| Ctrl+C in wizard | `"Aborted."` (exit 0) |

## Testing Strategy

Extend `cli/tests/commands/tools.test.ts`.

**`listAvailableTools` tests:**
- Returns all 4 tools (git, repo-manager, search, shell)
- Each entry has `name` and `description` fields
- Results are sorted by name

**`toolsAddDirect` tests** (using `/tmp` dir):
- Installs a single valid tool — file exists at destination
- Installs multiple tools in one call
- Skips already-installed tool, returns it in `skipped` list
- Throws on unknown tool name (message contains "Unknown tool")
- Creates tools dir if it doesn't exist

**Not tested** (interactive): wizard flow — `@inquirer/prompts` is not mockable without significant scaffolding.

## Files Touched

| File | Change |
|------|--------|
| `cli/src/commands/tools.ts` | Add `listAvailableTools`, `toolsAddDirect`, wizard flow in `'add'` case |
| `cli/tests/commands/tools.test.ts` | Add tests for new exported functions |

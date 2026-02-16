# Design: `apply_patch` Tool for Studio Runner

**Date:** 2026-02-16
**Status:** Approved

## Problem

The coder agent uses `write_file` for all file modifications — rewriting entire files even for small changes. This is expensive in tokens, fragile (risk of losing content), and hard to validate structurally.

## Solution

Add a new builtin tool `repo_manager-apply_patch` that accepts a unified diff and applies it to a file. Smaller output, structurally verifiable, fails loudly if context doesn't match.

## Scope — 4 Areas of Change

### 1. Tool Implementation (`runner/src/tools/builtin/patch.ts`)

Factory: `createPatchTools(repoPath: string): Tool[]` — returns one tool.

**Tool name:** `repo_manager-apply_patch` in code, `repo_manager.apply_patch` in YAML configs.

**Parameters:** `path` (relative file path) + `patch` (unified diff string).

**Patch engine algorithm:**
- Parse `@@` hunks, ignore optional `---`/`+++` headers
- For each hunk: try matching at the hinted line number first, then scan the full file
- Match context lines with trailing whitespace tolerance (`trimEnd()`)
- Exactly 1 match = apply; 0 matches = context mismatch error; 2+ matches = ambiguous error
- Apply hunks in reverse order (bottom-up) so line offsets don't cascade

**Returns:** `PatchResult { success, path, hunks_applied, hunks_total, lines_added, lines_removed, error? }`

**Error cases:**
- File not found → `File not found: ${path}`
- Context mismatch → `Context mismatch at hunk ${n}: expected "${expected}" but found "${actual}" at line ${line}`
- Ambiguous match → `Ambiguous match: context found at lines ${lines}. Add more context lines.`
- Malformed patch → `Invalid patch format: ${details}`

### 2. Registration

- `runner/src/index.ts` — export `createPatchTools`
- `cli/src/commands/run.ts` — import and register in tool registry

### 3. Engine: `counted_tools` Validation

New contract field `counted_tools` — tools that count toward the `minimum` threshold (OR semantics). Different from `required_tools` (AND semantics — all must be called).

```yaml
tool_calls:
  minimum: 1
  counted_tools:
    - repo_manager.write_file
    - repo_manager.apply_patch
```

Requires a targeted change in the engine's contract validation logic.

### 4. YAML Config Updates

- `coder.agent.yaml` — add `repo_manager.apply_patch` to tools list + system prompt instruction to prefer `apply_patch` over `write_file` for modifications
- `code-generation.contract.yaml` — replace `required_tools` with `counted_tools`

## Tests

Unit tests in `runner/tests/apply-patch.test.ts` (vitest, temp directories):

1. Simple single-hunk patch
2. Multi-hunk patch
3. Addition-only hunk
4. Deletion-only hunk
5. Context mismatch error
6. File not found error
7. Trailing whitespace tolerance
8. Offset matching (wrong line number, correct content)
9. Ambiguous match error

## Out of Scope

- `write_file` unchanged
- No ralph or runner core changes
- No CLAUDE.md dot/hyphen discrepancy fix
- No cuisine project changes

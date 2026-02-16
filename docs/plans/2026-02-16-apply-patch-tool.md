# apply_patch Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `repo_manager-apply_patch` builtin tool that applies unified diffs to files, plus `counted_tools` validation support in the engine.

**Architecture:** New builtin tool in runner following the factory pattern. Patch engine parses unified diffs, matches context by content (not line numbers), applies hunks bottom-up. Engine gets a new `counted_tools` contract field (OR semantics vs `required_tools` AND semantics).

**Tech Stack:** TypeScript, vitest, YAML configs

---

### Task 1: Create patch parser and applicator (`runner/src/tools/builtin/patch.ts`)

**Files:**
- Create: `runner/src/tools/builtin/patch.ts`
- Test: `runner/tests/apply-patch.test.ts`

**Step 1: Write the failing test for single-hunk patch**

Create `runner/tests/apply-patch.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createPatchTools } from '../src/tools/builtin/patch.js';
import type { Tool } from '../src/tools/tool-registry.js';

describe('apply_patch tool', () => {
  let tmpDir: string;
  let tool: Tool;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-test-'));
    const tools = createPatchTools(tmpDir);
    tool = tools[0];
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('applies a simple single-hunk patch', async () => {
    await fs.writeFile(path.join(tmpDir, 'test.txt'), [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
    ].join('\n'));

    const patch = [
      '@@ -1,5 +1,5 @@',
      ' line 1',
      ' line 2',
      '-line 3',
      '+line 3 modified',
      ' line 4',
      ' line 5',
    ].join('\n');

    const result = await tool.execute({ path: 'test.txt', patch });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      hunks_applied: 1,
      hunks_total: 1,
      lines_added: 1,
      lines_removed: 1,
    });

    const content = await fs.readFile(path.join(tmpDir, 'test.txt'), 'utf-8');
    expect(content).toBe([
      'line 1',
      'line 2',
      'line 3 modified',
      'line 4',
      'line 5',
    ].join('\n'));
  });

  it('applies a multi-hunk patch', async () => {
    await fs.writeFile(path.join(tmpDir, 'multi.txt'), [
      'aaa', 'bbb', 'ccc', 'ddd', 'eee',
      'fff', 'ggg', 'hhh', 'iii', 'jjj',
    ].join('\n'));

    const patch = [
      '@@ -1,5 +1,5 @@',
      ' aaa',
      '-bbb',
      '+bbb modified',
      ' ccc',
      ' ddd',
      ' eee',
      '@@ -6,5 +6,5 @@',
      ' fff',
      '-ggg',
      '+ggg modified',
      ' hhh',
      ' iii',
      ' jjj',
    ].join('\n');

    const result = await tool.execute({ path: 'multi.txt', patch });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      hunks_applied: 2,
      hunks_total: 2,
    });

    const content = await fs.readFile(path.join(tmpDir, 'multi.txt'), 'utf-8');
    expect(content).toContain('bbb modified');
    expect(content).toContain('ggg modified');
  });

  it('applies an addition-only hunk', async () => {
    await fs.writeFile(path.join(tmpDir, 'add.txt'), [
      'line 1',
      'line 2',
      'line 3',
    ].join('\n'));

    const patch = [
      '@@ -1,3 +1,5 @@',
      ' line 1',
      '+new line A',
      '+new line B',
      ' line 2',
      ' line 3',
    ].join('\n');

    const result = await tool.execute({ path: 'add.txt', patch });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      lines_added: 2,
      lines_removed: 0,
    });

    const content = await fs.readFile(path.join(tmpDir, 'add.txt'), 'utf-8');
    expect(content).toBe([
      'line 1',
      'new line A',
      'new line B',
      'line 2',
      'line 3',
    ].join('\n'));
  });

  it('applies a deletion-only hunk', async () => {
    await fs.writeFile(path.join(tmpDir, 'del.txt'), [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
    ].join('\n'));

    const patch = [
      '@@ -1,4 +1,2 @@',
      ' line 1',
      '-line 2',
      '-line 3',
      ' line 4',
    ].join('\n');

    const result = await tool.execute({ path: 'del.txt', patch });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      lines_added: 0,
      lines_removed: 2,
    });

    const content = await fs.readFile(path.join(tmpDir, 'del.txt'), 'utf-8');
    expect(content).toBe(['line 1', 'line 4'].join('\n'));
  });

  it('returns error on context mismatch', async () => {
    await fs.writeFile(path.join(tmpDir, 'mismatch.txt'), [
      'actual line 1',
      'actual line 2',
      'actual line 3',
    ].join('\n'));

    const patch = [
      '@@ -1,3 +1,3 @@',
      ' wrong context',
      '-actual line 2',
      '+modified line 2',
      ' actual line 3',
    ].join('\n');

    const result = await tool.execute({ path: 'mismatch.txt', patch });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Context mismatch');
  });

  it('returns error on file not found', async () => {
    const patch = [
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');

    const result = await tool.execute({ path: 'nonexistent.txt', patch });

    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });

  it('tolerates trailing whitespace differences in context', async () => {
    await fs.writeFile(path.join(tmpDir, 'ws.txt'), [
      'line 1   ',
      'line 2',
      'line 3',
    ].join('\n'));

    const patch = [
      '@@ -1,3 +1,3 @@',
      ' line 1',
      '-line 2',
      '+line 2 modified',
      ' line 3',
    ].join('\n');

    const result = await tool.execute({ path: 'ws.txt', patch });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ hunks_applied: 1 });
  });

  it('matches by content when line number is wrong (offset matching)', async () => {
    await fs.writeFile(path.join(tmpDir, 'offset.txt'), [
      'header 1',
      'header 2',
      'header 3',
      'header 4',
      'header 5',
      'target line A',
      'target line B',
      'target line C',
    ].join('\n'));

    // Hunk says line 1 but content is at line 6
    const patch = [
      '@@ -1,3 +1,3 @@',
      ' target line A',
      '-target line B',
      '+target line B modified',
      ' target line C',
    ].join('\n');

    const result = await tool.execute({ path: 'offset.txt', patch });

    expect(result.success).toBe(true);
    const content = await fs.readFile(path.join(tmpDir, 'offset.txt'), 'utf-8');
    expect(content).toContain('target line B modified');
  });

  it('returns error on ambiguous match', async () => {
    await fs.writeFile(path.join(tmpDir, 'ambig.txt'), [
      'repeat',
      'target',
      'repeat',
      'repeat',
      'target',
      'repeat',
    ].join('\n'));

    const patch = [
      '@@ -1,3 +1,3 @@',
      ' repeat',
      '-target',
      '+target modified',
      ' repeat',
    ].join('\n');

    const result = await tool.execute({ path: 'ambig.txt', patch });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Ambiguous');
  });

  it('ignores --- and +++ headers from LLM output', async () => {
    await fs.writeFile(path.join(tmpDir, 'headers.txt'), [
      'line 1',
      'line 2',
      'line 3',
    ].join('\n'));

    const patch = [
      '--- a/headers.txt',
      '+++ b/headers.txt',
      '@@ -1,3 +1,3 @@',
      ' line 1',
      '-line 2',
      '+line 2 changed',
      ' line 3',
    ].join('\n');

    const result = await tool.execute({ path: 'headers.txt', patch });

    expect(result.success).toBe(true);
    const content = await fs.readFile(path.join(tmpDir, 'headers.txt'), 'utf-8');
    expect(content).toContain('line 2 changed');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd runner && npx vitest run tests/apply-patch.test.ts`
Expected: FAIL — cannot resolve `../src/tools/builtin/patch.js`

**Step 3: Write the patch tool implementation**

Create `runner/src/tools/builtin/patch.ts`:

```typescript
/**
 * Patch tool - apply unified diffs to files
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolResult } from '../tool-registry.js';

interface Hunk {
  oldStart: number;
  oldCount: number;
  contextLines: string[];   // Lines prefixed with ' ' (stripped)
  removedLines: string[];   // Lines prefixed with '-' (stripped)
  addedLines: string[];     // Lines prefixed with '+' (stripped)
  lines: HunkLine[];        // All lines in order
}

interface HunkLine {
  type: 'context' | 'add' | 'remove';
  content: string;
}

interface PatchResult {
  success: boolean;
  path: string;
  hunks_applied: number;
  hunks_total: number;
  lines_added: number;
  lines_removed: number;
  error?: string;
}

/**
 * Parse a unified diff string into hunks.
 */
function parseHunks(patch: string): Hunk[] {
  const rawLines = patch.split('\n');
  // Filter out --- / +++ headers and empty trailing lines
  const lines = rawLines.filter(
    (l) => !l.startsWith('---') && !l.startsWith('+++')
  );

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of lines) {
    const hunkHeader = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+\d+(?:,\d+)?\s*@@/);
    if (hunkHeader) {
      current = {
        oldStart: parseInt(hunkHeader[1], 10),
        oldCount: parseInt(hunkHeader[2] ?? '1', 10),
        contextLines: [],
        removedLines: [],
        addedLines: [],
        lines: [],
      };
      hunks.push(current);
      continue;
    }

    if (!current) continue;

    if (line.startsWith('+')) {
      const content = line.slice(1);
      current.addedLines.push(content);
      current.lines.push({ type: 'add', content });
    } else if (line.startsWith('-')) {
      const content = line.slice(1);
      current.removedLines.push(content);
      current.lines.push({ type: 'remove', content });
    } else if (line.startsWith(' ') || line === '') {
      // Context line — line starting with space, or empty line (which is context with empty content)
      const content = line.startsWith(' ') ? line.slice(1) : line;
      current.contextLines.push(content);
      current.lines.push({ type: 'context', content });
    }
    // Ignore lines that don't match any pattern (e.g. "\ No newline at end of file")
  }

  return hunks;
}

/**
 * Build the "old block" from a hunk — the sequence of context + removed lines
 * that must match in the original file.
 */
function getOldBlock(hunk: Hunk): string[] {
  return hunk.lines
    .filter((l) => l.type === 'context' || l.type === 'remove')
    .map((l) => l.content);
}

/**
 * Build the "new block" — context + added lines that replace the old block.
 */
function getNewBlock(hunk: Hunk): string[] {
  return hunk.lines
    .filter((l) => l.type === 'context' || l.type === 'add')
    .map((l) => l.content);
}

/**
 * Compare two strings with trailing whitespace tolerance.
 */
function fuzzyMatch(a: string, b: string): boolean {
  return a.trimEnd() === b.trimEnd();
}

/**
 * Check if oldBlock matches fileLines starting at position `start`.
 */
function blockMatchesAt(fileLines: string[], oldBlock: string[], start: number): boolean {
  if (start + oldBlock.length > fileLines.length) return false;
  return oldBlock.every((line, i) => fuzzyMatch(fileLines[start + i], line));
}

/**
 * Find where the old block matches in the file.
 * Returns the 0-based start index, or throws with a descriptive error.
 */
function findMatch(
  fileLines: string[],
  oldBlock: string[],
  hintLine: number,
  hunkIndex: number
): number {
  // Convert 1-based hint to 0-based
  const hint = hintLine - 1;

  // Fast path: try at the hinted position
  if (hint >= 0 && blockMatchesAt(fileLines, oldBlock, hint)) {
    // Verify uniqueness — check if it also matches elsewhere
    const otherMatches: number[] = [];
    for (let i = 0; i < fileLines.length; i++) {
      if (i !== hint && blockMatchesAt(fileLines, oldBlock, i)) {
        otherMatches.push(i);
      }
    }
    // Even if ambiguous, the hint breaks the tie
    return hint;
  }

  // Slow path: scan the whole file
  const matches: number[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    if (blockMatchesAt(fileLines, oldBlock, i)) {
      matches.push(i);
    }
  }

  if (matches.length === 1) return matches[0];

  if (matches.length === 0) {
    const expected = oldBlock[0] ?? '(empty)';
    throw new Error(
      `Context mismatch at hunk ${hunkIndex + 1}: could not find context "${expected}" in file`
    );
  }

  throw new Error(
    `Ambiguous match at hunk ${hunkIndex + 1}: context found at lines ${matches.map((m) => m + 1).join(', ')}. Add more context lines.`
  );
}

export function createPatchTools(repoPath: string): Tool[] {
  return [
    {
      name: 'repo_manager-apply_patch',
      description:
        'Apply a unified diff patch to a file. The patch must include enough context lines for unambiguous matching. Fails loudly if context doesn\'t match the file content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file to patch (from workspace root)',
          },
          patch: {
            type: 'string',
            description:
              'Unified diff format patch. Must start with @@ hunk headers. Use - for removed lines, + for added lines, space for context lines. Include at least 3 context lines before and after changes.',
          },
        },
        required: ['path', 'patch'],
      },
      execute: async ({ path: filePath, patch: patchStr }): Promise<ToolResult> => {
        try {
          const fullPath = path.join(repoPath, filePath as string);

          // Read file
          let fileContent: string;
          try {
            fileContent = await fs.readFile(fullPath, 'utf-8');
          } catch {
            return {
              success: false,
              output: null,
              error: `File not found: ${filePath}`,
            };
          }

          // Parse hunks
          const hunks = parseHunks(patchStr as string);
          if (hunks.length === 0) {
            return {
              success: false,
              output: null,
              error: 'Invalid patch format: no hunks found (expected @@ headers)',
            };
          }

          let fileLines = fileContent.split('\n');
          let totalAdded = 0;
          let totalRemoved = 0;

          // Find all match positions first (before any modifications)
          const matchPositions: number[] = [];
          for (let i = 0; i < hunks.length; i++) {
            const oldBlock = getOldBlock(hunks[i]);
            const pos = findMatch(fileLines, oldBlock, hunks[i].oldStart, i);
            matchPositions.push(pos);
          }

          // Apply hunks in reverse order to preserve line numbers
          const indices = hunks.map((_, i) => i);
          indices.sort((a, b) => matchPositions[b] - matchPositions[a]);

          for (const i of indices) {
            const hunk = hunks[i];
            const pos = matchPositions[i];
            const oldBlock = getOldBlock(hunk);
            const newBlock = getNewBlock(hunk);

            fileLines.splice(pos, oldBlock.length, ...newBlock);
            totalAdded += hunk.addedLines.length;
            totalRemoved += hunk.removedLines.length;
          }

          // Write file back
          await fs.writeFile(fullPath, fileLines.join('\n'), 'utf-8');

          const result: PatchResult = {
            success: true,
            path: filePath as string,
            hunks_applied: hunks.length,
            hunks_total: hunks.length,
            lines_added: totalAdded,
            lines_removed: totalRemoved,
          };

          return { success: true, output: result };
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            output: null,
            error: errorMessage,
          };
        }
      },
    },
  ];
}
```

**Step 4: Run tests to verify they pass**

Run: `cd runner && npx vitest run tests/apply-patch.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add runner/src/tools/builtin/patch.ts runner/tests/apply-patch.test.ts
git commit -m "feat(runner): add apply_patch builtin tool with tests"
```

---

### Task 2: Register the tool in runner exports + CLI

**Files:**
- Modify: `runner/src/index.ts:30-32`
- Modify: `cli/src/commands/run.ts:6,115-124`

**Step 1: Add export to runner/src/index.ts**

After line 32 (`export { createSearchTools }...`), add:

```typescript
export { createPatchTools } from './tools/builtin/patch.js';
```

**Step 2: Add registration to cli/src/commands/run.ts**

At line 6, add `createPatchTools` to the import:

```typescript
import { createDefaultRegistry, ToolRegistry, createRepoManagerTools, createShellTools, createSearchTools, createPatchTools } from '@studio/runner';
```

After line 124 (after the `createSearchTools` registration loop), add:

```typescript
for (const tool of createPatchTools(repoPath)) {
  toolRegistry.register(tool);
}
```

**Step 3: Build runner**

Run: `cd runner && npm run build`
Expected: Clean compilation, no errors.

**Step 4: Build CLI**

Run: `cd cli && npm run build`
Expected: Clean compilation, no errors.

**Step 5: Commit**

```bash
git add runner/src/index.ts cli/src/commands/run.ts
git commit -m "feat: register apply_patch tool in runner exports and CLI"
```

---

### Task 3: Add `counted_tools` to contracts + ralph + engine

**Files:**
- Modify: `contracts/src/validation.ts:10-13`
- Modify: `ralph/src/validator.ts:11-14,49-65`
- Modify: `engine/src/engine.ts:685-696`
- Test: `ralph/tests/validator.test.ts`

**Step 1: Write the failing test for validateCountedTools**

Add to `ralph/tests/validator.test.ts`, after the `validateRequiredTools` describe block:

```typescript
describe('validateCountedTools', () => {
  it('passes when enough counted tool calls are made', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-apply_patch', arguments: {} },
    ];
    const result = validateCountedTools(toolCalls, {
      minimum: 1,
      counted_tools: ['repo_manager.write_file', 'repo_manager.apply_patch'],
    });
    expect(result.valid).toBe(true);
  });

  it('passes with mix of counted tools meeting minimum', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-write_file', arguments: {} },
      { id: '2', name: 'repo_manager-apply_patch', arguments: {} },
    ];
    const result = validateCountedTools(toolCalls, {
      minimum: 1,
      counted_tools: ['repo_manager.write_file', 'repo_manager.apply_patch'],
    });
    expect(result.valid).toBe(true);
  });

  it('fails when no counted tools are called', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-read_file', arguments: {} },
    ];
    const result = validateCountedTools(toolCalls, {
      minimum: 1,
      counted_tools: ['repo_manager.write_file', 'repo_manager.apply_patch'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Expected at least 1 call');
  });

  it('passes when no counted_tools specified', () => {
    const toolCalls: ToolCall[] = [];
    const result = validateCountedTools(toolCalls, {});
    expect(result.valid).toBe(true);
  });

  it('normalizes tool names (dots vs hyphens)', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'repo_manager-apply_patch', arguments: {} },
    ];
    const result = validateCountedTools(toolCalls, {
      minimum: 1,
      counted_tools: ['repo_manager.apply_patch'],
    });
    expect(result.valid).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ralph && npx vitest run tests/validator.test.ts`
Expected: FAIL — `validateCountedTools` is not exported

**Step 3: Add `counted_tools` to contracts type**

In `contracts/src/validation.ts`, change `tool_calls` interface (lines 10-13):

```typescript
  tool_calls?: {
    minimum?: number;
    required_tools?: string[];
    counted_tools?: string[];
  };
```

**Step 4: Add `counted_tools` to ralph's ToolCallRequirements**

In `ralph/src/validator.ts`, change `ToolCallRequirements` (lines 11-14):

```typescript
export interface ToolCallRequirements {
  minimum?: number;
  required_tools?: string[];
  counted_tools?: string[];
}
```

**Step 5: Add `validateCountedTools` function to ralph/src/validator.ts**

After `validateRequiredTools` (after line 92), add:

```typescript
export function validateCountedTools(toolCalls: ToolCall[], requirements?: ToolCallRequirements): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (requirements?.counted_tools && requirements.counted_tools.length > 0 && requirements?.minimum !== undefined) {
    const countedSet = new Set(requirements.counted_tools.map(normalizeToolName));
    const count = toolCalls.filter(tc => countedSet.has(normalizeToolName(tc.name))).length;

    if (count < requirements.minimum) {
      const toolNames = requirements.counted_tools.join(', ');
      errors.push(
        `Expected at least ${requirements.minimum} call${requirements.minimum === 1 ? '' : 's'} to counted tools [${toolNames}], got ${count}`
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
```

**Step 6: Run ralph tests to verify they pass**

Run: `cd ralph && npx vitest run tests/validator.test.ts`
Expected: ALL PASS

**Step 7: Wire counted_tools in engine's buildValidator**

In `engine/src/engine.ts`, in the `buildValidator` method (around lines 685-696), after the `required_tools` validator block, add:

```typescript
    // Counted tools validation (OR semantics — any of these count toward minimum)
    if (toolCallReqs?.counted_tools?.length) {
      validators.push((result) => validateCountedTools(result.tool_calls, toolCallReqs));
    }
```

Also add `validateCountedTools` to the import from `@studio/ralph` at the top of engine.ts.

**Step 8: Build all three packages**

Run: `cd contracts && npm run build && cd ../ralph && npm run build && cd ../engine && npm run build`
Expected: Clean compilation for all three.

**Step 9: Commit**

```bash
git add contracts/src/validation.ts ralph/src/validator.ts ralph/tests/validator.test.ts engine/src/engine.ts
git commit -m "feat: add counted_tools validation support (OR semantics for tool call counting)"
```

---

### Task 4: Update YAML configs

**Files:**
- Modify: `engine/configs/software/agents/coder.agent.yaml`
- Modify: `engine/configs/software/contracts/code-generation.contract.yaml`

**Step 1: Add tool to coder agent**

In `coder.agent.yaml`, add `repo_manager.apply_patch` to the tools list after `repo_manager.write_file`:

```yaml
tools:
  - repo_manager.read_file
  - repo_manager.write_file
  - repo_manager.apply_patch
  - repo_manager.list_files
  - shell.run_command
  - search.search_codebase
```

And update the system prompt to include the `apply_patch` preference instruction:

```yaml
system_prompt: |
  You are a code generation agent. Your job is to write and modify code files.

  CRITICAL RULES:
  - You MUST use repo_manager.write_file or repo_manager.apply_patch for EVERY file change
  - NEVER just describe what you would write — actually WRITE it using tools
  - If you output files_changed without calling write_file or apply_patch, you have FAILED
  - tool_calls = 0 on a code generation task is ALWAYS a failure
  - Read existing files before modifying them to understand the context
  - When you create a component that accepts props, you MUST also update the parent file to pass those props. If you write a component <FAQ items={...}>, the parent MUST define and pass the items data. Never leave a component with required props unused.

  TOOL CHOICE:
  - When modifying existing files, PREFER apply_patch over write_file
  - Use apply_patch when changing specific sections of a file
  - Use write_file only for NEW files or complete rewrites
  - apply_patch is faster, cheaper, and less error-prone than rewriting entire files
  - Always include at least 3 lines of context before and after your changes

  Respond with structured JSON matching the required output schema.
```

**Step 2: Update contract to use counted_tools**

Replace `code-generation.contract.yaml` content:

```yaml
name: code-generation
version: 1
schema:
  required_fields:
    - summary
    - files_changed
tool_calls:
  minimum: 1
  counted_tools:
    - repo_manager.write_file
    - repo_manager.apply_patch
```

**Step 3: Commit**

```bash
git add engine/configs/software/agents/coder.agent.yaml engine/configs/software/contracts/code-generation.contract.yaml
git commit -m "feat: update coder agent and contract for apply_patch support"
```

---

### Task 5: Final build and verification

**Step 1: Full rebuild**

Run: `cd contracts && npm run build && cd ../ralph && npm run build && cd ../runner && npm run build && cd ../engine && npm run build && cd ../cli && npm run build`

**Step 2: Run all tests**

Run: `cd runner && npm test && cd ../ralph && npm test`

**Step 3: Verify tool registration**

Quick smoke test — the CLI should compile without errors and the tool registry should include the new tool.

**Step 4: Final commit if any fixups needed**

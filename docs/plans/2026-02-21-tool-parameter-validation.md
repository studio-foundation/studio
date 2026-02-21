# Tool Parameter Validation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fail fast with a clear error when a tool's YAML template uses undeclared placeholders (load-time) or the LLM passes wrong arguments (execution-time).

**Architecture:** Two validation layers in `runner/` only. Layer 1: `plugin-loader.ts` extracts `{{placeholder}}` names from shell command templates and diffs against declared `parameters` keys — throws `ToolYamlError` on mismatch. Layer 2: `tool-executor.ts` checks LLM-provided arguments against the tool's JSON Schema before calling `tool.execute()` — returns a failed `ToolCall` on mismatch.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

---

### Task 1: Create `ToolYamlError` class

**Files:**
- Create: `runner/src/tools/errors.ts`
- Create: `runner/src/tools/errors.test.ts`

**Step 1: Write the failing test**

```typescript
// runner/src/tools/errors.test.ts
import { describe, it, expect } from 'vitest';
import { ToolYamlError } from './errors.js';

describe('ToolYamlError', () => {
  it('is an Error with name ToolYamlError', () => {
    const err = new ToolYamlError('bad yaml');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ToolYamlError');
    expect(err.message).toBe('bad yaml');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @studio/runner test runner/src/tools/errors.test.ts
```

Expected: FAIL — `Cannot find module './errors.js'`

**Step 3: Write minimal implementation**

```typescript
// runner/src/tools/errors.ts
export class ToolYamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolYamlError';
  }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @studio/runner test runner/src/tools/errors.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add runner/src/tools/errors.ts runner/src/tools/errors.test.ts
git commit -m "feat(runner): add ToolYamlError class"
```

---

### Task 2: Load-time template consistency check

**Files:**
- Modify: `runner/src/tools/plugin-loader.ts`
- Create: `runner/src/tools/plugin-loader.test.ts`

**Background:** Shell command templates use `{{placeholder}}` syntax. The `renderTemplate` function silently substitutes an empty string if a placeholder has no matching argument. We need to catch this at load time by comparing placeholder names against declared `parameters` keys.

Keywords that appear as `{{word}}` but are NOT parameter names: `else` (the `{{else}}` delimiter in if/else blocks). The `#if` and `/if` tokens contain non-word characters so they never match `\{\{(\w+)\}\}`.

**Step 1: Write the failing tests**

```typescript
// runner/src/tools/plugin-loader.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProjectTools } from './plugin-loader.js';
import { ToolYamlError } from './errors.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'studio-tool-loader-test-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeToolYaml(name: string, content: string): Promise<string> {
  const dir = join(tmpDir, name);
  await mkdir(dir, { recursive: true });
  const toolsDir = join(dir, 'tools');
  await mkdir(toolsDir, { recursive: true });
  await writeFile(join(toolsDir, `${name}.tool.yaml`), content);
  return toolsDir;
}

describe('loadProjectTools — shell template validation', () => {
  it('throws ToolYamlError when template uses undeclared placeholder', async () => {
    const toolsDir = await writeToolYaml('bad-search', `
name: bad_search
version: 1
commands:
  - name: bad_search-search
    description: Search
    parameters:
      query:
        type: string
        required: true
    execute:
      type: shell
      command: 'curl "https://api.example.com?q={{search_query}}"'
`);
    await expect(loadProjectTools(toolsDir, '/tmp')).rejects.toThrow(ToolYamlError);
    await expect(loadProjectTools(toolsDir, '/tmp')).rejects.toThrow(
      "template uses {{search_query}} but no such parameter is declared"
    );
  });

  it('loads successfully when all template placeholders are declared', async () => {
    const toolsDir = await writeToolYaml('good-search', `
name: good_search
version: 1
commands:
  - name: good_search-search
    description: Search
    parameters:
      query:
        type: string
        required: true
    execute:
      type: shell
      command: 'curl "https://api.example.com?q={{query}}"'
`);
    await expect(loadProjectTools(toolsDir, '/tmp')).resolves.toHaveLength(1);
  });

  it('does not flag {{else}} as an undeclared placeholder', async () => {
    const toolsDir = await writeToolYaml('conditional-tool', `
name: conditional_tool
version: 1
commands:
  - name: conditional_tool-run
    description: Run with optional flag
    parameters:
      verbose:
        type: boolean
        required: false
    execute:
      type: shell
      command: 'echo {{#if verbose}}--verbose{{else}}--quiet{{/if}}'
`);
    await expect(loadProjectTools(toolsDir, '/tmp')).resolves.toHaveLength(1);
  });

  it('error message includes filename, command name, and declared parameters', async () => {
    const toolsDir = await writeToolYaml('err-msg', `
name: err_msg
version: 1
commands:
  - name: err_msg-run
    description: Run
    parameters:
      query:
        type: string
        required: true
    execute:
      type: shell
      command: 'curl {{typo}}'
`);
    await expect(loadProjectTools(toolsDir, '/tmp')).rejects.toThrow(
      "err-msg.tool.yaml › command 'err_msg-run'"
    );
    await expect(loadProjectTools(toolsDir, '/tmp')).rejects.toThrow(
      "Declared parameters: query"
    );
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter @studio/runner test runner/src/tools/plugin-loader.test.ts
```

Expected: FAIL — tests fail because no validation exists yet

**Step 3: Write the validation in `plugin-loader.ts`**

Add this import at the top of `plugin-loader.ts`:
```typescript
import { ToolYamlError } from './errors.js';
```

Add this function after `buildJsonSchema` (around line 54):
```typescript
/** Template keywords that appear as {{word}} but are not parameter names. */
const TEMPLATE_KEYWORDS = new Set(['else']);

/**
 * Validate that every {{placeholder}} in a shell command template
 * is declared in the command's parameters.
 * Throws ToolYamlError if any undeclared placeholder is found.
 */
function validateShellTemplate(fileName: string, cmd: ToolCommandDef): void {
  const exec = cmd.execute as { type: string; command?: string };
  if (exec.type !== 'shell' || !exec.command) return;

  const declared = new Set(Object.keys(cmd.parameters ?? {}));
  const used = new Set<string>();

  for (const match of exec.command.matchAll(/\{\{(\w+)\}\}/g)) {
    const name = match[1];
    if (!TEMPLATE_KEYWORDS.has(name)) used.add(name);
  }

  const unknown = [...used].filter(p => !declared.has(p));
  if (unknown.length > 0) {
    throw new ToolYamlError(
      `${fileName} › command '${cmd.name}':\n` +
      `  template uses ${unknown.map(p => `{{${p}}}`).join(', ')} but no such parameter is declared.\n` +
      `  Declared parameters: ${[...declared].join(', ') || '(none)'}`
    );
  }
}
```

Then in the `loadProjectTools` loop, call `validateShellTemplate` before `createShellTool`. The loop currently looks like (lines 97–104):

```typescript
for (const cmd of def.commands ?? []) {
  if (cmd.execute.type === 'builtin') {
    const tool = builtinMap.get(cmd.name);
    if (tool) tools.push(tool);
    // If unknown builtin name, skip silently (no crash)
  } else {
    tools.push(createShellTool(cmd, repoPath));
  }
}
```

Replace the `else` branch with:
```typescript
  } else {
    validateShellTemplate(file, cmd);   // ← add this line
    tools.push(createShellTool(cmd, repoPath));
  }
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio/runner test runner/src/tools/plugin-loader.test.ts
```

Expected: PASS (4 tests)

**Step 5: Build to verify no TypeScript errors**

```bash
pnpm build
```

Expected: clean build

**Step 6: Commit**

```bash
git add runner/src/tools/plugin-loader.ts runner/src/tools/plugin-loader.test.ts runner/src/tools/errors.ts runner/src/tools/errors.test.ts
git commit -m "feat(runner): validate shell template placeholders at load time"
```

---

### Task 3: Execution-time LLM argument validation

**Files:**
- Modify: `runner/src/tools/tool-executor.ts`
- Create: `runner/src/tools/tool-executor.test.ts`

**Background:** The `Tool.parameters` field is a JSON Schema object built by `buildJsonSchema()`. Its shape is:
```json
{
  "type": "object",
  "properties": { "query": { "type": "string" } },
  "required": ["query"]
}
```
We read `properties` to know declared params and `required` to know which are mandatory.

**Step 1: Write the failing tests**

```typescript
// runner/src/tools/tool-executor.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ToolExecutor } from './tool-executor.js';
import { ToolRegistry } from './tool-registry.js';

function makeRegistry(paramSchema: Record<string, unknown>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'test-tool',
    description: 'A test tool',
    parameters: paramSchema,
    execute: vi.fn().mockResolvedValue({ success: true, output: 'ok' }),
  });
  return registry;
}

const SCHEMA_WITH_REQUIRED = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
  },
  required: ['query'],
};

const SCHEMA_NO_REQUIRED = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
  },
};

describe('ToolExecutor — argument validation', () => {
  it('returns error for missing required parameter', async () => {
    const executor = new ToolExecutor(makeRegistry(SCHEMA_WITH_REQUIRED));
    const result = await executor.execute({
      id: '1',
      name: 'test-tool',
      arguments: {},
    });
    expect(result.error).toMatch(/missing required parameter.*query/);
    expect(result.result).toBeUndefined();
  });

  it('returns error for unknown parameter', async () => {
    const executor = new ToolExecutor(makeRegistry(SCHEMA_WITH_REQUIRED));
    const result = await executor.execute({
      id: '2',
      name: 'test-tool',
      arguments: { query: 'hello', pattern: 'oops' },
    });
    expect(result.error).toMatch(/unknown parameter.*pattern/);
    expect(result.error).toMatch(/declared: query/);
    expect(result.result).toBeUndefined();
  });

  it('executes successfully with correct required parameters', async () => {
    const registry = makeRegistry(SCHEMA_WITH_REQUIRED);
    const executor = new ToolExecutor(registry);
    const result = await executor.execute({
      id: '3',
      name: 'test-tool',
      arguments: { query: 'ramen' },
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('ok');
  });

  it('executes successfully with no required parameters and empty args', async () => {
    const executor = new ToolExecutor(makeRegistry(SCHEMA_NO_REQUIRED));
    const result = await executor.execute({
      id: '4',
      name: 'test-tool',
      arguments: {},
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('ok');
  });

  it('executes successfully with optional parameter provided', async () => {
    const executor = new ToolExecutor(makeRegistry(SCHEMA_NO_REQUIRED));
    const result = await executor.execute({
      id: '5',
      name: 'test-tool',
      arguments: { query: 'ramen' },
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('ok');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm --filter @studio/runner test runner/src/tools/tool-executor.test.ts
```

Expected: FAIL — missing required / unknown param tests don't get an error yet

**Step 3: Add validation in `tool-executor.ts`**

Add this helper function before the `ToolExecutor` class:

```typescript
/**
 * Validate LLM-provided arguments against the tool's JSON Schema.
 * Returns an error string if invalid, null if OK.
 */
function validateArgs(
  toolName: string,
  schema: Record<string, unknown>,
  args: Record<string, unknown>
): string | null {
  const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
  const required = (schema.required as string[] | undefined) ?? [];
  const declared = new Set(Object.keys(properties));

  const missing = required.filter(p => !(p in args));
  if (missing.length > 0) {
    return `Tool ${toolName}: missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`;
  }

  const unknown = Object.keys(args).filter(p => !declared.has(p));
  if (unknown.length > 0) {
    return `Tool ${toolName}: unknown parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (declared: ${[...declared].join(', ')})`;
  }

  return null;
}
```

Then in `ToolExecutor.execute()`, insert the validation call right after the tool lookup (after the `if (!tool)` block, before the `try`):

```typescript
// Validate arguments against the tool's parameter schema
const validationError = validateArgs(toolCall.name, tool.parameters, toolCall.arguments);
if (validationError) {
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments,
    error: validationError,
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @studio/runner test runner/src/tools/tool-executor.test.ts
```

Expected: PASS (5 tests)

**Step 5: Run full runner test suite**

```bash
pnpm --filter @studio/runner test
```

Expected: all tests pass

**Step 6: Build**

```bash
pnpm build
```

Expected: clean build

**Step 7: Commit**

```bash
git add runner/src/tools/tool-executor.ts runner/src/tools/tool-executor.test.ts
git commit -m "feat(runner): validate LLM tool arguments at execution time"
```

---

### Task 4: Final check

**Step 1: Run all tests from root**

```bash
pnpm test
```

Expected: all packages pass

**Step 2: Verify end-to-end error message format**

Simulate a bad YAML to manually confirm the error message reads well. Create a temp file:

```bash
cat > /tmp/test-bad.tool.yaml << 'EOF'
name: bad_tool
version: 1
commands:
  - name: bad_tool-search
    description: Search
    parameters:
      query:
        type: string
        required: true
    execute:
      type: shell
      command: 'curl "https://api.example.com?q={{search_query}}"'
EOF
```

Then write a quick Node.js snippet or adjust a test to load this file — confirm the error message says:
```
ToolYamlError: test-bad.tool.yaml › command 'bad_tool-search':
  template uses {{search_query}} but no such parameter is declared.
  Declared parameters: query
```

**Step 3: Commit if no issues found, or fix and commit**

```bash
git add -p  # only if changes were needed
git commit -m "fix(runner): adjust error message format after manual testing"
```

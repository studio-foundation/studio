# STU-141 — API CRUD Tools (GET, PUT, DELETE, install)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add REST endpoints to `@studio/api` for managing tool plugins — list, read, create/update, delete, and install from the bundled registry.

**Architecture:** Move the bundled tool templates from `cli/templates/tools/` to `runner/templates/tools/` so both CLI and API can access them without violating the dependency graph (CLI→runner is already allowed). The API tools route distinguishes builtins (present in runner's templates) from custom tools (`.tool.yaml` files in `.studio/tools/`). `DELETE` returns 403 for builtins. `POST /api/tools/install` copies a template from runner's registry to `.studio/tools/`.

**Tech Stack:** TypeScript, Fastify, js-yaml, Node fs/promises, vitest, @studio/runner, @studio/engine (InMemoryRunStore for tests)

---

## Packages touched

- `runner/` — add `templates/tools/` dir, export template helpers
- `cli/` — delete its local copies of the templates, import from runner
- `api/` — new route file + server registration + tests

---

### Task 1: Move tool templates from CLI to runner

**Files:**
- Create: `runner/templates/tools/repo-manager.tool.yaml` (copy from cli)
- Create: `runner/templates/tools/shell.tool.yaml` (copy from cli)
- Create: `runner/templates/tools/search.tool.yaml` (copy from cli)
- Create: `runner/templates/tools/git.tool.yaml` (copy from cli)

No test needed for this step — it's a file move. Just copy the four YAML files.

**Step 1: Copy the four files**

```bash
mkdir -p runner/templates/tools
cp cli/templates/tools/repo-manager.tool.yaml runner/templates/tools/
cp cli/templates/tools/shell.tool.yaml        runner/templates/tools/
cp cli/templates/tools/search.tool.yaml       runner/templates/tools/
cp cli/templates/tools/git.tool.yaml          runner/templates/tools/
```

**Step 2: Verify they exist**

```bash
ls runner/templates/tools/
# Expected: git.tool.yaml  repo-manager.tool.yaml  search.tool.yaml  shell.tool.yaml
```

**Step 3: Commit**

```bash
git add runner/templates/tools/
git commit -m "chore(runner): add bundled tool templates (moved from cli)"
```

---

### Task 2: Export tool template helpers from runner

The CLI currently has `listAvailableTools()` and `toolsAddDirect()` defined locally. We move the lookup logic into runner so the API can also use it.

**Files:**
- Modify: `runner/src/tools/plugin-loader.ts`
- Modify: `runner/src/index.ts`

**Step 1: Add to `runner/src/tools/plugin-loader.ts`**

Add at the bottom of the file (after existing exports):

```typescript
import { fileURLToPath } from 'node:url';

const BUNDLED_TOOL_TEMPLATES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../templates/tools'
);

/** Names of built-in tool plugins (ship with Studio). */
export const BUILTIN_TOOL_NAMES = new Set([
  'repo-manager',
  'shell',
  'search',
  'git',
]);

/**
 * List all tool plugins available for installation from the bundled registry.
 * Returns an array of { name, description } objects.
 */
export async function listAvailableToolTemplates(): Promise<{ name: string; description: string }[]> {
  let files: string[];
  try {
    files = (await readdir(BUNDLED_TOOL_TEMPLATES_DIR)).filter(f => f.endsWith('.tool.yaml')).sort();
  } catch {
    return [];
  }
  const result: { name: string; description: string }[] = [];
  for (const file of files) {
    const content = await readFile(resolve(BUNDLED_TOOL_TEMPLATES_DIR, file), 'utf-8');
    const def = yaml.load(content) as ToolPluginDef;
    result.push({ name: file.replace('.tool.yaml', ''), description: def.description ?? '' });
  }
  return result;
}

/**
 * Return the raw YAML content of a bundled tool template by name.
 * Returns null if the tool does not exist in the bundled registry.
 */
export async function getBundledToolTemplate(name: string): Promise<string | null> {
  const filePath = resolve(BUNDLED_TOOL_TEMPLATES_DIR, `${name}.tool.yaml`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}
```

**Step 2: Export from `runner/src/index.ts`**

Add at the end of the Tools section:

```typescript
export { loadProjectTools, listAvailableToolTemplates, getBundledToolTemplate, BUILTIN_TOOL_NAMES } from './tools/plugin-loader.js';
export type { LoadedPlugin } from './tools/plugin-loader.js';
```

(Replace the existing `export { loadProjectTools }` line.)

**Step 3: Run runner tests to verify nothing broke**

```bash
pnpm --filter @studio/runner test
# Expected: all pass
```

**Step 4: Commit**

```bash
git add runner/src/tools/plugin-loader.ts runner/src/index.ts
git commit -m "feat(runner): export bundled tool template helpers (listAvailableToolTemplates, getBundledToolTemplate)"
```

---

### Task 3: Update CLI to use runner's template helpers

The CLI's `tools.ts` duplicates the template-access logic. Replace it with runner's exports.

**Files:**
- Modify: `cli/src/commands/tools.ts`
- Delete: `cli/templates/tools/` (the 4 YAML files)

**Step 1: Update `cli/src/commands/tools.ts`**

Replace the local `TOOL_TEMPLATES_DIR`, `listAvailableTools()`, and the `readFile(templatePath)` block inside `toolsAddDirect()` with runner imports:

```typescript
// Add at the top:
import { listAvailableToolTemplates, getBundledToolTemplate } from '@studio/runner';
```

Replace `listAvailableTools()` call sites with `listAvailableToolTemplates()`.

Replace the `readFile(templatePath)` block in `toolsAddDirect()`:
```typescript
const templateContent = await getBundledToolTemplate(name);
if (!templateContent) {
  const available = await listAvailableToolTemplates();
  throw new Error(`Unknown tool '${name}'. Available: ${available.map(t => t.name).join(', ')}`);
}
```

Remove the `TOOL_TEMPLATES_DIR` constant and the local `listAvailableTools()` function entirely.

**Step 2: Delete the now-redundant CLI templates**

```bash
rm cli/templates/tools/repo-manager.tool.yaml
rm cli/templates/tools/shell.tool.yaml
rm cli/templates/tools/search.tool.yaml
rm cli/templates/tools/git.tool.yaml
rmdir cli/templates/tools cli/templates 2>/dev/null || true
```

**Step 3: Build CLI**

```bash
pnpm --filter @studio/cli build
# Expected: 0 errors
```

**Step 4: Commit**

```bash
git add cli/src/commands/tools.ts cli/templates/
git commit -m "refactor(cli): use runner's bundled tool templates instead of local copies"
```

---

### Task 4: Write failing tests for GET /api/tools

**Files:**
- Create: `api/tests/tools.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';

const TMP = resolve('/tmp', `.studio-api-tools-test-${Date.now()}`);
const TOOLS_DIR = resolve(TMP, 'tools');

const CUSTOM_TOOL_YAML = `name: my-custom-tool
description: A custom tool for testing
version: 1
commands:
  - name: my-custom-tool-do_something
    description: Does something useful
    parameters: {}
    execute:
      type: shell
      command: echo hello
`;

function makeServer() {
  return buildServer({
    store: new InMemoryRunStore(),
    launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
    configsDir: TMP,
    projectName: 'test-project',
    apiConfig: {},
    studioVersion: '0.0.0-test',
    maskedConfig: { providers: [] },
  });
}

beforeAll(() => {
  mkdirSync(TOOLS_DIR, { recursive: true });
  writeFileSync(resolve(TOOLS_DIR, 'my-custom-tool.tool.yaml'), CUSTOM_TOOL_YAML);
  writeFileSync(resolve(TOOLS_DIR, 'ignored.yaml'), ''); // must be ignored
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('GET /api/tools', () => {
  it('returns builtin tools with is_builtin: true', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/tools' });
    expect(res.statusCode).toBe(200);
    const { tools } = res.json() as { tools: { name: string; is_builtin: boolean }[] };
    const builtins = tools.filter(t => t.is_builtin);
    expect(builtins.map(t => t.name)).toContain('shell');
    expect(builtins.map(t => t.name)).toContain('repo-manager');
  });

  it('returns custom tools with is_builtin: false', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/tools' });
    expect(res.statusCode).toBe(200);
    const { tools } = res.json() as { tools: { name: string; is_builtin: boolean }[] };
    const custom = tools.find(t => t.name === 'my-custom-tool');
    expect(custom).toBeDefined();
    expect(custom!.is_builtin).toBe(false);
  });

  it('does not include non-.tool.yaml files', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/tools' });
    const { tools } = res.json() as { tools: { name: string }[] };
    expect(tools.map(t => t.name)).not.toContain('ignored');
  });

  it('returns empty custom tools list when tools dir is missing', async () => {
    const emptyServer = buildServer({
      store: new InMemoryRunStore(),
      launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
      configsDir: resolve('/tmp', `.studio-api-no-tools-${Date.now()}`),
      projectName: 'empty',
      apiConfig: {},
      studioVersion: '0.0.0-test',
      maskedConfig: { providers: [] },
    });
    const res = await emptyServer.inject({ method: 'GET', url: '/api/tools' });
    expect(res.statusCode).toBe(200);
    const { tools } = res.json() as { tools: { name: string; is_builtin: boolean }[] };
    // Builtins still present, no custom
    expect(tools.some(t => t.is_builtin)).toBe(true);
    expect(tools.every(t => t.name !== 'my-custom-tool')).toBe(true);
  });
});
```

**Step 2: Run to confirm failure**

```bash
pnpm --filter @studio/api test
# Expected: FAIL — toolsRoutes not registered yet
```

---

### Task 5: Write failing tests for GET /api/tools/:name

Append to `api/tests/tools.test.ts`:

```typescript
describe('GET /api/tools/:name', () => {
  it('returns parsed YAML for a custom tool', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/tools/my-custom-tool' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; version: number; is_builtin: boolean };
    expect(body.name).toBe('my-custom-tool');
    expect(body.version).toBe(1);
    expect(body.is_builtin).toBe(false);
  });

  it('returns builtin definition for a known builtin', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/tools/shell' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; is_builtin: boolean; prompt_snippet?: string };
    expect(body.name).toBe('shell');
    expect(body.is_builtin).toBe(true);
    expect(body.prompt_snippet).toBeTruthy(); // shell template has a prompt_snippet
  });

  it('returns 404 for unknown tool', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/tools/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });
});
```

---

### Task 6: Write failing tests for PUT /api/tools/:name

Append to `api/tests/tools.test.ts`:

```typescript
describe('PUT /api/tools/:name', () => {
  it('creates a new custom tool from YAML body', async () => {
    const server = makeServer();
    const yaml = `name: new-tool\ndescription: test\nversion: 1\ncommands: []\n`;
    const res = await server.inject({
      method: 'PUT',
      url: '/api/tools/new-tool',
      headers: { 'content-type': 'text/plain' },
      payload: yaml,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe('new-tool');
    // Verify it shows up in GET
    const getRes = await server.inject({ method: 'GET', url: '/api/tools/new-tool' });
    expect(getRes.statusCode).toBe(200);
  });

  it('creates a new custom tool from JSON body', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/tools/json-tool',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'json-tool', version: 1, commands: [] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 for invalid YAML body', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/tools/bad-tool',
      headers: { 'content-type': 'text/plain' },
      payload: 'key: [unclosed\n  - item',
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });
});
```

---

### Task 7: Write failing tests for DELETE /api/tools/:name

Append to `api/tests/tools.test.ts`:

```typescript
describe('DELETE /api/tools/:name', () => {
  it('deletes an existing custom tool', async () => {
    const server = makeServer();
    // Create it first
    await server.inject({
      method: 'PUT',
      url: '/api/tools/to-delete',
      headers: { 'content-type': 'text/plain' },
      payload: 'name: to-delete\nversion: 1\ncommands: []\n',
    });
    const res = await server.inject({ method: 'DELETE', url: '/api/tools/to-delete' });
    expect(res.statusCode).toBe(200);
    // Verify gone
    const getRes = await server.inject({ method: 'GET', url: '/api/tools/to-delete' });
    expect(getRes.statusCode).toBe(404);
  });

  it('returns 403 when trying to delete a builtin tool', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'DELETE', url: '/api/tools/shell' });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/builtin/i);
  });

  it('returns 404 for nonexistent custom tool', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'DELETE', url: '/api/tools/ghost-tool' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });
});
```

---

### Task 8: Write failing tests for POST /api/tools/install

Append to `api/tests/tools.test.ts`:

```typescript
describe('POST /api/tools/install', () => {
  it('installs a bundled tool by name', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/tools/install',
      payload: { name: 'shell' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { installed: string }).installed).toBe('shell');
    // Verify it's now in .studio/tools/
    const getRes = await server.inject({ method: 'GET', url: '/api/tools/shell' });
    expect(getRes.statusCode).toBe(200);
  });

  it('returns 409 if tool is already installed', async () => {
    const server = makeServer();
    // Install once first
    await server.inject({ method: 'POST', url: '/api/tools/install', payload: { name: 'git' } });
    // Install again
    const res = await server.inject({
      method: 'POST',
      url: '/api/tools/install',
      payload: { name: 'git' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 404 for unknown tool name', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/tools/install',
      payload: { name: 'nonexistent-tool' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });
});
```

**Step 2: Run all tests to confirm all fail**

```bash
pnpm --filter @studio/api test 2>&1 | grep -E "(FAIL|PASS|tools)"
# Expected: all tools tests FAIL — route not registered
```

---

### Task 9: Implement `api/src/routes/tools.ts`

**Files:**
- Create: `api/src/routes/tools.ts`

```typescript
import { readdir, readFile, writeFile, unlink, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';
import {
  BUILTIN_TOOL_NAMES,
  listAvailableToolTemplates,
  getBundledToolTemplate,
} from '@studio/runner';

function toolPath(configsDir: string, name: string): string {
  return join(configsDir, 'tools', `${name}.tool.yaml`);
}

async function isCustomTool(configsDir: string, name: string): Promise<boolean> {
  try {
    await access(toolPath(configsDir, name));
    return true;
  } catch {
    return false;
  }
}

export async function toolsRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const { configsDir } = options.deps;

  // GET /api/tools — list builtins + custom
  fastify.get('/tools', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  is_builtin: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const toolsList: { name: string; description: string; is_builtin: boolean }[] = [];

    // Builtins from bundled templates
    const available = await listAvailableToolTemplates();
    for (const t of available) {
      // Only show builtin if not overridden by a custom file
      const overridden = await isCustomTool(configsDir, t.name);
      if (!overridden) {
        toolsList.push({ name: t.name, description: t.description, is_builtin: true });
      }
    }

    // Custom tools from .studio/tools/
    const toolsDir = join(configsDir, 'tools');
    let entries: string[] = [];
    try {
      entries = await readdir(toolsDir);
    } catch {
      // dir doesn't exist — no custom tools
    }
    for (const file of entries.filter(f => f.endsWith('.tool.yaml'))) {
      const name = file.replace('.tool.yaml', '');
      const content = await readFile(join(toolsDir, file), 'utf-8');
      const def = yaml.load(content) as { description?: string };
      const isBuiltin = BUILTIN_TOOL_NAMES.has(name);
      toolsList.push({ name, description: def.description ?? '', is_builtin: isBuiltin });
    }

    return reply.send({ tools: toolsList });
  });

  // GET /api/tools/:name — read a tool definition
  fastify.get<{ Params: { name: string } }>('/tools/:name', {
    schema: {
      params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params;

    // Check custom tool first
    if (await isCustomTool(configsDir, name)) {
      const content = await readFile(toolPath(configsDir, name), 'utf-8');
      const parsed = yaml.load(content) as Record<string, unknown>;
      return reply.send({ ...parsed, is_builtin: BUILTIN_TOOL_NAMES.has(name) });
    }

    // Fall back to builtin template
    const template = await getBundledToolTemplate(name);
    if (template) {
      const parsed = yaml.load(template) as Record<string, unknown>;
      return reply.send({ ...parsed, is_builtin: true });
    }

    return reply.status(404).send({ error: `Tool '${name}' not found` });
  });

  // PUT /api/tools/:name — create or update a custom tool
  fastify.put<{ Params: { name: string }; Body: unknown }>(
    '/tools/:name',
    {
      schema: {
        params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        response: {
          200: { type: 'object', properties: { name: { type: 'string' } } },
          400: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      const contentType = request.headers['content-type'] ?? '';

      let yamlContent: string;
      if (contentType.includes('application/json')) {
        yamlContent = yaml.dump(request.body);
      } else {
        yamlContent = request.body as string;
      }

      try {
        yaml.load(yamlContent);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid YAML';
        return reply.status(400).send({ error: message });
      }

      await mkdir(join(configsDir, 'tools'), { recursive: true });
      await writeFile(toolPath(configsDir, name), yamlContent, 'utf-8');
      return reply.send({ name });
    }
  );

  // DELETE /api/tools/:name — delete a custom tool (403 for builtins)
  fastify.delete<{ Params: { name: string } }>('/tools/:name', {
    schema: {
      params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      response: {
        200: { type: 'object', properties: { deleted: { type: 'string' } } },
        403: { type: 'object', properties: { error: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params;

    // Reject if builtin (and not overridden by a custom file)
    if (BUILTIN_TOOL_NAMES.has(name) && !(await isCustomTool(configsDir, name))) {
      return reply.status(403).send({ error: `Cannot delete builtin tool '${name}'` });
    }

    try {
      await unlink(toolPath(configsDir, name));
    } catch {
      return reply.status(404).send({ error: `Tool '${name}' not found` });
    }
    return reply.send({ deleted: name });
  });

  // POST /api/tools/install — install a tool from the bundled registry
  fastify.post<{ Body: { name: string } }>('/tools/install', {
    schema: {
      body: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      response: {
        200: { type: 'object', properties: { installed: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
        409: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.body;

    const template = await getBundledToolTemplate(name);
    if (!template) {
      const available = await listAvailableToolTemplates();
      return reply.status(404).send({
        error: `Tool '${name}' not found in registry. Available: ${available.map(t => t.name).join(', ')}`,
      });
    }

    const destPath = toolPath(configsDir, name);
    const alreadyInstalled = await access(destPath).then(() => true).catch(() => false);
    if (alreadyInstalled) {
      return reply.status(409).send({ error: `Tool '${name}' is already installed` });
    }

    await mkdir(join(configsDir, 'tools'), { recursive: true });
    await writeFile(destPath, template, 'utf-8');
    return reply.send({ installed: name });
  });
}
```

---

### Task 10: Register tools routes in server.ts

**Files:**
- Modify: `api/src/server.ts`

**Step 1: Add import**

```typescript
import { toolsRoutes } from './routes/tools.js';
```

**Step 2: Register the route (add after pipelinesRoutes)**

```typescript
void fastify.register(toolsRoutes, { prefix: '/api', deps });
```

---

### Task 11: Run the tests

```bash
pnpm --filter @studio/api test
# Expected: all tools tests PASS
```

If any test fails, debug and fix before proceeding.

---

### Task 12: Build the full monorepo

```bash
pnpm build
# Expected: 0 errors across all packages
```

Fix any TypeScript errors before committing.

---

### Task 13: Commit

```bash
git add api/src/routes/tools.ts api/src/server.ts api/tests/tools.test.ts
git commit -m "feat(api): CRUD tools endpoints (STU-141)

GET/PUT/DELETE /api/tools/:name, GET /api/tools, POST /api/tools/install.
Builtins exposed read-only (403 on DELETE). Custom tools CRUD against
.studio/tools/. Install endpoint copies from runner's bundled registry."
```

---

## Acceptance Criteria Checklist

After all tasks:

- [ ] `GET /api/tools` returns builtins + custom with `is_builtin` flag
- [ ] `GET /api/tools/:name` returns full definition including `prompt_snippet`
- [ ] `PUT /api/tools/:name` writes `.tool.yaml` to `.studio/tools/`
- [ ] `DELETE /api/tools/:name` returns 403 for builtins
- [ ] `POST /api/tools/install` copies from bundled registry, 409 if already installed, 404 if unknown
- [ ] 400 for invalid YAML on PUT
- [ ] `pnpm build` passes
- [ ] All tests pass

## Notes for implementer

- **`BUILTIN_TOOL_NAMES`** comes from runner (`@studio/runner`). It's a `Set<string>` with values like `'repo-manager'`, `'shell'`, `'search'`, `'git'`.
- **`listAvailableToolTemplates()`** reads from `runner/templates/tools/` at runtime — this works because the templates live at the package root (not compiled), accessible via `import.meta.url`.
- **DELETE 403 logic**: A builtin can be "overridden" by placing a custom file in `.studio/tools/`. In that case, DELETE is allowed (it removes the override, not the builtin). So the 403 only fires when there's no custom file to delete.
- **POST /api/tools/install 409**: If `.studio/tools/<name>.tool.yaml` already exists, return 409. Even if it's an override of a builtin.
- Follow the `pipelines.ts` and `contracts.ts` patterns for route registration. `configsDir` is the `.studio/` directory path.

# STU-139 API CRUD Contracts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add four REST endpoints (`GET/PUT/DELETE /api/contracts`, `GET /api/contracts/:name`) that let a web interface read, create, update, and delete contract YAML files in `.studio/contracts/`.

**Architecture:** New `api/src/routes/contracts.ts` file registered in `server.ts`, following the exact same Fastify plugin pattern as `runs.ts` and `projects.ts`. Derives `contractsDir` from the existing `configsDir` dep — no new `ServerDeps` fields. Body for `PUT` is a JSON object; stored on disk as YAML via `js-yaml.dump()`.

**Tech Stack:** Fastify 5, js-yaml 4, Node.js `fs/promises`, Vitest

---

### Task 1: Write failing tests for GET endpoints

**Files:**
- Create: `api/tests/contracts.test.ts`

**Step 1: Create the test file**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';

const TMP = resolve('/tmp', `.studio-contracts-test-${Date.now()}`);
const CONTRACTS_DIR = resolve(TMP, 'contracts');

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
  mkdirSync(CONTRACTS_DIR, { recursive: true });
  writeFileSync(
    resolve(CONTRACTS_DIR, 'brief-analysis.contract.yaml'),
    'name: brief-analysis\nversion: 1\n'
  );
  writeFileSync(
    resolve(CONTRACTS_DIR, 'code-generation.contract.yaml'),
    'name: code-generation\nversion: 1\ntool_calls:\n  minimum: 1\n'
  );
  writeFileSync(resolve(CONTRACTS_DIR, 'ignored.yaml'), ''); // must be ignored
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('GET /api/contracts', () => {
  it('returns only *.contract.yaml files as contract names', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/contracts' });
    expect(res.statusCode).toBe(200);
    const { contracts } = res.json() as { contracts: string[] };
    expect(contracts).toContain('brief-analysis');
    expect(contracts).toContain('code-generation');
    expect(contracts).not.toContain('ignored');
    expect(contracts).not.toContain('brief-analysis.contract.yaml');
  });

  it('returns empty array when contracts dir is missing', async () => {
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
      configsDir: resolve('/tmp', `.studio-no-contracts-${Date.now()}`),
      projectName: 'test-project',
      apiConfig: {},
      studioVersion: '0.0.0-test',
      maskedConfig: { providers: [] },
    });
    const res = await server.inject({ method: 'GET', url: '/api/contracts' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { contracts: string[] }).contracts).toEqual([]);
  });
});

describe('GET /api/contracts/:name', () => {
  it('returns parsed contract content as JSON', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/contracts/brief-analysis' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; version: number };
    expect(body.name).toBe('brief-analysis');
    expect(body.version).toBe(1);
  });

  it('returns nested fields from YAML', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/contracts/code-generation' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tool_calls: { minimum: number } };
    expect(body.tool_calls.minimum).toBe(1);
  });

  it('returns 404 for unknown contract', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/contracts/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('Contract not found');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd /path/to/Studio
pnpm --filter @studio/api test 2>&1 | grep -A3 "contracts"
```

Expected: `Cannot find module '../src/routes/contracts'` or similar route-not-found errors.

---

### Task 2: Implement GET endpoints + register route

**Files:**
- Create: `api/src/routes/contracts.ts`
- Modify: `api/src/server.ts`

**Step 1: Create `api/src/routes/contracts.ts`**

```typescript
import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

export async function contractsRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const contractsDir = join(options.deps.configsDir, 'contracts');

  // GET /api/contracts
  fastify.get('/contracts', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            contracts: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }, async (_request, reply) => {
    let entries: string[];
    try {
      entries = await readdir(contractsDir);
    } catch {
      return reply.send({ contracts: [] });
    }
    const contracts = entries
      .filter(f => f.endsWith('.contract.yaml'))
      .map(f => f.slice(0, -'.contract.yaml'.length));
    return reply.send({ contracts });
  });

  // GET /api/contracts/:name
  fastify.get<{ Params: { name: string } }>('/contracts/:name', {
    schema: {
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  }, async (request, reply) => {
    const filePath = join(contractsDir, `${request.params.name}.contract.yaml`);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return reply.status(404).send({ error: 'Contract not found' });
    }
    return reply.send(yaml.load(content));
  });
}
```

Note: `writeFile`, `unlink`, and `mkdir` are imported now for the PUT/DELETE steps coming next — add them all at once to avoid modifying the import line repeatedly.

**Step 2: Register in `api/src/server.ts`**

Add import after existing route imports:
```typescript
import { contractsRoutes } from './routes/contracts.js';
```

Add registration after existing `projectsRoutes` registration:
```typescript
void fastify.register(contractsRoutes, { prefix: '/api', deps });
```

**Step 3: Run GET tests**

```bash
pnpm --filter @studio/api test 2>&1 | grep -E "✓|✗|PASS|FAIL"
```

Expected: all GET tests pass.

**Step 4: Commit**

```bash
git add api/src/routes/contracts.ts api/src/server.ts api/tests/contracts.test.ts
git commit -m "feat(api): add GET /api/contracts and GET /api/contracts/:name (STU-139)"
```

---

### Task 3: Write failing tests for PUT endpoint

**Files:**
- Modify: `api/tests/contracts.test.ts`

**Step 1: Add PUT tests to the existing test file** (after the GET describe blocks)

```typescript
describe('PUT /api/contracts/:name', () => {
  it('creates a new contract file', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/contracts/new-contract',
      payload: { name: 'new-contract', version: 1, schema: { required_fields: ['summary'] } },
    });
    expect(res.statusCode).toBe(200);
    // Verify it can be read back
    const getRes = await server.inject({ method: 'GET', url: '/api/contracts/new-contract' });
    expect(getRes.statusCode).toBe(200);
    expect((getRes.json() as { version: number }).version).toBe(1);
  });

  it('updates an existing contract', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/contracts/brief-analysis',
      payload: { name: 'brief-analysis', version: 2 },
    });
    expect(res.statusCode).toBe(200);
    // Verify version updated
    const getRes = await server.inject({ method: 'GET', url: '/api/contracts/brief-analysis' });
    expect((getRes.json() as { version: number }).version).toBe(2);
  });

  it('returns 400 when name field is missing', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/contracts/foo',
      payload: { version: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when version field is missing', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/contracts/foo',
      payload: { name: 'foo' },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

**Step 2: Run to verify they fail**

```bash
pnpm --filter @studio/api test 2>&1 | grep -E "PUT|✗|404"
```

Expected: 404 responses (route doesn't exist yet).

---

### Task 4: Implement PUT endpoint

**Files:**
- Modify: `api/src/routes/contracts.ts`

**Step 1: Add PUT handler** (inside `contractsRoutes`, after the GET `:name` handler)

```typescript
  // PUT /api/contracts/:name
  fastify.put<{
    Params: { name: string };
    Body: Record<string, unknown>;
  }>('/contracts/:name', {
    schema: {
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const body = request.body;

    if (!body['name'] || typeof body['name'] !== 'string') {
      return reply.status(400).send({ error: "Contract must have a 'name' field (string)" });
    }
    if (body['version'] === undefined) {
      return reply.status(400).send({ error: "Contract must have a 'version' field" });
    }

    await mkdir(contractsDir, { recursive: true });
    const filePath = join(contractsDir, `${request.params.name}.contract.yaml`);
    await writeFile(filePath, yaml.dump(body), 'utf-8');

    return reply.send({ name: request.params.name, content: body });
  });
```

**Step 2: Run PUT tests**

```bash
pnpm --filter @studio/api test 2>&1 | grep -E "✓|✗|PASS|FAIL"
```

Expected: all PUT tests pass.

**Step 3: Commit**

```bash
git add api/src/routes/contracts.ts api/tests/contracts.test.ts
git commit -m "feat(api): add PUT /api/contracts/:name (STU-139)"
```

---

### Task 5: Write failing tests for DELETE endpoint

**Files:**
- Modify: `api/tests/contracts.test.ts`

**Step 1: Add DELETE tests** (after the PUT describe block)

```typescript
describe('DELETE /api/contracts/:name', () => {
  it('deletes a contract and returns 204', async () => {
    const server = makeServer();
    // Create it first via PUT
    await server.inject({
      method: 'PUT',
      url: '/api/contracts/to-delete',
      payload: { name: 'to-delete', version: 1 },
    });
    const res = await server.inject({ method: 'DELETE', url: '/api/contracts/to-delete' });
    expect(res.statusCode).toBe(204);
    // Verify it's gone
    const getRes = await server.inject({ method: 'GET', url: '/api/contracts/to-delete' });
    expect(getRes.statusCode).toBe(404);
  });

  it('returns 404 for nonexistent contract', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'DELETE', url: '/api/contracts/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('Contract not found');
  });
});
```

**Step 2: Run to verify they fail**

```bash
pnpm --filter @studio/api test 2>&1 | grep -E "DELETE|✗"
```

Expected: 404 responses (route doesn't exist yet).

---

### Task 6: Implement DELETE endpoint + final verification

**Files:**
- Modify: `api/src/routes/contracts.ts`

**Step 1: Add DELETE handler** (after the PUT handler)

```typescript
  // DELETE /api/contracts/:name
  fastify.delete<{ Params: { name: string } }>('/contracts/:name', {
    schema: {
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  }, async (request, reply) => {
    const filePath = join(contractsDir, `${request.params.name}.contract.yaml`);
    try {
      await unlink(filePath);
    } catch {
      return reply.status(404).send({ error: 'Contract not found' });
    }
    return reply.status(204).send();
  });
```

**Step 2: Run full test suite**

```bash
pnpm --filter @studio/api test
```

Expected: all tests pass (GET list, GET by name, PUT create, PUT update, PUT 400s, DELETE 204, DELETE 404).

**Step 3: Run full monorepo build**

```bash
pnpm build
```

Expected: no TypeScript errors.

**Step 4: Final commit**

```bash
git add api/src/routes/contracts.ts api/tests/contracts.test.ts
git commit -m "feat(api): add DELETE /api/contracts/:name (STU-139)"
```

# GET /api/projects/:id/inputs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `GET /api/projects/:id/inputs` to the REST API, listing available `.input.yaml` files for a project.

**Architecture:** Mirror the existing `GET /api/projects/:id/pipelines` route in `api/src/routes/projects.ts`. Same ID validation, same `readdir` + filter + map pattern, same graceful empty-array fallback when the directory is missing.

**Tech Stack:** TypeScript, Fastify, Node.js `fs/promises`

---

### Task 1: Add failing tests

**Files:**
- Modify: `api/tests/projects.test.ts`

**Step 1: Add the test block**

Open `api/tests/projects.test.ts`. The file already has a `PROJECT_TMP` fixture that creates `inputs/faq-about.input.yaml` — no extra setup needed. Append a new describe block at the end of the file:

```typescript
describe('GET /api/projects/:id/inputs', () => {
  it('returns only *.input.yaml files as input names', async () => {
    const server = makeProjectServer();
    const { projects } = (await server.inject({ method: 'GET', url: '/api/projects' })).json() as {
      projects: Array<{ id: string }>;
    };
    const projectId = projects[0].id;

    const res = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/inputs`,
    });
    expect(res.statusCode).toBe(200);

    const { inputs } = res.json() as { inputs: string[] };
    expect(inputs).toContain('faq-about');
    expect(inputs).not.toContain('faq-about.input.yaml');
  });

  it('returns 404 for unknown project id', async () => {
    const server = makeProjectServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/projects/unknown-project/inputs',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns empty array when inputs dir is missing', async () => {
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
      configsDir: resolve('/tmp', `.studio-no-inputs-${Date.now()}`),
      projectName: 'test-project',
      apiConfig: {},
      studioVersion: '0.0.0-test',
      maskedConfig: { providers: [] },
    });
    const { projects } = (await server.inject({ method: 'GET', url: '/api/projects' })).json() as {
      projects: Array<{ id: string }>;
    };
    const projectId = projects[0].id;
    const res = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/inputs`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { inputs: string[] }).inputs).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio-foundation/api test
```

Expected: 3 new tests fail with 404 (route not registered yet).

**Step 3: Commit the failing tests**

```bash
git add api/tests/projects.test.ts
git commit -m "test(api): failing tests for GET /api/projects/:id/inputs (STU-136)"
```

---

### Task 2: Implement the route

**Files:**
- Modify: `api/src/routes/projects.ts:64-98`

**Step 1: Add the route handler**

In `api/src/routes/projects.ts`, add the following block immediately after the closing `});` of the `GET /api/projects/:id/pipelines` handler (after line 98):

```typescript
  // GET /api/projects/:id/inputs
  fastify.get<{ Params: { id: string } }>('/projects/:id/inputs', {
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            inputs: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }, async (request, reply) => {
    if (request.params.id !== id) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const inputsDir = join(configsDir, 'inputs');
    let entries: string[];
    try {
      entries = await readdir(inputsDir);
    } catch {
      return reply.send({ inputs: [] });
    }

    const inputs = entries
      .filter(f => f.endsWith('.input.yaml'))
      .map(f => f.replace('.input.yaml', ''));

    return reply.send({ inputs });
  });
```

**Step 2: Run tests to verify they pass**

```bash
cd /home/arianeguay/dev/src/Studio
pnpm --filter @studio-foundation/api test
```

Expected: all tests pass including the 3 new ones.

**Step 3: Build to verify no type errors**

```bash
pnpm build
```

Expected: exits 0 with no errors.

**Step 4: Commit**

```bash
git add api/src/routes/projects.ts
git commit -m "feat(api): GET /api/projects/:id/inputs (STU-136)"
```

---

### Task 3: Open PR

```bash
git push -u origin $(git branch --show-current)
gh pr create \
  --title "feat(api): GET /api/projects/:id/inputs (STU-136)" \
  --body "$(cat <<'EOF'
## Summary

- Adds `GET /api/projects/:id/inputs` endpoint
- Lists available `.input.yaml` files for a project (names only, suffix stripped)
- Returns `{ inputs: string[] }` — empty array if `inputs/` dir is missing
- Returns 404 for unknown project ID
- Mirrors the existing `GET /api/projects/:id/pipelines` pattern exactly

## Packages touched

- `@studio-foundation/api` — new route in `routes/projects.ts`

## How to test

```bash
pnpm --filter @studio-foundation/api test
```

Closes STU-136
EOF
)" \
  --base main
```

# API CRUD Skills Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add REST endpoints to manage `.skill.md` files in `.studio/skills/` via `GET/PUT/DELETE /api/skills`.

**Architecture:** New `skillsRoutes` Fastify plugin in `api/src/routes/skills.ts`, registered in `server.ts`. Skills are stored as `<name>.skill.md` files; the API returns/accepts raw markdown wrapped in JSON `{ content: string }`. Pattern is identical to `agentsRoutes` except files are `.skill.md` and content is plain text (not YAML).

**Tech Stack:** Node.js `fs/promises`, Fastify, TypeScript, Vitest.

---

### Task 1: Write failing tests for `GET /api/skills` and `GET /api/skills/:name`

**Files:**
- Create: `api/tests/skills.test.ts`

**Step 1: Create the test file**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { InMemoryRunStore } from '@studio/engine';

const TMP = resolve('/tmp', `.studio-skills-test-${Date.now()}`);
const SKILLS_DIR = resolve(TMP, 'skills');

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
  mkdirSync(SKILLS_DIR, { recursive: true });
  writeFileSync(resolve(SKILLS_DIR, 'commit-conventions.skill.md'), '# Commit Conventions\nUse conventional commits.');
  writeFileSync(resolve(SKILLS_DIR, 'react-patterns.skill.md'), '# React Patterns\nPrefer hooks over HOCs.');
  writeFileSync(resolve(SKILLS_DIR, 'ignored.md'), ''); // must be ignored
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('GET /api/skills', () => {
  it('returns only *.skill.md files as skill names', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/skills' });
    expect(res.statusCode).toBe(200);
    const { skills } = res.json() as { skills: string[] };
    expect(skills).toContain('commit-conventions');
    expect(skills).toContain('react-patterns');
    expect(skills).not.toContain('ignored');
    expect(skills).not.toContain('commit-conventions.skill.md');
  });

  it('returns empty array when skills dir is missing', async () => {
    const server = buildServer({
      store: new InMemoryRunStore(),
      launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
      configsDir: resolve('/tmp', `.studio-no-skills-${Date.now()}`),
      projectName: 'test-project',
      apiConfig: {},
      studioVersion: '0.0.0-test',
      maskedConfig: { providers: [] },
    });
    const res = await server.inject({ method: 'GET', url: '/api/skills' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { skills: string[] }).skills).toEqual([]);
  });
});

describe('GET /api/skills/:name', () => {
  it('returns skill content as JSON', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/skills/commit-conventions' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; content: string };
    expect(body.name).toBe('commit-conventions');
    expect(body.content).toContain('conventional commits');
  });

  it('returns 404 for unknown skill', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'GET', url: '/api/skills/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('Skill not found');
  });
});

describe('PUT /api/skills/:name', () => {
  it('creates a new skill file', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/skills/new-skill',
      payload: { content: '# New Skill\nSome instructions.' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; content: string };
    expect(body.name).toBe('new-skill');
    expect(body.content).toContain('New Skill');
    // Verify it can be read back
    const getRes = await server.inject({ method: 'GET', url: '/api/skills/new-skill' });
    expect(getRes.statusCode).toBe(200);
    expect((getRes.json() as { content: string }).content).toContain('New Skill');
  });

  it('updates an existing skill', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/skills/react-patterns',
      payload: { content: '# React Patterns\nUpdated content.' },
    });
    expect(res.statusCode).toBe(200);
    const getRes = await server.inject({ method: 'GET', url: '/api/skills/react-patterns' });
    expect((getRes.json() as { content: string }).content).toContain('Updated content');
  });

  it('returns 400 when content field is missing', async () => {
    const server = makeServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/skills/foo',
      payload: { name: 'foo' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/skills/:name', () => {
  it('deletes a skill and returns 204', async () => {
    const server = makeServer();
    await server.inject({
      method: 'PUT',
      url: '/api/skills/to-delete',
      payload: { content: '# To Delete' },
    });
    const res = await server.inject({ method: 'DELETE', url: '/api/skills/to-delete' });
    expect(res.statusCode).toBe(204);
    const getRes = await server.inject({ method: 'GET', url: '/api/skills/to-delete' });
    expect(getRes.statusCode).toBe(404);
  });

  it('returns 404 for nonexistent skill', async () => {
    const server = makeServer();
    const res = await server.inject({ method: 'DELETE', url: '/api/skills/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('Skill not found');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd /home/arianeguay/dev/src/Studio/.worktrees/stu-142-api-crud-skills
pnpm --filter @studio/api test 2>&1 | grep -E "FAIL|skills|passed|failed"
```

Expected: tests fail because `/api/skills` route doesn't exist (404 responses).

---

### Task 2: Implement `api/src/routes/skills.ts`

**Files:**
- Create: `api/src/routes/skills.ts`

**Step 1: Create the route file**

```typescript
import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.js';

export async function skillsRoutes(
  fastify: FastifyInstance,
  options: { deps: ServerDeps }
): Promise<void> {
  const skillsDir = join(options.deps.configsDir, 'skills');

  // GET /api/skills
  fastify.get('/skills', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            skills: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }, async (_request, reply) => {
    let entries: string[];
    try {
      entries = await readdir(skillsDir);
    } catch {
      return reply.send({ skills: [] });
    }
    const skills = entries
      .filter(f => f.endsWith('.skill.md'))
      .map(f => f.slice(0, -'.skill.md'.length));
    return reply.send({ skills });
  });

  // GET /api/skills/:name
  fastify.get<{ Params: { name: string } }>('/skills/:name', {
    schema: {
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  }, async (request, reply) => {
    const filePath = join(skillsDir, `${request.params.name}.skill.md`);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return reply.status(404).send({ error: 'Skill not found' });
    }
    return reply.send({ name: request.params.name, content });
  });

  // PUT /api/skills/:name
  fastify.put<{
    Params: { name: string };
    Body: Record<string, unknown>;
  }>('/skills/:name', {
    schema: {
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const { content } = request.body;

    if (typeof content !== 'string') {
      return reply.status(400).send({ error: "Skill must have a 'content' field (string)" });
    }

    await mkdir(skillsDir, { recursive: true });
    const filePath = join(skillsDir, `${request.params.name}.skill.md`);
    await writeFile(filePath, content, 'utf-8');

    return reply.send({ name: request.params.name, content });
  });

  // DELETE /api/skills/:name
  fastify.delete<{ Params: { name: string } }>('/skills/:name', {
    schema: {
      params: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  }, async (request, reply) => {
    const filePath = join(skillsDir, `${request.params.name}.skill.md`);
    try {
      await unlink(filePath);
    } catch {
      return reply.status(404).send({ error: 'Skill not found' });
    }
    return reply.status(204).send();
  });
}
```

**Step 2: Run tests — they should still fail** (route not registered yet)

```bash
pnpm --filter @studio/api test 2>&1 | grep -E "skills|passed|failed"
```

---

### Task 3: Register `skillsRoutes` in `server.ts`

**Files:**
- Modify: `api/src/server.ts`

**Step 1: Add import and register call**

In `api/src/server.ts`, add after the `agentsRoutes` import:
```typescript
import { skillsRoutes } from './routes/skills.js';
```

And after the `agentsRoutes` registration line:
```typescript
void fastify.register(skillsRoutes, { prefix: '/api', deps });
```

**Step 2: Run tests — all should pass**

```bash
pnpm --filter @studio/api test 2>&1 | tail -8
```

Expected:
```
Test Files  11 passed (11)
      Tests  XX passed (XX)
```

**Step 3: Build to confirm no TypeScript errors**

```bash
pnpm build 2>&1 | tail -5
```

Expected: no errors.

**Step 4: Commit**

```bash
cd /home/arianeguay/dev/src/Studio/.worktrees/stu-142-api-crud-skills
git add api/src/routes/skills.ts api/src/server.ts api/tests/skills.test.ts
git commit -m "feat(api): CRUD skills endpoints (STU-142)"
```

# Design: API CRUD Skills (STU-142)

## Context

Skills (`.skill.md`) are markdown files in `.studio/skills/` injected into agent system prompts. A web interface needs to create and modify them via the REST API.

## Endpoints

```
GET    /api/skills           → { skills: string[] }
GET    /api/skills/:name     → { name: string, content: string }
PUT    /api/skills/:name     → body: { content: string } → { name: string, content: string }
DELETE /api/skills/:name     → 204 No Content
```

## File Handling

- Directory: `join(configsDir, 'skills')`
- Files: `<name>.skill.md`
- GET list: reads dir, filters `*.skill.md`, strips `.skill.md` suffix; returns `[]` if dir missing
- GET /:name: reads file, returns `{ name, content: rawMarkdownString }`; 404 if not found
- PUT /:name: validates `content` is a string, `mkdir` recursive, writes `<name>.skill.md`
- DELETE /:name: unlinks file; 404 if not found, 204 on success

## Validation (PUT)

Single check: `content` must be present and a string (400 otherwise). No structure validation — markdown is free-form.

## Response Format

JSON throughout, consistent with other CRUD routes (`agents`, `contracts`, `pipelines`).

## Implementation

**New file:** `api/src/routes/skills.ts` — `skillsRoutes(fastify, options)` following the `agentsRoutes` pattern.

**Modified:** `api/src/server.ts` — register `skillsRoutes` with prefix `/api`.

**New test file:** `api/tests/skills.test.ts` — covers GET list, GET /:name, PUT, DELETE with the same structure as `agents.test.ts`.

# STU-148 — GET /api/project (project introspection) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `GET /api/project` endpoint that returns a single-call snapshot of the current Studio project: version, config (keys masked), and lists of all resource names.

**Architecture:** Compute `studioVersion` and `maskedConfig` once at bootstrap, inject via `ServerDeps`. The route handler scans six subdirectories of `configsDir` in parallel and assembles the response. Missing dirs return `[]` gracefully.

**Tech Stack:** TypeScript, Fastify, Node.js `fs/promises.readdir`, ESM `import.meta.url` for package.json lookup.

---

### Task 1: Extend `ServerDeps` and `BootstrapResult` interfaces

**Files:**
- Modify: `api/src/server.ts`
- Modify: `api/src/bootstrap.ts`

**Step 1: Add two fields to `ServerDeps` in `server.ts`**

In `api/src/server.ts`, extend the `ServerDeps` interface:

```typescript
export interface ServerDeps {
  store: RunStore;
  launcher: RunLauncher;
  configsDir: string;
  projectName: string;
  apiConfig: ApiConfig;
  studioVersion: string;
  maskedConfig: {
    defaults?: { provider?: string; model?: string };
    providers: string[];
  };
}
```

**Step 2: Add same fields to `BootstrapResult` in `bootstrap.ts`**

In `api/src/bootstrap.ts`, extend the `BootstrapResult` interface:

```typescript
export interface BootstrapResult {
  store: RunStore;
  launcher: RunLauncher;
  configsDir: string;
  projectName: string;
  apiConfig: { key?: string; port?: number };
  cleanup: () => Promise<void>;
  studioVersion: string;
  maskedConfig: {
    defaults?: { provider?: string; model?: string };
    providers: string[];
  };
}
```

**Step 3: Typecheck only (no logic yet)**

```bash
cd /path/to/Studio && pnpm --filter @studio-foundation/api typecheck
```

Expected: errors about missing fields in the `return` statement of `bootstrap()`. That's expected — we haven't wired the values yet.

**Step 4: Commit the interface stubs**

```bash
git add api/src/server.ts api/src/bootstrap.ts
git commit -m "feat(api): extend ServerDeps + BootstrapResult for studioVersion and maskedConfig (STU-148)"
```

---

### Task 2: Write failing tests for `GET /api/project`

**Files:**
- Modify: `api/tests/projects.test.ts`

**Step 1: Add fixtures and test describe block**

In `api/tests/projects.test.ts`, after the existing `afterAll` block and `makeServer` helper, add:

```typescript
// ─── Fixtures for GET /api/project ──────────────────────────────────────────

const PROJECT_TMP = resolve('/tmp', `.studio-project-introspection-test-${Date.now()}`);

function makeProjectServer(opts: {
  withConfig?: boolean;
  withSkills?: boolean;
} = {}) {
  return buildServer({
    store: new InMemoryRunStore(),
    launcher: { launch: async () => ({ run_id: 'x' }), cancel: async () => {} },
    configsDir: PROJECT_TMP,
    projectName: 'my-project',
    apiConfig: {},
    studioVersion: '1.2.3',
    maskedConfig: opts.withConfig
      ? { defaults: { provider: 'anthropic', model: 'claude-haiku' }, providers: ['anthropic'] }
      : { providers: [] },
  });
}

beforeAll(() => {
  // pipelines
  mkdirSync(resolve(PROJECT_TMP, 'pipelines'), { recursive: true });
  writeFileSync(resolve(PROJECT_TMP, 'pipelines', 'feature-builder.pipeline.yaml'), '');
  writeFileSync(resolve(PROJECT_TMP, 'pipelines', 'bug-fixer.pipeline.yaml'), '');
  writeFileSync(resolve(PROJECT_TMP, 'pipelines', 'ignored.yaml'), ''); // must be ignored

  // contracts
  mkdirSync(resolve(PROJECT_TMP, 'contracts'), { recursive: true });
  writeFileSync(resolve(PROJECT_TMP, 'contracts', 'brief-analysis.contract.yaml'), '');
  writeFileSync(resolve(PROJECT_TMP, 'contracts', 'code-generation.contract.yaml'), '');

  // agents
  mkdirSync(resolve(PROJECT_TMP, 'agents'), { recursive: true });
  writeFileSync(resolve(PROJECT_TMP, 'agents', 'analyst.agent.yaml'), '');
  writeFileSync(resolve(PROJECT_TMP, 'agents', 'coder.agent.yaml'), '');

  // tools
  mkdirSync(resolve(PROJECT_TMP, 'tools'), { recursive: true });
  writeFileSync(resolve(PROJECT_TMP, 'tools', 'repo_manager-read_file.tool.yaml'), '');

  // inputs
  mkdirSync(resolve(PROJECT_TMP, 'inputs'), { recursive: true });
  writeFileSync(resolve(PROJECT_TMP, 'inputs', 'faq-about.input.yaml'), '');

  // NOTE: no skills/ dir — intentionally absent
});

afterAll(() => {
  rmSync(PROJECT_TMP, { recursive: true, force: true });
});

describe('GET /api/project', () => {
  it('returns all resource lists and metadata', async () => {
    const server = makeProjectServer({ withConfig: true });
    const res = await server.inject({ method: 'GET', url: '/api/project' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    expect(body.studio_version).toBe('1.2.3');
    expect(body.studio_dir).toBe(PROJECT_TMP);
    expect(body.pipelines).toEqual(expect.arrayContaining(['feature-builder', 'bug-fixer']));
    expect((body.pipelines as string[])).not.toContain('ignored');
    expect(body.contracts).toEqual(expect.arrayContaining(['brief-analysis', 'code-generation']));
    expect(body.agents).toEqual(expect.arrayContaining(['analyst', 'coder']));
    expect(body.tools).toEqual(expect.arrayContaining(['repo_manager-read_file']));
    expect(body.inputs).toEqual(expect.arrayContaining(['faq-about']));
  });

  it('returns empty array for missing skills/ directory', async () => {
    const server = makeProjectServer();
    const res = await server.inject({ method: 'GET', url: '/api/project' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { skills: string[] }).skills).toEqual([]);
  });

  it('includes masked config with provider names only', async () => {
    const server = makeProjectServer({ withConfig: true });
    const res = await server.inject({ method: 'GET', url: '/api/project' });
    const body = res.json() as { config: { providers: string[]; defaults: Record<string, string> } };
    expect(body.config.providers).toEqual(['anthropic']);
    expect(body.config.defaults?.provider).toBe('anthropic');
  });

  it('returns empty providers when no config', async () => {
    const server = makeProjectServer({ withConfig: false });
    const res = await server.inject({ method: 'GET', url: '/api/project' });
    const body = res.json() as { config: { providers: string[] } };
    expect(body.config.providers).toEqual([]);
  });
});
```

**Step 2: Run tests — expect failure**

```bash
pnpm --filter @studio-foundation/api test
```

Expected: TypeScript compile errors because `studioVersion` and `maskedConfig` aren't yet accepted by `buildServer`, OR runtime 404 because route doesn't exist.

**Step 3: Commit the tests**

```bash
git add api/tests/projects.test.ts
git commit -m "test(api): add failing tests for GET /api/project (STU-148)"
```

---

### Task 3: Implement bootstrap — read version + build maskedConfig

**Files:**
- Modify: `api/src/bootstrap.ts`

**Step 1: Add `readFile` import if not present and `fileURLToPath`**

At the top of `bootstrap.ts`, the `readFile` import from `node:fs/promises` is already present. Add `fileURLToPath` from `node:url`:

```typescript
import { fileURLToPath } from 'node:url';
```

**Step 2: Read version and build maskedConfig inside `bootstrap()`**

Inside the `bootstrap()` function, after the `config` is loaded (around line 70, after the `try/catch` that loads `config.yaml`), add:

```typescript
// Read studio version from api/package.json
const pkgPath = new URL('../../package.json', import.meta.url);
const pkgRaw = await readFile(fileURLToPath(pkgPath), 'utf-8');
const studioVersion = (JSON.parse(pkgRaw) as { version: string }).version;

// Build masked config — provider names only, no API keys
const maskedConfig = {
  defaults: config.defaults,
  providers: Object.keys(config.providers ?? {}),
};
```

**Step 3: Add both to the return object**

In the `return` statement at the bottom of `bootstrap()`, add the two new fields:

```typescript
return {
  store,
  launcher,
  configsDir: studioDir,
  projectName,
  apiConfig: config.api ?? {},
  cleanup: async () => { ... },
  studioVersion,
  maskedConfig,
};
```

**Step 4: Typecheck**

```bash
pnpm --filter @studio-foundation/api typecheck
```

Expected: no errors (all fields now present in return + interfaces match).

**Step 5: Commit**

```bash
git add api/src/bootstrap.ts
git commit -m "feat(api): compute studioVersion and maskedConfig in bootstrap (STU-148)"
```

---

### Task 4: Implement `GET /api/project` route

**Files:**
- Modify: `api/src/routes/projects.ts`

**Step 1: Update the destructuring in `projectsRoutes` to include new deps**

Change the top of `projectsRoutes` from:

```typescript
const { configsDir, projectName } = options.deps;
```

to:

```typescript
const { configsDir, projectName, studioVersion, maskedConfig } = options.deps;
```

**Step 2: Add a `listResources` helper at the top of the file (after imports)**

```typescript
async function listResources(dir: string, suffix: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter(f => f.endsWith(suffix))
      .map(f => f.slice(0, -suffix.length));
  } catch {
    return [];
  }
}
```

**Step 3: Add the route handler inside `projectsRoutes`**

After the existing routes, add:

```typescript
// GET /api/project — full introspection of the current Studio project
fastify.get('/project', async (_request, reply) => {
  const [pipelines, contracts, agents, tools, skills, inputs] = await Promise.all([
    listResources(join(configsDir, 'pipelines'), '.pipeline.yaml'),
    listResources(join(configsDir, 'contracts'), '.contract.yaml'),
    listResources(join(configsDir, 'agents'), '.agent.yaml'),
    listResources(join(configsDir, 'tools'), '.tool.yaml'),
    listResources(join(configsDir, 'skills'), '.skill.md'),
    listResources(join(configsDir, 'inputs'), '.input.yaml'),
  ]);

  return reply.send({
    studio_version: studioVersion,
    studio_dir: configsDir,
    config: maskedConfig,
    pipelines,
    contracts,
    agents,
    tools,
    skills,
    inputs,
  });
});
```

**Step 4: Run tests**

```bash
pnpm --filter @studio-foundation/api test
```

Expected: all tests pass, including the new `GET /api/project` describe block.

**Step 5: Build**

```bash
pnpm build
```

Expected: clean build, no TypeScript errors.

**Step 6: Commit**

```bash
git add api/src/routes/projects.ts
git commit -m "feat(api): add GET /api/project introspection endpoint (STU-148)"
```

---

### Task 5: Wire bootstrap into server entry point

**Files:**
- Modify: `api/src/api.ts` (or wherever `bootstrap()` result is passed to `buildServer`)

**Step 1: Check how bootstrap feeds into buildServer**

Read `api/src/api.ts` to confirm the call site. It should look like:

```typescript
const result = await bootstrap();
const server = buildServer(result);
```

Since `BootstrapResult` now matches `ServerDeps` (same fields), no change is needed if the spread is direct. Verify with:

```bash
pnpm --filter @studio-foundation/api typecheck
```

Expected: no errors.

**Step 2: Run full test suite one final time**

```bash
pnpm --filter @studio-foundation/api test
```

Expected: all tests green.

**Step 3: Final build**

```bash
pnpm build
```

Expected: clean.

**Step 4: Commit if any wiring was needed**

```bash
git add api/src/api.ts  # only if changed
git commit -m "chore(api): wire studioVersion + maskedConfig from bootstrap to server (STU-148)"
```

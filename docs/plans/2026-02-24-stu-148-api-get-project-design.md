# STU-148 — Design: GET /api/project (project introspection)

## Context

A web interface needs a single call to discover everything available in the current Studio project before launching runs or rendering forms. Currently no global introspection endpoint exists.

## Endpoint

```
GET /api/project
```

No parameters. Returns the complete state of the `.studio/` directory detected at API startup.

## Response shape

```json
{
  "studio_version": "0.1.0",
  "studio_dir": "/abs/path/to/.studio",
  "config": {
    "defaults": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" },
    "providers": ["anthropic"]
  },
  "pipelines": ["feature-builder", "bug-fixer"],
  "contracts": ["brief-analysis", "code-generation", "qa-review"],
  "agents": ["analyst", "coder"],
  "tools": ["repo_manager-read_file", "repo_manager-write_file"],
  "skills": ["commit-conventions"],
  "inputs": ["faq-about"]
}
```

- `providers` is a list of **names only** — no API keys exposed.
- Missing subdirectories (e.g. no `skills/` yet) return `[]`, not an error.

## Approach: extend ServerDeps (Option A)

Two new fields are computed once at bootstrap time and injected into every route via `ServerDeps`:

| Field | Type | Computed in |
|-------|------|-------------|
| `studioVersion` | `string` | `bootstrap.ts` — reads `api/package.json` via `import.meta.url` |
| `maskedConfig` | `{ defaults?, providers: string[] }` | `bootstrap.ts` — derived from already-loaded config |

### Why at bootstrap, not at request time?

- Version never changes during the process lifetime.
- Config is already parsed in `bootstrap.ts` — no point re-reading YAML on every request.
- Keeps route handlers thin and testable with plain objects.

## Changes by file

### `api/src/bootstrap.ts`

- Read `api/package.json` for `version` using `fileURLToPath(import.meta.url)`.
- Build `maskedConfig` from the already-loaded `config`: extract `defaults`, collect `Object.keys(config.providers ?? {})` as provider names.
- Add `studioVersion: string` and `maskedConfig` to `BootstrapResult`.

### `api/src/server.ts`

- Add `studioVersion: string` and `maskedConfig` to `ServerDeps`.
- Pass both through from `BootstrapResult` into the server.

### `api/src/routes/projects.ts`

New route alongside existing ones:

```
GET /api/project
```

Handler scans 6 directories in parallel with `Promise.all`:

| Dir | Pattern | Strip |
|-----|---------|-------|
| `pipelines/` | `*.pipeline.yaml` | `.pipeline.yaml` |
| `contracts/` | `*.contract.yaml` | `.contract.yaml` |
| `agents/` | `*.agent.yaml` | `.agent.yaml` |
| `tools/` | `*.tool.yaml` | `.tool.yaml` |
| `skills/` | `*.skill.md` | `.skill.md` |
| `inputs/` | `*.input.yaml` | `.input.yaml` |

Each `readdir` is wrapped in a try/catch — missing dir → `[]`.

## Tests

New `describe('GET /api/project', ...)` in `api/tests/projects.test.ts`:

- Fixture: TMP dir with `pipelines/`, `contracts/`, `agents/`, `tools/`, `inputs/` populated; `skills/` intentionally absent.
- Assert all top-level fields are present.
- Assert each resource list is correctly parsed (suffix stripped, non-matching files excluded).
- Assert `skills` is `[]` when dir is missing.
- Assert `studio_dir` equals the absolute `configsDir`.
- Assert `config.providers` is `["anthropic"]` (name only) when config has an anthropic key.
- Assert `config.providers` is `[]` when no providers configured.

## Acceptance criteria (from issue)

- [ ] `GET /api/project` returns all resource lists
- [ ] Config included with API keys masked (provider names only)
- [ ] `studio_version` included
- [ ] `studio_dir` (absolute path to `.studio/`) included

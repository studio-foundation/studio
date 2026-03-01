# STU-169 Modular Distribution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the static `@studio/api` dependency from `@studio/cli` and replace it with dynamic loading + `studio install api` / `studio api stop|status` commands.

**Architecture:** Move `resolveRepoPath` to `@studio/engine` (no server deps), demote `@studio/api` to devDependency in the CLI, load it dynamically at runtime when `studio api start` is invoked. Write a PID file so `stop`/`status` work from a second terminal.

**Tech Stack:** TypeScript, Vitest, Node.js builtins (`child_process`, `fs/promises`, `os`), Commander

---

### Task 1: Move `resolveRepoPath` to `@studio/engine`

**Files:**
- Create: `engine/tests/repo-resolver.test.ts`
- Create: `engine/src/repo-resolver.ts`
- Modify: `engine/src/index.ts`

**Step 1: Write the failing test**

Create `engine/tests/repo-resolver.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { homedir } from 'node:os';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { resolveRepoPath, cloneRepo } from '../src/repo-resolver.js';
import { execSync } from 'node:child_process';

const mockExecSync = vi.mocked(execSync);

afterEach(() => {
  vi.unstubAllEnvs();
  mockExecSync.mockClear();
});

describe('resolveRepoPath', () => {
  it('returns resolved repoPathOverride when provided', async () => {
    const result = await resolveRepoPath({ repoPathOverride: 'my-project', pipelineName: 'p' });
    expect(result).toMatch(/my-project$/);
  });

  it('returns "." when no repoPathOverride and no repoUrl', async () => {
    const result = await resolveRepoPath({ pipelineName: 'feature-builder' });
    expect(result).toBe('.');
  });

  it('throws when repoUrl is set but no rawProjectsDir and no env var', async () => {
    vi.stubEnv('STUDIO_PROJECTS_DIR', '');
    await expect(
      resolveRepoPath({ repoUrl: 'https://github.com/user/repo', pipelineName: 'p' })
    ).rejects.toThrow('STUDIO_PROJECTS_DIR is not set');
  });

  it('clones when repoUrl is provided with rawProjectsDir', async () => {
    const result = await resolveRepoPath({
      repoUrl: 'https://github.com/user/repo',
      rawProjectsDir: '/tmp/projects',
      pipelineName: 'my-pipeline',
    });
    expect(mockExecSync).toHaveBeenCalledOnce();
    const cmd = mockExecSync.mock.calls[0]![0] as string;
    expect(cmd).toContain('git clone');
    expect(cmd).toContain('https://github.com/user/repo');
    expect(result).toContain('/tmp/projects/my-pipeline-');
  });

  it('clones when repoUrl is provided via STUDIO_PROJECTS_DIR env var', async () => {
    vi.stubEnv('STUDIO_PROJECTS_DIR', '/tmp/envprojects');
    const result = await resolveRepoPath({
      repoUrl: 'https://github.com/user/repo',
      pipelineName: 'test-pipe',
    });
    expect(mockExecSync).toHaveBeenCalledOnce();
    expect(result).toContain('/tmp/envprojects/test-pipe-');
  });

  it('expands ~ in rawProjectsDir', async () => {
    const result = await resolveRepoPath({
      repoUrl: 'https://github.com/user/repo',
      rawProjectsDir: '~/projects',
      pipelineName: 'p',
    });
    expect(result).toContain(homedir() + '/projects/p-');
  });

  it('repoPathOverride takes precedence over repoUrl', async () => {
    const result = await resolveRepoPath({
      repoPathOverride: '/explicit/path',
      repoUrl: 'https://github.com/user/repo',
      rawProjectsDir: '/tmp/p',
      pipelineName: 'p',
    });
    expect(result).toBe('/explicit/path');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('passes branch arg when branch is set', async () => {
    await resolveRepoPath({
      repoUrl: 'https://github.com/user/repo',
      rawProjectsDir: '/tmp/projects',
      pipelineName: 'p',
      branch: 'main',
    });
    const cmd = mockExecSync.mock.calls[0]![0] as string;
    expect(cmd).toContain('--branch main');
  });
});

describe('cloneRepo', () => {
  it('throws a descriptive error when git clone fails', async () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('repository not found'); });
    await expect(
      cloneRepo('https://github.com/bad/repo', '/tmp/p', 'pipeline')
    ).rejects.toThrow('Failed to clone https://github.com/bad/repo');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd .worktrees/stu-169/engine && pnpm test
```
Expected: FAIL — "Cannot find module '../src/repo-resolver.js'"

**Step 3: Create `engine/src/repo-resolver.ts`**

Copy the implementation verbatim from `api/src/utils/repo-resolver.ts`:

```typescript
import { execSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

export interface RepoResolveOptions {
  repoPathOverride?: string;
  repoUrl?: string;
  rawProjectsDir?: string;
  pipelineName: string;
  branch?: string;
}

export async function cloneRepo(
  repoUrl: string,
  projectsDir: string,
  pipelineName: string,
  branch?: string
): Promise<string> {
  await mkdir(projectsDir, { recursive: true });

  const timestamp = new Date().toISOString()
    .replace(/:/g, 'h')
    .replace(/\..+$/, '')
    .replace('T', 'T');
  const dirName = `${pipelineName}-${timestamp}`;
  const clonePath = join(projectsDir, dirName);

  const branchArg = branch ? `--branch ${branch}` : '';
  const cmd = `git clone --depth 1 ${branchArg} ${repoUrl} ${clonePath}`;

  try {
    execSync(cmd, { stdio: 'pipe' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to clone ${repoUrl}: ${msg}`);
  }

  return clonePath;
}

export async function resolveRepoPath(options: RepoResolveOptions): Promise<string> {
  const { repoPathOverride, repoUrl, rawProjectsDir, pipelineName, branch } = options;

  if (repoPathOverride) {
    return resolve(repoPathOverride);
  }

  if (repoUrl) {
    const rawDir = rawProjectsDir || process.env['STUDIO_PROJECTS_DIR'];
    const projectsDir = rawDir?.replace(/^~/, homedir());
    if (!projectsDir) {
      throw new Error(
        'STUDIO_PROJECTS_DIR is not set. Set it in config.yaml paths.projects_dir or as an environment variable.'
      );
    }
    return cloneRepo(repoUrl, projectsDir, pipelineName, branch);
  }

  return '.';
}
```

**Step 4: Export from `engine/src/index.ts`**

Add at the end of `engine/src/index.ts`:

```typescript
// Repo resolution
export { resolveRepoPath, cloneRepo } from './repo-resolver.js';
export type { RepoResolveOptions } from './repo-resolver.js';
```

**Step 5: Run tests to verify they pass**

```bash
cd .worktrees/stu-169/engine && pnpm test
```
Expected: all engine tests pass

**Step 6: Commit**

```bash
cd .worktrees/stu-169
git add engine/src/repo-resolver.ts engine/src/index.ts engine/tests/repo-resolver.test.ts
git commit -m "feat(engine): add resolveRepoPath and cloneRepo utilities (STU-169)"
```

---

### Task 2: Update API to re-export from engine

**Files:**
- Modify: `api/src/utils/repo-resolver.ts`

**Step 1: Replace implementation with re-export**

Replace the entire content of `api/src/utils/repo-resolver.ts` with:

```typescript
// Re-exported from @studio/engine — implementation lives there
export { resolveRepoPath, cloneRepo } from '@studio/engine';
export type { RepoResolveOptions } from '@studio/engine';
```

**Step 2: Run API tests to verify no regressions**

```bash
cd .worktrees/stu-169/api && pnpm test
```
Expected: all API tests pass (the `api/tests/utils/repo-resolver.test.ts` still passes because the tests import from `../../src/utils/repo-resolver.js` which now re-exports from engine)

**Step 3: Commit**

```bash
cd .worktrees/stu-169
git add api/src/utils/repo-resolver.ts
git commit -m "refactor(api): re-export resolveRepoPath from @studio/engine (STU-169)"
```

---

### Task 3: Update CLI `run.ts` import

**Files:**
- Modify: `cli/src/commands/run.ts:8`

**Step 1: Update the import**

In `cli/src/commands/run.ts`, change line 8:

```typescript
// Before:
import { resolveRepoPath } from '@studio/api';

// After:
import { resolveRepoPath } from '@studio/engine';
```

**Step 2: Run CLI tests**

```bash
cd .worktrees/stu-169/cli && pnpm test
```
Expected: all CLI tests pass

**Step 3: Commit**

```bash
cd .worktrees/stu-169
git add cli/src/commands/run.ts
git commit -m "refactor(cli): import resolveRepoPath from @studio/engine (STU-169)"
```

---

### Task 4: Move `@studio/api` to devDependency in CLI

**Files:**
- Modify: `cli/package.json`

**Step 1: Update `cli/package.json`**

Move `"@studio/api": "workspace:*"` from `dependencies` to `devDependencies`:

```json
{
  "dependencies": {
    "@inquirer/prompts": "^8.2.1",
    "@studio/contracts": "workspace:*",
    "@studio/engine": "workspace:*",
    "@studio/runner": "workspace:*",
    "chalk": "^5.6.2",
    "commander": "^14.0.3",
    "dotenv": "^17.3.1",
    "js-yaml": "^4.1.1",
    "ora": "^9.3.0"
  },
  "devDependencies": {
    "@studio/api": "workspace:*",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^25.2.3",
    "typescript": "^5.3.0",
    "vitest": "^4.0.18"
  }
}
```

**Step 2: Re-run pnpm install and build**

```bash
cd .worktrees/stu-169
pnpm install
pnpm build
```
Expected: build succeeds — TypeScript still resolves `@studio/api` types because it's in devDependencies

**Step 3: Run CLI tests**

```bash
cd .worktrees/stu-169/cli && pnpm test
```
Expected: all CLI tests pass

**Step 4: Commit**

```bash
cd .worktrees/stu-169
git add cli/package.json pnpm-lock.yaml
git commit -m "build(cli): move @studio/api to devDependencies (STU-169)"
```

---

### Task 5: Rewrite `commands/api.ts` — dynamic import + PID daemon

**Files:**
- Create: `cli/tests/commands/api.test.ts`
- Modify: `cli/src/commands/api.ts`

**Step 1: Write the failing tests**

Create `cli/tests/commands/api.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';

// Override PID file location for tests
const TEST_PID_FILE = join(tmpdir(), `.studio-api-test-${process.pid}.pid`);

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => tmpdir() };
});

// Import after mocking
const { apiStopCommand, apiStatusCommand, writePid, readPid, clearPid, isProcessAlive } = await import('../../src/commands/api.js');

afterEach(async () => {
  try { await unlink(TEST_PID_FILE); } catch {}
});

describe('writePid / readPid / clearPid', () => {
  it('writes and reads PID with port', async () => {
    await writePid(3700);
    const entry = await readPid();
    expect(entry).not.toBeNull();
    expect(entry!.pid).toBe(process.pid);
    expect(entry!.port).toBe(3700);
  });

  it('readPid returns null when no file exists', async () => {
    const entry = await readPid();
    expect(entry).toBeNull();
  });

  it('clearPid removes the file', async () => {
    await writePid(3700);
    await clearPid();
    const entry = await readPid();
    expect(entry).toBeNull();
  });
});

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    // PID 999999999 is very unlikely to exist
    expect(isProcessAlive(999999999)).toBe(false);
  });
});

describe('apiStopCommand', () => {
  it('prints "not running" when no PID file', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await apiStopCommand();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
    consoleSpy.mockRestore();
  });

  it('prints "stale PID" and clears file when process is dead', async () => {
    await writePid(3700);
    // Overwrite with a dead PID
    const pidFile = join(tmpdir(), '.studio', 'api.pid');
    await writeFile(pidFile, '999999999:3700', 'utf-8');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await apiStopCommand();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('stale'));
    expect(await readPid()).toBeNull();
    consoleSpy.mockRestore();
  });

  it('sends SIGTERM and clears PID when process is the current process', async () => {
    await writePid(3700);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await apiStopCommand();

    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(await readPid()).toBeNull();
    killSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

describe('apiStatusCommand', () => {
  it('prints "not running" when no PID file', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await apiStatusCommand({});
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
    consoleSpy.mockRestore();
  });

  it('prints "running" when process is alive and health check succeeds', async () => {
    await writePid(3700);
    // Override with current PID (alive) and mock fetch
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await apiStatusCommand({});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('running'));
    consoleSpy.mockRestore();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd .worktrees/stu-169/cli && pnpm test tests/commands/api.test.ts
```
Expected: FAIL — "writePid is not exported"

**Step 3: Rewrite `cli/src/commands/api.ts`**

```typescript
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../config.js';

interface ApiOptions {
  port?: string;
  config?: string;
}

function pidFilePath(): string {
  return join(homedir(), '.studio', 'api.pid');
}

export async function writePid(port: number): Promise<void> {
  await mkdir(join(homedir(), '.studio'), { recursive: true });
  await writeFile(pidFilePath(), `${process.pid}:${port}`, 'utf-8');
}

export async function readPid(): Promise<{ pid: number; port: number } | null> {
  try {
    const content = await readFile(pidFilePath(), 'utf-8');
    const [pidStr, portStr] = content.trim().split(':');
    const pid = parseInt(pidStr ?? '', 10);
    const port = parseInt(portStr ?? '', 10);
    if (isNaN(pid) || isNaN(port)) return null;
    return { pid, port };
  } catch {
    return null;
  }
}

export async function clearPid(): Promise<void> {
  try { await unlink(pidFilePath()); } catch {}
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function apiStartCommand(options: ApiOptions): Promise<void> {
  let apiModule: typeof import('@studio/api');
  try {
    apiModule = await import('@studio/api');
  } catch {
    console.error('API not installed. Run: studio install api');
    process.exit(1);
  }

  const { bootstrap, buildServer } = apiModule;
  const config = await loadConfig(options.config);
  const cwd = config.resolvedStudioDir
    ? config.resolvedStudioDir.replace(/\/.studio$/, '')
    : process.cwd();

  let result: Awaited<ReturnType<typeof bootstrap>>;
  try {
    result = await bootstrap(cwd);
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { store, launcher, configsDir, projectName, apiConfig, cleanup, studioVersion, maskedConfig, webhookStore, integrationStore, integrationRuntime } = result;
  const port = options.port ? parseInt(options.port, 10) : (apiConfig.port ?? 3700);
  const server = buildServer({ store, launcher, configsDir, projectName, apiConfig, studioVersion, maskedConfig, webhookStore, integrationStore, integrationRuntime });

  await writePid(port);

  const shutdown = async () => {
    await server.close();
    await cleanup();
    await clearPid();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await server.listen({ port, host: '0.0.0.0' });
  console.log(`Studio API running on http://localhost:${port}`);
}

export async function apiStopCommand(): Promise<void> {
  const entry = await readPid();
  if (!entry) {
    console.log('Studio API is not running.');
    return;
  }
  if (!isProcessAlive(entry.pid)) {
    await clearPid();
    console.log('Studio API is not running (stale PID file removed).');
    return;
  }
  process.kill(entry.pid, 'SIGTERM');
  await clearPid();
  console.log('Studio API stopped.');
}

export async function apiStatusCommand(options: ApiOptions): Promise<void> {
  const entry = await readPid();
  if (!entry) {
    console.log('Studio API: not running');
    return;
  }
  if (!isProcessAlive(entry.pid)) {
    await clearPid();
    console.log('Studio API: not running (stale PID file removed)');
    return;
  }
  const port = options.port ? parseInt(options.port, 10) : entry.port;
  try {
    const response = await fetch(`http://localhost:${port}/api/health`);
    if (response.ok) {
      console.log(`Studio API: running on port ${port} (PID ${entry.pid})`);
    } else {
      console.log(`Studio API: process alive (PID ${entry.pid}) but not responding on port ${port}`);
    }
  } catch {
    console.log(`Studio API: process alive (PID ${entry.pid}) but port ${port} not responding`);
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
cd .worktrees/stu-169/cli && pnpm test tests/commands/api.test.ts
```
Expected: all api.test.ts tests pass

**Step 5: Run full CLI test suite**

```bash
cd .worktrees/stu-169/cli && pnpm test
```
Expected: all CLI tests pass

**Step 6: Commit**

```bash
cd .worktrees/stu-169
git add cli/src/commands/api.ts cli/tests/commands/api.test.ts
git commit -m "feat(cli): rewrite api command with dynamic import + PID daemon (STU-169)"
```

---

### Task 6: Update `cli/src/index.ts` — add stop/status routing

**Files:**
- Modify: `cli/src/index.ts`

**Step 1: Update the `studio api` command block**

In `cli/src/index.ts`, replace the existing `studio api` command block (lines ~125-138):

```typescript
// Before:
program
  .command('api <action>')
  .description('Manage the Studio API server (start)')
  .option('--port <port>', 'Port to listen on (default: 3700)')
  .option('--config <path>', 'Path to config file')
  .action((action: string, options: { port?: string; config?: string }) => {
    if (action === 'start') {
      void apiStartCommand(options);
    } else {
      console.error(`Unknown api action: ${action}. Use: studio api start`);
      process.exit(1);
    }
  });
```

Replace with:

```typescript
program
  .command('api <action>')
  .description('Manage the Studio API server (start, stop, status)')
  .option('--port <port>', 'Port to listen on (default: 3700)')
  .option('--config <path>', 'Path to config file')
  .action((action: string, options: { port?: string; config?: string }) => {
    if (action === 'start') {
      void apiStartCommand(options);
    } else if (action === 'stop') {
      void apiStopCommand();
    } else if (action === 'status') {
      void apiStatusCommand(options);
    } else {
      console.error(`Unknown api action: ${action}. Use: studio api start|stop|status`);
      process.exit(1);
    }
  });
```

Also update the import at the top of `index.ts` to include the new exports:

```typescript
// Before:
import { apiStartCommand } from './commands/api.js';

// After:
import { apiStartCommand, apiStopCommand, apiStatusCommand } from './commands/api.js';
```

**Step 2: Run CLI tests**

```bash
cd .worktrees/stu-169/cli && pnpm test
```
Expected: all tests pass

**Step 3: Commit**

```bash
cd .worktrees/stu-169
git add cli/src/index.ts
git commit -m "feat(cli): add studio api stop and status commands (STU-169)"
```

---

### Task 7: Add `studio install api` command

**Files:**
- Create: `cli/tests/commands/install.test.ts`
- Create: `cli/src/commands/install.ts`
- Modify: `cli/src/index.ts`

**Step 1: Write the failing test**

Create `cli/tests/commands/install.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { installExtensionCommand } from '../../src/commands/install.js';

const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
  mockExecSync.mockClear();
});

describe('installExtensionCommand', () => {
  it('runs npm install -g @studio/api when extension is "api"', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await installExtensionCommand('api');

    expect(mockExecSync).toHaveBeenCalledWith('npm install -g @studio/api', { stdio: 'inherit' });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('@studio/api installed'));
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with error for unknown extension', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(installExtensionCommand('web')).rejects.toThrow('exit');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown extension'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with error when npm install fails', async () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('npm ERR! 404'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(installExtensionCommand('api')).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd .worktrees/stu-169/cli && pnpm test tests/commands/install.test.ts
```
Expected: FAIL — "Cannot find module '../../src/commands/install.js'"

**Step 3: Create `cli/src/commands/install.ts`**

```typescript
import { execSync } from 'node:child_process';
import chalk from 'chalk';

const KNOWN_EXTENSIONS: Record<string, string> = {
  api: '@studio/api',
};

export async function installExtensionCommand(extension: string): Promise<void> {
  const pkg = KNOWN_EXTENSIONS[extension];
  if (!pkg) {
    console.error(`Unknown extension: ${extension}. Available: ${Object.keys(KNOWN_EXTENSIONS).join(', ')}`);
    process.exit(1);
  }

  console.log(`Installing ${pkg}...`);
  try {
    execSync(`npm install -g ${pkg}`, { stdio: 'inherit' });
    console.log(chalk.green(`✓ ${pkg} installed. Run: studio api start`));
  } catch {
    console.error(chalk.red(`Failed to install ${pkg}`));
    process.exit(1);
  }
}
```

**Step 4: Register in `cli/src/index.ts`**

Add the import at the top:
```typescript
import { installExtensionCommand } from './commands/install.js';
```

Add the command before `program.parse()`:
```typescript
program
  .command('install <extension>')
  .description('Install a Studio extension (api)')
  .action((extension: string) => {
    void installExtensionCommand(extension);
  });
```

**Step 5: Run new tests to verify they pass**

```bash
cd .worktrees/stu-169/cli && pnpm test tests/commands/install.test.ts
```
Expected: all install tests pass

**Step 6: Run full CLI test suite**

```bash
cd .worktrees/stu-169/cli && pnpm test
```
Expected: all CLI tests pass

**Step 7: Commit**

```bash
cd .worktrees/stu-169
git add cli/src/commands/install.ts cli/tests/commands/install.test.ts cli/src/index.ts
git commit -m "feat(cli): add studio install api command (STU-169)"
```

---

### Task 8: Final verification

**Step 1: Full monorepo build**

```bash
cd .worktrees/stu-169 && pnpm build
```
Expected: all packages build without errors

**Step 2: Full test suite across all packages**

```bash
cd .worktrees/stu-169 && pnpm test
```
Expected: all tests pass across contracts, ralph, runner, engine, api, cli

**Step 3: Verify `@studio/api` is not in CLI runtime dependencies**

```bash
node -e "
const pkg = JSON.parse(require('fs').readFileSync('.worktrees/stu-169/cli/package.json','utf8'));
const hasDep = '@studio/api' in (pkg.dependencies ?? {});
console.log('@studio/api in dependencies:', hasDep);
console.log('@studio/api in devDependencies:', '@studio/api' in (pkg.devDependencies ?? {}));
"
```
Expected:
```
@studio/api in dependencies: false
@studio/api in devDependencies: true
```

**Step 4: Commit if any last changes**

No commit needed if all changes were committed in prior tasks.

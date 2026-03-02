# Script Executor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an `executor: script` option to pipeline stages so deterministic scripts (Python, Node, shell) can run without an LLM, while keeping RALPH validation and retry intact.

**Architecture:** `executor`, `script`, and `runtime` fields are added to `StageDefinition`. The engine makes agent loading conditional on `stageDef.agent` being present. A new `runScript()` function in the runner handles subprocess execution (stdin JSON → stdout JSON). The engine calls `runScript()` or `runAgent()` based on whether an agent config was loaded — the runner owns the knowledge of what each executor does.

**Tech Stack:** Node.js `child_process.spawn`, TypeScript, vitest, existing @studio/contracts + @studio/runner + @studio/engine packages.

---

### Task 1: Update `StageDefinition` in contracts — make `agent` optional, add script fields

**Files:**
- Modify: `contracts/src/pipeline.ts:59-77`

**Step 1: Write the failing type test**

In `contracts/src/pipeline.ts`, there is no test file — this is a type-only change. We verify it compiles correctly in Task 5.

**Step 2: Update `StageDefinition`**

In `contracts/src/pipeline.ts`, replace the `StageDefinition` interface:

```typescript
export interface StageDefinition {
  name: string;
  kind?: StageKind;
  agent?: string;           // optional — not needed for script executor
  executor?: string;        // 'script' or absent (defaults to LLM)
  script?: string;          // path to script file (required when executor: 'script')
  runtime?: 'python' | 'node' | 'shell'; // runtime for script executor
  timeout_ms?: number;      // script timeout in ms (default: 30000)
  contract?: string;
  ralph?: {
    max_attempts: number;
    retry_strategy: string;
    max_tool_calls?: number;
  };
  context?: {
    include: string[];
    packs?: string[];
  };
  tools?: {
    required?: string[];
  };
  hooks?: StageHooks;
}
```

**Step 3: Build to verify no type errors**

Run: `pnpm --filter @studio/contracts build`
Expected: success, no errors

**Step 4: Commit**

```bash
git add contracts/src/pipeline.ts
git commit -m "feat(contracts): make StageDefinition.agent optional, add executor/script/runtime/timeout_ms fields"
```

---

### Task 2: Make `raw_response` optional in `AgentRunResult`

**Files:**
- Modify: `runner/src/runner.ts:27-40`

**Context:** Script stages have no LLM response. `raw_response` is only assigned within `runner.ts` itself (lines 181, 344, 365) and never read outside the runner package. Making it optional avoids a type cast in the script executor.

**Step 1: Update the interface**

In `runner/src/runner.ts`, change line 31 from:

```typescript
  raw_response: LLMResponse;
```

to:

```typescript
  raw_response?: LLMResponse;
```

**Step 2: Build to verify**

Run: `pnpm --filter @studio/runner build`
Expected: success. The field is only assigned (never read as required) outside the runner — so no downstream type errors.

**Step 3: Run runner tests**

Run: `pnpm --filter @studio/runner test`
Expected: all pass

**Step 4: Commit**

```bash
git add runner/src/runner.ts
git commit -m "feat(runner): make AgentRunResult.raw_response optional — script executor has no LLM response"
```

---

### Task 3: Create `runner/src/script-executor.ts` — TDD

**Files:**
- Create: `runner/src/__tests__/script-executor.test.ts`
- Create: `runner/src/script-executor.ts`

**Step 1: Write the failing tests**

Create `runner/src/__tests__/script-executor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';

// Mock child_process and fs before importing the module under test
vi.mock('node:child_process');
vi.mock('node:fs');

import { runScript } from '../script-executor.js';
import type { AgentContext } from '../prompt-builder.js';

function makeContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    input: 'test input',
    ...overrides,
  } as AgentContext;
}

function makeSpawnMock(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  errorEvent?: Error;
}) {
  const proc = new EventEmitter() as ReturnType<typeof cp.spawn>;
  (proc as any).stdout = new EventEmitter();
  (proc as any).stderr = new EventEmitter();
  (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
  (proc as any).kill = vi.fn();

  vi.mocked(cp.spawn).mockReturnValue(proc as any);

  // Simulate async process lifecycle
  setTimeout(() => {
    if (opts.errorEvent) {
      proc.emit('error', opts.errorEvent);
      return;
    }
    if (opts.stdout) (proc as any).stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) (proc as any).stderr.emit('data', Buffer.from(opts.stderr));
    proc.emit('close', opts.exitCode ?? 0);
  }, 10);

  return proc;
}

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.clearAllMocks();
});

describe('runScript', () => {
  it('parses stdout JSON and returns output on exit 0', async () => {
    const output = { result: 'ok', count: 42 };
    makeSpawnMock({ stdout: JSON.stringify(output), exitCode: 0 });

    const result = await runScript({
      scriptPath: 'scripts/parse.py',
      runtime: 'python',
      context: makeContext(),
    });

    expect(result.output).toEqual(output);
    expect(result.tool_calls).toEqual([]);
    expect(result.tool_calls_count).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('sets error when script exits with non-zero code', async () => {
    makeSpawnMock({ stdout: '', stderr: 'FileNotFoundError', exitCode: 1 });

    const result = await runScript({
      scriptPath: 'scripts/parse.py',
      runtime: 'python',
      context: makeContext(),
    });

    expect(result.output).toBeNull();
    expect(result.error).toMatch(/exited with code 1/);
    expect(result.error).toMatch(/FileNotFoundError/);
  });

  it('sets error when stdout is not valid JSON', async () => {
    makeSpawnMock({ stdout: 'not json at all', exitCode: 0 });

    const result = await runScript({
      scriptPath: 'scripts/parse.py',
      runtime: 'python',
      context: makeContext(),
    });

    expect(result.output).toBeNull();
    expect(result.error).toMatch(/not valid JSON/);
    expect(result.error).toMatch(/not json at all/);
  });

  it('sets error on process spawn error', async () => {
    const proc = new EventEmitter() as ReturnType<typeof cp.spawn>;
    (proc as any).stdout = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
    vi.mocked(cp.spawn).mockReturnValue(proc as any);
    setTimeout(() => proc.emit('error', new Error('ENOENT: python3 not found')), 10);

    const result = await runScript({
      scriptPath: 'scripts/parse.py',
      runtime: 'python',
      context: makeContext(),
    });

    expect(result.error).toMatch(/process error/);
    expect(result.error).toMatch(/ENOENT/);
  });

  it('uses python3 command for python runtime', async () => {
    makeSpawnMock({ stdout: '{}', exitCode: 0 });

    await runScript({ scriptPath: 'scripts/parse.py', runtime: 'python', context: makeContext() });

    expect(vi.mocked(cp.spawn)).toHaveBeenCalledWith(
      'python3',
      ['scripts/parse.py'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('uses node command for node runtime', async () => {
    makeSpawnMock({ stdout: '{}', exitCode: 0 });

    await runScript({ scriptPath: 'scripts/parse.js', runtime: 'node', context: makeContext() });

    expect(vi.mocked(cp.spawn)).toHaveBeenCalledWith('node', ['scripts/parse.js'], expect.anything());
  });

  it('uses sh command for shell runtime', async () => {
    makeSpawnMock({ stdout: '{}', exitCode: 0 });

    await runScript({ scriptPath: 'scripts/run.sh', runtime: 'shell', context: makeContext() });

    expect(vi.mocked(cp.spawn)).toHaveBeenCalledWith('sh', ['scripts/run.sh'], expect.anything());
  });

  it('activates venv when venv/ directory exists', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('venv'));
    makeSpawnMock({ stdout: '{}', exitCode: 0 });

    await runScript({
      scriptPath: 'scripts/parse.py',
      runtime: 'python',
      context: makeContext(),
      cwd: '/project',
    });

    const spawnCall = vi.mocked(cp.spawn).mock.calls[0];
    const spawnEnv = (spawnCall[2] as any).env;
    expect(spawnEnv.VIRTUAL_ENV).toBe('/project/venv');
    expect(spawnEnv.PATH).toContain('/project/venv/bin');
  });

  it('writes context JSON to stdin', async () => {
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    const proc = new EventEmitter() as ReturnType<typeof cp.spawn>;
    (proc as any).stdout = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    (proc as any).stdin = stdinMock;
    vi.mocked(cp.spawn).mockReturnValue(proc as any);
    setTimeout(() => {
      (proc as any).stdout.emit('data', Buffer.from('{"ok":true}'));
      proc.emit('close', 0);
    }, 10);

    const ctx = makeContext({ input: 'hello world' });
    await runScript({ scriptPath: 'scripts/parse.py', runtime: 'python', context: ctx });

    expect(stdinMock.write).toHaveBeenCalledWith(JSON.stringify(ctx));
    expect(stdinMock.end).toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter @studio/runner test runner/src/__tests__/script-executor.test.ts`
Expected: FAIL — `runScript` not found

**Step 3: Implement `runner/src/script-executor.ts`**

Create `runner/src/script-executor.ts`:

```typescript
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunResult } from './runner.js';
import type { AgentContext } from './prompt-builder.js';

export interface ScriptExecutorConfig {
  scriptPath: string;
  runtime: 'python' | 'node' | 'shell';
  context: AgentContext;
  cwd?: string;
  timeoutMs?: number;
}

const RUNTIME_COMMANDS: Record<string, string> = {
  python: 'python3',
  node: 'node',
  shell: 'sh',
};

function buildEnv(runtime: string, cwd: string): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;

  if (runtime === 'python') {
    const venvPath = existsSync(join(cwd, 'venv'))
      ? join(cwd, 'venv')
      : existsSync(join(cwd, '.venv'))
        ? join(cwd, '.venv')
        : null;

    if (venvPath) {
      env.VIRTUAL_ENV = venvPath;
      env.PATH = `${join(venvPath, 'bin')}:${env.PATH ?? ''}`;
    }
  }

  return env;
}

export async function runScript(config: ScriptExecutorConfig): Promise<AgentRunResult> {
  const startTime = Date.now();
  const cwd = config.cwd ?? process.cwd();
  const timeoutMs = config.timeoutMs ?? 30_000;
  const cmd = RUNTIME_COMMANDS[config.runtime];
  const env = buildEnv(config.runtime, cwd);
  const stdin = JSON.stringify(config.context);

  return new Promise((resolve) => {
    const proc = spawn(cmd, [config.scriptPath], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 1000);
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.stdin.write(stdin);
    proc.stdin.end();

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - startTime;

      if (timedOut) {
        resolve({ output: null, tool_calls: [], tool_calls_count: 0, duration_ms, error: `Script timed out after ${timeoutMs}ms` });
        return;
      }

      if (exitCode !== 0) {
        resolve({ output: null, tool_calls: [], tool_calls_count: 0, duration_ms, error: `Script exited with code ${exitCode}: ${stderr.trim()}` });
        return;
      }

      let output: unknown;
      try {
        output = JSON.parse(stdout.trim());
      } catch {
        resolve({ output: null, tool_calls: [], tool_calls_count: 0, duration_ms, error: `Script output is not valid JSON: ${stdout.slice(0, 200)}` });
        return;
      }

      resolve({ output, tool_calls: [], tool_calls_count: 0, duration_ms });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ output: null, tool_calls: [], tool_calls_count: 0, duration_ms: Date.now() - startTime, error: `Script process error: ${err.message}` });
    });
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @studio/runner test runner/src/__tests__/script-executor.test.ts`
Expected: all 9 tests pass

**Step 5: Commit**

```bash
git add runner/src/script-executor.ts runner/src/__tests__/script-executor.test.ts
git commit -m "feat(runner): add runScript() — script executor for deterministic stages without LLM"
```

---

### Task 4: Export `runScript` from runner package

**Files:**
- Modify: `runner/src/index.ts`

**Step 1: Add export**

In `runner/src/index.ts`, after the `export { runAgent }` line (line 6), add:

```typescript
// Script executor
export { runScript } from './script-executor.js';
export type { ScriptExecutorConfig } from './script-executor.js';
```

**Step 2: Build**

Run: `pnpm --filter @studio/runner build`
Expected: success

**Step 3: Commit**

```bash
git add runner/src/index.ts
git commit -m "feat(runner): export runScript and ScriptExecutorConfig from package"
```

---

### Task 5: Update engine to support script stages — TDD

**Files:**
- Create: `engine/src/__tests__/engine.script-stage.test.ts`
- Modify: `engine/src/engine.ts`

**Context:** The engine currently hardcodes `loadAgentProfile(stageDef.agent, ...)` unconditionally and calls `runAgent()` inside the RALPH executor. For script stages (`!stageDef.agent`), we skip agent loading and call `runScript()` instead. The engine checks `stageDef.agent` (not `executor`) — it's the runner that knows what `executor: 'script'` means.

**Step 1: Find an existing engine test to understand test patterns**

Run: `ls engine/src/__tests__/`
Read one existing test to understand how the engine is tested (mock provider, mock filesystem, etc.)

**Step 2: Write failing engine integration tests**

Create `engine/src/__tests__/engine.script-stage.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { PipelineEngine } from '../engine.js';
import type { PipelineDefinition } from '@studio/contracts';

// Mock runScript from runner to avoid real subprocess spawning
vi.mock('@studio/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@studio/runner')>();
  return {
    ...actual,
    runScript: vi.fn(),
  };
});

import { runScript } from '@studio/runner';

const FIXTURES_DIR = resolve(__dirname, '__fixtures__/script-stage');

// Minimal test fixture: a pipeline with one script stage
const SCRIPT_PIPELINE: PipelineDefinition = {
  name: 'test-script-pipeline',
  description: 'Test pipeline with script stage',
  version: 1,
  stages: [
    {
      name: 'epub-ingestion',
      executor: 'script',
      script: 'scripts/parse.py',
      runtime: 'python',
      contract: 'book-context',
    },
  ],
};

function makeEngine() {
  return new PipelineEngine({
    configsDir: FIXTURES_DIR,
    // providerRegistry not needed for script stages — but EngineConfig requires it
    // Pass a mock registry that won't be called
    providerRegistry: {} as any,
  });
}

describe('engine — script stage execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes a script stage and returns success when output matches contract', async () => {
    vi.mocked(runScript).mockResolvedValue({
      output: { title: 'My Book', chapters: 3 },
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 50,
    });

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: SCRIPT_PIPELINE,
      userInput: 'parse book.epub',
    });

    expect(result.status).toBe('success');
    expect(result.stages[0]?.status).toBe('success');
    expect(result.stages[0]?.output).toEqual({ title: 'My Book', chapters: 3 });
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runScript)).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptPath: 'scripts/parse.py',
        runtime: 'python',
      }),
    );
  });

  it('retries on non-zero exit (runScript returns error)', async () => {
    const scriptError = {
      output: null,
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
      error: 'Script exited with code 1: parse error',
    };
    // Fail twice, succeed on third attempt
    vi.mocked(runScript)
      .mockResolvedValueOnce(scriptError)
      .mockResolvedValueOnce(scriptError)
      .mockResolvedValue({
        output: { title: 'My Book', chapters: 3 },
        tool_calls: [],
        tool_calls_count: 0,
        duration_ms: 50,
      });

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: {
        ...SCRIPT_PIPELINE,
        stages: [{
          ...SCRIPT_PIPELINE.stages[0],
          ralph: { max_attempts: 3, retry_strategy: 'none' },
        }],
      },
      userInput: 'parse book.epub',
    });

    expect(result.status).toBe('success');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(3);
  });

  it('fails stage after exhausting max_attempts', async () => {
    vi.mocked(runScript).mockResolvedValue({
      output: null,
      tool_calls: [],
      tool_calls_count: 0,
      duration_ms: 10,
      error: 'Script exited with code 1: always failing',
    });

    const engine = makeEngine();
    const result = await engine.run({
      pipelineDef: {
        ...SCRIPT_PIPELINE,
        stages: [{
          ...SCRIPT_PIPELINE.stages[0],
          ralph: { max_attempts: 2, retry_strategy: 'none' },
        }],
      },
      userInput: 'parse book.epub',
    });

    expect(result.status).toBe('failed');
    expect(result.stages[0]?.status).toBe('failed');
    expect(vi.mocked(runScript)).toHaveBeenCalledTimes(2);
  });
});
```

**Note:** You'll also need to create a minimal `__fixtures__/script-stage/` directory with an empty `contracts/book-context.contract.yaml` (no required fields, so any JSON passes). Look at how existing engine tests set up fixtures to follow the same pattern.

**Step 3: Run tests to verify they fail**

Run: `pnpm --filter @studio/engine test engine/src/__tests__/engine.script-stage.test.ts`
Expected: FAIL — compilation errors or engine doesn't handle script stages yet

**Step 4: Update `engine/src/engine.ts` — make agent loading conditional**

**4a. Add `runScript` import** (add to the existing `@studio/runner` import block around line 36-44):

```typescript
import {
  runAgent,
  runScript,          // ADD THIS
  type AgentRunResult,
  ...
} from '@studio/runner';
```

**4b. Make agent loading conditional** (around line 449). Replace:

```typescript
// Load agent profile
const agentConfig = await loadAgentProfile(stageDef.agent, paths.agentsDir);
if (this.config.providerOverride) {
  agentConfig.provider = this.config.providerOverride;
}
// Inject plugin skills...
if (agentConfig.plugins?.length && this.config.pluginSkills) { ... }
// Inject project skills...
if (agentConfig.skills?.length) { ... }
// Inject project domain invariants...
if (pipelineContext.invariantsContent) { ... }
```

With:

```typescript
// Load agent profile — only for LLM stages (script stages have no agent)
let agentConfig: Awaited<ReturnType<typeof loadAgentProfile>> | null = null;
if (stageDef.agent) {
  agentConfig = await loadAgentProfile(stageDef.agent, paths.agentsDir);
  if (this.config.providerOverride) {
    agentConfig.provider = this.config.providerOverride;
  }
  // Inject plugin skills...
  if (agentConfig.plugins?.length && this.config.pluginSkills) { ... }
  // Inject project skills...
  if (agentConfig.skills?.length) { ... }
  // Inject project domain invariants...
  if (pipelineContext.invariantsContent) { ... }
}
```

**4c. Guard the `onStageContext` event** (around line 510, which reads `agentConfig.system_prompt`):

```typescript
// ...(includePrompt ? { system_prompt: agentConfig.system_prompt } : {}),
// becomes:
...(includePrompt && agentConfig ? { system_prompt: agentConfig.system_prompt } : {}),
```

**4d. Guard the stage middleware** (around line 532, which reads `agentConfig.anonymize`):

```typescript
// const stageMiddleware = (!runMiddleware && agentConfig.anonymize)
// becomes:
const stageMiddleware = (!runMiddleware && agentConfig?.anonymize)
  ? new AnonymizationMiddleware()
  : null;
```

**4e. Update the RALPH executor closure** (around line 639). Replace the `runAgent()` call with a conditional:

```typescript
const result = stageDef.agent
  ? await runAgent({
      agent: agentConfig!,
      task: taskInput,
      context: agentContext,
      executionContext: runnerExecContext,
      toolRegistry: toolRegistry,
      providerRegistry: this.config.providerRegistry,
      outputContract: contract ?? undefined,
      maxToolCalls: stageDef.ralph?.max_tool_calls,
      anonymizationMiddleware: runMiddleware ?? stageMiddleware ?? undefined,
      signal,
      callbacks: { ... },  // unchanged
    })
  : await runScript({
      scriptPath: stageDef.script!,
      runtime: stageDef.runtime ?? 'shell' as const,
      context: agentContext,
      cwd: this.config.repoPath ?? this.config.configsDir,
      timeoutMs: stageDef.timeout_ms,
    });
```

**4f. Guard `agentConfig.name` in the AgentRun recording** (around line 676):

```typescript
const agentRun: AgentRun = {
  id: agentRunId,
  agent_name: agentConfig?.name ?? `script:${stageDef.script ?? 'unknown'}`,
  ...
};
```

**Step 5: Build the engine**

Run: `pnpm --filter @studio/engine build`
Expected: success, no TypeScript errors

**Step 6: Run the new tests**

Run: `pnpm --filter @studio/engine test engine/src/__tests__/engine.script-stage.test.ts`
Expected: all 3 tests pass

**Step 7: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass (no regression)

**Step 8: Commit**

```bash
git add engine/src/engine.ts engine/src/__tests__/engine.script-stage.test.ts
git commit -m "feat(engine): support executor:script stages — conditional agent loading, runScript dispatch"
```

---

### Task 6: Final build + full test run

**Step 1: Full build**

Run: `pnpm build`
Expected: all packages build successfully

**Step 2: Full test suite**

Run: `pnpm test`
Expected: all tests pass

**Step 3: Commit if any cleanup needed, then push**

```bash
git push -u origin arianedguay/stu-114-stage-executor-script-stages-deterministes-sans-llm-multi
```

---

## Acceptance Criteria Checklist

- [ ] `executor: script` supporté dans le pipeline YAML (`StageDefinition`)
- [ ] Script reçoit input en stdin JSON, retourne output en stdout JSON
- [ ] Runtime `python` (`python3`) et `node` supportés, plus `shell` (`sh`)
- [ ] Détection venv Python (venv/ ou .venv/) avec activation PATH
- [ ] Output validé par contract (RALPH loop intact, aucun changement)
- [ ] Retry fonctionne si exit non-zero ou output JSON invalide
- [ ] `executor` absent → comportement LLM inchangé
- [ ] `pnpm build` passe
- [ ] `pnpm test` passe

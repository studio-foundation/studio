# Mock Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `--provider mock` CLI flag that runs any pipeline with zero LLM API calls, using predefined outputs from a per-project `mock.yaml` config.

**Architecture:** `MockProvider implements AgentLoopProvider` in runner. It reads `request.stage_name` (new optional field in `LLMRequest`) to look up predefined outputs from a YAML config. The engine accepts a `providerOverride` to force all stages through mock. Real tool calls are executed (real filesystem writes), tokens = 0.

**Tech Stack:** TypeScript, Vitest, js-yaml (already used in CLI), existing provider interfaces in `@studio/contracts` and `@studio/runner`.

---

### Task 1: Add `stage_name?` to `LLMRequest` in contracts

**Files:**
- Modify: `contracts/src/provider.ts` (line 8-14)

**Step 1: Add the field**

In `contracts/src/provider.ts`, change:

```typescript
export interface LLMRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
  stage_name?: string;  // add this line
}
```

**Step 2: Build contracts**

```bash
cd contracts && npm run build
```
Expected: no errors.

**Step 3: Run contracts tests**

```bash
cd contracts && npm run test
```
Expected: all pass (the field is additive).

**Step 4: Commit**

```bash
git add contracts/src/provider.ts
git commit -m "feat(contracts): add optional stage_name to LLMRequest"
```

---

### Task 2: Pass `stage_name` in runner when building LLMRequest

**Files:**
- Modify: `runner/src/runner.ts` (lines 82–95 and 126–133 — the two places where `LLMRequest` is built inline)

**Step 1: Update the AgentLoopProvider branch (line ~82)**

Find the block:
```typescript
const loopResult = await provider.runAgentLoop(
  {
    model: agent.model,
    messages,
    tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
  },
```

Change to:
```typescript
const loopResult = await provider.runAgentLoop(
  {
    model: agent.model,
    messages,
    tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    stage_name: task.contract_name,
  },
```

**Step 2: Update the standard loop branch (line ~126)**

Find:
```typescript
const response = await provider.call({
  model: agent.model,
  messages: currentMessages,
  tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
  temperature: agent.temperature,
  max_tokens: agent.max_tokens
});
```

Change to:
```typescript
const response = await provider.call({
  model: agent.model,
  messages: currentMessages,
  tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
  temperature: agent.temperature,
  max_tokens: agent.max_tokens,
  stage_name: task.contract_name,
});
```

**Step 3: Build runner**

```bash
cd runner && npm run build
```
Expected: no errors.

**Step 4: Run runner tests**

```bash
cd runner && npm run test
```
Expected: all pass (stage_name is optional, existing tests unaffected).

**Step 5: Commit**

```bash
git add runner/src/runner.ts
git commit -m "feat(runner): pass stage_name in LLMRequest for mock support"
```

---

### Task 3: Create `MockProvider`

**Files:**
- Create: `runner/src/providers/mock.ts`
- Create: `runner/tests/mock-provider.test.ts`
- Modify: `runner/src/index.ts` (add export)

**Step 1: Write the failing test**

Create `runner/tests/mock-provider.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MockProvider } from '../src/providers/mock.js';

const stagesMap = new Map([
  ['brief-analysis', {
    output: { summary: 'mock summary', requirements: ['req1'] },
    tool_calls: [],
  }],
  ['code-generation', {
    output: { summary: 'mock code', files_changed: ['foo.ts'] },
    tool_calls: [
      { name: 'repo_manager-write_file', arguments: { path: 'foo.ts', content: '// mock' } },
    ],
  }],
]);

describe('MockProvider', () => {
  it('returns predefined output for a known stage', async () => {
    const provider = new MockProvider(stagesMap);
    const executeTool = vi.fn().mockResolvedValue({ result: 'ok' });

    const result = await provider.runAgentLoop(
      {
        model: 'mock',
        messages: [],
        stage_name: 'brief-analysis',
      },
      executeTool
    );

    expect(result.content).toBe(JSON.stringify({ summary: 'mock summary', requirements: ['req1'] }));
    expect(result.tool_calls).toHaveLength(0);
    expect(result.finish_reason).toBe('stop');
    expect(result.usage?.total_tokens).toBe(0);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('calls executeTool for each tool call in config', async () => {
    const provider = new MockProvider(stagesMap);
    const executeTool = vi.fn().mockResolvedValue({ result: 'written' });

    const result = await provider.runAgentLoop(
      {
        model: 'mock',
        messages: [],
        stage_name: 'code-generation',
      },
      executeTool
    );

    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool).toHaveBeenCalledWith(
      'repo_manager-write_file',
      { path: 'foo.ts', content: '// mock' },
      expect.any(String)
    );
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].name).toBe('repo_manager-write_file');
  });

  it('throws a clear error for unknown stage', async () => {
    const provider = new MockProvider(stagesMap);

    await expect(
      provider.runAgentLoop({ model: 'mock', messages: [], stage_name: 'unknown-stage' }, vi.fn())
    ).rejects.toThrow('Unknown mock stage: "unknown-stage"');
  });

  it('throws when stage_name is missing', async () => {
    const provider = new MockProvider(stagesMap);

    await expect(
      provider.runAgentLoop({ model: 'mock', messages: [] }, vi.fn())
    ).rejects.toThrow('MockProvider requires stage_name');
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
cd runner && npm run test tests/mock-provider.test.ts
```
Expected: FAIL — `MockProvider` not found.

**Step 3: Implement `MockProvider`**

Create `runner/src/providers/mock.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import type { LLMRequest, LLMResponse } from '@studio/contracts';
import type { AgentLoopProvider, AgentLoopResult, ToolCallOutcome } from './provider.js';

export interface MockStageConfig {
  output: Record<string, unknown>;
  tool_calls: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

export class MockProvider implements AgentLoopProvider {
  readonly name = 'mock';

  constructor(private readonly stages: Map<string, MockStageConfig>) {}

  async call(_request: LLMRequest): Promise<LLMResponse> {
    return {
      content: '{}',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  async runAgentLoop(
    request: LLMRequest,
    executeTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolCallOutcome>
  ): Promise<AgentLoopResult> {
    if (!request.stage_name) {
      throw new Error('MockProvider requires stage_name in LLMRequest');
    }

    const config = this.stages.get(request.stage_name);
    if (!config) {
      throw new Error(
        `Unknown mock stage: "${request.stage_name}". Add it to mock.yaml.`
      );
    }

    const toolCallResults: AgentLoopResult['tool_calls'] = [];

    for (const tc of config.tool_calls) {
      const callId = randomUUID();
      const outcome = await executeTool(tc.name, tc.arguments, callId);
      toolCallResults.push({ id: callId, name: tc.name, arguments: tc.arguments, ...outcome });
    }

    return {
      content: JSON.stringify(config.output),
      tool_calls: toolCallResults,
      finish_reason: 'stop',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
cd runner && npm run test tests/mock-provider.test.ts
```
Expected: all 4 tests pass.

**Step 5: Export from runner index**

In `runner/src/index.ts`, add after the existing provider exports:

```typescript
export { MockProvider } from './providers/mock.js';
export type { MockStageConfig } from './providers/mock.js';
```

**Step 6: Build runner**

```bash
cd runner && npm run build
```
Expected: no errors.

**Step 7: Run all runner tests**

```bash
cd runner && npm run test
```
Expected: all pass.

**Step 8: Commit**

```bash
git add runner/src/providers/mock.ts runner/tests/mock-provider.test.ts runner/src/index.ts
git commit -m "feat(runner): add MockProvider for zero-cost pipeline testing"
```

---

### Task 4: Add `providerOverride` to engine

**Files:**
- Modify: `engine/src/engine.ts` (EngineConfig interface ~line 80, executeStage ~line 320)

**Step 1: Write the failing test**

In `engine/tests/engine.test.ts`, add a new test (look at existing tests for the pattern — the engine tests use a stub provider). Add:

```typescript
it('providerOverride forces all stages to use the specified provider', async () => {
  // Build a mock provider that records which provider was used
  const mockProvider = {
    name: 'mock',
    call: vi.fn().mockResolvedValue({ content: '{"summary":"ok"}', tool_calls: [], finish_reason: 'stop' }),
    runAgentLoop: vi.fn().mockResolvedValue({
      content: '{"summary":"ok"}',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  };

  const registry = new ProviderRegistry();
  registry.register(mockProvider);

  const engine = new PipelineEngine(
    {
      configsDir: '...',    // use test fixtures
      providerRegistry: registry,
      toolRegistry: new ToolRegistry(),
      providerOverride: 'mock',  // the new field
    },
    {}
  );
  // ... run and assert mockProvider.runAgentLoop was called
});
```

Note: If adding this test is complex given existing fixture setup, write a simpler integration-style check. The key invariant: when `providerOverride` is set, `agentConfig.provider` is replaced before registry lookup.

**Step 2: Run existing engine tests to confirm baseline**

```bash
cd engine && npm run test
```
Expected: all pass (no changes yet).

**Step 3: Add `providerOverride` to `EngineConfig`**

In `engine/src/engine.ts`, change:

```typescript
export interface EngineConfig {
  configsDir: string;
  repoPath?: string;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  db?: RunStore;
  providerOverride?: string;  // add this line
}
```

**Step 4: Use `providerOverride` in `executeStage`**

In `executeStage()`, find the line (around line 321):

```typescript
const agentConfig = await loadAgentProfile(stageDef.agent, paths.agentsDir);
```

Add immediately after:

```typescript
if (this.config.providerOverride) {
  agentConfig.provider = this.config.providerOverride;
}
```

**Step 5: Build engine**

```bash
cd engine && npm run build
```
Expected: no errors.

**Step 6: Run engine tests**

```bash
cd engine && npm run test
```
Expected: all pass.

**Step 7: Commit**

```bash
git add engine/src/engine.ts
git commit -m "feat(engine): add providerOverride to EngineConfig"
```

---

### Task 5: Add `--provider` flag to CLI

**Files:**
- Modify: `cli/src/index.ts` (line 23-29, the `run` command definition)
- Modify: `cli/src/commands/run.ts` (RunOptions interface + runCommand function)

**Step 1: Add option to `RunOptions` and `runCommand`**

In `cli/src/commands/run.ts`, update `RunOptions`:

```typescript
interface RunOptions {
  input?: string;
  inputFile?: string;
  repo?: string;
  repoUrl?: string;
  config?: string;
  json?: boolean;
  verbose?: boolean;
  provider?: string;  // add this
}
```

**Step 2: Add mock loading logic in `runCommand`**

After the `providerRegistry` is created (around line 246), add:

```typescript
// Handle --provider mock
if (options.provider === 'mock') {
  const mockYamlPath = join(configsDir, project, 'mock.yaml');
  let mockRaw: string;
  try {
    mockRaw = await readFile(mockYamlPath, 'utf-8');
  } catch {
    console.error(`Error: --provider mock requires ${mockYamlPath}`);
    process.exit(1);
  }

  const mockConfig = yaml.load(mockRaw) as { stages: Record<string, { output: Record<string, unknown>; tool_calls: Array<{ name: string; arguments: Record<string, unknown> }> }> };
  const stagesMap = new Map(Object.entries(mockConfig.stages));
  const { MockProvider } = await import('@studio/runner');
  const mockProvider = new MockProvider(stagesMap);
  providerRegistry.register(mockProvider);
}
```

**Step 3: Pass `providerOverride` to the engine**

Find:
```typescript
const engine = new PipelineEngine(
  {
    configsDir,
    repoPath,
    providerRegistry,
    toolRegistry,
  },
  events
);
```

Change to:
```typescript
const engine = new PipelineEngine(
  {
    configsDir,
    repoPath,
    providerRegistry,
    toolRegistry,
    ...(options.provider ? { providerOverride: options.provider } : {}),
  },
  events
);
```

**Step 4: Register the CLI option in `cli/src/index.ts`**

Find the `run` command block and add `.option('--provider <name>', 'Override LLM provider for all stages (e.g. mock)')` after the existing options:

```typescript
program
  .command('run <project/pipeline>')
  .description('Run a pipeline (e.g. studio run cuisine/recipe-generator)')
  .option('-i, --input <text>', 'Input description for the pipeline')
  .option('-f, --input-file <path>', 'Path to YAML input file')
  .option('-r, --repo <path>', 'Path to the target repository')
  .option('--repo-url <url>', 'Git URL to clone as target repository')
  .option('--config <path>', 'Path to .studiorc.yaml config file')
  .option('--provider <name>', 'Override LLM provider for all stages (e.g. mock)')
  .option('--json', 'Output results as JSON')
  .option('--verbose', 'Show detailed execution logs')
  .action(runCommand);
```

**Step 5: Build CLI**

```bash
cd cli && npm run build
```
Expected: no errors.

**Step 6: Run CLI tests**

```bash
cd cli && npm run test
```
Expected: all pass.

**Step 7: Commit**

```bash
git add cli/src/index.ts cli/src/commands/run.ts
git commit -m "feat(cli): add --provider flag for provider override (e.g. mock)"
```

---

### Task 6: Create `mock.yaml` for software/feature-builder

**Files:**
- Create: `engine/configs/software/mock.yaml`

**Step 1: Create the mock config**

```yaml
# Mock outputs for software/feature-builder pipeline
# Used with: studio run software/feature-builder --provider mock
stages:
  brief-analysis:
    output:
      summary: "Mock: Add FAQ section to About page"
      requirements:
        - "Display FAQ with accordion expand/collapse"
        - "Match existing page typography and spacing"
      acceptance_criteria:
        - "FAQ section renders on About page"
        - "Each item expands/collapses on click"
        - "Style matches existing design"
    tool_calls: []

  implementation-plan:
    output:
      summary: "Mock implementation plan for FAQ section"
      steps:
        - "Create FAQSection component"
        - "Add FAQ data to About page"
        - "Wire accordion interaction"
      files_to_modify:
        - "src/pages/about.tsx"
      estimated_complexity: "low"
    tool_calls: []

  code-generation:
    output:
      summary: "Mock: Generated FAQ component"
      files_changed:
        - "src/components/FAQSection.tsx"
    tool_calls:
      - name: repo_manager-write_file
        arguments:
          path: "src/components/FAQSection.tsx"
          content: |
            // Mock generated FAQ component
            export const FAQSection = () => (
              <section>
                <h2>FAQ</h2>
                <details><summary>What is this?</summary><p>A mock FAQ.</p></details>
              </section>
            );

  qa-review:
    output:
      status: "approved"
      summary: "Mock QA: implementation looks correct"
      issues: []
    tool_calls: []
```

**Step 2: Smoke test — run the full pipeline with mock**

```bash
studio run software/feature-builder \
  --input-file engine/configs/software/inputs/faq-about.input.yaml \
  --provider mock
```

Expected output:
- Pipeline completes with status `success`
- All 4 stages complete: `brief-analysis`, `implementation-plan`, `code-generation`, `qa-review`
- `src/components/FAQSection.tsx` created in CWD
- No API calls, tokens = 0 in summary

**Step 3: Verify anti-théâtre works**

Check that `code-generation` stage shows `tool_calls: 1` in output (not 0).

**Step 4: Commit**

```bash
git add engine/configs/software/mock.yaml
git commit -m "feat(configs): add mock.yaml for software/feature-builder pipeline"
```

---

## Build order (dependency chain)

```
contracts → runner → engine → cli
```

Always build in this order. After modifying any package, rebuild it before testing dependents.

## Quick rebuild all

```bash
cd contracts && npm run build && cd ../runner && npm run build && cd ../engine && npm run build && cd ../cli && npm run build && cd ..
```

# Mock Provider Design — STU-5

**Date:** 2026-02-17
**Issue:** [STU-5](https://linear.app/studioag/issue/STU-5/mock-provider-pour-dev-sans-couts-llm)

## Problem

Running `feature-builder` during development burns tokens on every test. Need a mock provider that simulates LLM calls with zero real API costs.

## Solution

Approach 1: `MockProvider as AgentLoopProvider` + per-project `mock.yaml` config + engine `providerOverride` + CLI `--provider` flag.

## Package Changes

### `@studio-foundation/contracts` — `LLMRequest`

Add optional field `stage_name?: string`. Fully backward-compatible — all existing providers ignore it.

### `@studio-foundation/runner` — 2 changes

**`runner.ts`:** Pass `task.contract_name` as `stage_name` in the inline `LLMRequest` object (where `model`, `messages`, `tools` are assembled).

**`providers/mock.ts`:** New file. `MockProvider implements AgentLoopProvider`.

- Constructed with a `Map<string, MockStageConfig>` loaded from a YAML file.
- `runAgentLoop()`:
  1. Read `request.stage_name`, lookup in map.
  2. Unknown stage → throw: `Unknown mock stage: "<name>". Add it to mock.yaml.`
  3. Call `executeTool()` for each tool call defined in config (real execution, real filesystem).
  4. Return `{ content: JSON.stringify(output), tool_calls, finish_reason: 'stop', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }`.
- `call()`: satisfies the `Provider` interface, returns output without tool calls.

### `@studio-foundation/engine` — `providerOverride`

Add `providerOverride?: string` to `PipelineEngineConfig`. In `executeStage()`, substitute `agentConfig.provider` with `providerOverride` when set. One line change.

### `@studio-foundation/cli` — `--provider` flag

Add `--provider <name>` to `RunOptions` and the `run` command definition.

If `--provider mock`:
1. Load `configs/<project>/mock.yaml`
2. Create `MockProvider(stagesMap)`
3. `registry.register(mockProvider)`
4. Pass `providerOverride: 'mock'` to `PipelineEngine`

## mock.yaml Format

Location: `engine/configs/<project>/mock.yaml`

```yaml
stages:
  brief-analysis:
    output:
      summary: "Mock brief analysis"
      requirements: ["Add FAQ section to About page"]
      acceptance_criteria: ["FAQ renders correctly", "Style matches existing"]
    tool_calls: []

  implementation-plan:
    output:
      summary: "Mock implementation plan"
      steps: ["Create FAQ component", "Update About page"]
      files_to_modify: ["src/pages/about.tsx"]
    tool_calls: []

  code-generation:
    output:
      summary: "Mock code generation"
      files_changed: ["src/pages/about.tsx"]
    tool_calls:
      - name: repo_manager-write_file
        arguments:
          path: "src/pages/mock-output.tsx"
          content: "// mock generated file\nexport const Mock = () => null;\n"

  qa-review:
    output:
      status: "approved"
      summary: "Mock QA review — approved"
      issues: []
    tool_calls: []
```

## CLI Usage

```bash
studio run software/feature-builder --input-file engine/configs/software/inputs/faq-about.input.yaml --provider mock
```

## Execution Flow

```
--provider mock detected
    ↓
Load configs/<project>/mock.yaml
    ↓
Create MockProvider(stages map)
    ↓
registry.register(mockProvider)       # name = 'mock'
    ↓
PipelineEngine({ ..., providerOverride: 'mock' })
    ↓
executeStage() replaces agentConfig.provider with 'mock'
    ↓
runner → registry.get('mock') → MockProvider.runAgentLoop()
    ↓
Real tool calls executed, output from mock.yaml, tokens = 0
```

## Error Handling

- `mock.yaml` missing → `"--provider mock requires configs/<project>/mock.yaml"`
- Stage not in mock → `"Unknown mock stage: "<name>". Add it to mock.yaml."`
- Unknown `--provider` value → registry already throws "Provider not found"
- No `--provider` → existing behavior unchanged

## Acceptance Criteria

- `studio run software/feature-builder --provider mock` runs without API calls
- Outputs are realistic enough to pass contract validation
- Tool calls are tracked correctly (anti-théâtre works)
- `coder` agent still uses its configured provider when not in mock mode

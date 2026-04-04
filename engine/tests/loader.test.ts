import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { parsePipelineYaml, loadPipeline, loadPipelineByName } from '../src/pipeline/loader.js';
import { parseAgentYaml } from '../src/pipeline/agent-loader.js';
import { parseContractYaml } from '../src/pipeline/contract-loader.js';
import { isStageGroup } from '@studio/contracts';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');
const PIPELINES_DIR = join(FIXTURES_DIR, 'software', 'pipelines');

describe('parsePipelineYaml', () => {
  it('parses a valid pipeline YAML', () => {
    const yamlContent = `
name: test-pipeline
description: A test pipeline
version: 1
stages:
  - name: stage-1
    kind: analysis
    agent: analyst
    ralph:
      max_attempts: 3
`;
    const pipeline = parsePipelineYaml(yamlContent);
    expect(pipeline.name).toBe('test-pipeline');
    expect(pipeline.stages).toHaveLength(1);
    expect(pipeline.stages[0].name).toBe('stage-1');
    expect(pipeline.stages[0].kind).toBe('analysis');
    expect(pipeline.stages[0].agent).toBe('analyst');
  });

  it('throws when name is missing', () => {
    const yamlContent = `
stages:
  - name: s1
    kind: analysis
    agent: a
`;
    expect(() => parsePipelineYaml(yamlContent)).toThrow("missing required field 'name'");
  });

  it('throws when stages is missing', () => {
    const yamlContent = `
name: bad-pipeline
`;
    expect(() => parsePipelineYaml(yamlContent)).toThrow("missing required field 'stages'");
  });

  it('throws when stages is empty', () => {
    const yamlContent = `
name: empty-pipeline
stages: []
`;
    expect(() => parsePipelineYaml(yamlContent)).toThrow('at least one stage');
  });

  it('throws when a stage is missing kind', () => {
    const yamlContent = `
name: bad-stages
stages:
  - name: no-kind
    agent: analyst
`;
    expect(() => parsePipelineYaml(yamlContent)).toThrow("missing 'kind'");
  });

  it('parses pipeline with repo config', () => {
    const yamlContent = `
name: test-pipeline
description: Test
version: 1
repo:
  url: https://github.com/test/repo
  branch: main
stages:
  - name: stage1
    kind: analysis
    agent: test-agent
`;
    const pipeline = parsePipelineYaml(yamlContent);
    expect(pipeline.repo?.url).toBe('https://github.com/test/repo');
    expect(pipeline.repo?.branch).toBe('main');
  });

  it('parses pipeline without repo config', () => {
    const yamlContent = `
name: test-pipeline
description: Test
version: 1
stages:
  - name: stage1
    kind: analysis
    agent: test-agent
`;
    const pipeline = parsePipelineYaml(yamlContent);
    expect(pipeline.repo).toBeUndefined();
  });

  it('throws when a stage is missing agent', () => {
    const yamlContent = `
name: bad-stages
stages:
  - name: no-agent
    kind: analysis
`;
    expect(() => parsePipelineYaml(yamlContent)).toThrow("missing 'agent'");
  });

  it('parses a pipeline with a group entry', () => {
    const yamlContent = `
name: grouped-pipeline
description: Pipeline with a group
version: 2
stages:
  - name: analysis
    kind: analysis
    agent: analyst
  - group: review-loop
    max_iterations: 3
    stages:
      - name: code-gen
        kind: code_generation
        agent: coder
      - name: qa
        kind: qa
        agent: analyst
`;
    const pipeline = parsePipelineYaml(yamlContent);
    expect(pipeline.stages).toHaveLength(2);

    // First entry is a regular stage
    const first = pipeline.stages[0];
    expect(isStageGroup(first)).toBe(false);
    expect((first as any).name).toBe('analysis');

    // Second entry is a group
    const second = pipeline.stages[1];
    expect(isStageGroup(second)).toBe(true);
    if (isStageGroup(second)) {
      expect(second.group).toBe('review-loop');
      expect(second.max_iterations).toBe(3);
      expect(second.stages).toHaveLength(2);
      expect(second.stages[0].name).toBe('code-gen');
      expect(second.stages[1].name).toBe('qa');
    }
  });

  it('parses max_tool_calls from the ralph block', () => {
    const yamlContent = `
name: test-pipeline
version: 1
stages:
  - name: code-gen
    kind: code_generation
    agent: coder
    ralph:
      max_attempts: 5
      max_tool_calls: 200
`;
    const pipeline = parsePipelineYaml(yamlContent);
    const stage = pipeline.stages[0] as any;
    expect(stage.ralph?.max_tool_calls).toBe(200);
  });

  it('leaves max_tool_calls undefined when not specified', () => {
    const yamlContent = `
name: test-pipeline
version: 1
stages:
  - name: brief-analysis
    kind: analysis
    agent: analyst
    ralph:
      max_attempts: 3
`;
    const pipeline = parsePipelineYaml(yamlContent);
    const stage = pipeline.stages[0] as any;
    expect(stage.ralph?.max_tool_calls).toBeUndefined();
  });

  it('defaults max_iterations to 3 when not specified', () => {
    const yamlContent = `
name: default-iters
version: 1
stages:
  - group: loop
    stages:
      - name: s1
        kind: analysis
        agent: a
      - name: s2
        kind: qa
        agent: a
`;
    const pipeline = parsePipelineYaml(yamlContent);
    const g = pipeline.stages[0];
    expect(isStageGroup(g)).toBe(true);
    if (isStageGroup(g)) {
      expect(g.max_iterations).toBe(3);
    }
  });

  it('throws when a group has no stages', () => {
    const yamlContent = `
name: bad-group
version: 1
stages:
  - group: empty-loop
    stages: []
`;
    expect(() => parsePipelineYaml(yamlContent)).toThrow('at least 2 stages');
  });

  it('throws when a group has only 1 stage', () => {
    const yamlContent = `
name: bad-group
version: 1
stages:
  - group: solo-loop
    stages:
      - name: only-one
        kind: analysis
        agent: a
`;
    expect(() => parsePipelineYaml(yamlContent)).toThrow('at least 2 stages');
  });
});

describe('loadPipeline — real files', () => {
  it('loads feature-builder.pipeline.yaml', async () => {
    const pipeline = await loadPipeline(join(PIPELINES_DIR, 'feature-builder.pipeline.yaml'));
    expect(pipeline.name).toBe('feature-builder');
    // 2 simple stages + 1 group = 3 entries
    expect(pipeline.stages).toHaveLength(3);
  });

  it('loadPipelineByName resolves the path', async () => {
    const pipeline = await loadPipelineByName('feature-builder', PIPELINES_DIR);
    expect(pipeline.name).toBe('feature-builder');
  });

  it('throws for non-existent pipeline', async () => {
    await expect(
      loadPipeline('/nonexistent/path/pipeline.yaml')
    ).rejects.toThrow('Failed to load pipeline');
  });
});

describe('parseAgentYaml', () => {
  it('parses a valid agent YAML', () => {
    const yamlContent = `
name: test-agent
provider: anthropic
model: claude-sonnet-4-20250514
temperature: 0.3
tools:
  - repo_manager.read_file
system_prompt: You are a test agent.
`;
    const agent = parseAgentYaml(yamlContent);
    expect(agent.name).toBe('test-agent');
    expect(agent.provider).toBe('anthropic');
    expect(agent.model).toBe('claude-sonnet-4-20250514');
  });

  it('throws when name is missing', () => {
    expect(() => parseAgentYaml('provider: x\nmodel: y')).toThrow("missing required field 'name'");
  });

  it('allows missing provider (defaults applied at runtime)', () => {
    const agent = parseAgentYaml('name: x\nmodel: y');
    expect(agent.name).toBe('x');
    expect(agent.provider).toBeUndefined();
  });

  it('allows missing model (defaults applied at runtime)', () => {
    const agent = parseAgentYaml('name: x\nprovider: y');
    expect(agent.name).toBe('x');
    expect(agent.model).toBeUndefined();
  });
});

describe('parseContractYaml', () => {
  it('parses a valid contract YAML', () => {
    const yamlContent = `
name: test-contract
version: 1
schema:
  required_fields:
    - summary
    - details
`;
    const contract = parseContractYaml(yamlContent);
    expect(contract.name).toBe('test-contract');
    expect(contract.version).toBe(1);
    expect(contract.schema?.required_fields).toEqual(['summary', 'details']);
  });

  it('throws when name is missing', () => {
    expect(() => parseContractYaml('version: 1')).toThrow("missing required field 'name'");
  });

  it('throws when version is missing', () => {
    expect(() => parseContractYaml('name: x')).toThrow("missing required field 'version'");
  });
});

describe('parsePipelineYaml — parallel group', () => {
  it('parses mode: parallel and on_failure: collect-all', () => {
    const yaml = `
name: parallel-test
description: parallel
version: 1
stages:
  - group: work
    mode: parallel
    on_failure: collect-all
    stages:
      - name: stage-a
        kind: analysis
        agent: analyst
      - name: stage-b
        kind: analysis
        agent: analyst
`;
    const pipeline = parsePipelineYaml(yaml);
    const group = pipeline.stages[0];
    expect(isStageGroup(group)).toBe(true);
    if (isStageGroup(group)) {
      expect(group.mode).toBe('parallel');
      expect(group.on_failure).toBe('collect-all');
    }
  });

  it('defaults mode to sequential when omitted', () => {
    const yaml = `
name: seq-test
description: seq
version: 1
stages:
  - group: work
    stages:
      - name: stage-a
        kind: analysis
        agent: analyst
      - name: stage-b
        kind: analysis
        agent: analyst
`;
    const pipeline = parsePipelineYaml(yaml);
    const group = pipeline.stages[0];
    if (isStageGroup(group)) {
      expect(group.mode).toBeUndefined();
    }
  });

  it('warns and sets max_iterations to 1 when mode is parallel and max_iterations > 1', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const yaml = `
name: parallel-warn-test
description: parallel warn
version: 1
stages:
  - group: work
    mode: parallel
    max_iterations: 3
    stages:
      - name: stage-a
        kind: analysis
        agent: analyst
      - name: stage-b
        kind: analysis
        agent: analyst
`;
    const pipeline = parsePipelineYaml(yaml);
    const group = pipeline.stages[0];
    if (isStageGroup(group)) {
      expect(group.max_iterations).toBe(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("parallel group 'work' has max_iterations > 1")
      );
    }
    consoleSpy.mockRestore();
  });
});

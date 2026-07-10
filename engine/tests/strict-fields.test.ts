// STU-408 — fail-loud config loading: unknown fields are rejected with a hard error
import { describe, it, expect } from 'vitest';
import { parseContractYaml } from '../src/pipeline/contract-loader.js';
import { parsePipelineYaml } from '../src/pipeline/loader.js';

describe('parseContractYaml — unknown field rejection', () => {
  it('throws on an unknown top-level field, naming the field and the file', () => {
    const yamlContent = `
name: sneaky
version: 1
schema:
  required_fields: [summary]
field_constraints:
  tasks:
    min_items: 5
`;
    expect(() => parseContractYaml(yamlContent, '/tmp/sneaky.contract.yaml')).toThrow(
      /Unknown field 'field_constraints'.*\/tmp\/sneaky\.contract\.yaml/
    );
  });

  it('suggests the closest valid field for a typo', () => {
    const yamlContent = `
name: typo
version: 1
post_validations:
  rejection_detection:
    field: status
`;
    expect(() => parseContractYaml(yamlContent, '/tmp/typo.contract.yaml')).toThrow(
      /Did you mean 'post_validation'\?/
    );
  });

  it('offers no suggestion when nothing is close', () => {
    const yamlContent = `
name: far-off
version: 1
zzz_totally_unrelated: true
`;
    let message = '';
    try {
      parseContractYaml(yamlContent, '/tmp/far.contract.yaml');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Unknown field 'zzz_totally_unrelated'");
    expect(message).not.toContain('Did you mean');
  });
});

describe('parseContractYaml — nested block strictness', () => {
  it('rejects field_constraints hidden inside schema (parallel-tasks theatre)', () => {
    const yamlContent = `
name: parallel-tasks
version: 1
schema:
  required_fields: [tasks]
  field_constraints:
    tasks:
      min_items: 5
`;
    expect(() => parseContractYaml(yamlContent)).toThrow(
      /Unknown field 'field_constraints' in schema of contract 'parallel-tasks'/
    );
  });

  it('rejects constraints inside post_validation (qa-review theatre)', () => {
    const yamlContent = `
name: qa-review
version: 1
post_validation:
  rejection_detection:
    field: status
  constraints:
    - if_field: status
      operator: equals
`;
    expect(() => parseContractYaml(yamlContent)).toThrow(
      /Unknown field 'constraints' in post_validation of contract 'qa-review'/
    );
  });

  it('rejects a typo inside tool_calls with a suggestion', () => {
    const yamlContent = `
name: typo-tools
version: 1
tool_calls:
  minimun: 1
`;
    expect(() => parseContractYaml(yamlContent)).toThrow(/Did you mean 'minimum'\?/);
  });

  it('rejects an unknown key inside rejection_detection', () => {
    const yamlContent = `
name: bad-rd
version: 1
post_validation:
  rejection_detection:
    field: status
    on_reject: restart
`;
    expect(() => parseContractYaml(yamlContent)).toThrow(
      /Unknown field 'on_reject' in post_validation.rejection_detection/
    );
  });

  it('accepts a fully-featured valid contract', () => {
    const yamlContent = `
name: full
version: 1
schema:
  required_fields: [summary, files_changed]
tool_calls:
  minimum: 1
  maximum: 15
  required_tools: [repo_manager.write_file]
  required_tool_groups: [[git.commit, git.push]]
  counted_tools: [repo_manager.write_file]
validators:
  - name: lint
    command: "eslint --stdin"
    timeout_ms: 10000
custom_rules:
  - name: actionable
    description: "must be actionable"
    check: "recommendations.length > 0"
post_validation:
  rejection_detection:
    field: status
    approved_values: [approved]
    rejected_values: [rejected]
    details_field: issues
    summary_field: summary
    reject_if_non_empty: issues
`;
    expect(() => parseContractYaml(yamlContent)).not.toThrow();
  });
});

describe('parsePipelineYaml — unknown field rejection', () => {
  const validStage = `
    kind: analysis
    agent: analyst`;

  it('throws on an unknown top-level field with a suggestion', () => {
    const yamlContent = `
name: p
version: 1
on_pipline_start:
  - command: date
    inject_as: now
stages:
  - name: s1${validStage}
`;
    expect(() => parsePipelineYaml(yamlContent, '/tmp/p.pipeline.yaml')).toThrow(
      /Unknown field 'on_pipline_start'.*Did you mean 'on_pipeline_start'\?/
    );
  });

  it('throws on an unknown stage field', () => {
    const yamlContent = `
name: p
stages:
  - name: s1${validStage}
    max_attempts: 3
`;
    expect(() => parsePipelineYaml(yamlContent)).toThrow(
      /Unknown field 'max_attempts' in stage 's1'/
    );
  });

  it('throws on an unknown group field', () => {
    const yamlContent = `
name: p
stages:
  - group: g1
    max_iteration: 3
    stages:
      - name: s1
        kind: analysis
        agent: analyst
      - name: s2
        kind: analysis
        agent: analyst
`;
    expect(() => parsePipelineYaml(yamlContent)).toThrow(
      /Unknown field 'max_iteration' in group 'g1'.*Did you mean 'max_iterations'\?/
    );
  });

  it('throws on an unknown key inside a ralph block', () => {
    const yamlContent = `
name: p
stages:
  - name: s1${validStage}
    ralph:
      max_attempts: 3
      retry_stategy: enriched
`;
    expect(() => parsePipelineYaml(yamlContent)).toThrow(
      /Unknown field 'retry_stategy' in ralph of stage 's1'.*Did you mean 'retry_strategy'\?/
    );
  });

  it('throws on an unknown key inside context / tools / hooks blocks', () => {
    expect(() => parsePipelineYaml(`
name: p
stages:
  - name: s1${validStage}
    context:
      includes: [input]
`)).toThrow(/Unknown field 'includes' in context of stage 's1'/);

    expect(() => parsePipelineYaml(`
name: p
stages:
  - name: s1${validStage}
    tools:
      require: [git-commit]
`)).toThrow(/Unknown field 'require' in tools of stage 's1'/);

    expect(() => parsePipelineYaml(`
name: p
stages:
  - name: s1${validStage}
    hooks:
      on_stage_done:
        - command: echo ok
`)).toThrow(/Unknown field 'on_stage_done' in hooks of stage 's1'/);
  });

  it('accepts a fully-featured valid pipeline', () => {
    const yamlContent = `
name: full
description: everything the kernel supports
version: 1
repo:
  url: https://example.invalid/repo.git
  branch: main
on_pipeline_start:
  - command: date
    inject_as: now
input_schema:
  type: structured
  fields:
    - name: brief
      type: text
      prompt: "What to build?"
      required: true
stages:
  - name: s1
    kind: analysis
    agent: analyst
    condition: "input.count > 0"
    contract: brief-analysis
    ralph:
      max_attempts: 3
      retry_strategy: enriched
      max_tool_calls: 10
    context:
      include: [input]
      packs: [core]
    tools:
      required: [git-commit]
    hooks:
      on_stage_start:
        - command: echo start
          on_failure: warn
      pre_tool_use:
        - matcher: git-commit
          command: echo committing
          on_failure: reject
  - group: g1
    max_iterations: 2
    mode: sequential
    stages:
      - name: s2
        kind: work
        agent: worker
      - name: s3
        kind: review
        agent: reviewer
  - name: s4
    kind: script-step
    executor: script
    script: ./check.py
    runtime: python
    timeout_ms: 5000
`;
    expect(() => parsePipelineYaml(yamlContent)).not.toThrow();
  });
});

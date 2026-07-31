import { describe, it, expect } from 'vitest';
import { parsePipelineYaml } from './loader.js';
import type { MapStage, StageDefinition } from '@studio-foundation/contracts';

const MINIMAL_STAGE = `
  - name: analyze
    kind: analysis
    agent: analyst
`;

describe('parsePipelineYaml — on_pipeline_start', () => {
  it('parses on_pipeline_start commands', () => {
    const yaml = `
name: test-pipeline
description: test
version: 1
on_pipeline_start:
  - command: "git status --short"
    inject_as: git_status
  - command: "git log --oneline -5"
    inject_as: recent_commits
stages:
${MINIMAL_STAGE}
`;
    const result = parsePipelineYaml(yaml);
    expect(result.on_pipeline_start).toEqual([
      { command: 'git status --short', inject_as: 'git_status' },
      { command: 'git log --oneline -5', inject_as: 'recent_commits' },
    ]);
  });

  it('returns undefined on_pipeline_start when absent', () => {
    const yaml = `
name: test-pipeline
description: test
version: 1
stages:
${MINIMAL_STAGE}
`;
    const result = parsePipelineYaml(yaml);
    expect(result.on_pipeline_start).toBeUndefined();
  });

  it('throws when on_pipeline_start entry is missing command', () => {
    const yaml = `
name: test-pipeline
description: test
version: 1
on_pipeline_start:
  - inject_as: git_status
stages:
${MINIMAL_STAGE}
`;
    expect(() => parsePipelineYaml(yaml)).toThrow("on_pipeline_start entry missing 'command'");
  });

  it('throws when on_pipeline_start entry is missing inject_as', () => {
    const yaml = `
name: test-pipeline
description: test
version: 1
on_pipeline_start:
  - command: "git status"
stages:
${MINIMAL_STAGE}
`;
    expect(() => parsePipelineYaml(yaml)).toThrow("on_pipeline_start entry missing 'inject_as'");
  });
});

const PIPELINE_WITH_HOOKS = `
name: test-pipeline
description: test
version: 1
stages:
  - name: code-gen
    kind: code
    agent: coder
    hooks:
      on_stage_start:
        - command: "git stash"
          on_failure: warn
      on_stage_complete:
        - command: "npx tsc --noEmit"
          on_failure: reject
      pre_tool_use:
        - matcher: "repo_manager-write_file"
          command: "echo pre {{tool.path}}"
          on_failure: warn
      post_tool_use:
        - matcher: "repo_manager-write_file"
          command: "npx prettier --write {{tool.path}}"
          on_failure: warn
`;

describe('parsePipelineYaml — stage hooks', () => {
  it('parses all four hook types from a stage', () => {
    const result = parsePipelineYaml(PIPELINE_WITH_HOOKS);
    const stage = result.stages[0] as StageDefinition;
    expect(stage.hooks?.on_stage_start).toEqual([
      { command: 'git stash', on_failure: 'warn' },
    ]);
    expect(stage.hooks?.on_stage_complete).toEqual([
      { command: 'npx tsc --noEmit', on_failure: 'reject' },
    ]);
    expect(stage.hooks?.pre_tool_use).toEqual([
      { matcher: 'repo_manager-write_file', command: 'echo pre {{tool.path}}', on_failure: 'warn' },
    ]);
    expect(stage.hooks?.post_tool_use).toEqual([
      { matcher: 'repo_manager-write_file', command: 'npx prettier --write {{tool.path}}', on_failure: 'warn' },
    ]);
  });

  it('returns undefined hooks when stage has no hooks', () => {
    const yaml = `
name: test-pipeline
description: test
version: 1
stages:
  - name: analyze
    kind: analysis
    agent: analyst
`;
    const result = parsePipelineYaml(yaml);
    const stage = result.stages[0] as StageDefinition;
    expect(stage.hooks).toBeUndefined();
  });
});

describe('parsePipelineYaml — context.include directives (STU-593)', () => {
  const withInclude = (include: string) => `
name: test-pipeline
description: test
version: 1
stages:
  - name: analyze
    kind: analysis
    agent: analyst
    context:
      include:
        - input
        - ${include}
`;

  it('accepts every directive getContextForStage implements', () => {
    for (const directive of [
      'input', 'previous_stage_output', 'all_stage_outputs', 'stage_name',
      'group_feedback', 'previous_stage_tool_results', 'all_stage_tool_results',
      'repo_files', 'repo_structure', 'pipeline_start_context',
    ]) {
      expect(() => parsePipelineYaml(withInclude(directive))).not.toThrow();
    }
  });

  it('throws on an unknown context.include directive instead of silently dropping it', () => {
    expect(() => parsePipelineYaml(withInclude('entity-classification'))).toThrow(
      /Unknown context\.include 'entity-classification' in stage 'analyze'/,
    );
  });

  it('suggests the closest directive on a typo', () => {
    expect(() => parsePipelineYaml(withInclude('all_stage_output'))).toThrow(
      /Did you mean 'all_stage_outputs'\?/,
    );
  });
});

describe('parsePipelineYaml — map stage batch', () => {
  const withBatch = (batch: string) => `
name: test-pipeline
description: test
version: 1
stages:
  - map: items
    over: input.things
    pipeline: per-item
    as: thing
${batch}
`;

  it('accepts the boolean shorthand', () => {
    const result = parsePipelineYaml(withBatch('    batch: true'));
    expect((result.stages[0] as MapStage).batch).toBe(true);
  });

  it('accepts a tuning object and keeps only what was written', () => {
    const result = parsePipelineYaml(withBatch(
      '    batch:\n      max_size: 50\n      poll_interval_ms: 5000',
    ));
    expect((result.stages[0] as MapStage).batch).toEqual({ max_size: 50, poll_interval_ms: 5000 });
  });

  it('leaves batch absent when the key is omitted', () => {
    const result = parsePipelineYaml(withBatch('    concurrency: 4'));
    expect((result.stages[0] as MapStage).batch).toBeUndefined();
  });

  it('accepts flush_after_ms: 0 — that disables the quiescence flush, it is not a bad value', () => {
    const result = parsePipelineYaml(withBatch('    batch:\n      flush_after_ms: 0'));
    expect((result.stages[0] as MapStage).batch).toEqual({ flush_after_ms: 0 });
  });

  it('rejects a non-integer setting', () => {
    expect(() => parsePipelineYaml(withBatch('    batch:\n      max_size: 0'))).toThrow(
      /batch\.max_size' must be an integer >= 1/,
    );
  });

  it('rejects a batch key the kernel does not implement', () => {
    expect(() => parsePipelineYaml(withBatch('    batch:\n      retry_forever: true'))).toThrow(
      /retry_forever/,
    );
  });

  it('rejects a batch value that is neither a boolean nor an object', () => {
    expect(() => parsePipelineYaml(withBatch('    batch: "yes"'))).toThrow(
      /must be a boolean or an object/,
    );
  });
});

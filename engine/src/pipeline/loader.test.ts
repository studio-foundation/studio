import { describe, it, expect } from 'vitest';
import { parsePipelineYaml } from './loader.js';

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

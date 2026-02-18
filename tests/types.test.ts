// Type-level tests for @studio/contracts
// These tests verify that types compile correctly

import { describe, it, expect } from 'vitest';
import type {
  PipelineDefinition,
  StageDefinition,
  StageStatus,
  AgentConfig,
  ValidationResult,
} from '../src/index.js';

describe('contracts types', () => {
  it('can create valid pipeline definition', () => {
    const pipeline: PipelineDefinition = {
      name: 'test-pipeline',
      description: 'Test pipeline',
      version: 1,
      stages: [],
    };
    expect(pipeline.name).toBe('test-pipeline');
  });

  it('can create valid stage definition', () => {
    const stage: StageDefinition = {
      name: 'test-stage',
      kind: 'analysis',
      agent: 'test-agent',
    };
    expect(stage.kind).toBe('analysis');
  });

  it('status types are correct', () => {
    const status: StageStatus = 'success';
    expect(status).toBe('success');
  });

  it('can create agent config', () => {
    const agent: AgentConfig = {
      name: 'test-agent',
      provider: 'openai',
      model: 'gpt-4',
    };
    expect(agent.provider).toBe('openai');
  });

  it('can create pipeline with repo config', () => {
    const pipeline: PipelineDefinition = {
      name: 'test',
      description: 'Test',
      version: 1,
      repo: {
        url: 'https://github.com/test/repo',
        branch: 'main',
      },
      stages: [],
    };
    expect(pipeline.repo?.url).toBe('https://github.com/test/repo');
  });

  it('validation result structure', () => {
    const validation: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
    };
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });
});

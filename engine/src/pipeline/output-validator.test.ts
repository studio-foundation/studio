import { describe, it, expect } from 'vitest';
import { validateOutput } from './output-validator.js';
import type { OutputContract } from '@studio/contracts';

const schemaOnlyContract: OutputContract = {
  name: 'test-schema',
  version: 1,
  schema: { required_fields: ['summary', 'files_changed'] },
};

const toolCallContract: OutputContract = {
  name: 'test-tool-calls',
  version: 1,
  schema: { required_fields: ['summary'] },
  tool_calls: { minimum: 1, required_tools: ['repo_manager-write_file'] },
};

const postValidationContract: OutputContract = {
  name: 'test-post-validation',
  version: 1,
  schema: { required_fields: ['status'] },
  post_validation: {
    rejection_detection: {
      field: 'status',
      approved_values: ['approved'],
      rejected_values: ['rejected'],
    },
  },
};

describe('validateOutput', () => {
  describe('schema validation', () => {
    it('returns valid: true when all required fields are present', () => {
      const result = validateOutput(schemaOnlyContract, { summary: 'ok', files_changed: ['a.ts'] });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.post_validation.accepted).toBe(true);
    });

    it('returns valid: false with error when required field is missing', () => {
      const result = validateOutput(schemaOnlyContract, { summary: 'ok' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: files_changed');
    });

    it('returns valid: false when output is not an object', () => {
      const result = validateOutput(schemaOnlyContract, 'not an object');
      expect(result.valid).toBe(false);
    });
  });

  describe('tool_calls validation', () => {
    it('returns valid: false when minimum not met (empty tool_calls)', () => {
      const result = validateOutput(toolCallContract, { summary: 'ok' }, []);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('tool call'))).toBe(true);
    });

    it('returns valid: false when required tool was not called', () => {
      const result = validateOutput(
        toolCallContract,
        { summary: 'ok' },
        [{ name: 'shell-run_command', arguments: {}, result: 'ok' }]
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('repo_manager-write_file'))).toBe(true);
    });

    it('returns valid: true when required tool was called successfully', () => {
      const result = validateOutput(
        toolCallContract,
        { summary: 'ok' },
        [{ name: 'repo_manager-write_file', arguments: { path: 'a.ts' }, result: 'ok' }]
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe('post_validation', () => {
    it('accepted: true when approved value present', () => {
      const result = validateOutput(postValidationContract, { status: 'approved' });
      expect(result.valid).toBe(true);
      expect(result.post_validation.accepted).toBe(true);
    });

    it('accepted: false with rejection_reason when rejected value present', () => {
      const result = validateOutput(postValidationContract, { status: 'rejected' });
      expect(result.post_validation.accepted).toBe(false);
      expect(result.post_validation.rejection_reason).toBeTruthy();
    });

    it('post_validation runs independently of schema validity', () => {
      const result = validateOutput(
        { ...postValidationContract, schema: { required_fields: ['summary', 'status'] } },
        { status: 'rejected' }
      );
      expect(result.valid).toBe(false);
      expect(result.post_validation.accepted).toBe(false);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { postValidate } from '../src/pipeline/post-validator.js';
import type { OutputContract } from '@studio-foundation/contracts';

describe('postValidate', () => {
  it('accepts when no post_validation config', () => {
    const contract: OutputContract = { name: 'test', version: 1 };
    const result = postValidate({ status: 'rejected' }, contract);
    expect(result.accepted).toBe(true);
  });

  it('accepts when status is in approved_values', () => {
    const contract: OutputContract = {
      name: 'qa',
      version: 1,
      post_validation: {
        rejection_detection: { field: 'status', approved_values: ['approved'] },
      },
    };
    const result = postValidate({ status: 'approved', summary: 'ok', issues: [] }, contract);
    expect(result.accepted).toBe(true);
  });

  it('accepts with approved_with_notes', () => {
    const contract: OutputContract = {
      name: 'qa',
      version: 1,
      post_validation: {
        rejection_detection: { field: 'status', approved_values: ['approved', 'approved_with_notes'] },
      },
    };
    const result = postValidate({ status: 'approved_with_notes', summary: 'minor issues', issues: [] }, contract);
    expect(result.accepted).toBe(true);
  });

  it('rejects when status is not in approved_values', () => {
    const contract: OutputContract = {
      name: 'qa',
      version: 1,
      post_validation: {
        rejection_detection: {
          field: 'status',
          approved_values: ['approved', 'approved_with_notes'],
          details_field: 'issues',
          summary_field: 'summary',
        },
      },
    };
    const result = postValidate(
      { status: 'implementation_incomplete', summary: 'missing props', issues: ['bug 1', 'bug 2'] },
      contract,
    );
    expect(result.accepted).toBe(false);
    expect(result.rejection_reason).toContain('implementation_incomplete');
    expect(result.rejection_reason).toContain('missing props');
    expect(result.rejection_details).toEqual(['bug 1', 'bug 2']);
  });

  it('extracts details from structured issues', () => {
    const contract: OutputContract = {
      name: 'qa',
      version: 1,
      post_validation: {
        rejection_detection: {
          field: 'status',
          approved_values: ['approved'],
          details_field: 'issues',
        },
      },
    };
    const result = postValidate(
      {
        status: 'needs_changes',
        summary: 'issues found',
        issues: [
          { severity: 'high', description: 'Missing prop' },
          { severity: 'low', description: 'Naming convention' },
        ],
      },
      contract,
    );
    expect(result.accepted).toBe(false);
    expect(result.rejection_details).toEqual(['Missing prop', 'Naming convention']);
  });

  it('accepts when output is not an object', () => {
    const contract: OutputContract = {
      name: 'qa',
      version: 1,
      post_validation: {
        rejection_detection: { field: 'status', approved_values: ['approved'] },
      },
    };
    expect(postValidate('just a string', contract).accepted).toBe(true);
    expect(postValidate(null, contract).accepted).toBe(true);
    expect(postValidate(undefined, contract).accepted).toBe(true);
  });

  it('accepts when status field is not a string', () => {
    const contract: OutputContract = {
      name: 'qa',
      version: 1,
      post_validation: {
        rejection_detection: { field: 'status', approved_values: ['approved'] },
      },
    };
    const result = postValidate({ status: 42, summary: 'ok' }, contract);
    expect(result.accepted).toBe(true);
  });

  it('includes expected values in rejection reason', () => {
    const contract: OutputContract = {
      name: 'qa',
      version: 1,
      post_validation: {
        rejection_detection: { field: 'status', approved_values: ['approved', 'approved_with_notes'] },
      },
    };
    const result = postValidate({ status: 'failed', issues: [] }, contract);
    expect(result.accepted).toBe(false);
    expect(result.rejection_reason).toContain('approved or approved_with_notes');
  });

  it('handles string issues field', () => {
    const contract: OutputContract = {
      name: 'qa',
      version: 1,
      post_validation: {
        rejection_detection: {
          field: 'status',
          approved_values: ['approved'],
          details_field: 'issues',
        },
      },
    };
    const result = postValidate(
      { status: 'rejected', issues: 'Something is wrong' },
      contract,
    );
    expect(result.accepted).toBe(false);
    expect(result.rejection_details).toEqual(['Something is wrong']);
  });

  it('rejects when reject_if_non_empty field has items, even if status is approved', () => {
    const contract: OutputContract = {
      name: 'critique',
      version: 1,
      post_validation: {
        rejection_detection: {
          field: 'status',
          approved_values: ['approved'],
          details_field: 'issues',
          summary_field: 'feedback',
          reject_if_non_empty: 'issues',
        },
      },
    };
    const result = postValidate(
      { status: 'approved', feedback: 'Minor issues', issues: ['Too much salt'] },
      contract,
    );
    expect(result.accepted).toBe(false);
    expect(result.rejection_reason).toContain('non-empty');
    expect(result.rejection_reason).toContain('Minor issues');
    expect(result.rejection_details).toEqual(['Too much salt']);
  });

  it('accepts when reject_if_non_empty field is an empty array', () => {
    const contract: OutputContract = {
      name: 'critique',
      version: 1,
      post_validation: {
        rejection_detection: {
          field: 'status',
          approved_values: ['approved'],
          reject_if_non_empty: 'issues',
        },
      },
    };
    const result = postValidate(
      { status: 'approved', issues: [] },
      contract,
    );
    expect(result.accepted).toBe(true);
  });

  it('rejects with structured issues via reject_if_non_empty', () => {
    const contract: OutputContract = {
      name: 'critique',
      version: 1,
      post_validation: {
        rejection_detection: {
          field: 'status',
          approved_values: ['approved'],
          reject_if_non_empty: 'issues',
        },
      },
    };
    const result = postValidate(
      { status: 'approved', issues: [{ severity: 'low', description: 'Bland seasoning' }] },
      contract,
    );
    expect(result.accepted).toBe(false);
    expect(result.rejection_details).toEqual(['Bland seasoning']);
  });

  it('extracts details from objects using "issue" field when "description" is absent', () => {
    const contract: OutputContract = {
      name: 'qa',
      version: 1,
      post_validation: {
        rejection_detection: {
          field: 'status',
          approved_values: ['approved'],
          details_field: 'issues',
        },
      },
    };
    const result = postValidate(
      {
        status: 'rejected',
        issues: [
          { issue: 'Missing error handling', severity: 'high' },
          { issue: 'No input validation' },
        ],
      },
      contract,
    );
    expect(result.accepted).toBe(false);
    expect(result.rejection_details).toEqual(['Missing error handling', 'No input validation']);
  });

  it('extracts details from objects using "message" field as fallback', () => {
    const contract: OutputContract = {
      name: 'qa',
      version: 1,
      post_validation: {
        rejection_detection: {
          field: 'status',
          approved_values: ['approved'],
          details_field: 'issues',
        },
      },
    };
    const result = postValidate(
      {
        status: 'rejected',
        issues: [
          { message: 'Auth token not refreshed', file: 'src/auth.ts' },
        ],
      },
      contract,
    );
    expect(result.accepted).toBe(false);
    expect(result.rejection_details).toEqual(['Auth token not refreshed']);
  });

  it('falls back to first string value for objects with unknown field names', () => {
    const contract: OutputContract = {
      name: 'qa',
      version: 1,
      post_validation: {
        rejection_detection: {
          field: 'status',
          approved_values: ['approved'],
          details_field: 'issues',
        },
      },
    };
    const result = postValidate(
      {
        status: 'rejected',
        issues: [
          { problem: 'Missing test coverage', severity: 'medium' },
        ],
      },
      contract,
    );
    expect(result.accepted).toBe(false);
    expect(result.rejection_details).toHaveLength(1);
    // Should extract some string value from the object
    expect(typeof result.rejection_details![0]).toBe('string');
  });

  it('omits rejection_details when no details_field configured', () => {
    const contract: OutputContract = {
      name: 'qa',
      version: 1,
      post_validation: {
        rejection_detection: { field: 'status', approved_values: ['approved'] },
      },
    };
    const result = postValidate({ status: 'rejected' }, contract);
    expect(result.accepted).toBe(false);
    expect(result.rejection_details).toBeUndefined();
  });
});

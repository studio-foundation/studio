import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PipelineRun } from '@studio-foundation/contracts';
import { formatResult, formatJson, formatError, formatDuration } from '../src/output/formatter.js';

let output: string[];
const originalLog = console.log;
const originalError = console.error;

beforeEach(() => {
  output = [];
  console.log = vi.fn((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
  console.error = vi.fn((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-123',
    pipeline_name: 'test-pipeline',
    status: 'success',
    started_at: '2025-01-01T00:00:00.000Z',
    completed_at: '2025-01-01T00:04:32.000Z',
    stages: [
      {
        id: 'stage-1',
        stage_name: 'analysis',
        status: 'success',
        started_at: '2025-01-01T00:00:00.000Z',
        completed_at: '2025-01-01T00:01:00.000Z',
        tasks: [
          {
            id: 'task-1',
            task_name: 'analysis',
            status: 'success',
            started_at: '2025-01-01T00:00:00.000Z',
            completed_at: '2025-01-01T00:01:00.000Z',
            agent_runs: [
              {
                id: 'agent-1',
                agent_name: 'analyst',
                attempt: 1,
                status: 'success',
                tool_calls: 3,
                started_at: '2025-01-01T00:00:00.000Z',
                completed_at: '2025-01-01T00:01:00.000Z',
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('formatResult', () => {
  it('should display success pipeline with stages', () => {
    const run = makeRun();
    formatResult(run);

    const text = output.join('\n');
    expect(text).toContain('test-pipeline');
    expect(text).toContain('success');
    expect(text).toContain('analysis');
    expect(text).toContain('1 attempt');
  });

  it('should display duration', () => {
    const run = makeRun();
    formatResult(run);

    const text = output.join('\n');
    expect(text).toContain('4m32s');
  });

  it('should display failed pipeline with error info', () => {
    const run = makeRun({
      status: 'failed',
      stages: [
        {
          id: 'stage-1',
          stage_name: 'code-gen',
          status: 'failed',
          started_at: '2025-01-01T00:00:00.000Z',
          completed_at: '2025-01-01T00:01:00.000Z',
          tasks: [
            {
              id: 'task-1',
              task_name: 'code-gen',
              status: 'failed',
              started_at: '2025-01-01T00:00:00.000Z',
              completed_at: '2025-01-01T00:01:00.000Z',
              agent_runs: [
                {
                  id: 'agent-1',
                  agent_name: 'coder',
                  attempt: 1,
                  status: 'failed',
                  tool_calls: 0,
                  started_at: '2025-01-01T00:00:00.000Z',
                  completed_at: '2025-01-01T00:01:00.000Z',
                  error: 'tool_calls = 0: agent did not make any real tool calls',
                },
              ],
            },
          ],
        },
      ],
    });

    formatResult(run);

    const text = output.join('\n');
    expect(text).toContain('failed');
    expect(text).toContain('FAILED');
    expect(text).toContain('tool_calls = 0');
  });
});

describe('formatJson', () => {
  it('should output pretty JSON', () => {
    formatJson({ key: 'value' });

    const text = output.join('\n');
    expect(text).toContain('"key": "value"');
  });
});

describe('formatError', () => {
  it('should output error message', () => {
    formatError(new Error('something broke'));

    const text = output.join('\n');
    expect(text).toContain('something broke');
  });
});

describe('formatDuration', () => {
  it('should format sub-second durations', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('should format seconds', () => {
    expect(formatDuration(12000)).toBe('12s');
  });

  it('should format minutes', () => {
    expect(formatDuration(83000)).toBe('1m23s');
  });
});

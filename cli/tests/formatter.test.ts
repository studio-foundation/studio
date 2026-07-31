import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PipelineRun } from '@studio-foundation/contracts';
import { formatResult, formatJson, formatError, formatDuration, formatCompactDuration } from '../src/output/formatter.js';

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

  it('omits the attempt count for a successful call stage (no agent runs)', () => {
    const run = makeRun({
      stages: [
        {
          id: 'stage-1',
          stage_name: 'wiki-resolution',
          status: 'success',
          started_at: '2025-01-01T00:00:00.000Z',
          completed_at: '2025-01-01T00:01:00.000Z',
          tasks: [],
        },
      ],
    });

    formatResult(run);

    const text = output.join('\n');
    expect(text).toContain('wiki-resolution');
    expect(text).toContain('✓');
    expect(text).not.toContain('attempt');
  });

  it('shows per-child duration next to a call stage', () => {
    const run = makeRun({
      stages: [
        {
          id: 'stage-1',
          stage_name: 'wiki-extraction',
          status: 'success',
          started_at: '2025-01-01T00:00:00.000Z',
          completed_at: '2025-01-01T00:00:01.300Z',
          tasks: [],
        },
        {
          id: 'stage-2',
          stage_name: 'pages-export',
          status: 'success',
          started_at: '2025-01-01T00:00:01.300Z',
          completed_at: '2025-01-01T00:00:17.600Z',
          tasks: [],
        },
      ],
    });

    formatResult(run);

    const text = output.join('\n');
    expect(text).toContain('wiki-extraction');
    expect(text).toContain('1.3s');
    expect(text).toContain('pages-export');
    expect(text).toContain('16.3s');
  });

  it('nests a child pipeline\'s stages beneath its call stage', () => {
    const child: PipelineRun = {
      id: 'child-1',
      pipeline_name: 'leaf-a',
      status: 'success',
      started_at: '2025-01-01T00:00:00.000Z',
      completed_at: '2025-01-01T00:00:01.300Z',
      stages: [
        {
          id: 'cs-1',
          stage_name: 'leaf-a-stage',
          status: 'success',
          started_at: '2025-01-01T00:00:00.000Z',
          completed_at: '2025-01-01T00:00:01.300Z',
          tasks: [],
        },
      ],
    };
    const run = makeRun({
      stages: [
        {
          id: 'stage-1',
          stage_name: 'wiki-extraction',
          status: 'success',
          started_at: '2025-01-01T00:00:00.000Z',
          completed_at: '2025-01-01T00:00:01.300Z',
          tasks: [],
          child_run_id: 'child-1',
        },
      ],
    });

    formatResult(run, new Map([['child-1', child]]));

    const text = output.join('\n');
    expect(text).toContain('wiki-extraction');
    expect(text).toContain('leaf-a');       // child pipeline label
    expect(text).toContain('leaf-a-stage'); // nested child stage
  });

  it('renders normally when a call stage has no resolvable child run', () => {
    const run = makeRun({
      stages: [
        {
          id: 'stage-1',
          stage_name: 'wiki-extraction',
          status: 'success',
          started_at: '2025-01-01T00:00:00.000Z',
          completed_at: '2025-01-01T00:00:01.300Z',
          tasks: [],
          child_run_id: 'missing-child',
        },
      ],
    });

    formatResult(run, new Map());

    const text = output.join('\n');
    expect(text).toContain('wiki-extraction');
    expect(text).not.toContain('└─');
  });

  it('omits duration for a zero-length (skipped) stage', () => {
    const run = makeRun({
      stages: [
        {
          id: 'stage-1',
          stage_name: 'section-filter-verdict',
          status: 'skipped',
          started_at: '2025-01-01T00:00:00.000Z',
          completed_at: '2025-01-01T00:00:00.000Z',
          tasks: [],
          skipped_reason: 'condition not met',
        },
      ],
    });

    formatResult(run);

    const text = output.join('\n');
    expect(text).toContain('⊘ skipped');
    expect(text).not.toMatch(/\b0(\.0)?s\b/);
    expect(text).not.toContain('0ms');
  });

  it('renders a condition-skipped stage as skipped with its reason', () => {
    const run = makeRun({
      stages: [
        {
          id: 'stage-1',
          stage_name: 'section-filter-verdict',
          status: 'skipped',
          started_at: '2025-01-01T00:00:00.000Z',
          completed_at: '2025-01-01T00:00:00.000Z',
          tasks: [],
          skipped_reason: 'condition not met: stages.section-filter-pre.output.needs_verdict == true',
        },
      ],
    });

    formatResult(run);

    const text = output.join('\n');
    expect(text).toContain('⊘ skipped');
    expect(text).toContain('condition not met');
    expect(text).not.toContain('FAILED');
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

describe('formatCompactDuration', () => {
  it('keeps milliseconds under a second', () => {
    expect(formatCompactDuration(950)).toBe('950ms');
  });

  it('shows one decimal for sub-minute durations', () => {
    expect(formatCompactDuration(1300)).toBe('1.3s');
    expect(formatCompactDuration(16300)).toBe('16.3s');
  });

  it('rolls over to minutes and seconds past a minute', () => {
    expect(formatCompactDuration(83000)).toBe('1m23s');
  });
});

describe('formatResult — token usage (STU-750)', () => {
  const usage = (model: string, total: number, extra: Record<string, number> = {}) => ({
    prompt_tokens: total, completion_tokens: 0, total_tokens: total, ...extra,
    by_model: { [model]: { prompt_tokens: total, completion_tokens: 0, total_tokens: total, ...extra } },
  });

  function runWithUsage(): PipelineRun {
    const base = makeRun();
    return {
      ...base,
      stages: [
        { ...base.stages[0], stage_name: 'analysis', token_usage: usage('claude-opus-4-5', 120_000, { cached_input_tokens: 90_000 }) },
        { ...base.stages[0], id: 'stage-2', stage_name: 'review', token_usage: usage('claude-haiku-4-5', 5_000) },
      ],
    };
  }

  it('reports the run total, summed from the stages', () => {
    formatResult(runWithUsage());

    const total = output.find((l) => l.startsWith('Tokens:'));
    expect(total).toBeDefined();
    expect(total).toContain('125.0k tokens');
    expect(total).toContain('90.0k cached');
  });

  it('puts each stage cost on its own line', () => {
    formatResult(runWithUsage());

    expect(output.find((l) => l.includes('analysis'))).toContain('120.0k tok');
    expect(output.find((l) => l.includes('review'))).toContain('5.0k tok');
  });

  it('breaks the total down per model, heaviest first', () => {
    formatResult(runWithUsage());

    const header = output.findIndex((l) => l === 'Tokens by model:');
    expect(header).toBeGreaterThan(-1);
    expect(output[header + 1]).toContain('claude-opus-4-5');
    expect(output[header + 2]).toContain('claude-haiku-4-5');
  });

  it('says nothing about tokens when the run recorded none', () => {
    formatResult(makeRun());

    expect(output.some((l) => l.startsWith('Tokens:'))).toBe(false);
    expect(output.some((l) => l === 'Tokens by model:')).toBe(false);
  });
});

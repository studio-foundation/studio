import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ora BEFORE importing progress.ts
const mockOraInstance = {
  start: vi.fn().mockReturnThis(),
  stop: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
};
vi.mock('ora', () => ({ default: vi.fn(() => mockOraInstance) }));
import ora from 'ora';

// Now import the module under test
import { ProgressDisplay } from '../../src/output/progress.js';

function makeDisplay() {
  return new ProgressDisplay(false, 'live');
}

function stageStartEvent(n = 1, total = 3) {
  return { stage_name: 'code-generation', stage_index: n - 1, total_stages: total };
}

function stageCompleteEvent(status = 'success') {
  return {
    stage_name: 'code-generation', stage_index: 0, total_stages: 3,
    status, attempts: 1, duration_ms: 1000,
  };
}

function toolCallStartEvent() {
  return { tool: 'repo_manager-read_file', params: { path: 'foo.ts' }, timestamp: Date.now() };
}

function toolCallCompleteEvent() {
  return { tool: 'repo_manager-read_file', result: 'ok', duration_ms: 100, timestamp: Date.now() };
}

describe('ProgressDisplay — thinking spinner (live mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts thinking spinner on onStageStart', () => {
    const d = makeDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    expect(ora).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Thinking') }));
    expect(mockOraInstance.start).toHaveBeenCalledTimes(1);
  });

  it('stops thinking spinner before starting tool spinner on onToolCallStart', () => {
    const d = makeDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.clearAllMocks();
    events.onToolCallStart!(toolCallStartEvent());
    expect(mockOraInstance.stop).toHaveBeenCalled();
  });

  it('restarts thinking spinner after onToolCallComplete', () => {
    const d = makeDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    events.onToolCallStart!(toolCallStartEvent());
    vi.clearAllMocks();
    events.onToolCallComplete!(toolCallCompleteEvent());
    // After tool succeeds a new thinking spinner should start
    expect(mockOraInstance.start).toHaveBeenCalled();
  });

  it('restarts thinking spinner after onToolCallComplete with error', () => {
    const d = makeDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    events.onToolCallStart!(toolCallStartEvent());
    vi.clearAllMocks();
    events.onToolCallComplete!({ tool: 'repo_manager-read_file', result: undefined, error: 'file not found', duration_ms: 100, timestamp: Date.now() });
    expect(mockOraInstance.start).toHaveBeenCalled();
  });

  it('stops thinking spinner on onStageComplete', () => {
    const d = makeDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.clearAllMocks();
    events.onStageComplete!(stageCompleteEvent());
    expect(mockOraInstance.stop).toHaveBeenCalled();
  });

  it('does NOT start thinking spinner in non-live mode', () => {
    const d = new ProgressDisplay(false, 'quiet');
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    expect(ora).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Thinking') }));
  });

  it('stops thinking spinner on onTaskRetry', () => {
    const d = makeDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.clearAllMocks();
    events.onTaskRetry!({ stage: 'code-generation', attempt: 2, failures: ['validation failed'] });
    expect(mockOraInstance.stop).toHaveBeenCalled();
  });
});

describe('ProgressDisplay — token streaming (live mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops thinking spinner when first token arrives', () => {
    const d = makeDisplay();
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    vi.clearAllMocks();
    events.onAgentToken!({ token: 'Hello', stage: 'code-generation', timestamp: Date.now() });
    expect(mockOraInstance.stop).toHaveBeenCalled();
  });

  it('does not print tokens in non-live mode', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const d = new ProgressDisplay(false, 'quiet');
    const events = d.getEvents();
    events.onAgentToken!({ token: 'Hello', stage: 'code-generation', timestamp: Date.now() });
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});

describe('ProgressDisplay — constructor accepts live + verbose booleans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts {live: true, verbose: false} and behaves like live mode', () => {
    const d = new ProgressDisplay(false, { live: true, verbose: false });
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    expect(ora).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Thinking') }));
  });

  it('accepts {live: false, verbose: false} and behaves like quiet mode', () => {
    const d = new ProgressDisplay(false, { live: false, verbose: false });
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    // quiet mode: uses regular spinner, no thinking spinner
    expect(ora).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Thinking') }));
  });

  it('prints full tool result in live+verbose mode', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = new ProgressDisplay(false, { live: true, verbose: true });
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    events.onToolCallStart!(toolCallStartEvent());
    events.onToolCallComplete!({
      tool: 'repo_manager-read_file',
      result: { content: 'const x = 1;\nconst y = 2;' },
      duration_ms: 50,
      timestamp: Date.now(),
    });
    // Should print full content, not just "2 lines"
    const allOutput = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).toContain('const x = 1;');
    expect(allOutput).toContain('const y = 2;');
    logSpy.mockRestore();
  });

  it('does NOT print full tool result in live-only mode', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = new ProgressDisplay(false, { live: true, verbose: false });
    const events = d.getEvents();
    events.onStageStart!(stageStartEvent());
    events.onToolCallStart!(toolCallStartEvent());
    events.onToolCallComplete!({
      tool: 'repo_manager-read_file',
      result: { content: 'const x = 1;\nconst y = 2;' },
      duration_ms: 50,
      timestamp: Date.now(),
    });
    const allOutput = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(allOutput).not.toContain('const x = 1;');
    logSpy.mockRestore();
  });
});

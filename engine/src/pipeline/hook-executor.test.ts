import { describe, it, expect } from 'vitest';
import { renderHookCommand, runStageHook, runToolHook } from './hook-executor.js';

describe('renderHookCommand', () => {
  it('substitutes {{tool.argName}} with tool argument value', () => {
    const result = renderHookCommand(
      'npx prettier --write {{tool.path}}',
      { path: '/tmp/foo.ts' }
    );
    expect(result).toBe('npx prettier --write /tmp/foo.ts');
  });

  it('returns empty string for missing tool argument', () => {
    const result = renderHookCommand('do something {{tool.missing}}', {});
    expect(result).toBe('do something ');
  });

  it('substitutes multiple occurrences of the same placeholder', () => {
    const result = renderHookCommand('cp {{tool.src}} {{tool.dst}}', { src: 'a.ts', dst: 'b.ts' });
    expect(result).toBe('cp a.ts b.ts');
  });

  it('leaves non-tool placeholders unchanged', () => {
    const result = renderHookCommand('echo {{other}}', { other: 'x' });
    // {{other}} is not a {{tool.*}} pattern — left as-is
    expect(result).toBe('echo {{other}}');
  });

  it('substitutes {{output.field}} with value from outputContext', () => {
    const result = renderHookCommand(
      'npx eslint {{output.files_changed}}',
      {},
      { files_changed: 'src/foo.ts' }
    );
    expect(result).toBe('npx eslint src/foo.ts');
  });

  it('space-joins array values from outputContext', () => {
    const result = renderHookCommand(
      'npx eslint {{output.files_changed}}',
      {},
      { files_changed: ['src/foo.ts', 'src/bar.ts'] }
    );
    expect(result).toBe('npx eslint src/foo.ts src/bar.ts');
  });

  it('returns empty string for missing output field', () => {
    const result = renderHookCommand(
      'npx eslint {{output.missing}}',
      {},
      {}
    );
    expect(result).toBe('npx eslint ');
  });

  it('handles mixed {{tool.*}} and {{output.*}} in same command', () => {
    const result = renderHookCommand(
      'run {{tool.script}} on {{output.files_changed}}',
      { script: 'check.sh' },
      { files_changed: 'src/foo.ts' }
    );
    expect(result).toBe('run check.sh on src/foo.ts');
  });

  it('leaves {{tool.*}} unchanged when outputContext not provided', () => {
    const result = renderHookCommand('echo {{tool.path}}', { path: 'x.ts' });
    expect(result).toBe('echo x.ts');
  });
});

describe('runStageHook', () => {
  it('returns success with stdout when command exits 0', async () => {
    const result = await runStageHook(
      { command: 'echo hello', on_failure: 'warn' },
      '/tmp'
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('');
  });

  it('returns failure with stderr when command exits non-zero', async () => {
    const result = await runStageHook(
      { command: 'sh -c "echo boom >&2; exit 1"', on_failure: 'warn' },
      '/tmp'
    );
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('boom');
  });
});

describe('runToolHook', () => {
  it('renders template and executes command', async () => {
    const result = await runToolHook(
      { matcher: 'repo_manager-write_file', command: 'echo {{tool.path}}', on_failure: 'warn' },
      { path: '/tmp/test.ts' },
      '/tmp'
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('/tmp/test.ts');
  });

  it('returns failure when rendered command exits non-zero', async () => {
    const result = await runToolHook(
      { matcher: 'any-tool', command: 'exit 1', on_failure: 'warn' },
      {},
      '/tmp'
    );
    expect(result.success).toBe(false);
  });
});

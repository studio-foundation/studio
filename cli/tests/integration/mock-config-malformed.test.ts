/**
 * Regression test for STU-1257: a mock.yaml missing the required top-level
 * `stages` key used to crash `studio run` with a raw
 * `TypeError: Cannot convert undefined or null to object` (from
 * `Object.entries(mockConfig.stages)` on `undefined`) — no file, no key, no
 * stack. The fix validates `stages` is present before reading it and names
 * the file and the missing key instead.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

const CLI_BIN = resolve(import.meta.dirname, '../../dist/index.js');

function setupProject(dir: string): void {
  const studioDir = join(dir, '.studio');
  mkdirSync(join(studioDir, 'pipelines'), { recursive: true });
  mkdirSync(join(studioDir, 'agents'), { recursive: true });

  writeFileSync(join(studioDir, 'config.yaml'), [
    'providers: {}',
    'defaults:',
    '  provider: mock',
  ].join('\n') + '\n');

  writeFileSync(join(studioDir, 'agents', 'echo.agent.yaml'), [
    'name: echo',
    'description: Echoes input',
    'system_prompt: You echo the input.',
  ].join('\n') + '\n');

  writeFileSync(join(studioDir, 'pipelines', 'leaf.pipeline.yaml'), [
    'name: leaf',
    'stages:',
    '  - name: leaf-stage',
    '    kind: work',
    '    agent: echo',
    '    context:',
    '      include: [input]',
  ].join('\n') + '\n');

  // Malformed on purpose: no top-level `stages:` wrapper (STU-1257's repro).
  writeFileSync(join(studioDir, 'mock.yaml'), [
    'leaf-stage:',
    '  content: \'{"result": "ok"}\'',
  ].join('\n') + '\n');
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`CLI process did not exit within 15000ms. stderr so far: ${stderr}`));
    }, 15000);
    child.on('exit', (code) => { clearTimeout(timer); resolvePromise({ code, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

describe('studio run — malformed mock.yaml (STU-1257)', () => {
  let projectDir: string;

  afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it('names the file and the missing key instead of a raw TypeError', async () => {
    projectDir = `/tmp/.studio-malformed-mock-test-${Date.now()}`;
    setupProject(projectDir);

    const child = spawn(
      process.execPath,
      [CLI_BIN, 'run', 'leaf', '--input', 'hello', '--provider', 'mock'],
      { cwd: projectDir, stdio: ['ignore', 'ignore', 'pipe'] },
    );

    const { code, stderr } = await waitForExit(child);

    expect(code).not.toBe(0);
    expect(stderr).toContain(join(projectDir, '.studio', 'mock.yaml'));
    expect(stderr).toContain('stages');
    expect(stderr).not.toContain('Cannot convert undefined or null to object');
  }, 20_000);
});

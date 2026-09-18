/**
 * Proves the nested run console (STU-861) on a real run, not only the
 * synthetic depth-1/depth-2 event sequences ProgressDisplay.getEvents() is
 * driven with elsewhere. STU-861 shipped on unit tests alone because the repo
 * had no runnable `.studio/` pipeline that nested a fan-out inside a called
 * pipeline that itself fans out — the gap this test closes (STU-1261).
 *
 * Fixture: `cli/tests/fixtures/nested-console/` — orchestrate.pipeline.yaml
 * fans out over 2 books (concurrency 2, depth 0→1); each book calls
 * chapters-pipeline, whose own map fans out over that book's chapters
 * (depth 1→2, depth 2→3 for the leaf). With outer concurrency 2, both books'
 * inner fan-outs are live at the same time — the actual risk STU-861 could
 * not prove: two live map renderers on screen at once, not just one nested
 * inside a linear call cascade. One chapter is deliberately gated to fail by
 * a script stage, so the run also exercises a real per-item failure line.
 *
 * This only checks facts that are reproducible from captured stdout — not
 * pixel-exact terminal behavior. The stdout capture here is exactly how most
 * people see this output anyway (CI logs, `studio run > out.txt`), and ora's
 * spinners disable animation on a non-TTY stream, so what's captured is the
 * same static text a human would read.
 */
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const CLI_BIN = resolve(import.meta.dirname, '../../dist/index.js');
const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/nested-console');

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: FIXTURE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`CLI did not exit within 20000ms. stdout so far: ${stdout}\nstderr: ${stderr}`));
    }, 20_000);
    child.on('exit', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

const RUN_ARGS = ['run', 'orchestrate', '--input-file', 'books.input.yaml', '--provider', 'mock'];

describe('nested run console on a real run (STU-1261)', () => {
  it('renders both fan-outs, each indented under its parent, with the outer alive twice concurrently', async () => {
    const { code, stdout } = await run(RUN_ARGS);

    expect(code).toBe(0);

    // The outer fan-out (process-books, depth 0) and the inner one
    // (review-chapters, reached through book-pipeline's call, depth 2).
    expect(stdout).toContain('↳ process-books — fan-out over 2 items (concurrency 2)');
    const innerHeaders = stdout.split('↳ review-chapters — fan-out over 2 items (concurrency 2)').length - 1;
    // Two books, each spawning its own inner map — both headers must appear,
    // not just one reused for both (that would mean the second book's fan-out
    // never rendered at all, the actual risk this test exists to catch).
    expect(innerHeaders).toBe(2);

    // Indentation: the inner header lines are indented deeper than the outer
    // one — 6 spaces vs 2, per ProgressDisplay's `'  '.repeat(depth)`.
    const outerLine = stdout.split('\n').find((l) => l.includes('↳ process-books'));
    const innerLine = stdout.split('\n').find((l) => l.includes('↳ review-chapters'));
    expect(outerLine).toBeDefined();
    expect(innerLine).toBeDefined();
    const outerIndent = outerLine!.match(/^\s*/)![0].length;
    const innerIndent = innerLine!.match(/^\s*/)![0].length;
    expect(innerIndent).toBeGreaterThan(outerIndent);

    // Both inner headers appear before either inner fan-out's own summary —
    // i.e. book two's map started rendering while book one's was still live,
    // not queued up and printed only after book one fully finished.
    const secondInnerHeaderIndex = stdout.lastIndexOf('↳ review-chapters — fan-out over 2 items (concurrency 2)');
    const firstInnerSummaryIndex = stdout.indexOf('review-chapters 1/2 succeeded, 1 failed');
    const secondInnerSummaryIndex = stdout.indexOf('review-chapters 2/2 succeeded');
    expect(secondInnerHeaderIndex).toBeLessThan(Math.max(firstInnerSummaryIndex, secondInnerSummaryIndex));

    // The gated chapter's per-item failure is a real static line (not folded
    // into a live counter), and the run still completes successfully overall
    // (on_item_failure: collect-all, and the sibling chapter/book succeed).
    expect(stdout).toContain('Chapter 2 (fails review) failed');
    expect(stdout).toContain('Chapter failed the review gate');
    expect(stdout).toContain('review-chapters 1/2 succeeded, 1 failed');
    expect(stdout).toContain('✓ process-books 2/2 succeeded');
    expect(stdout).toContain('✓ Pipeline completed');
  }, 15_000);

  it('keeps the same shape under --live', async () => {
    const { code, stdout } = await run([...RUN_ARGS, '--live']);

    expect(code).toBe(0);
    expect(stdout).toContain('↳ process-books — fan-out over 2 items (concurrency 2)');
    const innerHeaders = stdout.split('↳ review-chapters — fan-out over 2 items (concurrency 2)').length - 1;
    expect(innerHeaders).toBe(2);
    expect(stdout).toContain('Chapter 2 (fails review) failed');
    expect(stdout).toContain('✓ Pipeline completed');
  }, 15_000);

  it('--json keeps its contract: no human-rendered map text, structured output only', async () => {
    const { code, stdout } = await run([...RUN_ARGS, '--json']);

    expect(code).toBe(0);
    expect(stdout).not.toContain('↳');
    expect(stdout).not.toContain('fan-out over');

    const result = JSON.parse(stdout) as {
      status: string;
      stages: Array<{ stage_name: string; status: string; output: { total: number; succeeded: number; failed: number } }>;
    };
    expect(result.status).toBe('success');
    const outer = result.stages.find((s) => s.stage_name === 'process-books');
    expect(outer?.output).toEqual(expect.objectContaining({ total: 2, succeeded: 2, failed: 0 }));
  }, 15_000);
});

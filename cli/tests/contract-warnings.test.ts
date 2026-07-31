import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parsePipelineYaml } from '@studio-foundation/engine';
import {
  missingContractWarnings,
  missingContractWarningsEnabled,
  resolvePipelinesDir,
  scanPipelineContracts,
} from '../src/contract-warnings.js';
import { collectChecks } from '../src/preflight.js';
import type { PreflightCheck } from '../src/preflight.js';

const STUDIO_DIR = resolve('/tmp', '.studio-contract-warnings-test');
const PIPELINES_DIR = join(STUDIO_DIR, 'pipelines');

beforeEach(async () => {
  await mkdir(PIPELINES_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(STUDIO_DIR, { recursive: true, force: true });
});

const writePipeline = (name: string, body: string) =>
  writeFile(join(PIPELINES_DIR, `${name}.pipeline.yaml`), body, 'utf-8');

const COVERED = `
name: covered
stages:
  - name: plan
    kind: planning
    agent: planner
    contract: plan
`;

const UNCOVERED = `
name: uncovered
stages:
  - name: plan
    kind: planning
    agent: planner
    contract: plan
  - name: code-generation
    kind: code
    agent: coder
`;

const contracts = (checks: PreflightCheck[]): PreflightCheck =>
  checks.find((c) => c.name === 'Contracts')!;

describe('missingContractWarnings', () => {
  it('returns nothing when every stage has a contract', () => {
    expect(missingContractWarnings(parsePipelineYaml(COVERED))).toEqual([]);
  });

  it('names each contract-less stage once', () => {
    expect(missingContractWarnings(parsePipelineYaml(UNCOVERED))).toEqual([
      "stage 'code-generation' has no contract — output is not validated",
    ]);
  });
});

describe('missingContractWarningsEnabled', () => {
  it('is on by default', () => {
    expect(missingContractWarningsEnabled({})).toBe(true);
    expect(missingContractWarningsEnabled({ warnings: {} })).toBe(true);
  });

  it('is off only when the project says so', () => {
    expect(missingContractWarningsEnabled({ warnings: { missing_contract: false } })).toBe(false);
    expect(missingContractWarningsEnabled({ warnings: { missing_contract: true } })).toBe(true);
  });
});

describe('scanPipelineContracts', () => {
  it('reports an empty scan when the directory does not exist', async () => {
    expect(await scanPipelineContracts(join(STUDIO_DIR, 'nope'))).toEqual({
      scanned: 0,
      unreadable: [],
      stages: [],
    });
  });

  it('tags each unvalidated stage with its pipeline', async () => {
    await writePipeline('covered', COVERED);
    await writePipeline('uncovered', UNCOVERED);

    const coverage = await scanPipelineContracts(PIPELINES_DIR);
    expect(coverage.scanned).toBe(2);
    expect(coverage.stages).toEqual([
      { pipeline: 'uncovered', stage: 'code-generation' },
    ]);
  });

  it('counts a pipeline it cannot parse instead of throwing', async () => {
    await writePipeline('broken', 'name: broken\nstages: []\n');
    const coverage = await scanPipelineContracts(PIPELINES_DIR);
    expect(coverage.scanned).toBe(0);
    expect(coverage.unreadable).toEqual(['broken.pipeline.yaml']);
  });
});

describe('doctor — Contracts check', () => {
  it('is ok when there is no pipeline to look at', async () => {
    const check = contracts(await collectChecks(STUDIO_DIR, {}));
    expect(check.status).toBe('ok');
    expect(check.detail).toBe('no pipelines found');
  });

  it('is ok when every stage validates its output', async () => {
    await writePipeline('covered', COVERED);
    const check = contracts(await collectChecks(STUDIO_DIR, {}));
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('every stage validates its output');
  });

  it('warns — never fails — on a contract-less stage, and names it', async () => {
    await writePipeline('uncovered', UNCOVERED);
    const check = contracts(await collectChecks(STUDIO_DIR, {}));
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('1 stage');
    expect(check.fix).toContain("pipeline 'uncovered', stage 'code-generation'");
    expect(check.fix).toContain('warnings.missing_contract: false');
  });

  it('stays quiet when the project suppressed the warning', async () => {
    await writePipeline('uncovered', UNCOVERED);
    const check = contracts(
      await collectChecks(STUDIO_DIR, { warnings: { missing_contract: false } })
    );
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('warnings suppressed');
    expect(check.fix).toBeUndefined();
  });
});

describe('resolvePipelinesDir', () => {
  it('defaults to <studio dir>/pipelines', () => {
    expect(resolvePipelinesDir(STUDIO_DIR, {})).toBe(PIPELINES_DIR);
  });

  it('follows paths.configs when the project relocates its configs', () => {
    expect(resolvePipelinesDir(STUDIO_DIR, { paths: { configs: '/tmp/elsewhere' } })).toBe(
      join('/tmp/elsewhere', 'pipelines')
    );
  });
});

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PipelineEngine, type EngineConfig } from '../src/engine.js';
import { DirectEngineSpawner } from '../src/spawners/direct-engine-spawner.js';
import { InMemoryRunStore } from '../src/state/run-store.js';

// STU-615: a call (or map) stage inside a *called* pipeline must still be able
// to spawn — DirectEngineSpawner used to build child engines without a
// spawner, so nesting died at depth 1 with "requires a run spawner" while
// maxDepth promised 3. Real engines, real YAML loading, real script executor;
// no LLM (the leaf is a shell echo).

const LEAF = `name: leaf
description: leaf pipeline — one shell stage
version: 1
stages:
  - name: leaf-stage
    executor: script
    runtime: shell
    script: scripts/leaf.sh
`;

const MID = `name: mid
description: mid pipeline — calls leaf (depth 2 spawn)
version: 1
stages:
  - call: leaf-call
    pipeline: leaf
`;

const PARENT = `name: parent
description: parent pipeline — calls mid (depth 1 spawn)
version: 1
stages:
  - call: mid-call
    pipeline: mid
`;

function writeConfigs(root: string): void {
  mkdirSync(join(root, 'pipelines'), { recursive: true });
  writeFileSync(join(root, 'pipelines', 'leaf.pipeline.yaml'), LEAF);
  writeFileSync(join(root, 'pipelines', 'mid.pipeline.yaml'), MID);
  writeFileSync(join(root, 'pipelines', 'parent.pipeline.yaml'), PARENT);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'leaf.sh'), '#!/bin/sh\necho \'{"ok": true}\'\n', { mode: 0o755 });
}

describe('nested call — spawner handoff (STU-615)', () => {
  it('a call inside a called pipeline spawns at depth 2 and succeeds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-nested-call-'));
    try {
      writeConfigs(root);
      const engineConfig = {
        configsDir: root,
        repoPath: root,
        providerRegistry: { get: () => undefined, register: () => undefined } as any,
        db: new InMemoryRunStore(),
      } as unknown as EngineConfig;
      const spawner = new DirectEngineSpawner(engineConfig);
      const engine = new PipelineEngine({ ...engineConfig, spawner, maxDepth: 3 });

      const result = await engine.run({ pipeline: 'parent', input: { book: 'x' } });

      expect(result.status).toBe('success');
      const midCall = result.stages[0] as { status: string; output?: unknown };
      expect(midCall.status).toBe('success');
      // The mid pipeline's own call ran (this is the depth-2 spawn that used to
      // die with "requires a run spawner") and the leaf's output bubbled up.
      expect(midCall.output).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stamps child stage events with their nesting depth (STU-620)', async () => {
    const { PipelineEngine } = await import('../src/engine.js');
    const { DirectEngineSpawner } = await import('../src/spawners/direct-engine-spawner.js');
    const { InMemoryRunStore } = await import('../src/state/run-store.js');
    const root = mkdtempSync(join(tmpdir(), 'studio-depth-events-'));
    try {
      writeConfigs(root);
      const engineConfig = {
        configsDir: root,
        repoPath: root,
        providerRegistry: { get: () => undefined, register: () => undefined } as any,
        db: new InMemoryRunStore(),
      } as unknown as EngineConfig;

      const seen: Array<{ stage: string; depth?: number; childId?: string }> = [];
      const events = {
        onStageStart: (e: any, ctx?: any) =>
          seen.push({ stage: e.stage_name, depth: ctx?.depth, childId: ctx?.childId }),
      };

      const spawner = new DirectEngineSpawner(engineConfig, events);
      const engine = new PipelineEngine({ ...engineConfig, spawner, maxDepth: 3 }, events);
      const result = await engine.run({ pipeline: 'parent', input: { book: 'x' } });
      expect(result.status).toBe('success');

      const leafCall = seen.find(s => s.stage === 'leaf-call');   // mid pipeline stage, depth 1
      const leafStage = seen.find(s => s.stage === 'leaf-stage'); // leaf pipeline stage, depth 2
      expect(leafCall?.depth).toBe(1);
      expect(leafStage?.depth).toBe(2);
      expect(typeof leafCall?.childId).toBe('string');
      expect(leafStage?.childId).not.toBe(leafCall?.childId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('gives concurrent same-depth spawns distinct childIds (STU-620)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-concurrent-spawn-'));
    try {
      writeConfigs(root);
      const engineConfig = {
        configsDir: root,
        repoPath: root,
        providerRegistry: { get: () => undefined, register: () => undefined } as any,
        db: new InMemoryRunStore(),
      } as unknown as EngineConfig;

      const seen: Array<{ stage: string; depth?: number; childId?: string }> = [];
      const events = {
        onStageStart: (e: any, ctx?: any) =>
          seen.push({ stage: e.stage_name, depth: ctx?.depth, childId: ctx?.childId }),
      };

      const spawner = new DirectEngineSpawner(engineConfig, events);

      const [resultA, resultB] = await Promise.all([
        spawner.spawnAndWait({ pipeline: 'leaf', input: {}, parentRunId: 'parent-a', depth: 1 }),
        spawner.spawnAndWait({ pipeline: 'leaf', input: {}, parentRunId: 'parent-b', depth: 1 }),
      ]);

      expect(resultA.status).toBe('success');
      expect(resultB.status).toBe('success');

      const leafStageEvents = seen.filter(s => s.stage === 'leaf-stage' && s.depth === 1);
      expect(leafStageEvents).toHaveLength(2);
      const childIds = leafStageEvents.map(s => s.childId);
      expect(new Set(childIds).size).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

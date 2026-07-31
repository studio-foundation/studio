import { describe, it, expect } from 'vitest';
import type { OutputContract } from '@studio-foundation/contracts';
import { contractRequiresToolCalls, shouldCachePrompt } from './prompt-cache.js';

const contract = (tool_calls?: OutputContract['tool_calls']): OutputContract => ({
  name: 'c',
  version: 1,
  ...(tool_calls ? { tool_calls } : {}),
});

describe('contractRequiresToolCalls', () => {
  it('is false without a contract, or without tool requirements', () => {
    expect(contractRequiresToolCalls(undefined)).toBe(false);
    expect(contractRequiresToolCalls(contract())).toBe(false);
  });

  it('is false when the contract only caps tool calls', () => {
    // A maximum permits zero — it predicts nothing about a second turn.
    expect(contractRequiresToolCalls(contract({ maximum: 5 }))).toBe(false);
    expect(contractRequiresToolCalls(contract({ minimum: 0 }))).toBe(false);
  });

  it('is true for a floor, a named tool, or a tool group', () => {
    expect(contractRequiresToolCalls(contract({ minimum: 1 }))).toBe(true);
    expect(contractRequiresToolCalls(contract({ required_tools: ['repo_manager.write_file'] }))).toBe(true);
    expect(contractRequiresToolCalls(contract({ required_tool_groups: [['a', 'b']] }))).toBe(true);
  });
});

describe('shouldCachePrompt', () => {
  it('does not cache a single-shot call — the case that was overpaying', () => {
    // A map item or a verdict: tools may be on the table, nothing obliges a
    // second turn, so the cache write would never be read back.
    expect(shouldCachePrompt({ hasTools: true, contract: contract() })).toBe(false);
    expect(shouldCachePrompt({ hasTools: false, contract: undefined })).toBe(false);
  });

  it('caches when the contract obliges the stage to call tools', () => {
    expect(shouldCachePrompt({ hasTools: true, contract: contract({ minimum: 1 }) })).toBe(true);
  });

  it('does not cache a tool-requiring contract when the agent has no tools', () => {
    // Misconfigured stage — it will fail validation, not loop.
    expect(shouldCachePrompt({ hasTools: false, contract: contract({ minimum: 1 }) })).toBe(false);
  });

  it('lets an agent force caching on for a measured shared prefix', () => {
    expect(shouldCachePrompt({ hasTools: false, contract: undefined, mode: 'on' })).toBe(true);
  });

  it('lets an agent force caching off even where auto would cache', () => {
    expect(shouldCachePrompt({ hasTools: true, contract: contract({ minimum: 1 }), mode: 'off' })).toBe(false);
  });

  it('treats an explicit auto exactly as an absent setting', () => {
    for (const c of [contract(), contract({ minimum: 1 })]) {
      expect(shouldCachePrompt({ hasTools: true, contract: c, mode: 'auto' }))
        .toBe(shouldCachePrompt({ hasTools: true, contract: c }));
    }
  });
});

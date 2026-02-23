import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioOAuthProvider } from './oauth-provider.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'studio-oauth-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('StudioOAuthProvider — storage', () => {
  it('tokens() returns undefined when no file exists', async () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    expect(await p.tokens()).toBeUndefined();
  });

  it('saveTokens() + tokens() round-trips correctly', async () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    const tokens = { access_token: 'tok123', token_type: 'bearer', expires_in: 3600, refresh_token: 'ref456' };
    await p.saveTokens(tokens);
    expect(await p.tokens()).toEqual(tokens);
  });

  it('clientInformation() returns undefined when no file exists', async () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    expect(await p.clientInformation()).toBeUndefined();
  });

  it('saveClientInformation() + clientInformation() round-trips correctly', async () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    const info = { client_id: 'cid', client_secret: 'csec' };
    await p.saveClientInformation(info);
    expect(await p.clientInformation()).toEqual(info);
  });

  it('two providers with same URL share the same storage file', async () => {
    const p1 = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    const p2 = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    await p1.saveTokens({ access_token: 'shared', token_type: 'bearer' });
    expect(await p2.tokens()).toEqual({ access_token: 'shared', token_type: 'bearer' });
  });

  it('two providers with different URLs use different storage files', async () => {
    const p1 = new StudioOAuthProvider('https://mcp.linear.app/mcp', tmpDir);
    const p2 = new StudioOAuthProvider('https://mcp.github.com/mcp', tmpDir);
    await p1.saveTokens({ access_token: 'linear-tok', token_type: 'bearer' });
    expect(await p2.tokens()).toBeUndefined();
  });
});

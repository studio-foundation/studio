import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioOAuthProvider } from './oauth-provider.js';

vi.mock('node:child_process', () => ({ exec: vi.fn() }));

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

describe('StudioOAuthProvider — PKCE', () => {
  it('codeVerifier() throws before saveCodeVerifier() is called', () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    expect(() => p.codeVerifier()).toThrow();
  });

  it('saveCodeVerifier() + codeVerifier() round-trips in memory', () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    p.saveCodeVerifier('verifier-abc');
    expect(p.codeVerifier()).toBe('verifier-abc');
  });

  it('codeVerifier is NOT persisted across instances', async () => {
    const p1 = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    const p2 = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    p1.saveCodeVerifier('only-in-p1');
    expect(() => p2.codeVerifier()).toThrow();
  });
});

describe('StudioOAuthProvider — metadata', () => {
  it('redirectUrl is undefined before startCallbackServer()', () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    expect(p.redirectUrl).toBeUndefined();
  });

  it('clientMetadata includes redirect_uri after server starts', async () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    const { close } = await p.startCallbackServer();
    try {
      const redirectUrl = p.redirectUrl;
      expect(redirectUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/);
      const meta = p.clientMetadata;
      expect(meta.client_name).toBe('Studio');
      expect(meta.redirect_uris).toHaveLength(1);
      expect(meta.redirect_uris[0].toString()).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    } finally {
      close();
    }
  });
});

describe('StudioOAuthProvider — callback server', () => {
  it('startCallbackServer() resolves codePromise when /callback?code=X is hit', async () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    const { codePromise, close } = await p.startCallbackServer();

    const port = (p.redirectUrl as string).match(/:(\d+)/)![1];
    const res = await fetch(`http://localhost:${port}/callback?code=auth-code-123`);
    expect(res.ok).toBe(true);
    expect(await codePromise).toBe('auth-code-123');
    close();
  });

  it('callback response contains success HTML', async () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    const { close } = await p.startCallbackServer();

    const port = (p.redirectUrl as string).match(/:(\d+)/)![1];
    const res = await fetch(`http://localhost:${port}/callback?code=x`);
    const html = await res.text();
    expect(html).toContain('Authorization successful');
    close();
  });

  it('codePromise rejects after timeout', async () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir, 50);
    const { codePromise, close } = await p.startCallbackServer();
    await expect(codePromise).rejects.toThrow('timed out');
    close();
  });

  it('sets callbackPort so redirectUrl reflects the server port', async () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    expect(p.redirectUrl).toBeUndefined();
    const { close } = await p.startCallbackServer();
    expect(p.redirectUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    close();
  });

  it('clears stale clientInformation but preserves tokens on startCallbackServer()', async () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    // Seed stale state: clientInformation with old redirect_uri + existing tokens
    await p.saveClientInformation({ client_id: 'old-client', redirect_uris: ['http://localhost:9999/callback'] } as any);
    await p.saveTokens({ access_token: 'tok', token_type: 'Bearer' });

    const { close } = await p.startCallbackServer();
    close();

    expect(await p.clientInformation()).toBeUndefined();
    expect(await p.tokens()).toEqual({ access_token: 'tok', token_type: 'Bearer' });
  });
});

describe('StudioOAuthProvider — redirectToAuthorization', () => {
  it('prints the authorization URL to stderr', async () => {
    const p = new StudioOAuthProvider('https://mcp.example.com/mcp', tmpDir);
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      written.push(String(s));
      return true;
    });

    await p.redirectToAuthorization(new URL('https://auth.example.com/authorize?foo=bar'));

    spy.mockRestore();
    expect(written.join('')).toContain('https://auth.example.com/authorize');
  });
});

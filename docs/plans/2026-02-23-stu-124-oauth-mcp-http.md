# STU-124: OAuth Flow for HTTP MCP Servers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable Studio to authenticate with OAuth-protected HTTP MCP servers (e.g. Linear) by implementing `OAuthClientProvider` with a local HTTP callback server.

**Architecture:** `StudioOAuthProvider` implements the MCP SDK's `OAuthClientProvider` interface. It stores tokens globally in `~/.config/studio/oauth/<hash>.json`. `MCPClient` creates a provider when `auth.type: 'oauth'` is in the server def, pre-starts a local callback server, catches `UnauthorizedError` from the SDK, awaits the OAuth code, calls `transport.finishAuth()`, then retries `connect()`. The CLI (`run.ts`) needs no changes.

**Tech Stack:** `@modelcontextprotocol/sdk` (OAuthClientProvider, UnauthorizedError, StreamableHTTPClientTransport), Node.js `http`, `crypto`, `fs/promises`, `child_process`, vitest.

---

### Task 1: Add `auth` field to `MCPServerDef`

**Files:**
- Modify: `runner/src/plugins/plugin-loader.ts`

**Step 1: Edit the type**

In `plugin-loader.ts`, extend the `http` variant of `MCPServerDef`:

```typescript
export type MCPServerDef =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      auth?: { type: 'oauth'; client_id?: string; client_secret?: string; scope?: string };
    };
```

**Step 2: Verify build passes**

```bash
pnpm build
```

Expected: builds without errors.

**Step 3: Commit**

```bash
git add runner/src/plugins/plugin-loader.ts
git commit -m "feat(runner): add auth field to MCPServerDef for OAuth support"
```

---

### Task 2: `StudioOAuthProvider` — token and client info storage

**Files:**
- Create: `runner/src/plugins/oauth-provider.ts`
- Create: `runner/src/plugins/oauth-provider.test.ts`

**Step 1: Write failing tests**

Create `runner/src/plugins/oauth-provider.test.ts`:

```typescript
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
```

**Step 2: Run tests to verify they fail**

```bash
cd runner && pnpm vitest run src/plugins/oauth-provider.test.ts
```

Expected: FAIL with "Cannot find module './oauth-provider.js'"

**Step 3: Create `oauth-provider.ts` with storage implementation**

Create `runner/src/plugins/oauth-provider.ts`:

```typescript
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

interface StorageData {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

export class StudioOAuthProvider implements OAuthClientProvider {
  private readonly filePath: string;
  private _codeVerifier: string | undefined;
  private _callbackPort: number | undefined;

  constructor(
    private readonly serverUrl: string,
    private readonly storageDir: string = join(
      process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
      '.config', 'studio', 'oauth'
    )
  ) {
    this.filePath = join(storageDir, `${urlHash(serverUrl)}.json`);
  }

  // --- Storage helpers ---

  private async load(): Promise<StorageData> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as StorageData;
    } catch {
      return {};
    }
  }

  private async save(data: StorageData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // --- OAuthClientProvider: tokens ---

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const data = await this.load();
    await this.save({ ...data, tokens });
  }

  // --- OAuthClientProvider: client information ---

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.load()).clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const data = await this.load();
    await this.save({ ...data, clientInformation: info });
  }

  // --- Stubs (implemented in later tasks) ---

  get redirectUrl(): string | URL | undefined { return undefined; }
  get clientMetadata(): OAuthClientMetadata {
    return { redirect_uris: [] };
  }
  saveCodeVerifier(_v: string): void {}
  codeVerifier(): string { throw new Error('not implemented'); }
  redirectToAuthorization(_url: URL): void {}
}
```

**Step 4: Run tests to verify they pass**

```bash
cd runner && pnpm vitest run src/plugins/oauth-provider.test.ts
```

Expected: all 5 storage tests PASS.

**Step 5: Commit**

```bash
git add runner/src/plugins/oauth-provider.ts runner/src/plugins/oauth-provider.test.ts
git commit -m "feat(runner): add StudioOAuthProvider with token/clientInfo storage"
```

---

### Task 3: `StudioOAuthProvider` — PKCE, metadata, redirectUrl

**Files:**
- Modify: `runner/src/plugins/oauth-provider.ts`
- Modify: `runner/src/plugins/oauth-provider.test.ts`

**Step 1: Write failing tests**

Append to the `describe` block in `oauth-provider.test.ts`:

```typescript
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
```

**Step 2: Run tests to verify they fail**

```bash
cd runner && pnpm vitest run src/plugins/oauth-provider.test.ts
```

Expected: PKCE and metadata tests FAIL.

**Step 3: Implement PKCE + metadata in `oauth-provider.ts`**

Replace the stub section at the bottom with:

```typescript
  // --- OAuthClientProvider: PKCE ---

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this._codeVerifier === undefined) {
      throw new Error('No code verifier saved for this session');
    }
    return this._codeVerifier;
  }

  // --- OAuthClientProvider: metadata ---

  get redirectUrl(): string | undefined {
    if (this._callbackPort === undefined) return undefined;
    return `http://localhost:${this._callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUri = this.redirectUrl ?? 'http://localhost/callback';
    return {
      client_name: 'Studio',
      redirect_uris: [new URL(redirectUri)],
    };
  }
```

Keep `redirectToAuthorization` as a stub for now.

**Step 4: Run tests to verify they pass**

```bash
cd runner && pnpm vitest run src/plugins/oauth-provider.test.ts
```

Expected: all PKCE and metadata tests PASS (callback server tests will still fail — added in next task).

**Step 5: Commit**

```bash
git add runner/src/plugins/oauth-provider.ts runner/src/plugins/oauth-provider.test.ts
git commit -m "feat(runner): add PKCE and clientMetadata to StudioOAuthProvider"
```

---

### Task 4: `StudioOAuthProvider` — callback server

**Files:**
- Modify: `runner/src/plugins/oauth-provider.ts`
- Modify: `runner/src/plugins/oauth-provider.test.ts`

**Step 1: Write failing tests**

Append to `oauth-provider.test.ts`:

```typescript
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
});
```

**Step 2: Run tests to verify they fail**

```bash
cd runner && pnpm vitest run src/plugins/oauth-provider.test.ts
```

Expected: callback server tests FAIL with "p.startCallbackServer is not a function".

**Step 3: Update `StudioOAuthProvider` constructor and add `startCallbackServer`**

Update the constructor signature to accept an optional `timeoutMs` param:

```typescript
constructor(
  private readonly serverUrl: string,
  private readonly storageDir: string = join(
    process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
    '.config', 'studio', 'oauth'
  ),
  private readonly timeoutMs: number = 5 * 60 * 1000
) {
  this.filePath = join(storageDir, `${urlHash(serverUrl)}.json`);
}
```

Add at the top of the file:

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
```

Add the `startCallbackServer` method:

```typescript
  async startCallbackServer(): Promise<{ codePromise: Promise<string>; close: () => void }> {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authorization successful</h1><p>You can close this tab.</p></body></html>');
          resolveCode(code);
        } else {
          res.writeHead(400);
          res.end('Missing code parameter');
          rejectCode(new Error('OAuth callback missing code parameter'));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((res, rej) => {
      server.listen(0, 'localhost', res);
      server.on('error', rej);
    });

    const { port } = server.address() as AddressInfo;
    this._callbackPort = port;

    const timeout = setTimeout(() => {
      rejectCode(new Error('OAuth authorization timed out. Run again to retry.'));
      server.close();
      this._callbackPort = undefined;
    }, this.timeoutMs);

    const close = () => {
      clearTimeout(timeout);
      server.close();
      this._callbackPort = undefined;
    };

    return { codePromise, close };
  }
```

**Step 4: Run tests to verify they pass**

```bash
cd runner && pnpm vitest run src/plugins/oauth-provider.test.ts
```

Expected: all callback server tests PASS.

**Step 5: Commit**

```bash
git add runner/src/plugins/oauth-provider.ts runner/src/plugins/oauth-provider.test.ts
git commit -m "feat(runner): add startCallbackServer() to StudioOAuthProvider"
```

---

### Task 5: `StudioOAuthProvider` — `redirectToAuthorization`

**Files:**
- Modify: `runner/src/plugins/oauth-provider.ts`
- Modify: `runner/src/plugins/oauth-provider.test.ts`

**Step 1: Write failing test**

Append to `oauth-provider.test.ts`:

```typescript
import { vi } from 'vitest';

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
```

**Step 2: Run test to verify it fails**

```bash
cd runner && pnpm vitest run src/plugins/oauth-provider.test.ts
```

Expected: FAIL (current stub does nothing).

**Step 3: Implement `redirectToAuthorization`**

Add at the top of `oauth-provider.ts`:

```typescript
import { exec } from 'node:child_process';
```

Replace the stub `redirectToAuthorization` with:

```typescript
  redirectToAuthorization(authorizationUrl: URL): void {
    const url = authorizationUrl.toString();
    process.stderr.write(`\n  Open this URL to authorize Studio:\n  ${url}\n\n`);

    const cmd =
      process.platform === 'darwin' ? `open "${url}"` :
      process.platform === 'win32' ? `start "" "${url}"` :
      `xdg-open "${url}"`;

    exec(cmd, () => { /* ignore errors — URL already printed */ });
  }
```

**Step 4: Run tests to verify they pass**

```bash
cd runner && pnpm vitest run src/plugins/oauth-provider.test.ts
```

Expected: ALL tests in the file PASS.

**Step 5: Commit**

```bash
git add runner/src/plugins/oauth-provider.ts runner/src/plugins/oauth-provider.test.ts
git commit -m "feat(runner): implement redirectToAuthorization in StudioOAuthProvider"
```

---

### Task 6: Wire `MCPClient` constructor for OAuth

**Files:**
- Modify: `runner/src/plugins/mcp-client.ts`
- Modify: `runner/src/plugins/mcp-client.test.ts`

**Step 1: Write failing tests**

Append to `mcp-client.test.ts`:

```typescript
describe('MCPClient — OAuth constructor', () => {
  it('creates an oauthProvider when auth.type is oauth', () => {
    const client = new MCPClient('linear', 'linear', {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      auth: { type: 'oauth' },
    });
    expect(client.oauthProvider).toBeDefined();
  });

  it('does not create oauthProvider for plain HTTP server', () => {
    const client = new MCPClient('github', 'github', {
      type: 'http',
      url: 'https://mcp.github.com/mcp',
      headers: { Authorization: 'Bearer tok' },
    });
    expect(client.oauthProvider).toBeUndefined();
  });

  it('does not create oauthProvider for stdio server', () => {
    const client = new MCPClient('myplugin', 'myserver', { command: 'cmd' });
    expect(client.oauthProvider).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd runner && pnpm vitest run src/plugins/mcp-client.test.ts
```

Expected: FAIL with "client.oauthProvider is not defined as a property".

**Step 3: Update `mcp-client.ts`**

Add import at top:

```typescript
import { StudioOAuthProvider } from './oauth-provider.js';
```

Add a public field and update the HTTP branch in the constructor:

```typescript
  oauthProvider: StudioOAuthProvider | undefined;

  constructor(
    private pluginName: string,
    private serverName: string,
    private def: MCPServerDef
  ) {
    if (def.type === 'http') {
      if (def.auth?.type === 'oauth') {
        this.oauthProvider = new StudioOAuthProvider(def.url);
        this.transport = new StreamableHTTPClientTransport(new URL(def.url), {
          authProvider: this.oauthProvider,
        });
      } else {
        const headers = this.resolveEnv(def.headers ?? {});
        this.transport = new StreamableHTTPClientTransport(new URL(def.url), {
          requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
        });
      }
    } else {
      // ... existing stdio path unchanged
    }
```

**Step 4: Run tests to verify they pass**

```bash
cd runner && pnpm vitest run src/plugins/mcp-client.test.ts
```

Expected: ALL tests PASS.

**Step 5: Commit**

```bash
git add runner/src/plugins/mcp-client.ts runner/src/plugins/mcp-client.test.ts
git commit -m "feat(runner): wire StudioOAuthProvider into MCPClient for OAuth servers"
```

---

### Task 7: `MCPClient.start()` — OAuth dance

**Files:**
- Modify: `runner/src/plugins/mcp-client.ts`
- Modify: `runner/src/plugins/mcp-client.test.ts`

**Step 1: Write failing test**

Append to `mcp-client.test.ts`:

```typescript
import { vi } from 'vitest';

describe('MCPClient.start() — OAuth dance', () => {
  it('calls startCallbackServer and finishAuth when UnauthorizedError is thrown', async () => {
    // Build an MCPClient with OAuth config
    const client = new MCPClient('linear', 'linear', {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      auth: { type: 'oauth' },
    });

    // Mock oauthProvider.startCallbackServer to return a pre-resolved code
    const mockClose = vi.fn();
    vi.spyOn(client.oauthProvider!, 'startCallbackServer').mockResolvedValue({
      codePromise: Promise.resolve('auth-code-xyz'),
      close: mockClose,
    });

    // Mock the SDK client and transport
    const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js');
    let connectCallCount = 0;
    vi.spyOn(client['client'], 'connect').mockImplementation(async () => {
      connectCallCount++;
      if (connectCallCount === 1) throw new UnauthorizedError('needs auth');
      // second call succeeds
    });
    const mockFinishAuth = vi.fn().mockResolvedValue(undefined);
    (client['transport'] as any).finishAuth = mockFinishAuth;

    await client.start();

    expect(mockFinishAuth).toHaveBeenCalledWith('auth-code-xyz');
    expect(connectCallCount).toBe(2);
    expect(mockClose).toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('closes the callback server and rethrows on non-OAuth error', async () => {
    const client = new MCPClient('linear', 'linear', {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      auth: { type: 'oauth' },
    });

    const mockClose = vi.fn();
    vi.spyOn(client.oauthProvider!, 'startCallbackServer').mockResolvedValue({
      codePromise: Promise.resolve('unused'),
      close: mockClose,
    });

    vi.spyOn(client['client'], 'connect').mockRejectedValue(new Error('network failure'));

    await expect(client.start()).rejects.toThrow('network failure');
    expect(mockClose).toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('closes the callback server immediately when connect() succeeds (tokens exist)', async () => {
    const client = new MCPClient('linear', 'linear', {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      auth: { type: 'oauth' },
    });

    const mockClose = vi.fn();
    vi.spyOn(client.oauthProvider!, 'startCallbackServer').mockResolvedValue({
      codePromise: new Promise(() => { /* never resolves */ }),
      close: mockClose,
    });

    vi.spyOn(client['client'], 'connect').mockResolvedValue(undefined);

    await client.start();

    expect(mockClose).toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd runner && pnpm vitest run src/plugins/mcp-client.test.ts
```

Expected: the three new OAuth dance tests FAIL.

**Step 3: Update `start()` in `mcp-client.ts`**

Add import at top:

```typescript
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
```

Replace the existing `start()` method:

```typescript
  async start(): Promise<void> {
    if (this.oauthProvider) {
      const { codePromise, close } = await this.oauthProvider.startCallbackServer();
      try {
        await this.client.connect(this.transport);
        close();
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          const code = await codePromise;
          close();
          await (this.transport as StreamableHTTPClientTransport).finishAuth(code);
          await this.client.connect(this.transport);
        } else {
          close();
          throw err;
        }
      }
    } else {
      await this.client.connect(this.transport);
    }
  }
```

**Step 4: Run tests to verify they pass**

```bash
cd runner && pnpm vitest run src/plugins/mcp-client.test.ts
```

Expected: ALL tests PASS.

**Step 5: Commit**

```bash
git add runner/src/plugins/mcp-client.ts runner/src/plugins/mcp-client.test.ts
git commit -m "feat(runner): implement OAuth dance in MCPClient.start() (STU-124)"
```

---

### Task 8: Export, full build, and verify

**Files:**
- Modify: `runner/src/plugins/index.ts`
- Modify: `runner/src/index.ts`

**Step 1: Export `StudioOAuthProvider` from the plugins index**

In `runner/src/plugins/index.ts`, add:

```typescript
export { StudioOAuthProvider } from './oauth-provider.js';
```

In `runner/src/index.ts`, add to the plugins export line:

```typescript
export { loadPlugins, MCPClient, StudioOAuthProvider } from './plugins/index.js';
export type { PluginManifest, MCPServerDef, SkillContent } from './plugins/index.js';
```

**Step 2: Run full test suite**

```bash
pnpm test
```

Expected: all tests across all packages pass.

**Step 3: Full build**

```bash
pnpm build
```

Expected: clean build with no errors.

**Step 4: Commit**

```bash
git add runner/src/plugins/index.ts runner/src/index.ts
git commit -m "feat(runner): export StudioOAuthProvider from runner package"
```

**Step 5: Manual smoke test with Linear**

Create `.studio/plugins/linear/.mcp.json` in any test project:

```json
{
  "mcpServers": {
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "auth": { "type": "oauth" }
    }
  }
}
```

Run:

```bash
studio run <any-pipeline> --provider mock
```

Expected: browser opens, Linear authorization page loads, after approving, `"Authorization successful"` page appears, run proceeds.

On second run: no browser opens, run proceeds immediately.

---

### Task 9: Push and open PR

**Step 1: Ensure you're on a feature branch**

```bash
git checkout -b arianedguay/stu-124-plugin-loader-support-oauth-flow-for-http-mcp-servers-linear
```

(Skip if already on the feature branch.)

**Step 2: Push and open PR**

```bash
git push -u origin HEAD
gh pr create \
  --title "feat(runner): OAuth flow for HTTP MCP servers (STU-124)" \
  --body "$(cat <<'EOF'
## Summary

- Implements `OAuthClientProvider` (`StudioOAuthProvider`) with token storage in `~/.config/studio/oauth/`
- Local HTTP callback server (port assigned by OS) captures the auth code automatically
- `MCPClient.start()` handles `UnauthorizedError` from the SDK: opens browser, awaits code, calls `finishAuth()`, retries connect
- Adds `auth: { type: 'oauth' }` field to `MCPServerDef` for HTTP servers
- CLI (`run.ts`) requires no changes

## Packages touched
- `runner` — new `oauth-provider.ts`, modified `mcp-client.ts` + `plugin-loader.ts`

## Test plan
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
- [ ] Manual: `studio run` with Linear plugin triggers browser auth on first run
- [ ] Manual: second run uses cached tokens silently

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" \
  --base main
```

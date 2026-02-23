import { describe, it, expect, vi } from 'vitest';
import { MCPClient } from './mcp-client.js';

describe('MCPClient', () => {
  it('generates correct tool prefix', () => {
    const client = new MCPClient('code-review', 'github', {
      command: 'npx',
      args: ['-y', '@mcp/server-github'],
    });
    expect(client.toolPrefix()).toBe('code-review-github');
  });

  it('resolves ${ENV_VAR} in env config', () => {
    process.env.TEST_TOKEN = 'secret-123';
    const client = new MCPClient('myplugin', 'myserver', {
      command: 'npx',
      env: { MY_TOKEN: '${TEST_TOKEN}' },
    });
    const resolved = client.resolveEnv({ MY_TOKEN: '${TEST_TOKEN}' });
    expect(resolved.MY_TOKEN).toBe('secret-123');
    delete process.env.TEST_TOKEN;
  });

  it('leaves env vars without substitution syntax as-is', () => {
    const client = new MCPClient('p', 's', { command: 'cmd' });
    const resolved = client.resolveEnv({ KEY: 'literal-value' });
    expect(resolved.KEY).toBe('literal-value');
  });

  it('uses HTTP transport for type:http — invalid url throws TypeError', () => {
    // StreamableHTTPClientTransport validates the URL in its constructor via `new URL(url)`.
    // If the old StdioClientTransport code path runs instead, no error is thrown (command
    // is only validated at start() time). So a throw here proves the right transport is used.
    expect(() => {
      new MCPClient('linear', 'linear', { type: 'http', url: 'not-a-valid-url' });
    }).toThrow(TypeError);
  });

  it('constructs successfully with a valid HTTP url', () => {
    expect(() => {
      new MCPClient('linear', 'linear', { type: 'http', url: 'https://mcp.linear.app/sse' });
    }).not.toThrow();
  });
});

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

describe('MCPClient.start() — OAuth dance', () => {
  it('calls startCallbackServer and finishAuth when UnauthorizedError is thrown', async () => {
    const client = new MCPClient('linear', 'linear', {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      auth: { type: 'oauth' },
    });

    const mockClose = vi.fn();
    vi.spyOn(client.oauthProvider!, 'startCallbackServer').mockResolvedValue({
      codePromise: Promise.resolve('auth-code-xyz'),
      close: mockClose,
    });

    const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js');
    const originalTransport = client['transport'];
    const transportsPassedToConnect: unknown[] = [];
    vi.spyOn(client['client'], 'connect').mockImplementation(async (t) => {
      transportsPassedToConnect.push(t);
      if (transportsPassedToConnect.length === 1) throw new UnauthorizedError('needs auth');
    });
    const mockFinishAuth = vi.fn().mockResolvedValue(undefined);
    (client['transport'] as any).finishAuth = mockFinishAuth;

    await client.start();

    expect(mockFinishAuth).toHaveBeenCalledWith('auth-code-xyz');
    expect(transportsPassedToConnect).toHaveLength(2);
    // Second connect must use a fresh transport (not the already-started one)
    expect(transportsPassedToConnect[1]).not.toBe(originalTransport);
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

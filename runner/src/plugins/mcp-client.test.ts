import { describe, it, expect } from 'vitest';
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
});

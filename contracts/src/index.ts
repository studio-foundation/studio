// Export barrel for @studio/contracts
// All types are re-exported from their source files

export * from './pipeline.js';
export * from './stage.js';
export * from './task.js';
export * from './agent.js';
export * from './run.js';
export * from './validation.js';
export * from './provider.js';
export * from './errors.js';
export * from './context-pack.js';
export * from './tool-plugin.js';

export * from './runner-events.js';

// Extending MCPServerDef to support http transport
export type MCPServerDef =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      auth?: { type: 'oauth'; client_id?: string; client_secret?: string; scope?: string };
    };

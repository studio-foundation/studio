export type MCPServerDef =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      auth?: { type: 'oauth'; client_id?: string; client_secret?: string; scope?: string };
    };
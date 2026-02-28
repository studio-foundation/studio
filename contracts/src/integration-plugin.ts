// contracts/src/integration-plugin.ts

export interface IntegrationPluginDef {
  name: string;
  version: number;
  description?: string;
  config?: {
    required?: string[];
    optional?: Record<string, unknown>;
  };
  events?: {
    consumes?: string[];
    emits?: string[];
  };
  test?: {
    type: 'http';
    endpoint: string;
    method?: 'GET' | 'POST';
    /** e.g. "bearer:${LINEAR_API_KEY}" — resolved before use */
    auth?: string;
    body?: string;
    expect?: { status?: number };
  };
  webhook?: {
    hmac?: {
      header: string;       // e.g. 'linear-signature'
      secret_env: string;   // e.g. 'LINEAR_WEBHOOK_SECRET' — resolved from integration config
    };
    handler: string;        // e.g. 'linear-webhook' — key in WEBHOOK_HANDLERS registry
  };
  on_failure?: {
    handler: string;        // e.g. 'linear-failure' — key in FAILURE_HANDLERS registry
  };
}

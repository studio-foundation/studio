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
}

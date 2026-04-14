// api/src/integrations/types.ts
import type { FastifyReply } from 'fastify';
import type { IntegrationPluginDef } from '@studio-foundation/contracts';
import type { GroupFeedbackEvent } from '@studio-foundation/engine';
import type { IntegrationStore } from '../integration-store.js';
import type { RunLauncher } from '../launcher.js';
import type { ApiConfig } from '../server.js';

export interface WebhookHandlerContext {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  integration: IntegrationPluginDef;
  store: IntegrationStore;
  launcher: RunLauncher;
  configsDir: string;
  projectsDir?: string;
  apiConfig: ApiConfig;
  integrationConfig: Record<string, unknown>;
}

export interface FailureHandlerContext {
  runId: string;
  durationMs: number;
  status: string;
  meta: Record<string, unknown>;
  lastGroupFeedback?: GroupFeedbackEvent;
  integration: IntegrationPluginDef;
  integrationConfig: Record<string, unknown>;
}

export interface WebhookHandler {
  handle(ctx: WebhookHandlerContext, reply: FastifyReply): Promise<unknown>;
}

export interface FailureHandler {
  handleFailure(ctx: FailureHandlerContext): Promise<void>;
}

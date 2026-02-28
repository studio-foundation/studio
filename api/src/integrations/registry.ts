// api/src/integrations/registry.ts
import type { WebhookHandler, FailureHandler } from './types.js';
import { LinearWebhookHandler } from './linear/webhook-handler.js';
import { LinearFailureHandler } from './linear/failure-handler.js';

export const WEBHOOK_HANDLERS: Record<string, WebhookHandler> = {
  'linear-webhook': new LinearWebhookHandler(),
};

export const FAILURE_HANDLERS: Record<string, FailureHandler> = {
  'linear-failure': new LinearFailureHandler(),
};

// WebhookDispatcher — listens to pipeline events and delivers them to registered webhooks
// Handles HMAC-SHA256 signing, retry logic (30s / 5min / 15min), and failure tracking

import { createHmac, randomUUID } from 'node:crypto';
import type { SseEventType } from './event-bus.js';
import type { WebhookStore } from './webhook-store.js';

export type WebhookEventType =
  | 'pipeline_start'
  | 'pipeline_complete'
  | 'stage_complete'
  | 'stage_rejected'
  | 'stage_failed'
  | 'group_feedback';

// Retry delays in ms: attempt 1 failed → 30s, attempt 2 failed → 5min, attempt 3 failed → 15min
const RETRY_DELAYS = [30_000, 5 * 60_000, 15 * 60_000];

function mapToWebhookEvent(sseType: SseEventType, data: unknown): WebhookEventType | null {
  switch (sseType) {
    case 'pipeline_start':
      return 'pipeline_start';
    case 'pipeline_complete':
      return 'pipeline_complete';
    case 'stage_complete': {
      const status = (data as { status?: string }).status;
      if (status === 'rejected') return 'stage_rejected';
      if (status === 'failed') return 'stage_failed';
      return 'stage_complete';
    }
    case 'group_feedback':
      return 'group_feedback';
    default:
      return null;
  }
}

function sign(body: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(body, 'utf-8');
  return `sha256=${hmac.digest('hex')}`;
}

export class WebhookDispatcher {
  constructor(
    private readonly store: WebhookStore,
    private readonly projectName: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async handleBusEvent(runId: string, sseType: SseEventType, data: unknown): Promise<void> {
    const webhookEvent = mapToWebhookEvent(sseType, data);
    if (!webhookEvent) return;

    const webhooks = this.store.listWebhooks().filter(
      w => w.status === 'active' && w.events.includes(webhookEvent),
    );

    await Promise.all(
      webhooks.map(webhook => this.dispatch(webhook.id, webhookEvent, runId, data, 1)),
    );
  }

  private async dispatch(
    webhookId: string,
    event: WebhookEventType,
    runId: string,
    sourceData: unknown,
    attempt: number,
  ): Promise<void> {
    const webhook = this.store.getWebhook(webhookId);
    if (!webhook || webhook.status === 'failed') return;

    const payload = {
      event,
      run_id: runId,
      project: this.projectName,
      ts: new Date().toISOString(),
      ...(sourceData as object),
    };

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Studio-Event': event,
    };
    if (webhook.secret) {
      headers['X-Studio-Signature'] = sign(body, webhook.secret);
    }

    const deliveryId = randomUUID();
    this.store.saveDelivery({
      id: deliveryId,
      webhook_id: webhookId,
      event,
      run_id: runId,
      status: 'pending',
      attempt,
      created_at: new Date().toISOString(),
    });

    try {
      const response = await this.fetcher(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        this.store.updateDelivery(deliveryId, 'success');
      } else {
        this.handleFailure(webhookId, event, runId, sourceData, attempt, deliveryId);
      }
    } catch {
      this.handleFailure(webhookId, event, runId, sourceData, attempt, deliveryId);
    }
  }

  private handleFailure(
    webhookId: string,
    event: WebhookEventType,
    runId: string,
    sourceData: unknown,
    attempt: number,
    deliveryId: string,
  ): void {
    const maxAttempts = RETRY_DELAYS.length + 1; // 4 total (1 original + 3 retries)

    if (attempt >= maxAttempts) {
      this.store.updateDelivery(deliveryId, 'failed');
      this.store.markWebhookFailed(webhookId);
      return;
    }

    this.store.updateDelivery(deliveryId, 'retrying');
    const delay = RETRY_DELAYS[attempt - 1];
    setTimeout(() => {
      void this.dispatch(webhookId, event, runId, sourceData, attempt + 1);
    }, delay);
  }
}

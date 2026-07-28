// Payload-level decisions for an inbound webhook: is it authentic, does it match,
// and what do the trigger's templates resolve to. All pure — the runtime owns I/O.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { evaluateCondition, interpolateTemplate, resolveContextPath } from '@studio-foundation/engine';
import type { ConditionContext } from '@studio-foundation/engine';
import type { TriggerDef } from '@studio-foundation/contracts';

/** `payload.<path>` reads the request body; nothing else is in scope. */
function payloadScope(payload: unknown): ConditionContext {
  return { input: {}, stageOutputs: new Map(), roots: { payload } };
}

export function verifyHmac(rawBody: Buffer, signature: string, secret: string): boolean {
  const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(signature, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Every `when:` condition must hold. No conditions means every delivery matches —
 * the trigger file's existence is the opt-in.
 */
export function matchesPayload(trigger: TriggerDef, payload: unknown): boolean {
  const conditions = trigger.webhook?.when ?? [];
  const scope = payloadScope(payload);
  return conditions.every(condition => evaluateCondition(condition, scope));
}

/** Resolve a `{{payload.<path>}}` template map against the delivered payload. */
export function renderTemplate(
  template: Record<string, unknown> | undefined,
  payload: unknown,
): Record<string, unknown> {
  if (!template) return {};
  const scope = payloadScope(payload);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    result[key] = interpolateTemplate(value, ref => resolveContextPath(ref, scope));
  }
  return result;
}

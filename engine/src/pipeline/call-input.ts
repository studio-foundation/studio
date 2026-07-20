// Build the input for a one-shot `call` stage's child run.
//
// A call stage runs a named pipeline once. Its `input:` template is resolved
// against the *parent* context — {{input}}, {{input.<path>}} and
// {{stages.<name>.output.<path>}}, the same references `condition` and `map`'s
// `over` read (resolveContextPath). With no template the parent input is
// forwarded to the child unchanged.

import type { CallStage } from '@studio-foundation/contracts';
import type { PipelineContext } from './context-propagation.js';
import { resolveContextPath } from './condition-evaluator.js';
import { interpolateTemplate } from './template-interpolation.js';

export function buildCallInput(call: CallStage, context: PipelineContext): Record<string, unknown> {
  const scope = { input: context.input, stageOutputs: context.stageOutputs };

  if (call.input) {
    const result: Record<string, unknown> = {};
    for (const [key, template] of Object.entries(call.input)) {
      result[key] = interpolateTemplate(template, (ref) => resolveContextPath(ref, scope));
    }
    return result;
  }

  // No template → forward the parent input verbatim (the "run this pipeline with
  // the same input I received" case that chains top-level pipelines).
  const input = context.input;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  throw new Error(
    `Call stage '${call.call}': the parent input is not an object, so it cannot be forwarded to ` +
    `'${call.pipeline ?? call.call}' directly. Add an 'input:' template mapping the child's fields.`
  );
}

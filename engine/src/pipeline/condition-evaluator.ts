// Secure condition evaluator — no eval(), no external dependencies.
// Supported syntax:
//   input.<field.path>                      compared to a literal
//   stages.<stage-name>.output.<field.path> compared to a literal
// Operators: ===, !==, >=, <=, ==, !=, >, <
// Returns false for any undefined/invalid path (skip-safe).

import type { PipelineInput } from './context-propagation.js';

// Longest-first to avoid '>' matching inside '>='
const OPERATORS = ['===', '!==', '>=', '<=', '==', '!=', '>', '<'] as const;
type Operator = typeof OPERATORS[number];

export function evaluateCondition(
  condition: string,
  context: { input: PipelineInput; stageOutputs: Map<string, unknown> },
): boolean {
  const trimmed = condition.trim();

  // Find operator (longest-first)
  let operator: Operator | undefined;
  let lhsStr = '';
  let rhsStr = '';

  for (const op of OPERATORS) {
    const idx = trimmed.indexOf(op);
    if (idx !== -1) {
      operator = op;
      lhsStr = trimmed.slice(0, idx).trim();
      rhsStr = trimmed.slice(idx + op.length).trim();
      break;
    }
  }

  if (!operator || !lhsStr || !rhsStr) return false;

  const lhsValue = resolveLhs(lhsStr, context);
  if (lhsValue === undefined) return false;

  const rhsValue = parseRhs(rhsStr);
  return compare(lhsValue, operator, rhsValue);
}

function resolveLhs(
  lhs: string,
  context: { input: PipelineInput; stageOutputs: Map<string, unknown> },
): unknown {
  return resolveContextPath(lhs, context);
}

/**
 * Resolve a context reference to its value. Shared by the condition evaluator
 * and the fan-out `over:`/`{{...}}` resolution so both read context identically.
 * Supported forms:
 *   input.<field.path>
 *   stages.<stage-name>.output.<field.path>
 * Returns undefined for any unknown prefix or unreachable path.
 */
export function resolveContextPath(
  ref: string,
  context: { input: PipelineInput; stageOutputs: Map<string, unknown> },
): unknown {
  if (ref === 'input') return context.input;

  if (ref.startsWith('input.')) {
    const fieldPath = ref.slice('input.'.length);
    if (typeof context.input !== 'object' || context.input === null) return undefined;
    return traversePath(context.input as Record<string, unknown>, fieldPath);
  }

  if (ref.startsWith('stages.')) {
    // Format: stages.<stage-name>.output(.<field.path>)?
    // Stage names can contain hyphens — split on first '.output' occurrence
    const rest = ref.slice('stages.'.length);
    const outputMarker = '.output';
    const markerIdx = rest.indexOf(outputMarker);
    if (markerIdx === -1) return undefined;

    const stageName = rest.slice(0, markerIdx);
    const afterMarker = rest.slice(markerIdx + outputMarker.length);
    const stageOutput = context.stageOutputs.get(stageName);
    if (stageOutput === undefined || stageOutput === null) return undefined;

    // "stages.foo.output" → the whole output; "stages.foo.output.a.b" → nested
    if (afterMarker === '') return stageOutput;
    if (!afterMarker.startsWith('.')) return undefined;
    return traversePath(stageOutput as Record<string, unknown>, afterMarker.slice(1));
  }

  return undefined;
}

function traversePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function parseRhs(rhs: string): unknown {
  // Number (int or float, optional leading minus)
  if (/^-?\d+(\.\d+)?$/.test(rhs)) return Number(rhs);
  // Boolean
  if (rhs === 'true') return true;
  if (rhs === 'false') return false;
  // Quoted string
  if ((rhs.startsWith('"') && rhs.endsWith('"')) || (rhs.startsWith("'") && rhs.endsWith("'"))) {
    return rhs.slice(1, -1);
  }
  // Plain string (e.g. input.mode == fast)
  return rhs;
}

function compare(lhs: unknown, op: Operator, rhs: unknown): boolean {
  // Coerce lhs to number if rhs is a number and lhs is a string
  let lhsCoerced: unknown = lhs;
  if (typeof rhs === 'number' && typeof lhs === 'string') {
    const n = Number(lhs);
    if (!isNaN(n)) lhsCoerced = n;
  }

  switch (op) {
    case '>':   return typeof lhsCoerced === 'number' && typeof rhs === 'number' && lhsCoerced > rhs;
    case '>=':  return typeof lhsCoerced === 'number' && typeof rhs === 'number' && lhsCoerced >= rhs;
    case '<':   return typeof lhsCoerced === 'number' && typeof rhs === 'number' && lhsCoerced < rhs;
    case '<=':  return typeof lhsCoerced === 'number' && typeof rhs === 'number' && lhsCoerced <= rhs;
    // eslint-disable-next-line eqeqeq
    case '==':  return lhsCoerced == rhs;
    case '===': return lhsCoerced === rhs;
    // eslint-disable-next-line eqeqeq
    case '!=':  return lhsCoerced != rhs;
    case '!==': return lhsCoerced !== rhs;
    default:    return false;
  }
}

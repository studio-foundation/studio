// Build the per-item input for a fan-out (map) stage.
//
// Each item of the `over:` list becomes one sub-pipeline run. The input for
// that run is derived from the map stage config:
//   - `input:` template → interpolate {{item}}, {{item.<path>}}, {{index}},
//     {{input}}, {{input.<path>}} in each value.
//   - `as:` shorthand   → { [as]: item }
//   - neither           → the item itself, if it is a plain object.

import type { MapStage } from '@studio-foundation/contracts';
import type { PipelineInput } from './context-propagation.js';
import { interpolateTemplate } from './template-interpolation.js';

interface ItemScope {
  item: unknown;
  index: number;
  input: PipelineInput;
}

/** Resolve a single {{...}} reference against the item/index/input scope. */
function resolveRef(ref: string, scope: ItemScope): unknown {
  if (ref === 'item') return scope.item;
  if (ref === 'index') return scope.index;
  if (ref === 'input') return scope.input;
  if (ref.startsWith('item.')) return traverse(scope.item, ref.slice('item.'.length));
  if (ref.startsWith('input.')) return traverse(scope.input, ref.slice('input.'.length));
  return undefined;
}

function traverse(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * A short, human-readable identity for one item of a fan-out list, for progress
 * display. Prefers a meaningful field of an object item (title/name/id/…) over
 * a bare index, so an operator watching a --live run sees *which* entity is in
 * flight, not just "#37". Never throws — it is display-only and must tolerate
 * any item shape (including the ones buildItemInput would reject).
 */
export function mapItemLabel(item: unknown, index: number): string {
  if (typeof item === 'string') return item.trim() || `#${index}`;
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    for (const key of ['title', 'name', 'id', 'slug', 'label', 'key', 'entity']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return `#${index}`;
}

/** Build the sub-pipeline input for one item of a fan-out stage. */
export function buildItemInput(
  map: MapStage,
  item: unknown,
  index: number,
  pipelineInput: PipelineInput,
): Record<string, unknown> {
  const scope: ItemScope = { item, index, input: pipelineInput };

  if (map.input) {
    const result: Record<string, unknown> = {};
    for (const [key, template] of Object.entries(map.input)) {
      result[key] = interpolateTemplate(template, (ref) => resolveRef(ref, scope));
    }
    return result;
  }

  if (map.as) {
    return { [map.as]: item };
  }

  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    return item as Record<string, unknown>;
  }

  throw new Error(
    `Map stage '${map.map}': item at index ${index} is not an object, so it cannot be used as pipeline input directly. ` +
    `Add 'as: <key>' (input becomes { <key>: item }) or an 'input:' template.`
  );
}

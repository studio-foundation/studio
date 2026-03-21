// cli/src/output/formatters.ts
import type { ToolCallSummary } from '@studio/engine';
import type { ToolCall } from '@studio/contracts';

// ── Shared helpers ──────────────────────────────────────────────────────────

function titleCase(key: string): string {
  return key
    .split(/[-_]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Token formatting ──────────────────────────────────────────────────────────

/**
 * Formats a token count into a compact human-readable string.
 * 450 → "450", 2100 → "2.1k", 17900 → "17.9k", 1234567 → "1.2M"
 */
export function formatTokens(count: number): string {
  if (count === 0) return '0';
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const k = count / 1000;
    return k % 1 === 0 ? `${k}k` : `${parseFloat(k.toFixed(1))}k`;
  }
  const m = count / 1_000_000;
  return m % 1 === 0 ? `${m}M` : `${parseFloat(m.toFixed(1))}M`;
}

// ── Stage line formatting ─────────────────────────────────────────────────────

const STAGE_LINE_WIDTH = 42;

/**
 * Formats a stage progress line with dot-filling for alignment.
 * formatStageLine("[1/4]", "brief-analysis", "✓ (12s, 2.1k tokens)")
 * → "[1/4] brief-analysis ............ ✓ (12s, 2.1k tokens)"
 */
export function formatStageLine(prefix: string, name: string, suffix: string): string {
  const left = `${prefix} ${name} `;
  const dotsNeeded = Math.max(2, STAGE_LINE_WIDTH - left.length);
  const dots = '.'.repeat(dotsNeeded);
  return `${left}${dots} ${suffix}`;
}

// ── Stage name mapping ────────────────────────────────────────────────────────

const STAGE_NAME_PATTERNS: Array<[RegExp, string]> = [
  [/^brief[-_]analysis$/i, 'Analyzing brief'],
  [/^implementation[-_]plan$/i, 'Planning implementation'],
  [/^code[-_]gen(?:eration)?$/i, 'Generating code'],
  [/^qa[-_]review$/i, 'Reviewing'],
  [/^analysis$/i, 'Analysis'],
  [/^planning$/i, 'Planning'],
  [/^generation$/i, 'Generating'],
  [/^review$/i, 'Reviewing'],
];

/**
 * Converts a kebab-case stage name to a human-readable label.
 * Uses a lookup table for known names; falls back to title-casing.
 */
export function humanReadableStageName(stageName: string): string {
  for (const [pattern, label] of STAGE_NAME_PATTERNS) {
    if (pattern.test(stageName)) return label;
  }
  return titleCase(stageName);
}

// ── Tool call grouping ────────────────────────────────────────────────────────

interface ToolGroup {
  singular: string;
  plural: string;
  verb: string; // past tense, e.g. "Read", "Wrote"
}

const TOOL_GROUPS: Record<string, ToolGroup> = {
  read_file:       { verb: 'Read',     singular: 'file',      plural: 'files' },
  write_file:      { verb: 'Wrote',    singular: 'file',      plural: 'files' },
  list_files:      { verb: 'Listed',   singular: 'directory', plural: 'directories' },
  run_command:     { verb: 'Ran',      singular: 'command',   plural: 'commands' },
  search_codebase: { verb: 'Searched', singular: 'time',      plural: 'times' },
  apply_patch:     { verb: 'Patched',  singular: 'file',      plural: 'files' },
};

/** Extracts the action part from a tool name like `repo_manager-read_file` → `read_file`. */
function toolAction(name: string): string {
  const idx = name.lastIndexOf('-');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * Groups tool calls by type and returns a human-readable summary string.
 * E.g. "Read 3 files, wrote 1 file, ran 2 commands"
 */
export function summarizeToolCalls(toolCalls: (ToolCallSummary | ToolCall)[]): string {
  if (toolCalls.length === 0) return '';

  const counts = new Map<string, number>();
  let unknownCount = 0;

  for (const tc of toolCalls) {
    const action = toolAction(tc.name);
    if (TOOL_GROUPS[action]) {
      counts.set(action, (counts.get(action) ?? 0) + 1);
    } else {
      unknownCount++;
    }
  }

  const parts: string[] = [];

  for (const [action, count] of counts) {
    const group = TOOL_GROUPS[action];
    const noun = count === 1 ? group.singular : group.plural;
    // First part uses title-case verb, rest lowercase
    const verb = parts.length === 0 ? group.verb : group.verb.toLowerCase();
    parts.push(`${verb} ${count} ${noun}`);
  }

  if (unknownCount > 0) {
    const label = `${unknownCount} tool call${unknownCount !== 1 ? 's' : ''}`;
    parts.push(label);
  }

  return parts.join(', ');
}

/** Counts how many tool calls wrote or patched files. */
export function countWriteFiles(toolCalls: (ToolCallSummary | ToolCall)[]): number {
  return toolCalls.filter((tc) => {
    const action = toolAction(tc.name);
    return action === 'write_file' || action === 'apply_patch';
  }).length;
}

// ── Live mode helpers ─────────────────────────────────────────────────────────

export function getToolIcon(tool: string): string {
  if (tool.startsWith('repo_manager-read')) return '📖';
  if (tool.startsWith('repo_manager-write')) return '✏️';
  if (tool.startsWith('repo_manager-list')) return '📁';
  if (tool.startsWith('search')) return '🔍';
  if (tool.startsWith('shell')) return '⚙️';
  if (tool.startsWith('git')) return '🔀';
  return '🔧';
}

export function summarizeToolParams(tool: string, params: Record<string, unknown>): string {
  if (tool.includes('read_file') || tool.includes('write_file')) return `(${params.path})`;
  if (tool.includes('list_files')) return params.path ? `(${params.path})` : '';
  if (tool.includes('search')) {
    const term = params.query ?? params.pattern;
    return term ? `("${term}")` : '';
  }
  if (tool.includes('run_command')) return `("${params.command}")`;
  return '';
}

export function summarizeToolResult(result: unknown, error?: string): string {
  if (error) return error;
  if (typeof result === 'string') {
    const lines = result.split('\n').length;
    return lines > 1 ? `${lines} lines` : result.slice(0, 60);
  }
  if (Array.isArray(result)) return `${result.length} items`;
  if (result !== null && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (typeof obj.content === 'string') {
      const lines = obj.content.split('\n').length;
      return lines > 1 ? `${lines} lines` : (obj.content.length > 0 ? obj.content.slice(0, 60) : 'empty');
    }
    if (Array.isArray(obj.files)) return `${obj.files.length} files`;
    if (obj.written === true) return 'written';
  }
  return 'Done';
}

// ── Verbose tool result formatting ───────────────────────────────────────────

/**
 * Formats the full result of a tool call for verbose display.
 * Each line is indented with 2 spaces.
 */
export function formatToolResult(result: unknown, error?: string): string {
  if (error) return `  (error) ${error}`;
  if (result === null || result === undefined) return '  (empty)';

  if (typeof result === 'string') {
    return result.split('\n').map(line => `  ${line}`).join('\n');
  }

  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if (typeof obj.content === 'string') {
      if (obj.content.length === 0) return '  (empty content)';
      return obj.content.split('\n').map(line => `  ${line}`).join('\n');
    }
  }

  // Arrays and other objects: indented JSON
  const json = JSON.stringify(result, null, 2);
  return json.split('\n').map(line => `  ${line}`).join('\n');
}

// ── Stage output formatting ─────────────────────────────────────────────────

const CIRCLED_DIGITS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

function circledIndex(i: number): string {
  return i < CIRCLED_DIGITS.length ? CIRCLED_DIGITS[i] : `(${i + 1})`;
}

function isPrimitive(value: unknown): value is string | number | boolean | null | undefined {
  return value === null || value === undefined || typeof value !== 'object';
}

function formatValue(value: unknown, indent: number, maxDepth: number): string {
  const pad = '    '.repeat(indent);

  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);

  if (typeof value === 'string') {
    if (value.length <= 80) return value;
    return `\n${pad}    ${value}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '(empty)';

    // Array of primitives
    if (value.every(isPrimitive)) {
      const inline = value.map(v => String(v ?? '—')).join(', ');
      if (inline.length <= 80) return inline;
      return '\n' + value.map(v => `${pad}    • ${String(v ?? '—')}`).join('\n');
    }

    // Array of objects
    return '\n' + value.map((item, i) => {
      const idx = circledIndex(i);
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        const keys = Object.keys(obj);
        // Single string field: compact rendering
        if (keys.length === 1 && typeof obj[keys[0]] === 'string') {
          return `${pad}    ${idx} ${obj[keys[0]]}`;
        }
        // First string field as title, rest as sub-fields
        const firstStrKey = keys.find(k => typeof obj[k] === 'string');
        if (firstStrKey && indent + 1 < maxDepth) {
          const title = obj[firstStrKey] as string;
          const rest = keys.filter(k => k !== firstStrKey);
          if (rest.length === 0) return `${pad}    ${idx} ${title}`;
          const subPad = pad + '        ';
          const maxKeyLen = Math.max(...rest.map(k => titleCase(k).length));
          const subFields = rest.map(k => {
            const label = titleCase(k).padEnd(maxKeyLen);
            const val = formatValue(obj[k], indent + 2, maxDepth);
            return `${subPad}${label} : ${val}`;
          }).join('\n');
          return `${pad}    ${idx} ${title}\n${subFields}`;
        }
      }
      // Fallback: JSON
      return `${pad}    ${idx} ${JSON.stringify(item)}`;
    }).join('\n');
  }

  // Nested object
  if (typeof value === 'object') {
    if (indent + 1 >= maxDepth) return JSON.stringify(value);
    const obj = value as Record<string, unknown>;
    const formatted = formatObjectFields(obj, indent + 1, maxDepth);
    return formatted ? '\n' + formatted : '(empty)';
  }

  return String(value);
}

function formatObjectFields(obj: Record<string, unknown>, indent: number, maxDepth: number): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';

  const pad = '    '.repeat(indent);
  const labels = keys.map(k => titleCase(k));
  const maxKeyLen = Math.max(...labels.map(l => l.length));

  return keys.map((key, i) => {
    const label = labels[i].padEnd(maxKeyLen);
    const val = formatValue(obj[key], indent, maxDepth);
    return `${pad}${label} : ${val}`;
  }).join('\n');
}

/**
 * Formats a stage output object as a human-readable string.
 * Detects types dynamically — no hardcoded field names.
 * Returns plain text (no ANSI colors).
 */
export function formatStageOutput(output: Record<string, unknown>, maxDepth = 4): string {
  return formatObjectFields(output, 0, maxDepth);
}

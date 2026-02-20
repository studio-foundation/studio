// cli/src/output/formatters.ts
import type { ToolCallSummary } from '@studio/engine';

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
  return stageName
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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
export function summarizeToolCalls(toolCalls: ToolCallSummary[]): string {
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

// ── Output summary ────────────────────────────────────────────────────────────

/**
 * Extracts a human-readable summary from a stage output object.
 * Prefers `summary` > `description` > field listing.
 * Never returns raw JSON.
 */
export function summarizeOutput(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  if (typeof output !== 'object' || Array.isArray(output)) return null;

  const o = output as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return null;

  const truncate = (s: string) => s.length > 150 ? s.slice(0, 150) + '...' : s;

  if (typeof o.summary === 'string' && o.summary.length > 0) {
    return truncate(o.summary);
  }
  if (typeof o.description === 'string' && o.description.length > 0) {
    return truncate(o.description);
  }

  return `${keys.length} field${keys.length !== 1 ? 's' : ''}: ${keys.join(', ')}`;
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
  if (tool.includes('search')) return `("${params.query}")`;
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

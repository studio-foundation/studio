// contracts/src/tool-plugin.ts

export type ParseOutputFormat = 'text' | 'json';

export interface ParameterDef {
  type: 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  required?: boolean;
  default?: unknown;
  items?: { type: string };
  /**
   * Dot-path into the stage's own resolved context (e.g. `input.book_dir`),
   * resolved by the executor at call time instead of by the LLM. A parameter
   * declaring this is hidden from the tool's LLM-facing schema entirely — the
   * model cannot see or set it, so it cannot echo back a wrong value for
   * something the pre-stage already gave it (STU-762).
   */
  from_context?: string;
}

export interface ShellExecute {
  type: 'shell';
  command: string;
  parse_output?: ParseOutputFormat;
  timeout_ms?: number;
}

export interface BuiltinExecute {
  type: 'builtin';
  handler?: string;  // informational only — we look up by cmd.name
  parse_output?: ParseOutputFormat;
}

export type CommandExecute = ShellExecute | BuiltinExecute;

export interface ToolCommandDef {
  name: string;
  description: string;
  parameters: Record<string, ParameterDef>;
  execute: CommandExecute;
  constraints?: Record<string, unknown>;
}

export interface ToolPluginDef {
  name: string;
  description?: string;
  version: number;
  commands: ToolCommandDef[];
  config?: Record<string, unknown>;
  prompt_snippet?: string;
  constraints?: {
    requires_initialized_repo?: boolean;
    /** `"git"`, or `"node >=18 <=22"` to also constrain the version. */
    requires_binaries?: string[];
  };
}

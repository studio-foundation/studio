// contracts/src/tool-plugin.ts

export type ParseOutputFormat = 'text' | 'json';

export interface ParameterDef {
  type: 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  required?: boolean;
  default?: unknown;
  items?: { type: string };
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
    requires_binaries?: string[];
  };
}

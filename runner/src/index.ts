/**
 * @studio/runner - Multi-provider LLM agent runner with tool execution
 */

// Main runner function
export { runAgent } from './runner.js';
export type { RunAgentConfig, AgentRunResult } from './runner.js';

// Prompt builder
export { buildPrompt } from './prompt-builder.js';
export type {
  TaskInput,
  AgentContext,
  GroupFeedbackContext,
  ExecutionContext,
  PromptBuildConfig
} from './prompt-builder.js';

// Providers
export type { Provider, AgentLoopProvider, AgentLoopResult } from './providers/provider.js';
export { isAgentLoopProvider } from './providers/provider.js';
export { OpenAIProvider } from './providers/openai.js';
export { OpenAIResponsesProvider } from './providers/openai-responses.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { ProviderRegistry, createDefaultRegistry } from './providers/registry.js';
export { MockProvider } from './providers/mock.js';
export type { MockStageConfig } from './providers/mock.js';

// Tools
export { ToolRegistry } from './tools/tool-registry.js';
export { ToolExecutor } from './tools/tool-executor.js';
export type { Tool, ToolResult } from './tools/tool-registry.js';

// Builtin tools
export { createRepoManagerTools } from './tools/builtin/repo-manager.js';
export { createShellTools } from './tools/builtin/shell.js';
export { createSearchTools } from './tools/builtin/search.js';
export { createPatchTools } from './tools/builtin/patch.js';
export { createGitTools } from './tools/builtin/git.js';

export { loadProjectTools } from './tools/plugin-loader.js';
export type { LoadedPlugin } from './tools/plugin-loader.js';

// Anonymization middleware
export { AnonymizationMiddleware } from './middleware/anonymization.js';
export type { AnonymizerOptions } from '@studio/anonymizer';

// Plugin system (Claude Code plugin compatibility)
export { loadPlugins, MCPClient, StudioOAuthProvider } from './plugins/index.js';
export type { PluginManifest, MCPServerDef, SkillContent } from './plugins/index.js';

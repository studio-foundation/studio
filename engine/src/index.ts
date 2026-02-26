// Export barrel for @studio/engine

// Main engine
export { PipelineEngine } from './engine.js';
export type { EngineConfig, RunInput } from './engine.js';

// Events
export { PipelineEventEmitter } from './events.js';
export type {
  EngineEvents,
  PipelineEvent,
  PipelineStartEvent,
  PipelineCompleteEvent,
  PipelineCancelledEvent,
  StageStartEvent,
  StageCompleteEvent,
  StageRetryEvent,
  ToolCallSummary,
  TokenUsage,
  GroupStartEvent,
  GroupIterationEvent,
  GroupFeedbackEvent,
  GroupCompleteEvent,
  StageContextEvent,
} from './events.js';

// State management
export { deriveStageStatus } from './state/status-derivation.js';
export { isValidTransition, transition } from './state/state-machine.js';
export type { StageLifecycleState } from './state/state-machine.js';

// Run store
export { InMemoryRunStore, SQLiteRunStore } from './state/run-store.js';
export type { RunStore } from './state/run-store.js';

// Pipeline loaders
export { loadPipeline, loadPipelineByName, parsePipelineYaml } from './pipeline/loader.js';
export { loadAgentProfile, parseAgentYaml } from './pipeline/agent-loader.js';
export { loadContract, parseContractYaml } from './pipeline/contract-loader.js';

// Context propagation
export {
  createInitialContext,
  addStageOutput,
  getContextForStage,
  setGroupFeedback,
  clearGroupFeedback,
} from './pipeline/context-propagation.js';
export type { PipelineContext, PipelineInput, GroupFeedback } from './pipeline/context-propagation.js';

// Contract validation
export { validateOutput } from './pipeline/output-validator.js';
export type { OutputValidationResult } from './pipeline/output-validator.js';
export type { PostValidationResult } from './pipeline/post-validator.js';

// Spawners
export { DirectEngineSpawner } from './spawners/direct-engine-spawner.js';

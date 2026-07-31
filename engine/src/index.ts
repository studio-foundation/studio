// Export barrel for @studio/engine

// Main engine
export { PipelineEngine } from './engine.js';
export type { EngineConfig, RunInput } from './engine.js';

// Events
export { PipelineEventEmitter } from './events.js';
export type {
  EngineEvents,
  EventContext,
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
  StagedToolCallStartEvent,
  StagedToolCallCompleteEvent,
  MapStartEvent,
  MapItemCompleteEvent,
  MapCompleteEvent,
} from './events.js';

// Fan-out (map) stage
export { MapOrchestrator } from './pipeline/map-orchestrator.js';
export type { MapStageOutput, MapItemResult, MapRunResult } from './pipeline/map-orchestrator.js';
export {
  FileSystemMapItemCache,
  InMemoryMapItemCache,
  hashItemInput,
  canonicalize,
  mapCacheSegment,
} from './pipeline/map-item-cache.js';
export type { MapItemCache, CachedMapItem, MapCacheNamespace } from './pipeline/map-item-cache.js';

// One-shot sub-pipeline call stage
export { CallOrchestrator } from './pipeline/call-orchestrator.js';
export type { CallRunResult } from './pipeline/call-orchestrator.js';

// State management
export { deriveStageStatus } from './state/status-derivation.js';
export { isValidTransition, transition } from './state/state-machine.js';
export type { StageLifecycleState } from './state/state-machine.js';

// Run store
export { InMemoryRunStore, SQLiteRunStore, PgRunStore } from './state/run-store.js';
export type { RunStore, AsyncRunStore, AnyRunStore } from './state/run-store.js';
export { openDatabase } from './state/sqlite.js';
export type { SyncDatabase, SyncStatement } from './state/sqlite.js';
export { isRunOrphaned, reconcileOrphan } from './state/orphan.js';

// Pipeline loaders
export { loadPipeline, loadPipelineByName, parsePipelineYaml } from './pipeline/loader.js';
export { loadAgentProfile, parseAgentYaml } from './pipeline/agent-loader.js';
export { resolveEnvVars } from './pipeline/env-vars.js';
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

// Contract coverage — stages running with nothing to validate against
export {
  findUnvalidatedStages,
  findUnvalidatedStagesInPipeline,
  formatUnvalidatedStages,
} from './pipeline/contract-coverage.js';
export type { UnvalidatedStage } from './pipeline/contract-coverage.js';

// Contract validation
export { validateOutput } from './pipeline/output-validator.js';
export type { OutputValidationResult } from './pipeline/output-validator.js';
export type { PostValidationResult } from './pipeline/post-validator.js';
export { validateSchema } from '@studio-foundation/ralph';

// Spawners
export { DirectEngineSpawner } from './spawners/direct-engine-spawner.js';

// Condition evaluation and {{...}} interpolation, reused by webhook triggers
export { evaluateCondition, resolveContextPath } from './pipeline/condition-evaluator.js';
export type { ConditionContext } from './pipeline/condition-evaluator.js';
export { interpolateTemplate } from './pipeline/template-interpolation.js';

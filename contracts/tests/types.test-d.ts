// Type-level tests, run by `vitest --typecheck` (enabled in vitest.config.ts).
//
// These assertions fail at compile time, not at runtime — which is the only way
// to test a package that is 90% erased types. They exist to make a change to a
// shared type a deliberate act: every one of them is an invariant some other
// package already relies on.

import { describe, it, expectTypeOf } from 'vitest';
import { isCallStage, isMapStage, isStageGroup } from '../src/index.js';
import type {
  AgentStatus,
  CallStage,
  FieldSpec,
  FieldType,
  MapStage,
  OutputContract,
  PipelineDefinition,
  PipelineEntry,
  ResolvedAgentConfig,
  StageDefinition,
  StageGroup,
  StageStatus,
  TaskStatus,
  ToolCallRequirements,
  ValidationResult,
} from '../src/index.js';

describe('stage status', () => {
  // The engine switches exhaustively on this union (deriveStageStatus, the CLI
  // formatter, the run store). Adding or removing a status must break here so
  // every switch gets revisited.
  it('is exactly the eight known statuses', () => {
    expectTypeOf<StageStatus>().toEqualTypeOf<
      | 'pending'
      | 'running'
      | 'success'
      | 'failed'
      | 'skipped'
      | 'rejected'
      | 'cancelled'
      | 'interrupted'
    >();
  });

  // PipelineRun.status and StageRun.status are typed StageStatus, so anything a
  // task or an agent can be must also be a valid stage status — otherwise a
  // status can't be propagated upward.
  it('is a superset of agent and task statuses', () => {
    expectTypeOf<AgentStatus>().toExtend<StageStatus>();
    expectTypeOf<TaskStatus>().toExtend<StageStatus>();
  });

  it('separates terminal-negative statuses', () => {
    // `rejected` (domain verdict) is not `failed` (execution error) — the
    // distinction post-validation rejection exists to make.
    expectTypeOf<'rejected'>().not.toEqualTypeOf<'failed'>();
  });
});

describe('ValidationResult', () => {
  it('is binary — valid is a boolean, never a score or a status string', () => {
    expectTypeOf<ValidationResult['valid']>().toEqualTypeOf<boolean>();
  });

  // Consumers read `result.errors.length` unguarded; making either list optional
  // would break them silently at runtime.
  it('always carries both lists', () => {
    expectTypeOf<ValidationResult['errors']>().toEqualTypeOf<string[]>();
    expectTypeOf<ValidationResult['warnings']>().toEqualTypeOf<string[]>();
    expectTypeOf<Required<ValidationResult>>().toEqualTypeOf<ValidationResult>();
  });
});

describe('OutputContract', () => {
  it('requires only a name and a version', () => {
    expectTypeOf<{ name: string; version: number }>().toExtend<OutputContract>();
    expectTypeOf<{ name: string }>().not.toExtend<OutputContract>();
    expectTypeOf<{ version: number }>().not.toExtend<OutputContract>();
  });

  it('keeps every validation mechanism optional and composable', () => {
    expectTypeOf<OutputContract['schema']>().toExtend<undefined | object>();
    expectTypeOf<OutputContract['tool_calls']>().toExtend<undefined | object>();
    expectTypeOf<OutputContract['validators']>().toExtend<undefined | unknown[]>();
    expectTypeOf<OutputContract['expected_outputs']>().toExtend<undefined | object>();
  });

  it('types expected_outputs.files as a required list of patterns', () => {
    expectTypeOf<NonNullable<OutputContract['expected_outputs']>['files']>()
      .toEqualTypeOf<string[]>();
  });
});

describe('ToolCallRequirements', () => {
  // Anti-theatre lives on this shape: a flat `required_tools` is AND, and
  // `required_tool_groups` is the OR ("wrote a file OR applied a patch"). Losing
  // the nesting collapses the two into one meaning.
  it('expresses OR semantics as groups of alternatives', () => {
    expectTypeOf<ToolCallRequirements['required_tools']>()
      .toEqualTypeOf<string[] | undefined>();
    expectTypeOf<ToolCallRequirements['required_tool_groups']>()
      .toEqualTypeOf<string[][] | undefined>();
  });

  it('is reachable from a contract', () => {
    expectTypeOf<OutputContract['tool_calls']>()
      .toEqualTypeOf<ToolCallRequirements | undefined>();
  });
});

describe('PipelineDefinition', () => {
  it('requires a name, description, version and stage list', () => {
    expectTypeOf<{
      name: string;
      description: string;
      version: number;
      stages: PipelineEntry[];
    }>().toExtend<PipelineDefinition>();

    expectTypeOf<{ name: string; description: string; version: number }>()
      .not.toExtend<PipelineDefinition>();
  });

  it('keeps the repo binding optional, and its branch optional within it', () => {
    expectTypeOf<NonNullable<PipelineDefinition['repo']>['url']>().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<PipelineDefinition['repo']>['branch']>()
      .toEqualTypeOf<string | undefined>();
  });
});

describe('FieldSpec', () => {
  it('covers exactly the six JSON types', () => {
    expectTypeOf<FieldType>().toEqualTypeOf<
      'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
    >();
  });

  // The recursion is what lets a contract describe `pages[].importance` — a flat
  // spec would push that validation back into ad-hoc scripts.
  it('recurses through arrays and nested objects', () => {
    expectTypeOf<FieldSpec['items']>().toEqualTypeOf<FieldSpec | undefined>();
    expectTypeOf<FieldSpec['fields']>().toEqualTypeOf<Record<string, FieldSpec> | undefined>();
  });

  it('allows every check to be omitted', () => {
    expectTypeOf<Record<string, never>>().toExtend<FieldSpec>();
  });
});

describe('PipelineEntry', () => {
  it('is exactly the four entry shapes', () => {
    expectTypeOf<PipelineEntry>().toEqualTypeOf<
      StageDefinition | StageGroup | MapStage | CallStage
    >();
  });

  it('narrows through the type guards', () => {
    const entry = {} as PipelineEntry;

    if (isStageGroup(entry)) {
      expectTypeOf(entry).toEqualTypeOf<StageGroup>();
    } else if (isMapStage(entry)) {
      expectTypeOf(entry).toEqualTypeOf<MapStage>();
    } else if (isCallStage(entry)) {
      expectTypeOf(entry).toEqualTypeOf<CallStage>();
    }
  });

  it('lets a stage omit its agent so a script executor can stand alone', () => {
    expectTypeOf<{ name: string; executor: 'script'; script: string }>()
      .toExtend<StageDefinition>();
  });
});

describe('ResolvedAgentConfig', () => {
  // The runner reads provider/model unguarded; resolution is what guarantees them.
  it('narrows provider and model to non-optional', () => {
    expectTypeOf<ResolvedAgentConfig['provider']>().toEqualTypeOf<string>();
    expectTypeOf<ResolvedAgentConfig['model']>().toEqualTypeOf<string>();
  });
});

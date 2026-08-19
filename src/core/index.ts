/**
 * Public surface for core.
 *
 * Side-effect imports ensure every composer registers itself with the runner
 * at module load. Importing anything from `core` populates the
 * dispatch table with the core primitives. Built-in composites
 * (adversarial, ensemble, tournament, consensus) live in composites
 * and surface through the umbrella package.
 */

import flow_schema_data from './flow-schema.json' with { type: 'json' }

export { run } from './runner.js'
export type { RunOptions, RunOutcome, StreamingRunHandle } from './runner.js'
export { step } from './step.js'
export { describe } from './describe.js'
export type { DescribeOptions, FlowNode, FlowValue } from './describe.js'
export { resolve_display_name } from './display_name.js'
export { assert_valid_step_id, is_valid_step_id, suggest_step_id } from './step_id.js'
export { sequence } from './sequence.js'
export type { SequenceOptions } from './sequence.js'
export { parallel } from './parallel.js'
export type { ParallelOptions } from './parallel.js'
export { branch } from './branch.js'
export type { BranchConfig } from './branch.js'
export { map } from './map.js'
export type { MapConfig } from './map.js'
export { pipe } from './pipe.js'
export type { PipeOptions } from './pipe.js'
export { retry } from './retry.js'
export type { RetryConfig } from './retry.js'
export { fallback } from './fallback.js'
export type { FallbackOptions } from './fallback.js'
export { timeout } from './timeout.js'
export type { TimeoutOptions } from './timeout.js'
export { loop } from './loop.js'
export type { LoopConfig, LoopGuardPredicate, LoopGuardResult, LoopOutcome } from './loop.js'
export { compose } from './compose.js'
export type { ComposeConfig } from './compose.js'
export { checkpoint } from './checkpoint.js'
export type { CheckpointConfig } from './checkpoint.js'
export { suspend } from './suspend.js'
export type { SuspendConfig } from './suspend.js'
export { scope, stash, use } from './scope.js'
export type { ScopeOptions, StashOptions, UseOptions } from './scope.js'
export { chain } from './chain.js'
export type { Chain, ChainOpen, ChainStepOptions } from './chain.js'

export {
  aborted_error,
  describe_cycle_error,
  error_path,
  resume_validation_error,
  suspended_error,
  timeout_error,
} from './errors.js'

// Named in core's public signatures (SuspendConfig.resume_schema,
// resume_validation_error.issues), so they must be nameable from the same
// surface that exports those.
export type { AnySchema, SchemaIssue } from '#schema'

export type {
  AnyStep,
  CheckpointStore,
  CleanupFn,
  RunContext,
  Step,
  StepFn,
  StepInput,
  StepMetadata,
  StepOutput,
  TrajectoryEvent,
  TrajectoryLogger,
} from './types.js'

export { is_step } from './is_step.js'
export { is_step_kind, STEP_KINDS } from './step_kinds.js'
export type { StepKind } from './step_kinds.js'

export {
  is_checkpoint_event,
  is_custom_trajectory_event,
  is_emit_event,
  is_run_end_event,
  is_span_end_event,
  is_span_start_event,
  parse_trajectory_event,
} from './trajectory.js'
export type {
  CheckpointEvent,
  CheckpointStatus,
  CustomTrajectoryEvent,
  EmitEvent,
  ParsedTrajectoryEvent,
  RunEndEvent,
  RunEndStatus,
  SpanEndEvent,
  SpanStartEvent,
  TrajectoryParseResult,
} from './trajectory.js'

export { flow_schema_data as flow_schema }

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
export { step } from './step.js'
export { describe } from './describe.js'
export type { DescribeOptions, FlowNode, FlowValue } from './describe.js'
export { sequence } from './sequence.js'
export { parallel } from './parallel.js'
export { branch } from './branch.js'
export { map } from './map.js'
export { pipe } from './pipe.js'
export { retry } from './retry.js'
export { fallback } from './fallback.js'
export { timeout } from './timeout.js'
export { loop } from './loop.js'
export type { LoopConfig, LoopGuardResult, LoopResult } from './loop.js'
export { compose } from './compose.js'
export { checkpoint } from './checkpoint.js'
export { suspend } from './suspend.js'
export { scope, stash, use } from './scope.js'

export {
  aborted_error,
  describe_cycle_error,
  resume_validation_error,
  suspended_error,
  timeout_error,
} from './errors.js'

export type {
  CheckpointStore,
  RunContext,
  Step,
  StepMetadata,
  TrajectoryEvent,
  TrajectoryLogger,
} from './types.js'

export { is_step_kind, STEP_KINDS } from './step_kinds.js'
export type { StepKind } from './step_kinds.js'

export {
  is_custom_trajectory_event,
  is_emit_event,
  is_span_end_event,
  is_span_start_event,
  parse_trajectory_event,
} from './trajectory.js'
export type {
  CustomTrajectoryEvent,
  EmitEvent,
  ParsedTrajectoryEvent,
  SpanEndEvent,
  SpanStartEvent,
  TrajectoryParseResult,
} from './trajectory.js'

export { flow_schema_data as flow_schema }

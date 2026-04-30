/**
 * Public surface for @repo/core.
 *
 * Side-effect imports ensure every composer registers itself with the runner
 * at module load. Importing anything from `@repo/core` populates the
 * dispatch table with all 16 primitives.
 */

import flow_schema_data from './flow-schema.json' with { type: 'json' };

export { run } from './runner.js';
export { step } from './step.js';
export { describe } from './describe.js';
export type { DescribeOptions, FlowNode, FlowValue } from './describe.js';
export { sequence } from './sequence.js';
export { parallel } from './parallel.js';
export { branch } from './branch.js';
export { map } from './map.js';
export { pipe } from './pipe.js';
export { retry } from './retry.js';
export { fallback } from './fallback.js';
export { timeout } from './timeout.js';
export { loop } from './loop.js';
export type { LoopConfig, LoopGuardResult, LoopResult } from './loop.js';
export { compose } from './compose.js';
export { checkpoint } from './checkpoint.js';
export { suspend } from './suspend.js';
export { scope, stash, use } from './scope.js';

export {
  aborted_error,
  describe_cycle_error,
  resume_validation_error,
  suspended_error,
  timeout_error,
} from './errors.js';

export type {
  CheckpointStore,
  RunContext,
  Step,
  StepMetadata,
  TrajectoryEvent,
  TrajectoryLogger,
} from './types.js';

export { is_step_kind, STEP_KINDS } from './step_kinds.js';
export type { StepKind } from './step_kinds.js';

export {
  custom_event_schema,
  emit_event_schema,
  span_end_event_schema,
  span_start_event_schema,
  trajectory_event_schema,
} from './trajectory.js';
export type {
  CustomTrajectoryEvent,
  EmitEvent,
  ParsedTrajectoryEvent,
  SpanEndEvent,
  SpanStartEvent,
} from './trajectory.js';

export const flow_schema = flow_schema_data;

export { version as core_version } from './version.js';

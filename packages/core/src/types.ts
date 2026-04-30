/**
 * Shared type surface for the composition layer.
 *
 * These types are the public value contract between composers, the runner,
 * and adapter packages (@repo/observability, @repo/stores,
 * @repo/engine). Adapter packages import types from here; nothing in
 * this file imports from any adapter.
 *
 * Type aliases and interfaces use PascalCase per constraints.md §2.
 * Value-level identifiers (field names, function parameter names) remain
 * snake_case; those are the value contract, not the type contract.
 */

export type TrajectoryEvent = {
  readonly kind: string
  readonly span_id?: string | undefined
  readonly [key: string]: unknown
}

export type TrajectoryLogger = {
  readonly record: (event: TrajectoryEvent) => void
  readonly start_span: (name: string, meta?: Record<string, unknown>) => string
  readonly end_span: (id: string, meta?: Record<string, unknown>) => void
}

export type CheckpointStore = {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: unknown) => Promise<void>
  readonly delete: (key: string) => Promise<void>
}

export type CleanupFn = () => Promise<void> | void

export type RunContext = {
  readonly run_id: string
  readonly trajectory: TrajectoryLogger
  readonly state: ReadonlyMap<string, unknown>
  readonly parent_span_id?: string | undefined
  readonly abort: AbortSignal
  readonly emit: (event: Record<string, unknown>) => void
  readonly on_cleanup: (fn: CleanupFn) => void
  readonly checkpoint_store?: CheckpointStore | undefined
  readonly resume_data?: Readonly<Record<string, unknown>> | undefined
  readonly streaming: boolean
}

export type StepFn<i, o> = (input: i, ctx: RunContext) => Promise<o> | o

export type StepMetadata = {
  readonly display_name?: string
  readonly description?: string
  readonly port_labels?: Readonly<{
    readonly in?: string
    readonly out?: string
  }>
}

export type Step<i, o> = {
  readonly id: string
  readonly kind: string
  run(input: i, ctx: RunContext): Promise<o> | o
  readonly config?: Readonly<Record<string, unknown>>
  readonly children?: ReadonlyArray<Step<unknown, unknown>>
  readonly anonymous?: boolean
  readonly meta?: StepMetadata
}

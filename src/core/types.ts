/**
 * Shared type surface for the composition layer.
 *
 * These types are the public value contract between composers, the runner,
 * and adapter packages (observability, stores,
 * engine). Adapter packages import types from here; nothing in
 * this file imports from any adapter.
 *
 * Type aliases and interfaces use PascalCase, per the naming convention.
 * Value-level identifiers (field names, function parameter names) remain
 * snake_case; those are the value contract, not the type contract.
 */

export type TrajectoryEvent = {
  readonly kind: string
  readonly span_id?: string | undefined
  // Epoch milliseconds, stamped at emission by the runner's logger wrapper.
  // Optional in the type so external loggers and literal constructors stay
  // valid; guaranteed in practice for events flowing through `run`.
  readonly ts?: number | undefined
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
  // Invoke another Step from inside a step body with spans, error paths, and
  // abort checks intact. Declared with a `this` parameter so the method
  // resolves against whichever derived context it is invoked on (contexts are
  // spread-copied per span level), and so a destructured bare `call` is a
  // compile error instead of a silently detached dispatch.
  readonly call: <ci, co>(this: RunContext, s: Step<ci, co>, input: ci) => Promise<co>
  readonly checkpoint_store?: CheckpointStore | undefined
  readonly resume_data?: Readonly<Record<string, unknown>> | undefined
  readonly streaming: boolean
}

export type StepFn<i, o> = (input: i, ctx: RunContext) => Promise<o> | o

/**
 * Descriptive metadata for a step. `name` is the display channel: it labels
 * trajectory spans and `describe` output, and changing it is always safe
 * because nothing keys off it. The step's `id` stays the identity channel.
 */
export type StepMetadata = {
  readonly name?: string
  readonly description?: string
  readonly port_labels?: Readonly<{
    readonly in?: string
    readonly out?: string
  }>
}

export type Step<i, o> = {
  readonly id: string
  readonly kind: string
  // Declared as a function property, not a method: strictFunctionTypes checks
  // properties contravariantly in `i`, so a step wired to an input its `run`
  // cannot accept is a compile error rather than leaning on method bivariance.
  readonly run: StepFn<i, o>
  readonly config?: Readonly<Record<string, unknown>>
  readonly children?: ReadonlyArray<AnyStep>
  readonly anonymous?: boolean
  readonly meta?: StepMetadata
}

/**
 * The supertype of every Step: `never` input (contravariant, so any concrete
 * input type is admitted) and `unknown` output (covariant). Use this for
 * heterogeneous step collections and type-erased plumbing; `AnyStep` cannot
 * be run directly, which is the point: pairing an erased step with an input
 * it accepts is the runner's job, not the type system's.
 */
export type AnyStep = Step<never, unknown>

/**
 * Extract a Step's input type. The fallback is `never`, not `unknown`, so a
 * non-step can never satisfy an input-position check by accident; sequence's
 * joint checking depends on that. This is the canonical extractor the
 * composers' internal type machinery builds on.
 */
export type StepInput<s> = s extends Step<infer i, unknown> ? i : never

/**
 * Extract a Step's output type. Falls back to `unknown` so type-erased
 * plumbing over `AnyStep` degrades to the safe top type instead of lying.
 */
export type StepOutput<s> = s extends Step<never, infer o> ? o : unknown

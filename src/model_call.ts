/**
 * model_call: the single sanctioned bridge between the composition and
 * engine layers.
 *
 * This is the only file under `src/` permitted to import value symbols from
 * both `core` and `engine` (enforced by the model-call-is-sole-bridge
 * ast-grep rule in `rules/`).
 *
 * The returned Step auto-threads ctx.abort, ctx.trajectory, and, only when
 * run.stream is driving, an on_chunk forwarder that records each chunk as a
 * `model_chunk` trajectory event. Callers cannot override these: the
 * composition layer owns cancellation and trajectory plumbing. Cost events
 * flow out via ctx.trajectory per the engine's own emission rules.
 */

import { createHash } from 'node:crypto'
import { aborted_error, step } from '#core'
import type { RunContext, Step, TrajectoryLogger } from '#core'
import type {
  EffortLevel,
  Engine,
  GenerateOptions,
  GenerateResult,
  Message,
  PrepareStepHook,
  RetryPolicy,
  Tool,
  ToolApprovalHandler,
} from '#engine'
import type { ToolSchema } from '#schema'

export type ModelCallInput = string | ReadonlyArray<Message>

export type ModelCallConfig<T = string, projected = GenerateResult<T>> = {
  readonly engine: Engine
  /**
   * Model id, sent to the provider verbatim (there is no alias layer).
   * Optional: if omitted, the engine's `defaults.model` is used. Errors at
   * call time if neither is set.
   */
  readonly model?: string
  /**
   * Transport for the model: `anthropic` | `claude_cli` | `openrouter` | ...
   * Optional: if omitted, the engine's `defaults.provider` (or its sole
   * configured provider) is used.
   */
  readonly provider?: string
  readonly id?: string
  readonly system?: string
  readonly tools?: ReadonlyArray<Tool>
  readonly schema?: ToolSchema<T>
  readonly effort?: EffortLevel
  readonly temperature?: number
  readonly max_tokens?: number
  readonly top_p?: number
  readonly max_steps?: number
  /**
   * Per-turn wall-clock budget in milliseconds, forwarded to the engine.
   * See `GenerateOptions.turn_timeout_ms`.
   */
  readonly turn_timeout_ms?: number
  /**
   * Per-turn message hook, forwarded to the engine. See
   * `GenerateOptions.prepare_step`.
   */
  readonly prepare_step?: PrepareStepHook
  readonly provider_options?: Record<string, unknown>
  readonly retry_policy?: RetryPolicy
  readonly tool_error_policy?: 'feed_back' | 'throw'
  readonly schema_repair_attempts?: number
  readonly tool_call_repair_attempts?: number
  readonly max_tool_calls_per_step?: number
  readonly on_tool_approval?: ToolApprovalHandler
  /**
   * Map the `GenerateResult` envelope into the step's output at the source.
   * The projection runs inside the model_call step itself, so `describe` and
   * the trajectory gain no wrapper node. Omitted, the envelope is the output.
   * `model_step` is this option preset to `(r) => r.content`.
   */
  readonly project?: (r: GenerateResult<T>) => projected
}

/**
 * Wrap the run's trajectory so the engine's own spans (engine.generate and its
 * step spans) nest under the model_call step rather than floating. The wrapper
 * keeps a private span stack seeded with the model_call step's id, so nesting
 * is correct and concurrency-safe even when several model_calls run together
 * under `parallel`/`map` (each invocation builds its own wrapper). A
 * caller-supplied `parent_span_id` is never overridden.
 */
function engine_trajectory(
  inner: TrajectoryLogger,
  root_parent: string | undefined,
): TrajectoryLogger {
  const stack: string[] = root_parent !== undefined ? [root_parent] : []
  return {
    record: (event) => {
      inner.record(event)
    },
    start_span: (name, meta) => {
      const has_parent = meta !== undefined && 'parent_span_id' in meta
      const parent = stack.length > 0 ? stack[stack.length - 1] : undefined
      const next_meta =
        has_parent || parent === undefined ? meta : { ...meta, parent_span_id: parent }
      const id = inner.start_span(name, next_meta)
      stack.push(id)
      return id
    },
    end_span: (id, meta) => {
      inner.end_span(id, meta)
      const idx = stack.lastIndexOf(id)
      if (idx !== -1) stack.splice(idx, 1)
    },
  }
}

/**
 * Derive a short, stable hash from the call's model, provider, system
 * prompt, and tool/schema shape.
 *
 * Used to build a default step id when the caller doesn't supply `cfg.id`.
 */
function stable_signature(input: {
  model: string | undefined
  provider: string | undefined
  system: string | undefined
  has_tools: boolean
  has_schema: boolean
}): string {
  const payload = JSON.stringify({
    model: input.model ?? null,
    provider: input.provider ?? null,
    system: input.system ?? null,
    has_tools: input.has_tools,
    has_schema: input.has_schema,
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 8)
}

let model_call_counter = 0

/**
 * Build the default step id: `model_call:<hash>:<n>`. The instance counter
 * keeps two leaves built from identical configs distinguishable in describe
 * and the trajectory; the hash still identifies the call's shape.
 */
function next_auto_id(input: Parameters<typeof stable_signature>[0]): string {
  model_call_counter += 1
  return `model_call:${stable_signature(input)}:${model_call_counter}`
}

/**
 * Copy `value` onto `target[key]` only when it is defined, so an absent optional
 * config field leaves the key off `GenerateOptions` rather than present-as-undefined.
 */
function assign_if_present<T, K extends keyof T>(target: T, key: K, value: T[K]): void {
  if (value !== undefined) target[key] = value
}

/**
 * Translate `cfg` into a `GenerateOptions`, folding each supplied optional field
 * in via `assign_if_present`. `tools` (spread to a fresh array) and
 * `retry_policy` (renamed to `retry`) are the two fields that do not copy
 * straight across and stay explicit; the rest map name-for-name.
 */
function build_generate_options<T, projected>(
  cfg: ModelCallConfig<T, projected>,
  prompt: Message[],
  ctx: RunContext,
): GenerateOptions<T> {
  const opts: GenerateOptions<T> = {
    prompt,
    abort: ctx.abort,
    trajectory: engine_trajectory(ctx.trajectory, ctx.parent_span_id),
  }
  assign_if_present(opts, 'model', cfg.model)
  assign_if_present(opts, 'provider', cfg.provider)
  assign_if_present(opts, 'system', cfg.system)
  if (cfg.tools !== undefined) opts.tools = [...cfg.tools]
  assign_if_present(opts, 'schema', cfg.schema)
  assign_if_present(opts, 'effort', cfg.effort)
  assign_if_present(opts, 'temperature', cfg.temperature)
  assign_if_present(opts, 'max_tokens', cfg.max_tokens)
  assign_if_present(opts, 'top_p', cfg.top_p)
  assign_if_present(opts, 'turn_timeout_ms', cfg.turn_timeout_ms)
  assign_if_present(opts, 'prepare_step', cfg.prepare_step)
  assign_if_present(opts, 'max_steps', cfg.max_steps)
  assign_if_present(opts, 'provider_options', cfg.provider_options)
  if (cfg.retry_policy !== undefined) opts.retry = cfg.retry_policy
  assign_if_present(opts, 'tool_error_policy', cfg.tool_error_policy)
  assign_if_present(opts, 'schema_repair_attempts', cfg.schema_repair_attempts)
  assign_if_present(opts, 'tool_call_repair_attempts', cfg.tool_call_repair_attempts)
  assign_if_present(opts, 'max_tool_calls_per_step', cfg.max_tool_calls_per_step)
  assign_if_present(opts, 'on_tool_approval', cfg.on_tool_approval)
  return opts
}

/**
 * Build a `Step` that calls `cfg.engine.generate` with `cfg` translated into
 * `GenerateOptions`.
 *
 * Threads `ctx.abort` and `ctx.trajectory` (nested under the model_call
 * step's own span) into every call, and, when `run.stream` is driving,
 * records each chunk as a `model_chunk` trajectory event. `cfg.project`
 * maps the `GenerateResult` envelope into the step's output inside the same
 * step; omitted, the envelope is the output.
 */
export function model_call<T = string, projected = GenerateResult<T>>(
  cfg: ModelCallConfig<T, projected>,
): Step<ModelCallInput, projected> {
  // Guard at construction so a wiring mistake (JS caller, spread gone wrong)
  // surfaces where it was made instead of as a bare property-read crash at
  // dispatch time.
  if (typeof cfg?.engine?.generate !== 'function') {
    throw new TypeError(
      'model_call: cfg.engine is required (an Engine from create_engine or fascicle/testing)',
    )
  }
  const has_tools = Boolean(cfg.tools && cfg.tools.length > 0)
  const has_schema = cfg.schema !== undefined
  // When `project` is omitted, `projected` defaults to the envelope type, which
  // is what the identity fallback's cast records.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const project = cfg.project ?? ((r: GenerateResult<T>) => r as unknown as projected)
  const step_id =
    cfg.id ??
    next_auto_id({
      model: cfg.model,
      provider: cfg.provider,
      system: cfg.system,
      has_tools,
      has_schema,
    })

  const describe_config: {
    model?: string
    provider?: string
    has_tools: boolean
    has_schema: boolean
    has_project: boolean
    has_prepare_step: boolean
    system?: string
    effort?: EffortLevel
    temperature?: number
    max_tokens?: number
    top_p?: number
    turn_timeout_ms?: number
  } = {
    has_tools,
    has_schema,
    has_project: cfg.project !== undefined,
    has_prepare_step: cfg.prepare_step !== undefined,
  }
  if (cfg.model !== undefined) describe_config.model = cfg.model
  if (cfg.provider !== undefined) describe_config.provider = cfg.provider
  if (cfg.system !== undefined) describe_config.system = cfg.system
  if (cfg.effort !== undefined) describe_config.effort = cfg.effort
  if (cfg.temperature !== undefined) describe_config.temperature = cfg.temperature
  if (cfg.max_tokens !== undefined) describe_config.max_tokens = cfg.max_tokens
  if (cfg.top_p !== undefined) describe_config.top_p = cfg.top_p
  if (cfg.turn_timeout_ms !== undefined) describe_config.turn_timeout_ms = cfg.turn_timeout_ms

  const inner = step<ModelCallInput, projected>(step_id, async (input, ctx) => {
    if (ctx.abort.aborted) {
      throw new aborted_error('aborted before model_call', {
        reason: { signal: 'abort' },
        step_index: 0,
      })
    }

    const prompt: Message[] =
      typeof input === 'string'
        ? [{ role: 'user', content: [{ type: 'text', text: input }] }]
        : [...input]

    const opts = build_generate_options(cfg, prompt, ctx)

    if (ctx.streaming) {
      opts.on_chunk = (chunk) => {
        // Record with kind preserved. ctx.emit would clobber kind to 'emit'
        // and bury the chunk, so stream consumers would have to un-nest a
        // generic event; recording keeps a clean top-level `model_chunk` event
        // (what docs/concepts.md already documents) carrying the StreamChunk.
        ctx.trajectory.record({ kind: 'model_chunk', step_id, chunk })
      }
    }

    return project(await cfg.engine.generate(opts))
  })

  return {
    id: inner.id,
    kind: inner.kind,
    run: (input, ctx) => inner.run(input, ctx),
    config: Object.freeze({ ...describe_config }),
  }
}

/**
 * model_step: `model_call` projected to its content.
 *
 * Returns a Step whose output is the model's final content (a `string`, or
 * the schema-validated value when `cfg.schema` is set) instead of the full
 * `GenerateResult` envelope. Use `model_step` when the flow only wants the
 * answer, keeping compositions at the `step, step, model_step, step` cadence;
 * drop to `model_call` when the caller needs usage, cost, tool calls, or
 * finish reason (or its `project` option, when the flow wants a slice of the
 * envelope mapped at the source).
 *
 * Implemented as `model_call` with `project` preset to `(r) => r.content`,
 * so the leaf is a single node in `describe` and the trajectory. Wrapping a
 * primitive into an app-shaped helper of your own is still the extension
 * pattern; this is its smallest instance.
 */
export function model_step<T = string>(
  cfg: Omit<ModelCallConfig<T>, 'project'>,
): Step<ModelCallInput, T> {
  return model_call<T, T>({ ...cfg, project: (r) => r.content })
}

/**
 * model_call — the single sanctioned bridge between the composition and
 * engine layers.
 *
 * This is the only file under packages/fascicle/src/ permitted to import
 * value symbols from both core and engine (enforced by the
 * model-call-is-sole-bridge ast-grep rule in rules/).
 *
 * The returned Step auto-threads ctx.abort, ctx.trajectory, and — only when
 * run.stream is driving — an on_chunk forwarder into ctx.emit. Callers cannot
 * override these; the composition layer owns cancellation and trajectory
 * plumbing. Cost events flow out via ctx.trajectory per the engine's own
 * emission rules (constraints §5.3).
 */

import { createHash } from 'node:crypto'
import { aborted_error, step } from '#core'
import type { Step, TrajectoryLogger } from '#core'
import type {
  EffortLevel,
  Engine,
  GenerateOptions,
  GenerateResult,
  Message,
  RetryPolicy,
  Tool,
  ToolApprovalHandler,
} from '#engine'
import type { z } from 'zod'

export type ModelCallInput = string | ReadonlyArray<Message>

export type ModelCallConfig<T = string> = {
  readonly engine: Engine
  /**
   * Model or alias string. Optional: if omitted, the engine's
   * `defaults.model` is used. Errors at call time if neither is set.
   */
  readonly model?: string
  /**
   * Transport for the model: `anthropic` | `claude_cli` | `openrouter` | ...
   * Optional: if omitted, the engine's `defaults.provider` (or sole configured
   * provider, else `anthropic`) is used.
   */
  readonly provider?: string
  readonly id?: string
  readonly system?: string
  readonly tools?: ReadonlyArray<Tool>
  readonly schema?: z.ZodType<T>
  readonly effort?: EffortLevel
  readonly max_steps?: number
  readonly provider_options?: Record<string, unknown>
  readonly retry_policy?: RetryPolicy
  readonly tool_error_policy?: 'feed_back' | 'throw'
  readonly schema_repair_attempts?: number
  readonly tool_call_repair_attempts?: number
  readonly max_tool_calls_per_step?: number
  readonly on_tool_approval?: ToolApprovalHandler
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

export function model_call<T = string>(
  cfg: ModelCallConfig<T>,
): Step<ModelCallInput, GenerateResult<T>> {
  const has_tools = Boolean(cfg.tools && cfg.tools.length > 0)
  const has_schema = cfg.schema !== undefined
  const step_id =
    cfg.id ??
    `model_call:${stable_signature({
      model: cfg.model,
      provider: cfg.provider,
      system: cfg.system,
      has_tools,
      has_schema,
    })}`

  const describe_config: {
    model?: string
    provider?: string
    has_tools: boolean
    has_schema: boolean
    system?: string
    effort?: EffortLevel
  } = {
    has_tools,
    has_schema,
  }
  if (cfg.model !== undefined) describe_config.model = cfg.model
  if (cfg.provider !== undefined) describe_config.provider = cfg.provider
  if (cfg.system !== undefined) describe_config.system = cfg.system
  if (cfg.effort !== undefined) describe_config.effort = cfg.effort

  const inner = step<ModelCallInput, GenerateResult<T>>(step_id, async (input, ctx) => {
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
  
    const opts: GenerateOptions<T> = {
      prompt,
      abort: ctx.abort,
      trajectory: engine_trajectory(ctx.trajectory, ctx.parent_span_id),
    }
    if (cfg.model !== undefined) opts.model = cfg.model
    if (cfg.provider !== undefined) opts.provider = cfg.provider
    if (cfg.system !== undefined) opts.system = cfg.system
    if (cfg.tools !== undefined) opts.tools = [...cfg.tools]
    if (cfg.schema !== undefined) opts.schema = cfg.schema
    if (cfg.effort !== undefined) opts.effort = cfg.effort
    if (cfg.max_steps !== undefined) opts.max_steps = cfg.max_steps
    if (cfg.provider_options !== undefined) opts.provider_options = cfg.provider_options
    if (cfg.retry_policy !== undefined) opts.retry = cfg.retry_policy
    if (cfg.tool_error_policy !== undefined) opts.tool_error_policy = cfg.tool_error_policy
    if (cfg.schema_repair_attempts !== undefined) {
      opts.schema_repair_attempts = cfg.schema_repair_attempts
    }
    if (cfg.tool_call_repair_attempts !== undefined) {
      opts.tool_call_repair_attempts = cfg.tool_call_repair_attempts
    }
    if (cfg.max_tool_calls_per_step !== undefined) {
      opts.max_tool_calls_per_step = cfg.max_tool_calls_per_step
    }
    if (cfg.on_tool_approval !== undefined) opts.on_tool_approval = cfg.on_tool_approval
  
    if (ctx.streaming) {
      opts.on_chunk = (chunk) => {
        // Record with kind preserved. ctx.emit would clobber kind to 'emit'
        // and bury the chunk, so stream consumers would have to un-nest a
        // generic event; recording keeps a clean top-level `model_chunk` event
        // (what docs/concepts.md already documents) carrying the StreamChunk.
        ctx.trajectory.record({ kind: 'model_chunk', step_id, chunk })
      }
    }
  
    return cfg.engine.generate(opts)
  })

  return {
    id: inner.id,
    kind: inner.kind,
    run: (input, ctx) => inner.run(input, ctx),
    config: Object.freeze({ ...describe_config }),
  }
}

/**
 * model_call — the single sanctioned bridge between the composition and
 * engine layers.
 *
 * This is the only file under packages/fascicle/src/ permitted to import
 * value symbols from both @repo/core and @repo/engine (enforced by the
 * model-call-is-sole-bridge ast-grep rule in rules/).
 *
 * The returned Step auto-threads ctx.abort, ctx.trajectory, and — only when
 * run.stream is driving — an on_chunk forwarder into ctx.emit. Callers cannot
 * override these; the composition layer owns cancellation and trajectory
 * plumbing. Cost events flow out via ctx.trajectory per the engine's own
 * emission rules (constraints §5.3).
 */

import { createHash } from 'node:crypto'
import { aborted_error, step } from '@repo/core'
import type { Step } from '@repo/core'
import type {
  EffortLevel,
  Engine,
  GenerateOptions,
  GenerateResult,
  Message,
  RetryPolicy,
  Tool,
  ToolApprovalHandler,
} from '@repo/engine'
import type { z } from 'zod'

export type ModelCallInput = string | ReadonlyArray<Message>

export type ModelCallConfig<T = unknown> = {
  readonly engine: Engine
  /**
   * Model or alias string. Optional: if omitted, the engine's
   * `defaults.model` is used. Errors at call time if neither is set.
   */
  readonly model?: string
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
  readonly on_tool_approval?: ToolApprovalHandler
}

function stable_signature(input: {
  model?: string
  system?: string
  has_tools: boolean
  has_schema: boolean
}): string {
  const payload = JSON.stringify({
    model: input.model ?? null,
    system: input.system ?? null,
    has_tools: input.has_tools,
    has_schema: input.has_schema,
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 8)
}

export function model_call<T = unknown>(
  cfg: ModelCallConfig<T>,
): Step<ModelCallInput, GenerateResult<T>> {
  const has_tools = Boolean(cfg.tools && cfg.tools.length > 0)
  const has_schema = cfg.schema !== undefined
  const signature_input: {
    model?: string
    system?: string
    has_tools: boolean
    has_schema: boolean
  } = { has_tools, has_schema }
  if (cfg.model !== undefined) signature_input.model = cfg.model
  if (cfg.system !== undefined) signature_input.system = cfg.system
  const step_id = cfg.id ?? `model_call:${stable_signature(signature_input)}`

  const describe_config: {
    model?: string
    has_tools: boolean
    has_schema: boolean
    system?: string
    effort?: EffortLevel
  } = {
    has_tools,
    has_schema,
  }
  if (cfg.model !== undefined) describe_config.model = cfg.model
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
      trajectory: ctx.trajectory,
    }
    if (cfg.model !== undefined) opts.model = cfg.model
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
    if (cfg.on_tool_approval !== undefined) opts.on_tool_approval = cfg.on_tool_approval
  
    if (ctx.streaming) {
      opts.on_chunk = (chunk) => {
        ctx.emit({ kind: 'model_chunk', step_id, chunk })
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

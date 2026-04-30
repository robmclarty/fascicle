/**
 * claude_cli adapter factory (spec §5.5, §6, §8, §13).
 *
 * Exports a `create_claude_cli_adapter(init)` factory that returns a
 * `SubprocessProviderAdapter`. The factory closure-captures a per-instance
 * `spawn_runtime` (which owns its own `Set<ChildProcess>` live registry), so
 * two factory invocations produce two independent registries (constraints §7
 * invariant 5: no module-level mutable state).
 *
 * The returned adapter exposes exactly `{ kind: 'subprocess', name, generate,
 * dispose, supports }` — no `build_model`, `translate_effort`, or
 * `normalize_usage` members.
 */

import { z } from 'zod'
import type {
  AliasTarget,
  EffortLevel,
  GenerateOptions,
  GenerateResult,
  Message,
  ProviderInit,
  StreamChunk,
  Tool,
} from '../../types.js'
import type {
  ProviderCapability,
  SubprocessProviderAdapter,
} from '../types.js'
import type {
  ClaudeCliCallOptions,
  ClaudeCliProviderConfig,
  ToolBridgeMode,
} from './types.js'
import {
  build_env,
  stderr_is_auth_failure,
  validate_auth_config,
} from './auth.js'
import {
  build_cli_argv,
  merge_allowed_tools,
  merge_system,
} from './argv.js'
import { build_sandbox_plan } from './sandbox.js'
import { create_spawn_runtime } from './spawn.js'
import {
  create_parser_state,
  feed_chunk,
  flush_remaining,
  snapshot,
} from './stream_parse.js'
import { build_generate_result } from './stream_result.js'
import {
  CLI_BINARY_DEFAULT,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
} from './constants.js'
import {
  aborted_error,
  claude_cli_error,
  engine_disposed_error,
  provider_auth_error,
  provider_capability_error,
  schema_validation_error,
} from '../../errors.js'
import { parse_with_schema } from '../../schema.js'
import {
  create_option_ignored_dedup,
  end_generate_span,
  end_step_span,
  record_cost,
  start_generate_span,
  start_step_span,
} from '../../trajectory.js'

const SUPPORTED: ReadonlySet<ProviderCapability> = new Set<ProviderCapability>([
  'text',
  'tools',
  'schema',
  'streaming',
  'reasoning',
])

const PROVIDER_NAME = 'claude_cli'

// Map fascicle's EffortLevel to Claude Code's CLAUDE_CODE_EFFORT_LEVEL env var.
// The CLI supports `low | medium | high | xhigh | max | auto`; we expose all
// non-`none` levels of fascicle's EffortLevel and let the user opt out via
// `effort: 'none'` (which results in no env var being set, deferring to whatever
// is already in the inherited environment).
const CLAUDE_CLI_EFFORT_VALUES: Record<Exclude<EffortLevel, 'none'>, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

export function effort_env_for_claude_cli(
  effort: EffortLevel | undefined,
): Record<string, string> {
  if (effort === undefined || effort === 'none') return {}
  return { CLAUDE_CODE_EFFORT_LEVEL: CLAUDE_CLI_EFFORT_VALUES[effort] }
}

function extract_call_opts(opts: GenerateOptions<unknown>): ClaudeCliCallOptions {
  const raw = opts.provider_options?.['claude_cli']
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return {}
  }
  return raw as ClaudeCliCallOptions
}

function count_user_messages(prompt: string | Message[]): number {
  if (typeof prompt === 'string') return 1
  let count = 0
  for (const m of prompt) {
    if (m.role === 'user') count += 1
  }
  return count
}

function extract_prompt_text(prompt: string | Message[]): string {
  if (typeof prompt === 'string') return prompt
  for (const m of prompt) {
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    const parts: string[] = []
    for (const p of m.content) {
      if (p.type === 'text') parts.push(p.text)
    }
    return parts.join('\n')
  }
  return ''
}

function extract_system_text(prompt: string | Message[]): string | undefined {
  if (typeof prompt === 'string') return undefined
  for (const m of prompt) {
    if (m.role === 'system') return m.content
  }
  return undefined
}

function compile_schema<T>(schema: z.ZodType<T>): string {
  const json = z.toJSONSchema(schema)
  return JSON.stringify(json)
}

function classify_close_error(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error {
  const snippet = stderr.slice(0, 512)
  if (stderr_is_auth_failure(stderr)) {
    return new provider_auth_error(
      PROVIDER_NAME,
      `claude CLI reported an auth failure: ${snippet}`,
      { refresh_command: 'claude login' },
    )
  }
  if (/bwrap|greywall|sandbox/i.test(stderr) && /not found|no such file|enoent/i.test(stderr)) {
    return new claude_cli_error('sandbox_unavailable', `sandbox binary unavailable: ${snippet}`, {
      stderr_snippet: snippet,
    })
  }
  const status = typeof code === 'number' ? code : undefined
  const signal_part = signal !== null ? ` (signal ${signal})` : ''
  const message = `claude CLI exited with code ${String(code)}${signal_part}: ${snippet}`
  const metadata: { status?: number; stderr_snippet?: string } = {
    stderr_snippet: snippet,
  }
  if (status !== undefined) metadata.status = status
  return new claude_cli_error('subprocess_exit', message, metadata)
}

type RunArgs = {
  readonly model_id: string
  readonly stdin_text: string
  readonly merged_system: string
  readonly merged_allowed_tools: ReadonlyArray<string>
  readonly call_opts: ClaudeCliCallOptions
  readonly compiled_schema: string | undefined
  readonly env: Record<string, string>
  readonly spawn_cmd: string
  readonly prefix_args: ReadonlyArray<string>
  readonly cwd: string | undefined
  readonly startup_timeout_ms: number
  readonly stall_timeout_ms: number
  readonly abort: AbortSignal | undefined
  readonly dispatch_chunk:
    | ((chunk: StreamChunk) => Promise<void>)
    | undefined
  readonly trajectory: GenerateOptions<unknown>['trajectory']
}

type RunOutcome = {
  readonly parsed: ReturnType<typeof snapshot>
  readonly chunks: StreamChunk[]
}

async function run_cli(
  spawn_runtime: ReturnType<typeof create_spawn_runtime>,
  args: RunArgs,
): Promise<RunOutcome> {
  const argv = build_cli_argv({
    model_id: args.model_id,
    provider_config: {},
    call_opts: args.call_opts,
    merged_allowed_tools: args.merged_allowed_tools,
    merged_system: args.merged_system,
    ...(args.compiled_schema !== undefined ? { compiled_schema: args.compiled_schema } : {}),
  })
  const full_argv: string[] = [...args.prefix_args, ...argv]

  const spawn_args: Parameters<typeof spawn_runtime.spawn_cli>[0] = {
    cmd: args.spawn_cmd,
    argv: full_argv,
    env: args.env,
    stdin: args.stdin_text,
    startup_timeout_ms: args.startup_timeout_ms,
    stall_timeout_ms: args.stall_timeout_ms,
  }
  if (args.cwd !== undefined) {
    (spawn_args as { cwd?: string }).cwd = args.cwd
  }
  if (args.abort !== undefined) {
    (spawn_args as { abort?: AbortSignal }).abort = args.abort
  }

  const session = await spawn_runtime.spawn_cli(spawn_args)

  const state = create_parser_state()
  const chunks: StreamChunk[] = []

  const consume = (async (): Promise<void> => {
    for await (const line of session.stdout_lines) {
      await feed_chunk(state, `${line}\n`, chunks, args.dispatch_chunk, args.trajectory)
    }
    await flush_remaining(state, chunks, args.dispatch_chunk, args.trajectory)
  })()

  let close_outcome: Awaited<ReturnType<typeof session.wait_close>>
  try {
    [close_outcome] = await Promise.all([session.wait_close(), consume])
  } catch (err: unknown) {
    try {
      await consume
    } catch {
      // ignore secondary consume errors
    }
    throw err
  }

  const parsed = snapshot(state)

  if (close_outcome.code !== 0) {
    throw classify_close_error(close_outcome.code, close_outcome.signal, close_outcome.stderr)
  }
  if (!parsed.received_result) {
    throw new claude_cli_error(
      'no_result_event',
      'claude CLI closed without emitting a terminal result event',
      { stderr_snippet: close_outcome.stderr.slice(0, 512) },
    )
  }

  return { parsed, chunks }
}

export function create_claude_cli_adapter(init: ProviderInit): SubprocessProviderAdapter {
  const config = init as ClaudeCliProviderConfig
  validate_auth_config(config)

  const spawn_runtime = create_spawn_runtime()
  let disposed = false
  const in_flight: Set<AbortController> = new Set()

  const resolved_binary = typeof config.binary === 'string' && config.binary.length > 0
    ? config.binary
    : CLI_BINARY_DEFAULT
  const resolved_auth_mode = config.auth_mode ?? 'auto'
  const resolved_startup_timeout = config.startup_timeout_ms ?? DEFAULT_STARTUP_TIMEOUT_MS
  const resolved_stall_timeout = config.stall_timeout_ms ?? DEFAULT_STALL_TIMEOUT_MS

  const adapter: SubprocessProviderAdapter = {
    kind: 'subprocess',
    name: PROVIDER_NAME,
    supports: (capability) => SUPPORTED.has(capability),
    async generate<T>(
      opts: GenerateOptions<T>,
      resolved: AliasTarget,
    ): Promise<GenerateResult<T>> {
      if (disposed) throw new engine_disposed_error()
      if (opts.abort?.aborted === true) {
        throw new aborted_error('aborted', { reason: opts.abort.reason })
      }
  
      const trajectory = opts.trajectory
      const call_opts = extract_call_opts(opts)
      const option_ignored = create_option_ignored_dedup(trajectory)
  
      if (opts.max_steps !== undefined) {
        option_ignored.emit('max_steps', PROVIDER_NAME)
      }
      if (opts.tool_error_policy !== undefined) {
        option_ignored.emit('tool_error_policy', PROVIDER_NAME)
      }
      if (opts.on_tool_approval !== undefined) {
        option_ignored.emit('on_tool_approval', PROVIDER_NAME)
      }
  
      const user_count = count_user_messages(opts.prompt)
      if (user_count >= 2) {
        throw new provider_capability_error(
          PROVIDER_NAME,
          'multi_turn_history',
          'use provider_options.claude_cli.session_id instead',
        )
      }
  
      const tools_list: ReadonlyArray<Tool> = opts.tools ?? []
      const tool_bridge: ToolBridgeMode = call_opts.tool_bridge ?? 'allowlist_only'
      if (tools_list.length > 0 && tool_bridge === 'forbid') {
        const has_execute = tools_list.some((t) => typeof t.execute === 'function')
        if (has_execute) {
          throw new provider_capability_error(
            PROVIDER_NAME,
            'tool_execute',
            'tool_bridge is forbid; tools with execute closures cannot run under claude_cli',
          )
        }
      }
  
      const tool_names: string[] = tools_list.map((t) => t.name)
      const merged_allowed_tools = merge_allowed_tools(call_opts.allowed_tools, tool_names)
      if (tools_list.length > 0 && tool_bridge === 'allowlist_only' && trajectory !== undefined) {
        const dropped = tools_list
          .filter((t) => typeof t.execute === 'function')
          .map((t) => t.name)
        trajectory.record({
          kind: 'cli_tool_bridge_allowlist_only',
          dropped,
        })
      }
  
      let compiled_schema: string | undefined
      if (opts.schema !== undefined) {
        compiled_schema = compile_schema(opts.schema)
      } else if (
        typeof call_opts.output_json_schema === 'string' &&
        call_opts.output_json_schema.length > 0
      ) {
        compiled_schema = call_opts.output_json_schema
      }
  
      const system_from_prompt = extract_system_text(opts.prompt)
      const merged_system = merge_system(
        opts.system ?? system_from_prompt,
        call_opts.append_system_prompt,
      )
  
      const stdin_text = extract_prompt_text(opts.prompt)
  
      const env = build_env(config, call_opts.env, resolved_auth_mode)
      Object.assign(env, effort_env_for_claude_cli(opts.effort))
  
      const sandbox_plan = build_sandbox_plan(resolved_binary, config.sandbox)
  
      const cwd = config.default_cwd
      const dispatch_chunk =
        opts.on_chunk !== undefined
          ? async (chunk: StreamChunk): Promise<void> => {
              const maybe = opts.on_chunk?.(chunk)
              if (maybe !== undefined && typeof maybe.then === 'function') {
                await maybe
              }
            }
          : undefined
  
      const controller = new AbortController()
      in_flight.add(controller)
  
      const caller_abort = opts.abort
      const on_caller_abort = (): void => {
        controller.abort(caller_abort?.reason)
      }
      if (caller_abort !== undefined) {
        if (caller_abort.aborted) controller.abort(caller_abort.reason)
        else caller_abort.addEventListener('abort', on_caller_abort, { once: true })
      }
  
      const generate_span = start_generate_span(trajectory, {
        model: opts.model ?? resolved.model_id,
        provider: PROVIDER_NAME,
        model_id: resolved.model_id,
        has_tools: tools_list.length > 0,
        has_schema: opts.schema !== undefined,
        streaming: dispatch_chunk !== undefined,
      })
      let first_step_span: string | undefined = start_step_span(trajectory, 0)
  
      const base_args: RunArgs = {
        model_id: resolved.model_id,
        stdin_text,
        merged_system,
        merged_allowed_tools,
        call_opts,
        compiled_schema,
        env,
        spawn_cmd: sandbox_plan.spawn_cmd,
        prefix_args: sandbox_plan.prefix_args,
        cwd,
        startup_timeout_ms: resolved_startup_timeout,
        stall_timeout_ms: resolved_stall_timeout,
        abort: controller.signal,
        dispatch_chunk,
        trajectory,
      }
  
      try {
        const first_outcome = await run_cli(spawn_runtime, base_args)
        let parsed = first_outcome.parsed
  
        let parsed_content: T | undefined
        if (opts.schema !== undefined) {
          const attempt = parse_with_schema(opts.schema, parsed.final_text)
          if (attempt.ok) {
            parsed_content = attempt.value
          } else {
            const repair_session_id = parsed.session_id
            if (repair_session_id === undefined) {
              throw new schema_validation_error(
                'schema validation failed and no session_id available for repair',
                attempt.error,
                parsed.final_text,
              )
            }
            const repair_prompt =
              'Your previous response did not match the expected schema. ' +
              'Return ONLY a JSON value that conforms to the provided --json-schema.'
            const repair_call_opts: ClaudeCliCallOptions = {
              ...call_opts,
              session_id: repair_session_id,
            }
            const repair_outcome = await run_cli(spawn_runtime, {
              ...base_args,
              stdin_text: repair_prompt,
              call_opts: repair_call_opts,
            })
            parsed = repair_outcome.parsed
            const retry = parse_with_schema(opts.schema, parsed.final_text)
            if (!retry.ok) {
              throw new schema_validation_error(
                'schema validation failed after one repair attempt',
                retry.error,
                parsed.final_text,
              )
            }
            parsed_content = retry.value
          }
        }
  
        const result_input: {
          parsed: typeof parsed
          resolved: AliasTarget
          schema?: typeof opts.schema
          parsed_content?: T
        } = {
          parsed,
          resolved,
        }
        if (opts.schema !== undefined) result_input.schema = opts.schema
        if (parsed_content !== undefined) result_input.parsed_content = parsed_content
  
        const result = build_generate_result<T>(result_input)
  
        for (const step of result.steps) {
          if (step.cost !== undefined) {
            record_cost(trajectory, step.index, step.cost, 'provider_reported')
          }
        }
  
        if (result.steps.length > 0) {
          const head = result.steps[0]
          if (head !== undefined) {
            end_step_span(trajectory, first_step_span, {
              usage: head.usage,
              finish_reason: head.finish_reason,
            })
          }
          first_step_span = undefined
          for (let i = 1; i < result.steps.length; i += 1) {
            const s = result.steps[i]
            if (s === undefined) continue
            const id = start_step_span(trajectory, i)
            end_step_span(trajectory, id, {
              usage: s.usage,
              finish_reason: s.finish_reason,
            })
          }
        } else {
          end_step_span(trajectory, first_step_span, {})
          first_step_span = undefined
        }
  
        end_generate_span(trajectory, generate_span, {
          usage: result.usage,
          finish_reason: result.finish_reason,
          model_resolved: result.model_resolved,
        })
  
        if (dispatch_chunk !== undefined) {
          await dispatch_chunk({
            kind: 'finish',
            finish_reason: result.finish_reason,
            usage: result.usage,
          })
        }
  
        return result
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (first_step_span !== undefined) {
          end_step_span(trajectory, first_step_span, { error: message })
          first_step_span = undefined
        }
        end_generate_span(trajectory, generate_span, { error: message })
        throw err
      } finally {
        if (caller_abort !== undefined) {
          caller_abort.removeEventListener('abort', on_caller_abort)
        }
        in_flight.delete(controller)
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      for (const controller of in_flight) {
        controller.abort('engine_disposed')
      }
      await spawn_runtime.dispose_all()
    },
  }

  return adapter
}

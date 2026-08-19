/**
 * claude_cli adapter factory.
 *
 * Exports a `create_claude_cli_adapter(init)` factory that returns a
 * `ExternalAgentAdapter`. The factory closure-captures a per-instance
 * `spawn_runtime` (which owns its own `Set<ChildProcess>` live registry), so
 * two factory invocations produce two independent registries; no state is
 * shared at module scope.
 *
 * The returned adapter exposes exactly `{ kind: 'external', name, generate,
 * dispose, supports }`, with no `build_model`, `translate_effort`, or
 * `normalize_usage` members.
 */

import { to_json_schema, type ToolSchema } from '#schema'
import type {
  ResolvedModel,
  EffortLevel,
  GenerateOptions,
  GenerateResult,
  Message,
  ProviderInit,
  StepRecord,
  StreamChunk,
  Tool,
} from '../../types.js'
import type {
  ProviderCapability,
  ExternalAgentAdapter,
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
  type ParsedStream,
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
import { format_schema_issues } from '#schema'
import {
  build_repair_prompt_text,
  parse_with_schema,
} from '../../schema.js'
import {
  create_option_ignored_dedup,
  end_generate_span,
  end_step_span,
  record_cost,
  record_schema_validation_failed,
  start_generate_span,
  start_step_span,
  with_timestamps,
} from '../../trajectory.js'

const SUPPORTED: ReadonlySet<ProviderCapability> = new Set<ProviderCapability>([
  'text',
  'tools',
  'schema',
  'streaming',
  'reasoning',
])

const PROVIDER_NAME = 'claude_cli'

// Map Fascicle's EffortLevel to Claude Code's CLAUDE_CODE_EFFORT_LEVEL env var.
// The CLI supports `low | medium | high | xhigh | max | auto`; we expose all
// non-`none` levels of Fascicle's EffortLevel and let the user opt out via
// `effort: 'none'` (which results in no env var being set, deferring to whatever
// is already in the inherited environment).
const CLAUDE_CLI_EFFORT_VALUES: Record<Exclude<EffortLevel, 'none'>, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

/**
 * Build the `CLAUDE_CODE_EFFORT_LEVEL` env var entry for a given effort
 * level.
 *
 * Returns an empty object for `undefined` or `'none'`, which leaves the
 * inherited environment (and thus the CLI's own default) untouched.
 */
export function effort_env_for_claude_cli(
  effort: EffortLevel | undefined,
): Record<string, string> {
  if (effort === undefined || effort === 'none') return {}
  return { CLAUDE_CODE_EFFORT_LEVEL: CLAUDE_CLI_EFFORT_VALUES[effort] }
}

/**
 * Pull the `claude_cli`-scoped provider options out of `provider_options`.
 *
 * Returns an empty object when the caller didn't set any, so downstream
 * code can read fields without an undefined check.
 */
export function extract_call_opts(opts: GenerateOptions<unknown>): ClaudeCliCallOptions {
  const raw = opts.provider_options?.['claude_cli']
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return {}
  }
  return raw
}

/**
 * Count how many `user` messages are in the prompt.
 *
 * A plain string prompt counts as a single user message.
 */
export function count_user_messages(prompt: string | Message[]): number {
  if (typeof prompt === 'string') return 1
  let count = 0
  for (const m of prompt) {
    if (m.role === 'user') count += 1
  }
  return count
}

/**
 * Extract the first user message's text to send as CLI stdin.
 *
 * `generate` rejects prompts with more than one user message (claude_cli
 * only supports a single turn per invocation), so only the first one is
 * ever relevant here.
 */
export function extract_prompt_text(prompt: string | Message[]): string {
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

/**
 * Pull the system message content out of a `Message[]` prompt.
 *
 * Returns `undefined` for a plain string prompt or when no system message
 * is present.
 */
export function extract_system_text(prompt: string | Message[]): string | undefined {
  if (typeof prompt === 'string') return undefined
  for (const m of prompt) {
    if (m.role === 'system') return m.content
  }
  return undefined
}

/**
 * Serialize a schema to the JSON Schema string the CLI's `--json-schema`
 * flag expects.
 *
 * `strip_meta` is what makes this CLI-specific: `claude --json-schema`
 * rejects a top-level `$schema`/`$id`, which every other provider tolerates.
 */
export function compile_schema<T>(schema: ToolSchema<T>): string {
  return JSON.stringify(to_json_schema(schema, { strip_meta: true }))
}

/**
 * Turn a closed CLI subprocess's exit code, signal, and stderr into an
 * `Error`.
 *
 * Checks stderr for an auth failure first, then for a missing sandbox
 * binary, then falls back to a generic exit-code error. The stderr
 * snippet attached to each error is truncated to 512 bytes.
 */
export function classify_close_error(
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

/**
 * Spawn one claude CLI invocation, stream its stdout into parsed events,
 * and wait for it to close.
 *
 * Runs `session.wait_close()` and the stdout-consuming loop concurrently:
 * the process can still be flushing stdout while it exits, so waiting for
 * close first would drop those trailing lines. Throws if the process
 * exits non-zero or closes without ever emitting a terminal `result`
 * event.
 */
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

/** Span ids one generate call holds open; `first_step` is cleared once closed. */
type GenerateSpans = {
  generate: string | undefined
  first_step: string | undefined
}

/**
 * Emit `option_ignored` events for the loop-control options this provider
 * cannot honor: the CLI runs its own tool loop on the far side of the
 * subprocess boundary.
 */
function emit_ignored_options<T>(
  opts: GenerateOptions<T>,
  trajectory: RunArgs['trajectory'],
): void {
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
  if (opts.tool_call_repair_attempts !== undefined) {
    option_ignored.emit('tool_call_repair_attempts', PROVIDER_NAME)
  }
  if (opts.max_tool_calls_per_step !== undefined) {
    option_ignored.emit('max_tool_calls_per_step', PROVIDER_NAME)
  }
}

/**
 * Reject requests the CLI cannot express: multi-turn user history (one user
 * turn per invocation; continuation goes through `session_id`), and
 * executable tools under `tool_bridge: 'forbid'`.
 */
function validate_request(
  prompt: string | Message[],
  tools_list: ReadonlyArray<Tool>,
  tool_bridge: ToolBridgeMode,
): void {
  if (count_user_messages(prompt) >= 2) {
    throw new provider_capability_error(
      PROVIDER_NAME,
      'multi_turn_history',
      'use provider_options.claude_cli.session_id instead',
    )
  }
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
}

/**
 * Record which executable tools the allowlist-only bridge is dropping:
 * their names still pass through `--allowedTools`, but their execute
 * closures cannot run on this side of the subprocess boundary.
 */
function record_allowlist_only_drop(
  tools_list: ReadonlyArray<Tool>,
  tool_bridge: ToolBridgeMode,
  trajectory: RunArgs['trajectory'],
): void {
  if (tools_list.length === 0 || tool_bridge !== 'allowlist_only' || trajectory === undefined) {
    return
  }
  const dropped = tools_list
    .filter((t) => typeof t.execute === 'function')
    .map((t) => t.name)
  trajectory.record({
    kind: 'cli_tool_bridge_allowlist_only',
    dropped,
  })
}

/**
 * Choose the JSON Schema string for `--json-schema`: a typed `opts.schema`
 * compiles and wins; otherwise a raw `output_json_schema` string passes
 * through verbatim.
 */
function resolve_compiled_schema<T>(
  opts: GenerateOptions<T>,
  call_opts: ClaudeCliCallOptions,
): string | undefined {
  if (opts.schema !== undefined) return compile_schema(opts.schema)
  if (
    typeof call_opts.output_json_schema === 'string' &&
    call_opts.output_json_schema.length > 0
  ) {
    return call_opts.output_json_schema
  }
  return undefined
}

/**
 * Wrap `opts.on_chunk` so sync and async callbacks dispatch the same way: a
 * returned thenable is awaited, any other return is fire-and-done. Returns
 * `undefined` when the caller isn't streaming, which downstream code uses
 * as the streaming flag.
 */
function make_dispatch_chunk<T>(
  opts: GenerateOptions<T>,
): ((chunk: StreamChunk) => Promise<void>) | undefined {
  if (opts.on_chunk === undefined) return undefined
  return async (chunk: StreamChunk): Promise<void> => {
    const maybe = opts.on_chunk?.(chunk)
    if (maybe !== undefined && typeof maybe.then === 'function') {
      await maybe
    }
  }
}

/**
 * Create this call's AbortController, register it in the adapter's
 * in-flight set (`dispose()` aborts everything still registered), and
 * forward the caller's abort signal into it, including one already aborted.
 * `unlink` undoes both and must run however generate settles, or the
 * registry would pin settled calls alive.
 */
function link_caller_abort(
  in_flight: Set<AbortController>,
  caller_abort: AbortSignal | undefined,
): { controller: AbortController; unlink: () => void } {
  const controller = new AbortController()
  in_flight.add(controller)
  const on_caller_abort = (): void => {
    controller.abort(caller_abort?.reason)
  }
  if (caller_abort !== undefined) {
    if (caller_abort.aborted) controller.abort(caller_abort.reason)
    else caller_abort.addEventListener('abort', on_caller_abort, { once: true })
  }
  return {
    controller,
    unlink: (): void => {
      if (caller_abort !== undefined) {
        caller_abort.removeEventListener('abort', on_caller_abort)
      }
      in_flight.delete(controller)
    },
  }
}

/**
 * Open the generate span and the first step span before the CLI spawns, so
 * their timing brackets the whole subprocess run.
 */
function open_spans<T>(
  trajectory: RunArgs['trajectory'],
  opts: GenerateOptions<T>,
  resolved: ResolvedModel,
  has_tools: boolean,
  streaming: boolean,
): GenerateSpans {
  return {
    generate: start_generate_span(trajectory, {
      model: opts.model ?? resolved.model_id,
      provider: PROVIDER_NAME,
      model_id: resolved.model_id,
      has_tools,
      has_schema: opts.schema !== undefined,
      streaming,
    }),
    first_step: start_step_span(trajectory, 0),
  }
}

/**
 * Failure message for schema validation that exhausted its repair budget.
 * Zero names the opt-out explicitly so "repair disabled" reads differently
 * from "repairs tried and failed".
 */
function repair_exhausted_message(max_repairs: number): string {
  if (max_repairs === 0) {
    return 'schema validation failed and repair is disabled (schema_repair_attempts: 0)'
  }
  return `schema validation failed after ${String(max_repairs)} repair attempt${max_repairs === 1 ? '' : 's'}`
}

/**
 * Validate the CLI's final text against `schema`, re-invoking the CLI with
 * a repair prompt on failure, up to `max_repairs` times.
 *
 * Each repair resumes the previous attempt's `session_id`, so a snapshot
 * without one makes validation failure terminal immediately. The returned
 * snapshot is the one the repair loop settled on; the result must be built
 * from it, not from the first attempt's.
 */
async function parse_schema_with_repair<T>(
  spawn_runtime: ReturnType<typeof create_spawn_runtime>,
  base_args: RunArgs,
  schema: ToolSchema<T>,
  max_repairs: number,
  first_parsed: ParsedStream,
  trajectory: RunArgs['trajectory'],
): Promise<{ parsed: ParsedStream; parsed_content: T }> {
  let parsed = first_parsed
  let repairs_done = 0
  for (;;) {
    const attempt = await parse_with_schema(schema, parsed.final_text)
    if (attempt.ok) {
      return { parsed, parsed_content: attempt.value }
    }
    record_schema_validation_failed(trajectory, {
      attempt: repairs_done === 0 ? 'initial' : 'repair',
      schema_issues: format_schema_issues(attempt.issues),
      raw_text: parsed.final_text,
    })
    if (repairs_done >= max_repairs) {
      throw new schema_validation_error(
        repair_exhausted_message(max_repairs),
        attempt.issues,
        parsed.final_text,
      )
    }
    const repair_session_id = parsed.session_id
    if (repair_session_id === undefined) {
      throw new schema_validation_error(
        'schema validation failed and no session_id available for repair',
        attempt.issues,
        parsed.final_text,
      )
    }
    const repair_outcome = await run_cli(spawn_runtime, {
      ...base_args,
      stdin_text: build_repair_prompt_text(attempt.issues),
      call_opts: { ...base_args.call_opts, session_id: repair_session_id },
    })
    parsed = repair_outcome.parsed
    repairs_done += 1
  }
}

/**
 * Resolve the call's final parse snapshot and validated content. Without a
 * schema the first snapshot is final and content stays undefined; with one,
 * the repair loop takes over.
 */
async function resolve_content<T>(
  spawn_runtime: ReturnType<typeof create_spawn_runtime>,
  base_args: RunArgs,
  opts: GenerateOptions<T>,
  first_parsed: ParsedStream,
): Promise<{ parsed: ParsedStream; parsed_content: T | undefined }> {
  if (opts.schema === undefined) {
    return { parsed: first_parsed, parsed_content: undefined }
  }
  return parse_schema_with_repair(
    spawn_runtime,
    base_args,
    opts.schema,
    opts.schema_repair_attempts ?? 1,
    first_parsed,
    base_args.trajectory,
  )
}

/**
 * Assemble the `build_generate_result` input, attaching the schema and its
 * validated value only when structured output was requested.
 */
function assemble_result<T>(
  parsed: ParsedStream,
  resolved: ResolvedModel,
  schema: ToolSchema<T> | undefined,
  parsed_content: T | undefined,
): GenerateResult<T> {
  return build_generate_result<T>({
    parsed,
    resolved,
    ...(schema !== undefined ? { schema } : {}),
    ...(parsed_content !== undefined ? { parsed_content } : {}),
  })
}

/**
 * Forward the CLI's per-turn provider-reported costs into the trajectory.
 */
function record_provider_costs(
  trajectory: RunArgs['trajectory'],
  steps: ReadonlyArray<StepRecord>,
): void {
  for (const step of steps) {
    if (step.cost !== undefined) {
      record_cost(trajectory, step.index, step.cost, 'provider_reported')
    }
  }
}

/**
 * Close the eagerly opened first step span against the steps the CLI
 * reported, then emit paired open/close spans for steps 1..n; those arrive
 * all at once on process close, so their spans carry usage, not timing.
 * Clears `spans.first_step` so the error path cannot close it twice.
 */
function close_step_spans(
  trajectory: RunArgs['trajectory'],
  spans: GenerateSpans,
  steps: ReadonlyArray<StepRecord>,
): void {
  if (steps.length === 0) {
    end_step_span(trajectory, spans.first_step, {})
    spans.first_step = undefined
    return
  }
  const head = steps[0]
  if (head !== undefined) {
    end_step_span(trajectory, spans.first_step, {
      usage: head.usage,
      finish_reason: head.finish_reason,
    })
  }
  spans.first_step = undefined
  for (let i = 1; i < steps.length; i += 1) {
    const s = steps[i]
    if (s === undefined) continue
    const id = start_step_span(trajectory, i)
    end_step_span(trajectory, id, {
      usage: s.usage,
      finish_reason: s.finish_reason,
    })
  }
}

/**
 * Emit the terminal `finish` chunk streaming callers expect; the CLI stream
 * has no equivalent event, so it is synthesized from the final result.
 */
async function dispatch_finish<T>(
  dispatch_chunk: ((chunk: StreamChunk) => Promise<void>) | undefined,
  result: GenerateResult<T>,
): Promise<void> {
  if (dispatch_chunk === undefined) return
  await dispatch_chunk({
    kind: 'finish',
    finish_reason: result.finish_reason,
    usage: result.usage,
  })
}

/**
 * Close whatever spans are still open with the failure message. A failure
 * after the step spans already closed (for example, in the finish-chunk dispatch)
 * closes only the generate span.
 */
function close_spans_on_error(
  trajectory: RunArgs['trajectory'],
  spans: GenerateSpans,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err)
  if (spans.first_step !== undefined) {
    end_step_span(trajectory, spans.first_step, { error: message })
    spans.first_step = undefined
  }
  end_generate_span(trajectory, spans.generate, { error: message })
}

/**
 * Build a claude_cli `ExternalAgentAdapter` bound to one config.
 *
 * Validates the auth config eagerly, before any call is made, and wires up
 * a spawn runtime plus an in-flight abort-controller registry that
 * `dispose()` uses to cancel every call still running.
 */
export function create_claude_cli_adapter(init: ProviderInit): ExternalAgentAdapter {
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

  const adapter: ExternalAgentAdapter = {
    kind: 'external',
    name: PROVIDER_NAME,
    supports: (capability) => SUPPORTED.has(capability),
    async generate<T>(
      opts: GenerateOptions<T>,
      resolved: ResolvedModel,
    ): Promise<GenerateResult<T>> {
      if (disposed) throw new engine_disposed_error()
      if (opts.abort?.aborted === true) {
        throw new aborted_error('aborted', { reason: opts.abort.reason })
      }

      // Stamp timestamps on this subprocess provider's trajectory events
      // too, matching the ai_sdk path: the external branch in generate.ts
      // returns before the main path's with_timestamps wrap runs, so it
      // has to happen here instead.
      const trajectory = with_timestamps(opts.trajectory)
      const call_opts = extract_call_opts(opts)
      emit_ignored_options(opts, trajectory)

      const tools_list: ReadonlyArray<Tool> = opts.tools ?? []
      const tool_bridge: ToolBridgeMode = call_opts.tool_bridge ?? 'allowlist_only'
      validate_request(opts.prompt, tools_list, tool_bridge)

      const merged_allowed_tools = merge_allowed_tools(
        call_opts.allowed_tools,
        tools_list.map((t) => t.name),
      )
      record_allowlist_only_drop(tools_list, tool_bridge, trajectory)

      const merged_system = merge_system(
        opts.system ?? extract_system_text(opts.prompt),
        call_opts.append_system_prompt,
      )
      const env = build_env(config, call_opts.env, resolved_auth_mode)
      Object.assign(env, effort_env_for_claude_cli(opts.effort))
      const sandbox_plan = build_sandbox_plan(resolved_binary, config.sandbox)
      const dispatch_chunk = make_dispatch_chunk(opts)

      const { controller, unlink } = link_caller_abort(in_flight, opts.abort)
      const spans = open_spans(
        trajectory,
        opts,
        resolved,
        tools_list.length > 0,
        dispatch_chunk !== undefined,
      )

      const base_args: RunArgs = {
        model_id: resolved.model_id,
        stdin_text: extract_prompt_text(opts.prompt),
        merged_system,
        merged_allowed_tools,
        call_opts,
        compiled_schema: resolve_compiled_schema(opts, call_opts),
        env,
        spawn_cmd: sandbox_plan.spawn_cmd,
        prefix_args: sandbox_plan.prefix_args,
        cwd: config.default_cwd,
        startup_timeout_ms: resolved_startup_timeout,
        stall_timeout_ms: resolved_stall_timeout,
        abort: controller.signal,
        dispatch_chunk,
        trajectory,
      }

      try {
        const first_outcome = await run_cli(spawn_runtime, base_args)
        const { parsed, parsed_content } = await resolve_content(
          spawn_runtime,
          base_args,
          opts,
          first_outcome.parsed,
        )

        const result = assemble_result<T>(parsed, resolved, opts.schema, parsed_content)
        record_provider_costs(trajectory, result.steps)
        close_step_spans(trajectory, spans, result.steps)
        end_generate_span(trajectory, spans.generate, {
          usage: result.usage,
          finish_reason: result.finish_reason,
          model_resolved: result.model_resolved,
        })
        await dispatch_finish(dispatch_chunk, result)

        return result
      } catch (err: unknown) {
        close_spans_on_error(trajectory, spans, err)
        throw err
      } finally {
        unlink()
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

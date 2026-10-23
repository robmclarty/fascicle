/**
 * Rebuild the turns a trajectory captured, and send one of them again.
 *
 * Under `capture: 'turns'` or `'wire'`, each turn's `request_sent` carries a
 * `request`: a call's first turn its settings, its tools, and every message,
 * and a later turn the messages it appended, or its whole array marked
 * `reshaped`. `captured_turns` folds those deltas back into the full request
 * each turn sent, and `replay_turn` sends one through an engine as a single
 * inert turn: no tool runs, no cache is derived, and nothing is captured.
 */

import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import { is_record, json_schema_to_standard } from '#schema'
import type {
  AssistantContentPart,
  CacheSetting,
  EffortLevel,
  Engine,
  GenerateOptions,
  GenerateResult,
  Message,
  Tool,
} from './types.js'

/**
 * A captured call's settings: the provider and model, the resolved effort and
 * cache, the sampling knobs it set, its provider options as the engine
 * defaults and the call merged them, before an adapter's translation, and its
 * schema as JSON Schema.
 */
export type CapturedSettings = {
  readonly provider: string
  readonly model_id: string
  readonly effort: EffortLevel
  readonly cache?: Exclude<CacheSetting, 'off'>
  readonly temperature?: number
  readonly max_tokens?: number
  readonly top_p?: number
  readonly provider_options?: Readonly<Record<string, unknown>>
  readonly schema?: Readonly<Record<string, unknown>>
}

/**
 * A captured tool: its name, its description, and its input schema as JSON
 * Schema (draft 2020-12), absent when the schema couldn't be written as one.
 */
export type CapturedTool = {
  readonly name: string
  readonly description: string
  readonly input_schema?: Readonly<Record<string, unknown>>
}

/**
 * One turn as it was sent: the call it belongs to, its step, the call's
 * settings and tools, the whole message array, system prompts included, and
 * the parts the provider returned when the trajectory holds them.
 */
export type CapturedTurn = {
  readonly call_span_id: string
  readonly step_index: number
  readonly settings: CapturedSettings
  readonly tools: ReadonlyArray<CapturedTool>
  readonly messages: ReadonlyArray<Message>
  readonly response?: ReadonlyArray<AssistantContentPart>
}

/** A request_sent event's fields that the fold reads. */
type SentRequest = {
  readonly step_index: number
  readonly span_id: string | undefined
  readonly request: unknown
}

/** A first turn's request, whole. */
type FirstRequest = {
  readonly settings: CapturedSettings
  readonly tools: ReadonlyArray<CapturedTool>
}

/**
 * True for an array where capture writes messages, which the fold trusts to
 * hold the messages it wrote.
 */
function is_messages(value: unknown): value is ReadonlyArray<Message> {
  return Array.isArray(value)
}

/**
 * True for an array where capture writes a reply's parts, which the fold
 * trusts to hold the parts it wrote.
 */
function is_parts(value: unknown): value is ReadonlyArray<AssistantContentPart> {
  return Array.isArray(value)
}

/**
 * True for a first turn's request: settings that name a provider and a
 * model, a tool list, and a message array.
 */
function is_first_request(value: unknown): value is FirstRequest {
  if (!is_record(value) || !Array.isArray(value['tools']) || !is_messages(value['messages'])) return false
  const settings = value['settings']
  return is_record(settings) && typeof settings['provider'] === 'string' && typeof settings['model_id'] === 'string'
}

/**
 * What one pass over the events gathers: each call's requests, and each
 * step span's reply. A reply is kept only under a span, so a turn without
 * one reads undefined.
 */
type Gathered = {
  readonly calls: Map<string, SentRequest[]>
  readonly responses: Map<string | undefined, ReadonlyArray<AssistantContentPart>>
}

/**
 * Read the events once, keeping each `request_sent` that names its call,
 * grouped by call in the order each call first appears, and each
 * `response_received` whose `content` is a list of parts, by its step span.
 */
function gather(events: Iterable<TrajectoryEvent>): Gathered {
  const gathered: Gathered = { calls: new Map(), responses: new Map() }
  for (const event of events) {
    const { span_id } = event
    if (event.kind === 'response_received' && span_id !== undefined && is_parts(event['content'])) {
      gathered.responses.set(span_id, event['content'])
    }
    const call = event['call_span_id']
    const step_index = event['step_index']
    if (event.kind !== 'request_sent' || typeof call !== 'string' || typeof step_index !== 'number') continue
    const entry: SentRequest = { step_index, span_id, request: event['request'] }
    const sent = gathered.calls.get(call)
    if (sent === undefined) gathered.calls.set(call, [entry])
    else sent.push(entry)
  }
  return gathered
}

/**
 * The whole array a turn sent: its own when its request holds one (a first
 * turn, or a reshaped one), and otherwise the array rebuilt at the step just
 * before it with this turn's `appended` added. Undefined when the request is
 * missing or unreadable, or when the step before it wasn't rebuilt.
 */
function rebuilt_messages(
  sent: SentRequest,
  previous: { readonly step_index: number; readonly messages: ReadonlyArray<Message> } | undefined,
): ReadonlyArray<Message> | undefined {
  const { request } = sent
  if (!is_record(request)) return undefined
  if (is_messages(request['messages'])) return request['messages']
  const appended = request['appended']
  if (!is_messages(appended) || previous?.step_index !== sent.step_index - 1) return undefined
  return [...previous.messages, ...appended]
}

/**
 * Fold one call's requests, in step order, into the turns it sent. A call
 * whose first turn is missing or unreadable yields nothing, since its
 * settings and tools went with it, and a turn that can't be rebuilt is left
 * out until a whole array picks the call up again.
 */
function fold_call(
  call_span_id: string,
  sent: ReadonlyArray<SentRequest>,
  responses: Gathered['responses'],
): CapturedTurn[] {
  const by_step = sent.toSorted((a, b) => a.step_index - b.step_index)
  const first = by_step.find((step) => step.step_index === 0)
  if (first === undefined || !is_first_request(first.request)) return []
  const { settings, tools } = first.request
  const turns: CapturedTurn[] = []
  let previous: { step_index: number; messages: ReadonlyArray<Message> } | undefined
  for (const step of by_step) {
    const messages = rebuilt_messages(step, previous)
    previous = messages === undefined ? undefined : { step_index: step.step_index, messages }
    if (messages === undefined) continue
    const response = responses.get(step.span_id)
    turns.push({
      call_span_id,
      step_index: step.step_index,
      settings,
      tools,
      messages,
      ...(response !== undefined ? { response } : {}),
    })
  }
  return turns
}

/**
 * Rebuild every captured turn in a trajectory's events, in any order the
 * events arrive. Each call's turns are folded by `call_span_id` and ordered
 * by `step_index`, a delta is applied only on top of the turn at the step
 * just before it, and a turn's `response` is the `response_received.content`
 * that shares its step span. A turn whose request is missing or unreadable
 * (absent, `null`, or a string a redactor returned) is left out, and the call
 * picks up again at its next whole array. A call whose first turn is missing,
 * as in a truncated log, is left out whole. Calls come out in the order each
 * first appears in the events.
 */
export function captured_turns(events: Iterable<TrajectoryEvent>): CapturedTurn[] {
  const { calls, responses } = gather(events)
  return [...calls].flatMap(([call_span_id, sent]) => fold_call(call_span_id, sent, responses))
}

/**
 * A captured tool rebuilt for a replay: its name, description, and schema,
 * with an `execute` that throws, so a replay can never act on the world. A
 * tool whose schema wasn't captured takes any object.
 */
function inert_tool(tool: CapturedTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: json_schema_to_standard(tool.input_schema ?? { type: 'object' }),
    execute: () => {
      throw new Error(`replay_turn never runs a tool: the model called '${tool.name}'`)
    },
  }
}

/**
 * Send one captured turn again, as one turn that can't act: the turn's
 * messages, settings, and tools through `engine.generate` with
 * `max_steps: 1`, `cache: 'off'`, `capture: 'off'`, and `system: ''`, so the
 * engine's default system prompt doesn't add a second one. The captured
 * schema stays behind, so the reply comes back raw. Each tool is rebuilt
 * with an `execute` that throws, and a model that calls one comes back with
 * the call listed and unexecuted (`finish_reason: 'max_steps'`). The
 * captured `provider_options` go as they were, a raw `cache_control`
 * included, and the replaying engine's defaults fill whatever the turn left
 * unset. `edit` changes the turn before it goes, and `provider` and `model`
 * send it elsewhere. A replay is inert only on the `ai_sdk` and native
 * transports, since an external provider runs its own loop and tools.
 */
export async function replay_turn(
  engine: Engine,
  turn: CapturedTurn,
  options: {
    /** Change the turn before it goes (drop a raw `cache_control`, reword a message). */
    readonly edit?: (turn: CapturedTurn) => CapturedTurn
    /** Send it to this provider instead of the one it was captured on. */
    readonly provider?: string
    /** Send it to this model instead of the one it was captured on. */
    readonly model?: string
    /** Where the replay records its own events. */
    readonly trajectory?: TrajectoryLogger
  } = {},
): Promise<GenerateResult> {
  const sent = options.edit === undefined ? turn : options.edit(turn)
  const { settings } = sent
  const opts: GenerateOptions = {
    provider: options.provider ?? settings.provider,
    model: options.model ?? settings.model_id,
    prompt: [...sent.messages],
    system: '',
    tools: sent.tools.map(inert_tool),
    effort: settings.effort,
    max_steps: 1,
    cache: 'off',
    capture: 'off',
    ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
    ...(settings.max_tokens !== undefined ? { max_tokens: settings.max_tokens } : {}),
    ...(settings.top_p !== undefined ? { top_p: settings.top_p } : {}),
    ...(settings.provider_options !== undefined ? { provider_options: { ...settings.provider_options } } : {}),
    ...(options.trajectory !== undefined ? { trajectory: options.trajectory } : {}),
  }
  return await engine.generate(opts)
}

/**
 * The turn inspector's reading of captured turns.
 *
 * Under `capture`, each model turn's `request_sent` carries a `request`: a
 * call's first turn its settings, its tools, and every message, and a later
 * turn the messages it appended, or its whole array marked `reshaped`. This
 * module folds those deltas back into the request each turn sent, the way
 * the engine's `captured_turns` does, joins each turn to the reply and the
 * usage its `response_received` recorded, and hangs each call's turns on the
 * structure node whose step made the call. The event shapes are the ones in
 * `docs/concepts.md`'s What Gets Recorded, the contract both readers follow.
 *
 * Nothing is imported from the engine, for the reason the fold gives
 * (`reduce.ts`): engine code must never reach the compiled bundle. So the
 * reading is local and permissive. A turn whose request is missing or
 * unreadable (dropped by a redactor, or cut off in a truncated log) is left
 * out until a whole array picks its call up again, and a call whose first
 * turn is missing is left out whole, since its settings and tools went with
 * it. The drawer then shows only what the log can prove was sent.
 *
 * Every string the drawer shows is decided here too: the turn rows, the
 * request and response laid out as labelled blocks, where long content
 * folds, and the badge's geometry, so `turns.tsx` stays markup.
 */

import type { Point } from './layout.js'
import type { SpanInfo } from './reduce.js'

type EventRecord = Readonly<Record<string, unknown>>

/**
 * A turn's usage, as its `response_received` reported it, a count the event
 * left out reading null. `cache_hit_ratio` rides only on a turn that read or
 * wrote the prompt cache.
 */
export type TurnUsage = {
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly cached_input_tokens: number | null
  readonly cache_write_tokens: number | null
  readonly cache_hit_ratio: number | null
}

/**
 * One captured turn as the drawer reads it: the `CapturedTurn` fields
 * (`call_span_id`, `step_index`, `settings`, `tools`, `messages`, and the
 * `response` when the log holds it), plus the usage its reply reported,
 * which the drawer shows and the copied turn leaves out.
 */
export type ViewerTurn = {
  readonly call_span_id: string
  readonly step_index: number
  readonly settings: EventRecord
  readonly tools: ReadonlyArray<unknown>
  readonly messages: ReadonlyArray<unknown>
  readonly response?: ReadonlyArray<unknown>
  readonly usage: TurnUsage | null
}

/** A `request_sent` the fold reads: its step, its step span, and its request. */
type SentRequest = {
  readonly step_index: number
  readonly span_id: string | null
  readonly request: unknown
}

/** What a step span's `response_received` holds for the drawer. */
type Reply = {
  readonly content: ReadonlyArray<unknown> | null
  readonly usage: TurnUsage
}

/** True when the value is a plain record: a bag of fields, not an array. */
function is_record(value: unknown): value is EventRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a finite number field, null when absent or another type. */
function num(record: EventRecord, key: string): number | null {
  const field = record[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : null
}

/** Read a string field, null when absent or another type. */
function str(record: EventRecord, key: string): string | null {
  const field = record[key]
  return typeof field === 'string' ? field : null
}

/** A `response_received` read for its reply parts and its usage. */
function read_reply(event: EventRecord): Reply {
  const content = event['content']
  return {
    content: Array.isArray(content) ? content : null,
    usage: {
      input_tokens: num(event, 'input_tokens'),
      output_tokens: num(event, 'output_tokens'),
      cached_input_tokens: num(event, 'cached_input_tokens'),
      cache_write_tokens: num(event, 'cache_write_tokens'),
      cache_hit_ratio: num(event, 'cache_hit_ratio'),
    },
  }
}

/** A `request_sent` that names its call. */
type CallRequest = SentRequest & { readonly call: string }

/** What one pass over the events gathers: each call's requests, and each step span's reply. */
type Gathered = {
  readonly calls: ReadonlyMap<string, ReadonlyArray<CallRequest>>
  readonly replies: ReadonlyMap<string | null, Reply>
}

/**
 * Read the events once, keeping each `request_sent` that names its call and
 * a step, grouped by call in the order each call first appears, and each
 * `response_received` that names its step span.
 */
function gather(events: Iterable<unknown>): Gathered {
  const requests: CallRequest[] = []
  const replies = new Map<string | null, Reply>()
  for (const event of events) {
    if (!is_record(event)) continue
    const span_id = str(event, 'span_id')
    const call = str(event, 'call_span_id')
    const step_index = num(event, 'step_index')
    if (event['kind'] === 'response_received' && span_id !== null) replies.set(span_id, read_reply(event))
    if (event['kind'] === 'request_sent' && call !== null && step_index !== null) {
      requests.push({ call, step_index, span_id, request: event['request'] })
    }
  }
  return { calls: Map.groupBy(requests, (sent) => sent.call), replies }
}

/** A first turn's request: settings naming a provider and a model, tools, and messages. */
type FirstRequest = {
  readonly settings: EventRecord
  readonly tools: ReadonlyArray<unknown>
}

/** True for a first turn's whole request, the one that carries the call's settings and tools. */
function is_first_request(value: unknown): value is FirstRequest & EventRecord {
  if (!is_record(value) || !Array.isArray(value['tools']) || !Array.isArray(value['messages'])) return false
  const settings = value['settings']
  return is_record(settings) && str(settings, 'provider') !== null && str(settings, 'model_id') !== null
}

/** The array a step was rebuilt to, which the step after it can extend. */
type Rebuilt = {
  readonly step_index: number
  readonly messages: ReadonlyArray<unknown>
}

/**
 * The whole array a turn sent: its own when its request holds one (a first
 * turn, or a reshaped one), and otherwise the array rebuilt at the step just
 * before it with this turn's `appended` added. Null when the request is
 * missing or unreadable, or when the step before it wasn't rebuilt.
 */
function rebuilt_messages(sent: SentRequest, previous: Rebuilt | null): ReadonlyArray<unknown> | null {
  const { request } = sent
  if (!is_record(request)) return null
  const whole = request['messages']
  if (Array.isArray(whole)) return whole
  const appended = request['appended']
  if (!Array.isArray(appended) || previous?.step_index !== sent.step_index - 1) return null
  return [...previous.messages, ...appended]
}

/** One rebuilt turn, with the call's settings and tools and its step span's reply. */
function joined_turn(
  call: FirstRequest & { readonly call_span_id: string },
  rebuilt: Rebuilt,
  reply: Reply | undefined,
): ViewerTurn {
  const response = reply?.content ?? null
  return {
    call_span_id: call.call_span_id,
    step_index: rebuilt.step_index,
    settings: call.settings,
    tools: call.tools,
    messages: rebuilt.messages,
    ...(response === null ? {} : { response }),
    usage: reply?.usage ?? null,
  }
}

/**
 * Fold one call's requests, in step order, into the turns it sent. The
 * lowest step has to be step 0 with a whole first request, since the call's
 * settings and tools ride only on that one.
 */
function fold_call(call_span_id: string, sent: ReadonlyArray<SentRequest>, replies: Gathered['replies']): ViewerTurn[] {
  const steps = sent.toSorted((a, b) => a.step_index - b.step_index)
  const head = steps[0]
  if (head?.step_index !== 0 || !is_first_request(head.request)) return []
  const call = { call_span_id, settings: head.request.settings, tools: head.request.tools }
  const turns: ViewerTurn[] = []
  let last: Rebuilt | null = null
  for (const step of steps) {
    const messages = rebuilt_messages(step, last)
    last = messages === null ? null : { step_index: step.step_index, messages }
    if (last !== null) turns.push(joined_turn(call, last, replies.get(step.span_id)))
  }
  return turns
}

/**
 * Rebuild every captured turn in an event log, in whatever order the events
 * arrived. Each call's turns are folded by `call_span_id` and ordered by
 * `step_index`, a delta applies only on top of the turn at the step just
 * before it, and a turn's reply is the `response_received` that shares its
 * step span. Calls come out in the order each first appears.
 */
export function read_turns(events: Iterable<unknown>): ReadonlyArray<ViewerTurn> {
  const { calls, replies } = gather(events)
  return [...calls].flatMap(([call_span_id, sent]) => fold_call(call_span_id, sent, replies))
}

/**
 * The structure node a call belongs to: the nearest span up the chain from
 * its `engine.generate` span that joined a node, which is the step that made
 * the call. Null when no span in the chain joined one. The hop cap keeps a
 * malformed parent cycle from hanging the walk.
 */
function call_node(spans: ReadonlyMap<string, SpanInfo>, call_span_id: string): string | null {
  let hops = spans.size
  let current = spans.get(call_span_id)
  while (current !== undefined && hops > 0) {
    hops -= 1
    if (current.node_id !== null) return current.node_id
    if (current.parent_span_id === null) return null
    current = spans.get(current.parent_span_id)
  }
  return null
}

/**
 * Hang each turn on the node whose step made its call, keeping the turns'
 * order. A call whose span the fold never saw, or whose chain joins no node,
 * has nowhere to hang and is left out.
 */
export function turns_by_node(
  turns: ReadonlyArray<ViewerTurn>,
  spans: ReadonlyMap<string, SpanInfo>,
): ReadonlyMap<string, ReadonlyArray<ViewerTurn>> {
  const by_node = new Map<string, ViewerTurn[]>()
  for (const turn of turns) {
    const node = call_node(spans, turn.call_span_id)
    if (node === null) continue
    const list = by_node.get(node)
    if (list === undefined) by_node.set(node, [turn])
    else list.push(turn)
  }
  return by_node
}

/**
 * The turn as JSON in the `CapturedTurn` shape that `replay_turn` takes:
 * the drawer's usage stays behind, and a turn without a captured reply has
 * no `response`.
 */
export function captured_turn_json(turn: ViewerTurn): string {
  const captured = {
    call_span_id: turn.call_span_id,
    step_index: turn.step_index,
    settings: turn.settings,
    tools: turn.tools,
    messages: turn.messages,
    // JSON leaves the key out when the log held no reply.
    response: turn.response,
  }
  return JSON.stringify(captured, null, 2)
}

/** A count with its thousands grouped, as the drawer prints tokens. */
function grouped(count: number): string {
  return count.toLocaleString('en-US')
}

/** The badge's word: `1 TURN`, `3 TURNS`. */
export function turns_label(count: number): string {
  return count === 1 ? '1 TURN' : `${count} TURNS`
}

/** One row of the drawer's turn list: the step, its tokens, and its cache hit when it had traffic. */
export type TurnRow = {
  readonly step: string
  readonly tokens: string
  readonly cache: string | null
}

/**
 * The row for one turn. Tokens read `2,412 IN · 96 OUT`, a side the reply
 * didn't report dropping out, and `NO USAGE` when the log holds no reply.
 * The cache hit is the turn's own ratio as a whole percent, absent on a turn
 * that neither read nor wrote the cache.
 */
export function turn_row(turn: ViewerTurn): TurnRow {
  const usage = turn.usage
  const sides: string[] = []
  if (usage !== null && usage.input_tokens !== null) sides.push(`${grouped(usage.input_tokens)} IN`)
  if (usage !== null && usage.output_tokens !== null) sides.push(`${grouped(usage.output_tokens)} OUT`)
  const ratio = usage === null ? null : usage.cache_hit_ratio
  return {
    step: `STEP ${turn.step_index}`,
    tokens: sides.length === 0 ? 'NO USAGE' : sides.join(' · '),
    cache: ratio === null ? null : `CACHE ${Math.round(ratio * 100)}%`,
  }
}

/**
 * The drawer's heading under the node's name: the turn count in the meta
 * register, then the provider and the model as they were sent, which stay
 * verbatim because the engine sends a model id exactly as written.
 */
export type DrawerMeta = {
  readonly count: string
  readonly model: string | null
}

/** The heading for a node's turns, the model read off the first turn's settings. */
export function drawer_meta(turns: ReadonlyArray<ViewerTurn>): DrawerMeta {
  const settings = turns[0]?.settings
  const named = settings === undefined ? [] : [str(settings, 'provider'), str(settings, 'model_id')]
  const model = named.filter((part) => part !== null).join(' · ')
  return { count: turns_label(turns.length), model: model === '' ? null : model }
}

/**
 * The turn the drawer shows: the one picked, held inside the list as it
 * grows or shrinks, and the newest until one is picked, since the newest
 * turn carries the whole conversation so far.
 */
export function selected_index(picked: number | null, count: number): number {
  const last = Math.max(0, count - 1)
  return picked === null ? last : Math.min(Math.max(0, picked), last)
}

/** How the last copy went, and for which turn. */
export type CopyState = {
  readonly index: number
  readonly ok: boolean
}

/** The copy control's word: what happened to the shown turn's last copy, or the offer to copy it. */
export function copy_label(state: CopyState | null, index: number): string {
  if (state === null || state.index !== index) return 'COPY TURN'
  return state.ok ? 'COPIED' : 'COPY FAILED'
}

/**
 * One piece of a message or a reply. `text` reads as prose and `code` as
 * preformatted JSON. `label` names a part that isn't plain text (a call,
 * reasoning, an image, a block only its provider reads), and `name` is the
 * identifier beside it, verbatim: the tool called, or the block's own type.
 */
export type TurnBlock = {
  readonly label: string | null
  readonly name: string | null
  readonly format: 'text' | 'code'
  readonly body: string
}

/**
 * One message of a request: its role, its label and the tool it answers,
 * whether it carries `is_error`, and its blocks.
 */
export type MessageView = {
  readonly role: string
  readonly label: string
  readonly name: string | null
  readonly error: boolean
  readonly blocks: ReadonlyArray<TurnBlock>
}

/**
 * A selected turn's request: the system prompts that lead it, its tool
 * names on one line (empty when it had none), and the rest of its messages
 * by role.
 */
export type RequestView = {
  readonly system: ReadonlyArray<string>
  readonly tools: string
  readonly messages: ReadonlyArray<MessageView>
}

/** A plain block with no label. */
function plain(format: TurnBlock['format'], body: string): TurnBlock {
  return { label: null, name: null, format, body }
}

/** A value as indented JSON, or its plain text when JSON can't hold it. */
function as_json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * A tool result's content: JSON text (the engine's `{"error": "…"}`, or a
 * tool's object output) indented as code, and anything else as prose.
 */
function content_block(text: string): TurnBlock {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) return plain('code', as_json(parsed))
  } catch {
    // Not JSON: the text reads as it was sent.
  }
  return plain('text', text)
}

/**
 * An image part's line: its media type and the size of its bytes, which
 * capture holds as base64, so four characters carry three bytes.
 */
function image_body(part: EventRecord): string {
  const media = str(part, 'media_type') ?? 'image'
  const image = str(part, 'image')
  if (image === null) return media
  return `${media} · ${grouped(Math.floor((image.length * 3) / 4))} bytes`
}

/** The type of the block an opaque part carries, as its provider wrote it, when it says. */
function opaque_type(part: EventRecord): string | null {
  const options = part['provider_options']
  if (!is_record(options)) return null
  for (const value of Object.values(options)) {
    const block = is_record(value) ? value['block'] : undefined
    const type = is_record(block) ? str(block, 'type') : null
    if (type !== null) return type
  }
  return null
}

/**
 * One content part as a block: text as prose, a call as its tool over its
 * input, reasoning as its text (or a note that the provider kept it hidden),
 * an image as its type and size, and an opaque part or one this build
 * doesn't know as its JSON.
 */
function part_block(part: unknown): TurnBlock {
  if (!is_record(part)) return plain('code', as_json(part))
  switch (part['type']) {
    case 'text':
      return plain('text', str(part, 'text') ?? '')
    case 'tool_call':
      return { label: 'CALL', name: str(part, 'name'), format: 'code', body: as_json(part['input']) }
    case 'reasoning': {
      const text = str(part, 'text') ?? ''
      return { label: 'REASONING', name: null, format: 'text', body: text === '' ? '(hidden by the provider)' : text }
    }
    case 'image':
      return { label: 'IMAGE', name: null, format: 'text', body: image_body(part) }
    case 'opaque':
      return { label: 'OPAQUE', name: opaque_type(part), format: 'code', body: as_json(part['provider_options']) }
    default:
      return plain('code', as_json(part))
  }
}

/** A message's content as blocks: a string as one, a list of parts as one per part. */
function content_blocks(content: unknown): ReadonlyArray<TurnBlock> {
  if (typeof content === 'string') return [plain('text', content)]
  if (Array.isArray(content)) return content.map(part_block)
  return [plain('code', as_json(content))]
}

/**
 * One message as the drawer lays it out. A tool message names the tool it
 * answers and reads its content as JSON where it can; its `is_error` is the
 * one flag the drawer marks. A message this build can't read shows as JSON.
 */
function message_view(message: unknown): MessageView {
  if (!is_record(message)) {
    return { role: 'unknown', label: 'MESSAGE', name: null, error: false, blocks: [plain('code', as_json(message))] }
  }
  const role = str(message, 'role') ?? 'unknown'
  const content = message['content']
  if (role !== 'tool') {
    return { role, label: role.toUpperCase(), name: null, error: false, blocks: content_blocks(content) }
  }
  return {
    role,
    label: 'TOOL',
    name: str(message, 'name'),
    error: message['is_error'] === true,
    blocks: typeof content === 'string' ? [content_block(content)] : content_blocks(content),
  }
}

/** True for a system message whose content is its prompt's text. */
function is_system_prompt(message: unknown): message is EventRecord & { readonly content: string } {
  return is_record(message) && message['role'] === 'system' && typeof message['content'] === 'string'
}

/** A captured tool's name, when it has one. */
function tool_name(tool: unknown): ReadonlyArray<string> {
  const name = is_record(tool) ? str(tool, 'name') : null
  return name === null ? [] : [name]
}

/**
 * A turn's request laid out: the system prompts that lead its messages,
 * each tool's name, and every message after them by role. A system message
 * further down, which the engine never writes, stays in the list where it
 * was sent.
 */
export function request_view(turn: ViewerTurn): RequestView {
  const system: string[] = []
  for (const message of turn.messages) {
    if (!is_system_prompt(message)) break
    system.push(message.content)
  }
  return {
    system,
    tools: turn.tools.flatMap(tool_name).join(' · '),
    messages: turn.messages.slice(system.length).map(message_view),
  }
}

/** A turn's reply as blocks, in the order the provider sent them, or null when the log holds none. */
export function response_view(turn: ViewerTurn): ReadonlyArray<TurnBlock> | null {
  return turn.response === undefined ? null : turn.response.map(part_block)
}

/** A text with more lines than this folds. */
export const FOLD_LINES = 8

/** A folded text keeps this many lines, so a fold always hides at least three. */
export const KEEP_LINES = 5

/** A text longer than this folds, however few its lines. */
export const FOLD_CHARS = 720

/** A text folded by length keeps this many characters. */
export const KEEP_CHARS = 480

/** A text cut for the drawer: the part it shows, and the fold control's label, or null when it shows whole. */
export type FoldedText = {
  readonly head: string
  readonly more: string | null
}

/**
 * Fold long content. A text of many lines keeps its first lines and counts
 * the rest (`+4 LINES`), unless those lines are long themselves; a text that
 * is long without many lines (minified JSON, one long paragraph) keeps its
 * first characters and counts the rest (`+1,204 CHARS`).
 */
export function fold_text(text: string): FoldedText {
  const lines = text.split('\n')
  if (lines.length > FOLD_LINES) {
    const head = lines.slice(0, KEEP_LINES).join('\n')
    if (head.length <= KEEP_CHARS) return { head, more: `+${lines.length - KEEP_LINES} LINES` }
  } else if (text.length <= FOLD_CHARS) {
    return { head: text, more: null }
  }
  return { head: text.slice(0, KEEP_CHARS), more: `+${grouped(text.length - KEEP_CHARS)} CHARS` }
}

/** The drawer's widest, at a wide window. */
export const DRAWER_MAX_WIDTH = 820

/** The drawer's share of a narrower window. */
export const DRAWER_SHARE = 0.56

/**
 * The drawer's width in a window this wide. The stage fits the flow into
 * what's left beside it, so a node the drawer would cover stays in view and
 * its badge stays in reach.
 */
export function drawer_width(viewport_width: number): number {
  return Math.round(Math.min(DRAWER_MAX_WIDTH, viewport_width * DRAWER_SHARE))
}

/** What the open drawer shows: the node's name, its turns, and the drawer's width. */
export type DrawerView = {
  readonly name: string
  readonly turns: ReadonlyArray<ViewerTurn>
  readonly width: number
}

/**
 * The drawer for the node that's open, or null when none is, or when the
 * open node has no turns in the folded prefix (a canvas scrubbed back before
 * them). The name is the node's label as its puck shows it.
 */
export function drawer_view(
  open: string | null,
  by_node: ReadonlyMap<string, ReadonlyArray<ViewerTurn>>,
  labels: ReadonlyArray<{ readonly id: string; readonly label: string }>,
  viewport_width: number,
): DrawerView | null {
  if (open === null) return null
  const turns = by_node.get(open)
  if (turns === undefined) return null
  const name = labels.find((glyph) => glyph.id === open)?.label ?? open
  return { name, turns, width: drawer_width(viewport_width) }
}

/**
 * The turns badge under a node's meta line: its box, centered on the meta
 * anchor, and its text, which the renderer fits to `text_length` so the box
 * and the word agree whatever the font's metrics.
 */
export type TurnsBadge = {
  readonly label: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly text_x: number
  readonly text_y: number
  readonly text_length: number
}

/** Below the meta baseline to the badge's top edge, past the meta's descenders. */
const BADGE_DROP = 6

const BADGE_HEIGHT = 15

/** The mono word's advance: 0.6em a character, tracked 0.14em, at 9.5px. */
const BADGE_ADVANCE = 9.5 * 0.74

const BADGE_PAD = 7

/** The baseline sits this far below the box's top, which centers the caps. */
const BADGE_BASELINE = 10.5

/**
 * Place the badge for a node's turns, centered under its meta line. The
 * text runs the box's width less its padding, with the last character's
 * tracking left out, so the word sits centered in the box.
 */
export function turns_badge(meta_anchor: Point, count: number): TurnsBadge {
  const label = turns_label(count)
  const text_length = label.length * BADGE_ADVANCE - 9.5 * 0.14
  const width = text_length + 2 * BADGE_PAD
  const y = meta_anchor.y + BADGE_DROP
  return {
    label,
    x: meta_anchor.x - width / 2,
    y,
    width,
    height: BADGE_HEIGHT,
    text_x: meta_anchor.x - text_length / 2,
    text_y: y + BADGE_BASELINE,
    text_length,
  }
}

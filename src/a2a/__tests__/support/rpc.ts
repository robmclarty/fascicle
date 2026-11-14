/**
 * Helpers for the a2a tests: JSON-RPC requests against an agent's `fetch`,
 * with plain `Request` objects and no sockets.
 */

import { randomUUID } from 'node:crypto'
import { is_record } from '#schema'
import type { A2aAgent } from '../../types.js'

type Json = Record<string, unknown>

export type RpcOptions = {
  readonly headers?: Record<string, string>
  readonly path?: string
}

export type MessageOptions = {
  readonly task_id?: string
  readonly context_id?: string
  readonly data?: unknown
}

const BASE = 'http://agent.test'

let next_id = 0

/**
 * A user message in the protocol's JSON, with a text part and, when `data`
 * is given, a data part after it.
 */
export function user_message(text: string, options: MessageOptions = {}): Json {
  return {
    messageId: randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text }, ...(options.data === undefined ? [] : [{ data: options.data }])],
    ...(options.task_id === undefined ? {} : { taskId: options.task_id }),
    ...(options.context_id === undefined ? {} : { contextId: options.context_id }),
  }
}

/**
 * The `Request` for one JSON-RPC call, speaking A2A 1.0 unless a header
 * says otherwise.
 */
export function rpc_request(method: string, params: Json, options: RpcOptions = {}): Request {
  next_id += 1
  return new Request(`${BASE}${options.path ?? '/'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...options.headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: next_id, method, params }),
  })
}

/**
 * A value as a JSON object, or an empty one when it isn't one.
 */
function record(value: unknown): Json {
  return is_record(value) ? value : {}
}

/**
 * A value as a list of JSON objects, leaving out whatever isn't one.
 */
function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(is_record) : []
}

/**
 * A field of a JSON-RPC response, when it holds an object.
 */
function field(body: unknown, name: string): Json | undefined {
  const value = record(body)[name]
  return is_record(value) ? value : undefined
}

/**
 * Call a method that answers with one JSON-RPC response.
 */
export async function call(
  agent: A2aAgent,
  method: string,
  params: Json,
  options: RpcOptions = {},
): Promise<{ readonly status: number; readonly result: Json | undefined; readonly error: Json | undefined }> {
  const response = await agent.fetch(rpc_request(method, params, options))
  const body: unknown = await response.json()
  return { status: response.status, result: field(body, 'result'), error: field(body, 'error') }
}

/**
 * The task a `SendMessage` answered with.
 */
export function task_in(answer: { readonly result: Json | undefined; readonly error: Json | undefined }): Json {
  const task = answer.result?.['task']
  if (!is_record(task)) throw new Error(`the call answered no task: ${JSON.stringify(answer.error)}`)
  return task
}

/**
 * Send a message and resolve the task it answers with.
 */
export async function send(agent: A2aAgent, text: string, options: MessageOptions & RpcOptions = {}): Promise<Json> {
  return task_in(await call(agent, 'SendMessage', { message: user_message(text, options) }, options))
}

/**
 * Read a task back.
 */
export async function get_task(agent: A2aAgent, id: string, options: RpcOptions = {}): Promise<Json> {
  const { result, error } = await call(agent, 'GetTask', { id }, options)
  if (result === undefined) throw new Error(`GetTask failed: ${JSON.stringify(error)}`)
  return result
}

/**
 * Call a streaming method and collect the result of every frame, in order.
 */
export async function stream(
  agent: A2aAgent,
  method: string,
  params: Json,
  options: RpcOptions = {},
): Promise<Json[]> {
  return frames_of(await agent.fetch(rpc_request(method, params, options)), method)
}

/**
 * Read a streamed response to its end and collect the result of every
 * frame, in order.
 */
export async function frames_of(response: Response, method = 'the call'): Promise<Json[]> {
  if (!(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    throw new Error(`${method} didn't stream: ${await response.text()}`)
  }
  const frames: Json[] = []
  for (const block of (await response.text()).split('\n\n')) {
    const line = block.split('\n').find((text) => text.startsWith('data: '))
    if (line === undefined) continue
    const frame: unknown = JSON.parse(line.slice('data: '.length))
    const result = field(frame, 'result')
    if (result !== undefined) frames.push(result)
  }
  return frames
}

/**
 * The state of a task in the protocol's JSON.
 */
export function state_of(task: Json): unknown {
  return record(task['status'])['state']
}

/**
 * The parts of an artifact or a message, or none when it's missing.
 */
export function parts_in(holder: unknown): Json[] {
  return records(record(holder)['parts'])
}

/**
 * The text of every text part in a list of parts, joined.
 */
export function parts_text(parts: unknown): string {
  return records(parts)
    .map((part) => (typeof part['text'] === 'string' ? part['text'] : ''))
    .join('')
}

/**
 * The text of a task's artifacts, one entry for each artifact.
 */
export function artifact_texts(task: Json): string[] {
  return records(task['artifacts']).map((artifact) => parts_text(artifact['parts']))
}

/**
 * The text of a task's status message.
 */
export function status_text(task: Json): string {
  return parts_text(record(record(task['status'])['message'])['parts'])
}

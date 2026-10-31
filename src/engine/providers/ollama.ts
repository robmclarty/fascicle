/**
 * Ollama local-provider adapter.
 *
 * Dispatches on `transport`: the default 'ai_sdk' backend wraps
 * ai-sdk-ollama as an optional peer; 'native' talks to the daemon's own
 * /api/chat endpoint over its NDJSON wire. The OpenAI-compatible tail is
 * served instead by pointing the `openai` provider's base_url at Ollama's
 * /v1. No API key; base_url is the daemon root and is required on both
 * transports. Ollama does not support reasoning effort: the ai_sdk branch
 * drops the field and records `effort_ignored`; the native branch ignores it
 * entirely (thinking is opt-in via provider_options.ollama.think). Ollama
 * does not emit the image_input capability.
 */

import type { EffortLevel, ProviderInit } from '../types.js'
import {
  load_optional_peer,
  missing_config_error,
  normalize_local_usage,
  resolve_transport,
  type AiSdkProviderAdapter,
  type EffortTranslation,
  type ProviderAdapter,
  type ProviderCapability,
} from './types.js'
import { create_ollama_native_adapter } from './ollama_native.js'

type OllamaSdk = {
  createOllama: (config: { baseURL?: string }) => (model_id: string) => unknown
}

/**
 * Give a failure that `ai-sdk-ollama` raised the `url` and `statusCode` that
 * the AI SDK's own errors carry. The package wraps the `ollama` client's
 * error, which keeps the status as `status_code` on the `cause`, and names
 * no URL, so without these the engine can't retry a 429 or a 5xx, and can't
 * say which address didn't answer.
 */
function add_request_facts(err: unknown, url: string): void {
  if (err === null || typeof err !== 'object') return
  const cause: unknown = Reflect.get(err, 'cause')
  const status: unknown =
    cause !== null && typeof cause === 'object' ? Reflect.get(cause, 'status_code') : undefined
  Object.assign(err, typeof status === 'number' ? { url, statusCode: status } : { url })
}

/**
 * The package's model, with a `doStream` whose failures carry the request's
 * URL and status (see add_request_facts), and everything else read through
 * to the model itself. Only `doStream` is wrapped, since every engine turn
 * streams, and only its own rejection, which is a failure before the stream
 * began. A connection that drops mid-stream reaches the stream as it is, so
 * it's never named as a server that couldn't be reached.
 */
export function with_request_facts(model: unknown, url: string): unknown {
  if (model === null || typeof model !== 'object') return model
  const do_stream: unknown = Reflect.get(model, 'doStream')
  if (typeof do_stream !== 'function') return model
  const stream = async (...args: unknown[]): Promise<unknown> => {
    try {
      return await Reflect.apply(do_stream, model, args)
    } catch (err: unknown) {
      add_request_facts(err, url)
      throw err
    }
  }
  return Object.create(model, { doStream: { value: stream } })
}

/**
 * Ollama has no reasoning-effort control on this transport, so every
 * non-`none` level is reported as ignored and no provider option is emitted.
 */
export function translate_ollama_effort(effort: EffortLevel): EffortTranslation {
  const ignored = effort !== 'none'
  return { provider_options: {}, effort_ignored: ignored }
}

/**
 * Normalize Ollama's raw usage payload into UsageTotals: the shared
 * local-backend mapper, since Ollama never reports cache or reasoning
 * tokens.
 */
export const normalize_ollama_usage = normalize_local_usage

const SUPPORTED: ReadonlySet<ProviderCapability> = new Set([
  'text',
  'tools',
  'schema',
  'streaming',
  // Ollama supports native constrained decoding via its `format` field, which
  // ai-sdk-ollama maps from the AI SDK responseFormat. The text-extraction
  // path is unreliable for local models, so prefer the constrained decode.
  'structured_output',
])

/**
 * Build the Ollama adapter, picking the native or ai_sdk backend per the
 * resolved `transport`.
 */
export const create_ollama_adapter = (init: ProviderInit): ProviderAdapter => {
  if (resolve_transport(init, 'ollama') === 'native') {
    return create_ollama_native_adapter(init)
  }
  return create_ollama_ai_sdk_adapter(init)
}

/**
 * Build the Ollama ai_sdk adapter: validates the required base_url and
 * lazily loads ai-sdk-ollama to build models, whose failures before a stream
 * begins carry the chat URL and the status (see with_request_facts).
 */
const create_ollama_ai_sdk_adapter = (init: ProviderInit): AiSdkProviderAdapter => {
  const base_url = typeof init.base_url === 'string' ? init.base_url : ''
  if (base_url.length === 0) {
    throw missing_config_error('ollama', 'base_url', 'http://localhost:11434')
  }
  // Where the ollama client posts a chat, which is also the URL the native
  // transport names, so a failure reads the same on both.
  const chat_url = `${base_url.replace(/\/+$/, '')}/api/chat`

  return {
    kind: 'ai_sdk',
    name: 'ollama',
    async build_model(model_id: string): Promise<unknown> {
      const sdk = await load_optional_peer<OllamaSdk>('ai-sdk-ollama')
      const provider = sdk.createOllama({ baseURL: base_url })
      return with_request_facts(provider(model_id), chat_url)
    },
    translate_effort: translate_ollama_effort,
    normalize_usage: normalize_ollama_usage,
    supports: (capability) => SUPPORTED.has(capability),
  }
}

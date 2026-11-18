/**
 * Inbound MCP sampling: answer a server's `sampling/createMessage` request
 * with a completion from a Fascicle engine.
 *
 * Sampling runs the other way from a tool call. The server asks and the
 * client spends the tokens, so everything here is about what a remote server
 * may ask for: one fixed model, a cap on output, text and images only, and no
 * tools.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type {
  CreateMessageRequest,
  CreateMessageResult,
  SamplingMessage,
} from '@modelcontextprotocol/sdk/types.js'
import type { TrajectoryLogger } from '#core'
import type { AssistantContentPart, Engine, Message, UserContentPart } from '#engine'
import { mcp_error } from './errors.js'
import type { McpClientSdk } from './sdk_loader.js'

// JSON-RPC's "invalid params", for a request this client declines to map.
const INVALID_PARAMS = -32602
// The code the MCP specification's own example uses for a user's refusal.
const REJECTED = -1

/**
 * A server's sampling request as the `on_request` hook sees it, already in
 * Fascicle's shapes. `max_tokens` is what the engine will be asked for, after
 * the config's cap. `model_preferences` is the server's hint object exactly as
 * sent, and nothing in Fascicle reads it.
 */
export type McpSamplingRequest = {
  messages: Message[]
  system?: string
  max_tokens: number
  model_preferences?: unknown
}

export type McpSamplingConfig = {
  engine: Engine
  // Sent to the engine as written, for every request. The server's model
  // preferences never choose it.
  model: string
  provider?: string
  // The most output tokens one request may ask for. A request that asks for
  // more is answered within this. Unset caps a request at 4,096.
  max_tokens?: number
  // Called before each completion. A false answer refuses the request
  // before the engine is called. Required, since a server that you connect
  // to is asking to spend your tokens, and the answer is yours to give. Pass
  // `() => true` to allow every request.
  on_request: (request: McpSamplingRequest) => boolean | Promise<boolean>
  trajectory?: TrajectoryLogger
}

// What one sampling request may ask for when the config sets no `max_tokens`.
const DEFAULT_SAMPLING_MAX_TOKENS = 4096

type Refuse = (code: number, message: string) => Error

type SamplingBlock = Extract<SamplingMessage['content'], { type: string }>

/**
 * Registers the sampling handler on a client that declared the `sampling`
 * capability.
 *
 * The SDK checks the capability when a handler is registered, and a client
 * constructed without it throws there. For a client the caller constructed
 * that is the caller's to fix, so the failure is rethrown as an `mcp_error`
 * that says how.
 */
export function register_sampling(sdk: McpClientSdk, client: Client, config: McpSamplingConfig): void {
  const handler = create_sampling_handler(config, (code, message) => new sdk.McpError(code, message))
  try {
    client.setRequestHandler(sdk.CreateMessageRequestSchema, handler)
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new mcp_error(
      `sampling can't be served on the client passed as \`transport: 'client'\` (${detail}): construct that Client with \`capabilities: { sampling: {} }\`, or drop the \`sampling\` option`,
    )
  }
}

/**
 * Builds the handler that turns one `sampling/createMessage` request into one
 * `engine.generate` call and its result.
 *
 * `refuse` makes the error the server is answered with when a request is
 * declined. A request carrying `tools` or `toolChoice` is declined outright:
 * the server would be choosing which of the host's tools run, which is the
 * decision tool approval exists to keep with the host. `stopSequences`,
 * `includeContext`, and `metadata` are dropped. A failure inside the engine is
 * left to the SDK, which answers the server with the error's message.
 */
function create_sampling_handler(
  config: McpSamplingConfig,
  refuse: Refuse,
): (request: CreateMessageRequest, extra: { signal: AbortSignal }) => Promise<CreateMessageResult> {
  return async (request, extra) => {
    const params = request.params
    if (params.tools !== undefined || params.toolChoice !== undefined) {
      throw refuse(
        INVALID_PARAMS,
        'sampling with tools is not supported by this client: send the request without `tools` and `toolChoice`',
      )
    }
    const messages = params.messages.map((message) => to_message(message, refuse))
    const max_tokens = Math.min(params.maxTokens, config.max_tokens ?? DEFAULT_SAMPLING_MAX_TOKENS)

    const allowed = await config.on_request({
      messages,
      ...(params.systemPrompt !== undefined ? { system: params.systemPrompt } : {}),
      max_tokens,
      ...(params.modelPreferences !== undefined ? { model_preferences: params.modelPreferences } : {}),
    })
    if (!allowed) throw refuse(REJECTED, 'sampling request rejected by the client')

    const result = await config.engine.generate({
      model: config.model,
      ...(config.provider !== undefined ? { provider: config.provider } : {}),
      prompt: messages,
      ...(params.systemPrompt !== undefined ? { system: params.systemPrompt } : {}),
      max_tokens,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      abort: extra.signal,
      ...(config.trajectory !== undefined ? { trajectory: config.trajectory } : {}),
    })
    return {
      model: result.model_resolved.model_id,
      role: 'assistant',
      content: { type: 'text', text: result.content },
      stopReason: to_stop_reason(result.finish_reason),
    }
  }
}

/**
 * Maps the engine's finish reason onto MCP's `stopReason`. The two MCP names
 * with an engine counterpart are translated, and any other reason goes out
 * as the engine spelled it, which MCP allows.
 */
function to_stop_reason(finish_reason: string): string {
  if (finish_reason === 'stop') return 'endTurn'
  if (finish_reason === 'length') return 'maxTokens'
  return finish_reason
}

/**
 * Converts one MCP sampling message into an engine `Message`. A message that
 * is a single text block becomes plain string content, the form every
 * provider transport takes.
 */
function to_message(message: SamplingMessage, refuse: Refuse): Message {
  const blocks: SamplingBlock[] = Array.isArray(message.content) ? message.content : [message.content]
  const [only] = blocks
  if (blocks.length === 1 && only?.type === 'text') {
    return message.role === 'user'
      ? { role: 'user', content: only.text }
      : { role: 'assistant', content: only.text }
  }
  return message.role === 'user'
    ? { role: 'user', content: blocks.map((block) => to_user_part(block, refuse)) }
    : { role: 'assistant', content: blocks.map((block) => to_assistant_part(block, refuse)) }
}

/** Converts one block of a user message: text, or an image as base64. */
function to_user_part(block: SamplingBlock, refuse: Refuse): UserContentPart {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'image') return { type: 'image', image: block.data, media_type: block.mimeType }
  throw unsupported(block.type, 'user', refuse)
}

/** Converts one block of an assistant message, which may only be text. */
function to_assistant_part(block: SamplingBlock, refuse: Refuse): AssistantContentPart {
  if (block.type === 'text') return { type: 'text', text: block.text }
  throw unsupported(block.type, 'assistant', refuse)
}

/** The refusal for a content block this client has no engine shape for. */
function unsupported(type: string, role: string, refuse: Refuse): Error {
  return refuse(
    INVALID_PARAMS,
    `sampling content of type '${type}' in a ${role} message is not supported by this client: send text, or an image in a user message`,
  )
}

/**
 * Shared state + helpers for mocking `ai` and the provider registry in tests.
 *
 * Usage: each test file declares its own vi.mock calls at top level (so
 * Vitest hoists them correctly), importing mock_state + the enqueue helpers
 * from this file to share state across multiple test files.
 */

export type FakeStreamPart =
  // Framing the real SDK emits when the stream opens, before any token.
  | { type: 'start' }
  | { type: 'start-step' }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'finish-step'
      finishReason: string
      usage: { inputTokens: number; outputTokens: number } & Record<string, unknown>
      providerMetadata?: Record<string, unknown>
    }
  | { type: 'error'; error: unknown }
  | { type: 'abort' }

/**
 * One entry of a step's `content`, the shape the real SDK returns on a
 * generateText result and as a promise on a streamText result.
 */
export type FakeContentPart =
  | { type: 'text'; text: string; providerMetadata?: Record<string, Record<string, unknown>> }
  | { type: 'reasoning'; text: string; providerMetadata?: Record<string, Record<string, unknown>> }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: unknown
      providerMetadata?: Record<string, Record<string, unknown>>
    }
  | { type: 'source'; id: string; url: string }

export type FakeGenerateTextResult = {
  text: string
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
  finishReason: string
  usage: { inputTokens: number; outputTokens: number } & Record<string, unknown>
  providerMetadata?: Record<string, unknown>
  /** The step's content; derived from text and toolCalls when left out. */
  content?: FakeContentPart[]
}

export type FakeStreamScript = {
  parts: FakeStreamPart[]
  delayMsPerPart?: number
  /** Runs just before each part is yielded, so a test can move a faked clock. */
  beforePart?: (index: number) => void
  /** The step's content promise; derived from the scripted parts when left out. */
  content?: FakeContentPart[]
}

/**
 * Derive a generateText result's content the way the SDK lays it out: the
 * text, when there is any, then each tool call. None of it carries data, so
 * the transport leaves TurnResult.content off and a test sees the turn it
 * always saw.
 */
function derive_generate_content(result: FakeGenerateTextResult): FakeContentPart[] {
  const parts: FakeContentPart[] = result.text.length > 0 ? [{ type: 'text', text: result.text }] : []
  for (const call of result.toolCalls) parts.push({ type: 'tool-call', ...call })
  return parts
}

/**
 * Derive a stream's content from its scripted parts: consecutive text deltas
 * join into one text part, consecutive reasoning deltas into one reasoning
 * part, and each tool call is its own part.
 */
function derive_stream_content(parts: ReadonlyArray<FakeStreamPart>): FakeContentPart[] {
  const content: FakeContentPart[] = []
  for (const part of parts) {
    const last = content.at(-1)
    if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
      const type = part.type === 'text-delta' ? 'text' : 'reasoning'
      if (last?.type === type) last.text += part.text
      else content.push({ type, text: part.text })
    } else if (part.type === 'tool-call') {
      content.push({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      })
    }
  }
  return content
}

/**
 * The stream parts that a generateText result streams as: the opening
 * framing, its content in order (a text or reasoning delta for each text or
 * reasoning part, and a tool call's input start, delta, and call), then the
 * step's finish carrying the result's finish reason, usage, and metadata.
 */
function stream_parts_of(
  result: FakeGenerateTextResult,
  content: ReadonlyArray<FakeContentPart>,
): FakeStreamPart[] {
  const parts: FakeStreamPart[] = [{ type: 'start' }, { type: 'start-step' }]
  for (const part of content) {
    if (part.type === 'text') parts.push({ type: 'text-delta', text: part.text })
    else if (part.type === 'reasoning') parts.push({ type: 'reasoning-delta', text: part.text })
    else if (part.type === 'tool-call') {
      parts.push(
        { type: 'tool-input-start', id: part.toolCallId, toolName: part.toolName },
        { type: 'tool-input-delta', id: part.toolCallId, delta: JSON.stringify(part.input) },
        { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input },
      )
    }
  }
  parts.push({
    type: 'finish-step',
    finishReason: result.finishReason,
    usage: result.usage,
    ...(result.providerMetadata !== undefined ? { providerMetadata: result.providerMetadata } : {}),
  })
  return parts
}

/**
 * Serve a streamText call from the generateText queue, counting it as the
 * generateText call it stands in for, so a test written against generateText
 * reads the same counts and params once its turn streams. The entry resolves
 * inside the generator, as generateText would await it, and an Error entry,
 * or a function entry that rejects, surfaces as the stream's error part.
 */
function stream_from_generate_queue(
  params: { abortSignal?: AbortSignal },
  next: MockState['generate_text_responses'][number],
): {
  stream: AsyncIterable<FakeStreamPart>
  content: Promise<FakeContentPart[]>
} {
  mock_state.generate_text_call_count += 1
  mock_state.last_generate_text_params = params
  mock_state.last_abort_signal = params.abortSignal
  const content = Promise.withResolvers<FakeContentPart[]>()
  async function* gen(): AsyncIterable<FakeStreamPart> {
    let result: FakeGenerateTextResult
    try {
      if (next instanceof Error) throw next
      result = typeof next === 'function' ? await next() : next
    } catch (err: unknown) {
      yield { type: 'error', error: err }
      return
    }
    const parts_content = result.content ?? derive_generate_content(result)
    yield* stream_parts_of(result, parts_content)
    content.resolve(parts_content)
  }
  return { stream: gen(), content: content.promise }
}

export type MockState = {
  generate_text_responses: Array<
    | (() => FakeGenerateTextResult | Promise<FakeGenerateTextResult>)
    | FakeGenerateTextResult
    | Error
  >
  stream_text_scripts: Array<() => FakeStreamScript | Error>
  generate_text_call_count: number
  stream_text_call_count: number
  last_generate_text_params: unknown
  last_stream_text_params: unknown
  last_abort_signal: AbortSignal | undefined
  capability_overrides: Record<string, Record<string, boolean>>
}

export const mock_state: MockState = {
  generate_text_responses: [],
  stream_text_scripts: [],
  generate_text_call_count: 0,
  stream_text_call_count: 0,
  last_generate_text_params: undefined,
  last_stream_text_params: undefined,
  last_abort_signal: undefined,
  capability_overrides: {},
}

export function reset_mock_state(): void {
  mock_state.generate_text_responses.length = 0
  mock_state.stream_text_scripts.length = 0
  mock_state.generate_text_call_count = 0
  mock_state.stream_text_call_count = 0
  mock_state.last_generate_text_params = undefined
  mock_state.last_stream_text_params = undefined
  mock_state.last_abort_signal = undefined
  mock_state.capability_overrides = {}
}

export function enqueue_generate_text(r: FakeGenerateTextResult | Error): void {
  mock_state.generate_text_responses.push(r)
}

export function enqueue_generate_text_fn(
  fn: () => FakeGenerateTextResult | Promise<FakeGenerateTextResult>,
): void {
  mock_state.generate_text_responses.push(fn)
}

export function enqueue_stream(parts: FakeStreamPart[], delay_ms_per_part?: number): void {
  mock_state.stream_text_scripts.push(() => {
    const script: FakeStreamScript = { parts }
    if (delay_ms_per_part !== undefined) script.delayMsPerPart = delay_ms_per_part
    return script
  })
}

export function enqueue_stream_script(script: FakeStreamScript): void {
  mock_state.stream_text_scripts.push(() => script)
}

export function enqueue_stream_error(err: Error): void {
  mock_state.stream_text_scripts.push(() => err)
}

export function make_text_result(
  text: string,
  usage?: { input_tokens?: number; output_tokens?: number },
): FakeGenerateTextResult {
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    usage: {
      inputTokens: usage?.input_tokens ?? 5,
      outputTokens: usage?.output_tokens ?? 3,
    },
  }
}

export async function build_mock_ai_module(): Promise<Record<string, unknown>> {
  return {
    isStepCount: (n: number) => ({ isStepCount: n }),
    tool: (def: { description: string; inputSchema: unknown }) => ({
      type: 'tool' as const,
      description: def.description,
      inputSchema: def.inputSchema,
    }),
    Output: {
      object: (cfg: { schema: unknown; name?: string; description?: string }) => ({
        name: 'object' as const,
        schema: cfg.schema,
      }),
    },
    generateText: async (params: { abortSignal?: AbortSignal }): Promise<FakeGenerateTextResult> => {
      mock_state.generate_text_call_count += 1
      mock_state.last_generate_text_params = params
      mock_state.last_abort_signal = params.abortSignal
      const next = mock_state.generate_text_responses.shift()
      if (next === undefined) throw new Error('mock generateText: no response queued')
      if (next instanceof Error) throw next
      const result = typeof next === 'function' ? await next() : next
      return { ...result, content: result.content ?? derive_generate_content(result) }
    },
    streamText: (params: { abortSignal?: AbortSignal }) => {
      // With no script of its own queued, a turn streams the next generateText
      // response, so a test written for generateText holds once its turn streams.
      if (mock_state.stream_text_scripts.length === 0) {
        const next = mock_state.generate_text_responses.shift()
        if (next !== undefined) return stream_from_generate_queue(params, next)
      }
      mock_state.stream_text_call_count += 1
      mock_state.last_stream_text_params = params
      mock_state.last_abort_signal = params.abortSignal
      const factory = mock_state.stream_text_scripts.shift()
      if (factory === undefined) throw new Error('mock streamText: no script queued')
      const next = factory()
      if (next instanceof Error) throw next
      const script = next
  
      async function* gen(): AsyncIterable<FakeStreamPart> {
        const abort_signal: AbortSignal | undefined = params.abortSignal
        for (const [index, part] of script.parts.entries()) {
          if (script.delayMsPerPart !== undefined && script.delayMsPerPart > 0) {
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(() => resolve(), script.delayMsPerPart)
              if (abort_signal !== undefined) {
                if (abort_signal.aborted) {
                  clearTimeout(t)
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
                  return
                }
                abort_signal.addEventListener(
                  'abort',
                  () => {
                    clearTimeout(t)
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
                  },
                  { once: true },
                )
              }
            })
          }
          script.beforePart?.(index)
          yield part
        }
      }
  
      return {
        stream: gen(),
        content: Promise.resolve(script.content ?? derive_stream_content(script.parts)),
      }
    },
  }
}

export async function build_mock_registry_module(): Promise<Record<string, unknown>> {
  const { default_normalize_usage } = await import('../../providers/types.js')
  const { engine_config_error } = await import('../../errors.js')
  type Init = { api_key?: string; base_url?: string; [k: string]: unknown }
  function make_factory(name: string, credentialed: boolean) {
    return (init: Init) => {
      if (credentialed) {
        if (typeof init.api_key !== 'string' || init.api_key.length === 0) {
          throw new engine_config_error(`${name} requires api_key`, name)
        }
      } else if (typeof init.base_url !== 'string' || init.base_url.length === 0) {
        throw new engine_config_error(`${name} requires base_url`, name)
      }
      const caps = new Set(['text', 'tools', 'schema', 'streaming'])
      if (name === 'anthropic' || name === 'openai' || name === 'google' || name === 'openrouter') {
        caps.add('reasoning')
      }
      if (name === 'ollama' || name === 'lmstudio') {
        caps.add('structured_output')
      }
      return {
        kind: 'ai_sdk' as const,
        name,
        build_model: async (model_id: string) => ({ _mock: true, provider: name, model_id }),
        translate_effort: (effort: string) => {
          if (effort === 'none') return { provider_options: {}, effort_ignored: false }
          if (name === 'ollama' || name === 'lmstudio') {
            return { provider_options: {}, effort_ignored: true }
          }
          return { provider_options: { [name]: { effort } }, effort_ignored: false }
        },
        normalize_usage: default_normalize_usage,
        supports: (cap: string) => {
          const override = mock_state.capability_overrides[name]?.[cap]
          if (override !== undefined) return override
          return caps.has(cap)
        },
      }
    }
  }
  const providers = new Map([
    ['anthropic', make_factory('anthropic', true)],
    ['openai', make_factory('openai', true)],
    ['google', make_factory('google', true)],
    ['ollama', make_factory('ollama', false)],
    ['lmstudio', make_factory('lmstudio', false)],
    ['openrouter', make_factory('openrouter', true)],
  ])
  return {
    list_builtin_providers: () => [...providers.keys()],
    get_provider_factory: (n: string) => {
      const f = providers.get(n)
      // Mirrors the real registry: an unknown name at construction is a
      // config typo, so it surfaces as engine_config_error.
      if (f === undefined) {
        throw new engine_config_error(
          `unknown provider '${n}'; built-in providers are: ${[...providers.keys()].join(', ')}`,
          n,
        )
      }
      return f
    },
  }
}

/**
 * Shared state + helpers for mocking `ai` and the provider registry in tests.
 *
 * Usage: each test file declares its own vi.mock calls at top level (so
 * Vitest hoists them correctly), importing mock_state + the enqueue helpers
 * from this file to share state across multiple test files.
 */

export type FakeStreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'finish-step'
      finishReason: string
      usage: { inputTokens: number; outputTokens: number } & Record<string, unknown>
    }
  | { type: 'error'; error: unknown }
  | { type: 'abort' }

export type FakeGenerateTextResult = {
  text: string
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
  finishReason: string
  usage: { inputTokens: number; outputTokens: number } & Record<string, unknown>
}

export type FakeStreamScript = {
  parts: FakeStreamPart[]
  delayMsPerPart?: number
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
    stepCountIs: (n: number) => ({ stepCountIs: n }),
    tool: (def: { description: string; inputSchema: unknown }) => ({
      type: 'tool' as const,
      description: def.description,
      inputSchema: def.inputSchema,
    }),
    generateText: async (params: { abortSignal?: AbortSignal }): Promise<FakeGenerateTextResult> => {
      mock_state.generate_text_call_count += 1
      mock_state.last_generate_text_params = params
      mock_state.last_abort_signal = params.abortSignal
      const next = mock_state.generate_text_responses.shift()
      if (next === undefined) throw new Error('mock generateText: no response queued')
      if (next instanceof Error) throw next
      if (typeof next === 'function') return next()
      return next
    },
    streamText: (params: { abortSignal?: AbortSignal }) => {
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
        for (const part of script.parts) {
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
          yield part
        }
      }
  
      return { fullStream: gen() }
    },
  }
}

export async function build_mock_registry_module(): Promise<Record<string, unknown>> {
  const { default_normalize_usage } = await import('../../src/providers/types.js')
  const { engine_config_error, provider_not_configured_error } = await import(
    '../../src/errors.js'
  )
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
      return {
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
      if (f === undefined) throw new provider_not_configured_error(n)
      return f
    },
  }
}

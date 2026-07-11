import { describe as vdescribe, expect, it } from 'vitest'
import { z } from 'zod'
import { aborted_error, describe, run } from '#core'
import type { RunContext } from '#core'
import type {
  Engine,
  GenerateOptions,
  GenerateResult,
  RetryPolicy,
  StreamChunk,
  Tool,
  ToolApprovalHandler,
} from '#engine'
import { model_call } from '../model_call.js'

const sample_tool: Tool = {
  name: 'noop',
  description: 'does nothing',
  input_schema: z.object({}),
  execute: () => null,
}
const sample_schema = z.object({ answer: z.string() })
const sample_retry: RetryPolicy = {
  max_attempts: 2,
  initial_delay_ms: 10,
  max_delay_ms: 100,
  retry_on: [],
}
const approve: ToolApprovalHandler = () => true

function bare_ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    run_id: 'rid',
    trajectory: { record: () => {}, start_span: () => 'span', end_span: () => {} },
    state: new Map<string, unknown>(),
    abort: new AbortController().signal,
    emit: () => {},
    on_cleanup: () => {},
    streaming: false,
    ...overrides,
  }
}

function config_of(step: ReturnType<typeof model_call>): Record<string, unknown> {
  return describe.json(step).config as Record<string, unknown>
}

function make_result(content: string): GenerateResult {
  return {
    content,
    tool_calls: [],
    steps: [],
    usage: { input_tokens: 1, output_tokens: 1 },
    finish_reason: 'stop',
    model_resolved: { provider: 'mock', model_id: 'x' },
  }
}

type MockEngineOptions = {
  readonly on_generate?: (opts: GenerateOptions) => Promise<void> | void
  readonly result?: GenerateResult
}

type CapturedCall = {
  readonly opts: GenerateOptions
  readonly had_on_chunk: boolean
}

function make_mock_engine(options: MockEngineOptions = {}): {
  engine: Engine
  calls: CapturedCall[]
} {
  const calls: CapturedCall[] = []
  const result = options.result ?? make_result('ok')
  const engine: Engine = {
    generate: async <t = string>(opts: GenerateOptions<t>): Promise<GenerateResult<t>> => {
      calls.push({ opts: opts as GenerateOptions, had_on_chunk: typeof opts.on_chunk === 'function' })
      if (options.on_generate) await options.on_generate(opts as GenerateOptions)
      return result as unknown as GenerateResult<t>
    },
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    with_providers: () => { throw new Error("stub engine does not support with_providers") },
    dispose: async () => {},
  }
  return { engine, calls }
}

vdescribe('model_call', () => {
  it('happy path: runs the engine and returns the canned result', async () => {
    const { engine, calls } = make_mock_engine({ result: make_result('hello') })
    const s = model_call({ engine, model: 'x' })
    expect(s.kind).toBe('step')
    expect(s.id.startsWith('model_call')).toBe(true)
    const result = await run(s, 'hi', { install_signal_handlers: false })
    expect(result.content).toBe('hello')
    expect(calls.length).toBe(1)
    expect(calls[0]?.opts.abort).toBeInstanceOf(AbortSignal)
    expect(calls[0]?.opts.trajectory).toBeDefined()
    expect(calls[0]?.had_on_chunk).toBe(false)
  })

  it('parents engine spans under the model_call step span', async () => {
    const events: Array<Record<string, unknown>> = []
    let id = 0
    const logger = {
      record: (e: Record<string, unknown>) => {
        events.push(e)
      },
      start_span: (name: string, meta?: Record<string, unknown>) => {
        id += 1
        const span_id = `span_${id}`
        events.push({ kind: 'span_start', span_id, name, ...meta })
        return span_id
      },
      end_span: (span_id: string, meta?: Record<string, unknown>) => {
        events.push({ kind: 'span_end', span_id, ...meta })
      },
    }
    const { engine } = make_mock_engine({
      on_generate: (opts) => {
        const gen = opts.trajectory?.start_span('engine.generate', {})
        const gen_step = opts.trajectory?.start_span('engine.generate.step', {})
        if (gen_step !== undefined) opts.trajectory?.end_span(gen_step, {})
        if (gen !== undefined) opts.trajectory?.end_span(gen, {})
      },
    })
    const s = model_call({ engine, model: 'x' })
    await run(s, 'hi', { trajectory: logger, install_signal_handlers: false })

    const starts = events.filter((e) => e['kind'] === 'span_start')
    const step_span = starts.find((e) => e['name'] === 'step')
    const gen = starts.find((e) => e['name'] === 'engine.generate')
    const gen_step = starts.find((e) => e['name'] === 'engine.generate.step')

    expect(step_span?.['parent_span_id']).toBeUndefined()
    expect(gen?.['parent_span_id']).toBe(step_span?.['span_id'])
    expect(gen_step?.['parent_span_id']).toBe(gen?.['span_id'])
  })

  it('default id is a stable hash over { model, system, has_tools, has_schema }', () => {
    const { engine } = make_mock_engine()
    const a1 = model_call({ engine, model: 'x' })
    const a2 = model_call({ engine, model: 'x' })
    expect(a1.id).toBe(a2.id)
    const b = model_call({ engine, model: 'y' })
    expect(b.id).not.toBe(a1.id)
    const with_system = model_call({ engine, model: 'x', system: 'be brief' })
    expect(with_system.id).not.toBe(a1.id)
  })

  it('normalizes string input to a user message and leaves arrays unchanged', async () => {
    const { engine, calls } = make_mock_engine()
    const s = model_call({ engine, model: 'x' })
    await run(s, 'hi there', { install_signal_handlers: false })
    const first = calls[0]?.opts.prompt
    expect(Array.isArray(first)).toBe(true)
    expect(first).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi there' }] },
    ])
  
    calls.length = 0
    const pre = [
      { role: 'system' as const, content: 'be brief' },
      { role: 'user' as const, content: 'expand' },
    ]
    await run(s, pre, { install_signal_handlers: false })
    expect(calls[0]?.opts.prompt).toEqual(pre)
  })

  it('explicit cfg.id overrides the default id', () => {
    const { engine } = make_mock_engine()
    const b = model_call({ engine, model: 'x', id: 'generate_plan' })
    expect(b.id).toBe('generate_plan')
  })

  it('raises aborted_error before engine.generate when ctx.abort is pre-aborted', async () => {
    const { engine, calls } = make_mock_engine()
    const s = model_call({ engine, model: 'x' })
    const controller = new AbortController()
    controller.abort()
    const logger = {
      record: () => {},
      start_span: () => 'span',
      end_span: () => {},
    }
    const ctx: RunContext = {
      run_id: 'rid',
      trajectory: logger,
      state: new Map<string, unknown>(),
      abort: controller.signal,
      emit: () => {},
      on_cleanup: () => {},
      streaming: false,
    }
    await expect(s.run('hi', ctx)).rejects.toBeInstanceOf(aborted_error)
    expect(calls.length).toBe(0)
  })

  it('propagates abort mid-call and the engine receives the signal', async () => {
    let observed_abort: AbortSignal | undefined
    const { engine } = make_mock_engine({
      on_generate: async (opts) => {
        observed_abort = opts.abort
        await new Promise<void>((resolve, reject) => {
          const err = new aborted_error('aborted', { reason: { signal: 'abort' } })
          if (opts.abort?.aborted) return reject(err)
          opts.abort?.addEventListener(
            'abort',
            () => {
              reject(err)
            },
            { once: true },
          )
        })
      },
    })
    const s = model_call({ engine, model: 'x' })
    const controller = new AbortController()
    const logger = {
      record: () => {},
      start_span: () => 'span',
      end_span: () => {},
    }
    const ctx: RunContext = {
      run_id: 'rid',
      trajectory: logger,
      state: new Map<string, unknown>(),
      abort: controller.signal,
      emit: () => {},
      on_cleanup: () => {},
      streaming: false,
    }
    const pending = s.run('hi', ctx)
    queueMicrotask(() => controller.abort())
    await expect(pending).rejects.toBeInstanceOf(aborted_error)
    expect(observed_abort).toBeDefined()
    expect(observed_abort?.aborted).toBe(true)
  })

  it('streaming parity: run and run.stream yield identical GenerateResult', async () => {
    const canned = make_result('stream_result')
    const plain = make_mock_engine({ result: canned })
    const streamed = make_mock_engine({
      result: canned,
      on_generate: async (opts) => {
        if (opts.on_chunk) {
          const chunk: StreamChunk = { kind: 'text', text: 'hi', step_index: 0 }
          await opts.on_chunk(chunk)
        }
      },
    })
  
    const plain_step = model_call({ engine: plain.engine, model: 'x' })
    const streamed_step = model_call({ engine: streamed.engine, model: 'x' })
  
    const plain_result = await run(plain_step, 'hi', { install_signal_handlers: false })
    const stream_handle = run.stream(streamed_step, 'hi', { install_signal_handlers: false })
    const events: unknown[] = []
    const consume = (async () => {
      for await (const e of stream_handle.events) events.push(e)
    })()
    const stream_result = await stream_handle.result
    await consume
  
    expect(stream_result).toEqual(plain_result)
    expect(plain.calls[0]?.had_on_chunk).toBe(false)
    expect(streamed.calls[0]?.had_on_chunk).toBe(true)
    const emitted = events.filter(
      (e): e is { kind: 'model_chunk'; step_id?: string } =>
        typeof e === 'object' && e !== null && 'kind' in e && e.kind === 'model_chunk',
    )
    expect(emitted.length).toBeGreaterThan(0)
  })

  it('describe surfaces model config and omits the raw engine object', () => {
    const { engine } = make_mock_engine()
    const s = model_call({ engine, model: 'sonnet', provider: 'claude_cli', system: 'be careful' })
    const text = describe(s)
    expect(text).toContain('model_call')
    expect(text).toContain('"sonnet"')
    expect(text).toContain('"claude_cli"')
    expect(text).toContain('"be careful"')
    expect(text).not.toContain('[object Object]')
    const json = describe.json(s)
    const cfg = json.config as Record<string, unknown>
    expect(cfg['model']).toBe('sonnet')
    expect(cfg['provider']).toBe('claude_cli')
    expect(cfg['system']).toBe('be careful')
    expect(cfg['has_tools']).toBe(false)
    expect(cfg['has_schema']).toBe(false)
    expect('engine' in cfg).toBe(false)
  })

  it('does not mutate cfg', async () => {
    const { engine } = make_mock_engine()
    const cfg = Object.freeze({ engine, model: 'x', system: 'fixed' })
    const s = model_call(cfg)
    await run(s, 'hi', { install_signal_handlers: false })
    expect(cfg.model).toBe('x')
    expect(cfg.system).toBe('fixed')
  })

  it('forwards every configured option to engine.generate', async () => {
    const { engine, calls } = make_mock_engine()
    const s = model_call({
      engine,
      model: 'm',
      provider: 'p',
      system: 'sys',
      tools: [sample_tool],
      schema: sample_schema,
      effort: 'high',
      max_steps: 5,
      provider_options: { temperature: 0.2 },
      retry_policy: sample_retry,
      tool_error_policy: 'throw',
      schema_repair_attempts: 3,
      tool_call_repair_attempts: 2,
      max_tool_calls_per_step: 1,
      on_tool_approval: approve,
    })
    await run(s, 'hi', { install_signal_handlers: false })
    const opts = calls[0]?.opts
    expect(opts?.model).toBe('m')
    expect(opts?.provider).toBe('p')
    expect(opts?.system).toBe('sys')
    expect(opts?.tools).toEqual([sample_tool])
    expect(opts?.schema).toBe(sample_schema)
    expect(opts?.effort).toBe('high')
    expect(opts?.max_steps).toBe(5)
    expect(opts?.provider_options).toEqual({ temperature: 0.2 })
    expect(opts?.retry).toBe(sample_retry)
    expect(opts?.tool_error_policy).toBe('throw')
    expect(opts?.schema_repair_attempts).toBe(3)
    expect(opts?.tool_call_repair_attempts).toBe(2)
    expect(opts?.max_tool_calls_per_step).toBe(1)
    expect(opts?.on_tool_approval).toBe(approve)
  })

  it('omits every unset option from engine.generate', async () => {
    const { engine, calls } = make_mock_engine()
    const s = model_call({ engine })
    await run(s, 'hi', { install_signal_handlers: false })
    expect(calls).toHaveLength(1)
    const opts = (calls[0]?.opts ?? {}) as Record<string, unknown>
    for (const key of [
      'model',
      'provider',
      'system',
      'tools',
      'schema',
      'effort',
      'max_steps',
      'provider_options',
      'retry',
      'tool_error_policy',
      'schema_repair_attempts',
      'tool_call_repair_attempts',
      'max_tool_calls_per_step',
      'on_tool_approval',
    ]) {
      expect(key in opts).toBe(false)
    }
  })

  it('copies the tools array rather than aliasing the caller list', async () => {
    const { engine, calls } = make_mock_engine()
    const tools = [sample_tool]
    const s = model_call({ engine, model: 'x', tools })
    await run(s, 'hi', { install_signal_handlers: false })
    expect(calls[0]?.opts.tools).toEqual(tools)
    expect(calls[0]?.opts.tools).not.toBe(tools)
  })

  it('varies the default id by provider, tools, and schema', () => {
    const { engine } = make_mock_engine()
    const base = model_call({ engine, model: 'x' })
    expect(model_call({ engine, model: 'x', provider: 'p' }).id).not.toBe(base.id)
    expect(model_call({ engine, model: 'x', tools: [sample_tool] }).id).not.toBe(base.id)
    expect(model_call({ engine, model: 'x', schema: sample_schema }).id).not.toBe(base.id)
    // The provider/system values themselves feed the hash, not just their presence.
    expect(model_call({ engine, model: 'x', provider: 'p' }).id).not.toBe(
      model_call({ engine, model: 'x', provider: 'q' }).id,
    )
    expect(model_call({ engine, model: 'x', system: 'a' }).id).not.toBe(
      model_call({ engine, model: 'x', system: 'b' }).id,
    )
  })

  it('default id is "model_call:" followed by an 8-char hex hash', () => {
    const { engine } = make_mock_engine()
    expect(model_call({ engine, model: 'x' }).id).toMatch(/^model_call:[0-9a-f]{8}$/)
  })

  it('reports has_tools and has_schema in describe config', () => {
    const { engine } = make_mock_engine()
    expect(config_of(model_call({ engine, model: 'x' }))['has_tools']).toBe(false)
    expect(config_of(model_call({ engine, model: 'x', tools: [] }))['has_tools']).toBe(false)
    expect(config_of(model_call({ engine, model: 'x', tools: [sample_tool] }))['has_tools']).toBe(true)
    expect(config_of(model_call({ engine, model: 'x' }))['has_schema']).toBe(false)
    expect(config_of(model_call({ engine, model: 'x', schema: sample_schema }))['has_schema']).toBe(true)
  })

  it('includes optional describe fields only when set', () => {
    const { engine } = make_mock_engine()
    const with_effort = config_of(model_call({ engine, model: 'x', effort: 'low' }))
    expect(with_effort['effort']).toBe('low')
    const bare = config_of(model_call({ engine }))
    expect('effort' in bare).toBe(false)
    expect('model' in bare).toBe(false)
    expect('provider' in bare).toBe(false)
    expect('system' in bare).toBe(false)
  })

  it('the pre-abort error carries the model_call message, reason, and step index', async () => {
    const { engine, calls } = make_mock_engine()
    const s = model_call({ engine, model: 'x' })
    const controller = new AbortController()
    controller.abort()
    let err: unknown
    try {
      await s.run('hi', bare_ctx({ abort: controller.signal }))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).message).toBe('aborted before model_call')
    expect((err as aborted_error).reason).toEqual({ signal: 'abort' })
    expect((err as aborted_error).step_index).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('records a model_chunk event carrying the chunk and step id while streaming', async () => {
    const chunk: StreamChunk = { kind: 'text', text: 'hi', step_index: 0 }
    const { engine } = make_mock_engine({
      on_generate: async (opts) => {
        if (opts.on_chunk) await opts.on_chunk(chunk)
      },
    })
    const s = model_call({ engine, model: 'x' })
    const recorded: unknown[] = []
    await s.run(
      'hi',
      bare_ctx({
        streaming: true,
        trajectory: {
          record: (e) => recorded.push(e),
          start_span: () => 'span',
          end_span: () => {},
        },
      }),
    )
    expect(recorded).toEqual([{ kind: 'model_chunk', step_id: s.id, chunk }])
  })

  it('nests engine spans, pops them on end, preserves explicit parents, and forwards records', async () => {
    const events: Array<Record<string, unknown>> = []
    let n = 0
    const logger = {
      record: (e: Record<string, unknown>) => {
        events.push({ _t: 'record', ...e })
      },
      start_span: (name: string, meta?: Record<string, unknown>) => {
        n += 1
        const id = `span_${n}`
        events.push({ _t: 'start', id, name, parent: meta?.['parent_span_id'] })
        return id
      },
      end_span: (id: string) => {
        events.push({ _t: 'end', id })
      },
    }
    const { engine } = make_mock_engine({
      on_generate: (opts) => {
        const t = opts.trajectory
        t?.record({ kind: 'note' })
        const a = t?.start_span('A', {}) ?? ''
        const b = t?.start_span('B', {}) ?? ''
        t?.end_span(b, {})
        const c = t?.start_span('C', {}) ?? '' // B is popped, so C should parent under A
        const d = t?.start_span('D', { parent_span_id: 'explicit' }) ?? ''
        t?.end_span(d, {})
        t?.end_span(c, {})
        t?.end_span(a, {})
      },
    })
    const s = model_call({ engine, model: 'x' })
    await run(s, 'hi', { trajectory: logger, install_signal_handlers: false })

    const start = (name: string): Record<string, unknown> | undefined =>
      events.find((e) => e['_t'] === 'start' && e['name'] === name)
    const step_span = start('step')
    expect(start('A')?.['parent']).toBe(step_span?.['id'])
    expect(start('B')?.['parent']).toBe(start('A')?.['id'])
    expect(start('C')?.['parent']).toBe(start('A')?.['id'])
    expect(start('D')?.['parent']).toBe('explicit')
    expect(events.some((e) => e['_t'] === 'record' && e['kind'] === 'note')).toBe(true)
    expect(events.filter((e) => e['_t'] === 'end')).not.toHaveLength(0)
  })

  it('adds no parent_span_id key at the stack root and tolerates a missing meta', async () => {
    const metas: Array<Record<string, unknown> | undefined> = []
    const logger = {
      record: () => {},
      start_span: (_name: string, meta?: Record<string, unknown>) => {
        metas.push(meta)
        return 'span'
      },
      end_span: () => {},
    }
    const { engine } = make_mock_engine({
      on_generate: (opts) => {
        opts.trajectory?.start_span('with-meta', {})
        opts.trajectory?.start_span('no-meta') // exercises the undefined-meta path
      },
    })
    const s = model_call({ engine, model: 'x' })
    await s.run('hi', bare_ctx({ trajectory: logger }))
    // Root span: not just parent === undefined, but no parent_span_id key at all.
    expect(metas[0]).toEqual({})
    expect('parent_span_id' in (metas[0] ?? { parent_span_id: 1 })).toBe(false)
  })

  it('pops the correct span on out-of-order and untracked ends', async () => {
    const parent_of: Record<string, unknown> = {}
    const id_of: Record<string, string> = {}
    let n = 0
    const logger = {
      record: () => {},
      start_span: (name: string, meta?: Record<string, unknown>) => {
        n += 1
        const id = `s${n}`
        id_of[name] = id
        parent_of[name] = meta?.['parent_span_id']
        return id
      },
      end_span: () => {},
    }
    const { engine } = make_mock_engine({
      on_generate: (opts) => {
        const t = opts.trajectory
        if (!t) return
        const a = t.start_span('A', {})
        t.end_span('never-tracked', {}) // untracked end must be a no-op, not pop A
        t.start_span('B', {}) // still nested under A
        t.end_span(a, {}) // end A while B is open (out of order)
        t.end_span(id_of['B'] ?? '', {})
        t.start_span('C', {}) // stack unwound to the step span
      },
    })
    const s = model_call({ engine, model: 'x' })
    await run(s, 'hi', { trajectory: logger, install_signal_handlers: false })
    expect(parent_of['B']).toBe(id_of['A'])
    expect(parent_of['C']).toBe(id_of['step'])
  })
})

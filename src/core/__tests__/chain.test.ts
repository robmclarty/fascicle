import { describe as vdescribe, expect, it } from 'vitest'
import { chain } from '../chain.js'
import type { Chain } from '../chain.js'
import { describe } from '../describe.js'
import { run } from '../runner.js'
import { step } from '../step.js'
import type { Step } from '../types.js'

vdescribe('chain', () => {
  it('threads a named record: each step sees prior bindings, output projects', async () => {
    const flow = chain<string>()
      .step('words', ({ input }) => input.split(' '))
      .step('count', ({ words }) => words.length)
      .output(({ words, count }) => `${count}:${words.join(',')}`)

    expect(await run(flow, 'a b c', { install_signal_handlers: false })).toBe('3:a,b,c')
  })

  it('names the input binding via the chain argument', async () => {
    const flow = chain<number, 'seed'>('seed')
      .step('doubled', ({ seed }) => seed * 2)
      .output(({ seed, doubled }) => seed + doubled)

    expect(await run(flow, 3, { install_signal_handlers: false })).toBe(9)
  })

  it('ctx.call invokes another Step from inside a binding', async () => {
    const shout = step('shout', (s: string) => s.toUpperCase())
    const flow = chain<string>()
      .step('loud', ({ input }, ctx) => ctx.call(shout, input))
      .output(({ loud }) => `${loud}!`)

    expect(await run(flow, 'hey', { install_signal_handlers: false })).toBe('HEY!')
  })

  it('a label-only stage leaves the record intact', async () => {
    const flow = chain<number>()
      .step('a', ({ input }) => input + 1)
      .stage('later')
      .step('b', ({ input, a }) => input + a)
      .output(({ a, b }) => [a, b])

    expect(await run(flow, 1, { install_signal_handlers: false })).toEqual([2, 3])
  })

  it('a projecting stage replaces the record so earlier bindings go out of scope', async () => {
    const flow = chain<number>()
      .step('a', ({ input }) => input + 1)
      .step('b', ({ a }) => a * 10)
      .stage('narrowed', ({ b }) => ({ b }))
      .step('after', (s) => Object.keys(s).sort())
      .output(({ after }) => after)

    expect(await run(flow, 1, { install_signal_handlers: false })).toEqual(['b'])
  })

  it('rejects duplicate binding names within a stage, including the input name', () => {
    expect(() =>
      chain<number>()
        .step('a', ({ input }) => input)
        .step('a', ({ input }) => input),
    ).toThrow(TypeError)
    expect(() => chain<number>().step('input', ({ input }) => input)).toThrow(
      'already defined',
    )
  })

  it('allows re-binding a name after a projecting stage resets the record', () => {
    expect(() =>
      chain<number>()
        .step('a', ({ input }) => input)
        .stage('reset', () => ({}))
        .step('a', () => 1),
    ).not.toThrow()
  })

  it('is immutable: a shared prefix extends in two directions', async () => {
    const prefix = chain<number>().step('a', ({ input }) => input + 1)
    const double = prefix.output(({ a }) => a * 2)
    const triple = prefix.output(({ a }) => a * 3)

    expect(await run(double, 1, { install_signal_handlers: false })).toBe(4)
    expect(await run(triple, 1, { install_signal_handlers: false })).toBe(6)
  })

  it('nests spans: steps under the chain, post-stage steps under the stage span', async () => {
    type SpanStart = { readonly name: string; readonly span_id: string; readonly meta: Record<string, unknown> }
    const starts: SpanStart[] = []
    let n = 0
    const logger = {
      record: () => {},
      start_span: (name: string, meta?: Record<string, unknown>) => {
        n += 1
        const span_id = `s${n}`
        starts.push({ name, span_id, meta: { ...meta } })
        return span_id
      },
      end_span: () => {},
    }

    const flow = chain<number>()
      .step('a', ({ input }) => input)
      .stage('phase')
      .step('b', ({ a }) => a)
      .output(({ b }) => b)
    await run(flow, 1, { install_signal_handlers: false, trajectory: logger })

    const chain_span = starts.find((s) => s.name === 'chain')
    const phase_span = starts.find((s) => s.name === 'phase')
    const step_a = starts.find((s) => s.meta['id'] === 'a')
    const step_b = starts.find((s) => s.meta['id'] === 'b')
    const out = starts.find((s) => s.meta['id'] === 'output')

    expect(chain_span).toBeDefined()
    expect(phase_span?.meta['parent_span_id']).toBe(chain_span?.span_id)
    expect(step_a?.meta['parent_span_id']).toBe(chain_span?.span_id)
    expect(step_b?.meta['parent_span_id']).toBe(phase_span?.span_id)
    expect(out?.meta['parent_span_id']).toBe(phase_span?.span_id)
  })

  it('ends an open stage span on failure and reports the error', async () => {
    const ended: Array<{ id: string; meta: Record<string, unknown> }> = []
    let n = 0
    const logger = {
      record: () => {},
      start_span: () => {
        n += 1
        return `s${n}`
      },
      end_span: (id: string, meta?: Record<string, unknown>) => {
        ended.push({ id, meta: { ...meta } })
      },
    }

    const flow = chain<number>()
      .stage('doomed')
      .step('boom', () => {
        throw new Error('kaput')
      })
      .output(({ boom }) => boom)
    await expect(
      run(flow, 1, { install_signal_handlers: false, trajectory: logger }),
    ).rejects.toThrow('kaput')

    const stage_end = ended.find((e) => e.meta['id'] === 'stage:doomed')
    expect(stage_end?.meta['error']).toBe('kaput')
  })

  it('ctx.call honors a pending abort before dispatching', async () => {
    const controller = new AbortController()
    const inner = step('inner', () => 'never')
    const flow = chain<string>()
      .step('x', (_s, ctx) => {
        controller.abort(new Error('stop'))
        return ctx.call(inner, 'v')
      })
      .output(({ x }) => x)

    await expect(
      run(flow, 'go', { install_signal_handlers: false, abort: controller.signal }),
    ).rejects.toThrow('stop')
  })

  it('describe exposes the kind, plan, and per-binding children', () => {
    const flow = chain<number>()
      .step('a', ({ input }) => input)
      .stage('phase')
      .step('b', ({ a }) => a)
      .output(({ b }) => b)

    const node = describe.json(flow) as unknown as Record<string, unknown>
    expect(node['kind']).toBe('chain')
    expect(node['config']).toMatchObject({
      input: 'input',
      plan: ['a', 'stage:phase', 'b', 'output'],
    })
  })

  it('an arm renders as the binding step child in describe without being dispatched', async () => {
    let arm_runs = 0
    const arm = step('inner_flow', (n: number) => {
      arm_runs += 1
      return n * 10
    })
    const flow = chain<number>()
      .step('a', async ({ input }, ctx) => ctx.call(arm, input), { arm })
      .step('b', ({ a }) => a + 1)
      .output(({ b }) => b)

    const node = describe.json(flow)
    const binding = node.children?.find((c) => c.id === 'a')
    expect(binding?.children?.map((c) => c.id)).toEqual(['inner_flow'])
    const plain = node.children?.find((c) => c.id === 'b')
    expect(plain?.children).toBeUndefined()
    // The text tree nests the arm one level deeper than its binding.
    const lines = describe(flow).split('\n')
    const binding_line = lines.findIndex((l) => l.includes('step(a)'))
    expect(lines[binding_line + 1]).toMatch(/^\s+step\(inner_flow\)/)

    // The arm is metadata: describing runs nothing.
    expect(arm_runs).toBe(0)
    // Dispatch runs the body (which calls the arm once), not the child list.
    const result = await run(flow, 4, { install_signal_handlers: false })
    expect(result).toBe(41)
    expect(arm_runs).toBe(1)
  })

  it('defaults the input type to never so an unstated input fails at run', async () => {
    const untyped = chain().output((s) => Object.keys(s))
    const rejected = () =>
      // @ts-expect-error the input type was never stated, so no real input is accepted
      run(untyped, 'real', { install_signal_handlers: false })
    void rejected

    const typed = chain()
      .input<string>()
      .output(({ input }) => input.toUpperCase())
    expect(await run(typed, 'ok', { install_signal_handlers: false })).toBe('OK')
  })

  it('.input<t>() on a fresh chain equals stating the type argument', async () => {
    const refined = chain('q').input<string>()
    const direct: Chain<string, { readonly q: string }> = chain<string, 'q'>('q')
    const same: Chain<string, { readonly q: string }> = refined
    void direct
    void same

    const flow = refined.step('len', ({ q }) => q.length).output(({ len }) => len * 2)
    expect(await run(flow, 'abcd', { install_signal_handlers: false })).toBe(8)
  })

  it('refuses .input after the first entry', () => {
    const after_step = chain<number>().step('a', ({ input }) => input)
    expect(() =>
      // @ts-expect-error .input is only available on a freshly opened chain
      after_step.input<string>(),
    ).toThrow(TypeError)
    const after_stage = chain<number>().stage('phase')
    expect(() =>
      // @ts-expect-error .input is only available on a freshly opened chain
      after_stage.input<string>(),
    ).toThrow(TypeError)
  })

  it('arm-first step: the chain dispatches the arm with the selected input', async () => {
    const seen: number[] = []
    const tenfold = step('tenfold', (n: number) => {
      seen.push(n)
      return n * 10
    })
    const flow = chain<number>()
      .step('scaled', tenfold, ({ input }) => input + 1)
      .step('b', ({ scaled }) => scaled + 1)
      .output(({ b }) => b)

    expect(await run(flow, 4, { install_signal_handlers: false })).toBe(51)
    expect(seen).toEqual([5])
  })

  it('arm-first step records the arm as the binding child in describe', () => {
    const tenfold = step('tenfold', (n: number) => n * 10)
    const flow = chain<number>()
      .step('scaled', tenfold, ({ input }) => input)
      .output(({ scaled }) => scaled)

    const node = describe.json(flow)
    const binding = node.children?.find((c) => c.id === 'scaled')
    expect(binding?.children?.map((c) => c.id)).toEqual(['tenfold'])
    // The text tree nests the arm one level deeper than its binding.
    const lines = describe(flow).split('\n')
    const binding_line = lines.findIndex((l) => l.includes('step(scaled)'))
    expect(lines[binding_line + 1]).toMatch(/^\s+step\(tenfold\)/)
  })

  it('arm-first step nests the arm span under the binding span', async () => {
    type SpanStart = { readonly name: string; readonly span_id: string; readonly meta: Record<string, unknown> }
    const starts: SpanStart[] = []
    let n = 0
    const logger = {
      record: () => {},
      start_span: (name: string, meta?: Record<string, unknown>) => {
        n += 1
        const span_id = `s${n}`
        starts.push({ name, span_id, meta: { ...meta } })
        return span_id
      },
      end_span: () => {},
    }

    const tenfold = step('tenfold', (x: number) => x * 10)
    const flow = chain<number>()
      .step('scaled', tenfold, ({ input }) => input)
      .output(({ scaled }) => scaled)
    await run(flow, 2, { install_signal_handlers: false, trajectory: logger })

    const binding = starts.find((s) => s.meta['id'] === 'scaled')
    const arm_span = starts.find((s) => s.meta['id'] === 'tenfold')
    expect(binding).toBeDefined()
    expect(arm_span?.meta['parent_span_id']).toBe(binding?.span_id)
  })

  it('throws when an arm is passed without a select function', () => {
    const tenfold = step('tenfold', (n: number) => n * 10)
    expect(() =>
      // @ts-expect-error the arm form requires a select projection
      chain<number>().step('scaled', tenfold),
    ).toThrow('select must be a function')
  })

  it('type-checks binding names and shapes at compile time', () => {
    // @ts-expect-error unknown binding name in the view
    chain<number>().step('a', ({ nope }) => nope)
    const tenfold = step('tenfold', (n: number) => n * 10)
    // @ts-expect-error the selection must produce the arm's input type
    chain<number>().step('bad', tenfold, ({ input }) => String(input))
    const typed = chain<number>()
      .step('a', ({ input }) => input + 1)
      .output(({ a }) => a)
    const ok: Step<number, number> = typed
    // @ts-expect-error the chain's output is a number, not a string
    const wrong: Step<number, string> = typed
    void ok
    void wrong
    expect(true).toBe(true)
  })
})

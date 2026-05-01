import { run, step } from '@repo/core'
import type { Step } from '@repo/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { JudgeArgs, Score } from '../bench.js'
import { judge_equals, judge_llm, judge_with } from '../judges.js'

afterEach(() => {
  for (const l of process.listeners('SIGINT')) process.off('SIGINT', l)
  for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l)
})

async function evaluate<I, O>(
  j: Step<JudgeArgs<I, O>, Score | undefined>,
  args: JudgeArgs<I, O>,
): Promise<Score | undefined> {
  return run(j, args, { install_signal_handlers: false })
}

describe('judge_equals', () => {
  it('scores 1 when output deep-equals meta.expected', async () => {
    const j = judge_equals<{ x: number; y: number[] }>()
    const out = await evaluate(j, {
      input: 'ignored',
      output: { x: 1, y: [2, 3] },
      meta: { expected: { x: 1, y: [2, 3] } },
    })
    expect(out).toEqual({ score: 1, reason: 'match' })
  })

  it('scores 0 on mismatch', async () => {
    const j = judge_equals<number>()
    const out = await evaluate(j, { input: 'x', output: 5, meta: { expected: 6 } })
    expect(out).toEqual({ score: 0, reason: 'mismatch' })
  })

  it('abstains when meta.expected is missing', async () => {
    const j = judge_equals<number>()
    expect(await evaluate(j, { input: 'x', output: 5 })).toBeUndefined()
    expect(await evaluate(j, { input: 'x', output: 5, meta: {} })).toBeUndefined()
  })
})

describe('judge_with', () => {
  it('normalizes a number return into a Score', async () => {
    const j = judge_with<number, number>(({ output }) => output / 10)
    const out = await evaluate(j, { input: 1, output: 7 })
    expect(out).toEqual({ score: 0.7 })
  })

  it('passes through Score objects with reason', async () => {
    const j = judge_with<number, number>(() => ({ score: 0.5, reason: 'meh' }))
    const out = await evaluate(j, { input: 1, output: 2 })
    expect(out).toEqual({ score: 0.5, reason: 'meh' })
  })

  it('abstains on undefined', async () => {
    const j = judge_with<number, number>(() => undefined)
    expect(await evaluate(j, { input: 1, output: 2 })).toBeUndefined()
  })

  it('rejects NaN/Infinity returns', async () => {
    const j = judge_with<number, number>(() => Number.NaN)
    expect(await evaluate(j, { input: 1, output: 2 })).toBeUndefined()
    const j2 = judge_with<number, number>(() => Number.POSITIVE_INFINITY)
    expect(await evaluate(j2, { input: 1, output: 2 })).toBeUndefined()
  })

  it('awaits async user functions', async () => {
    const j = judge_with<number, number>(async ({ output }) => Promise.resolve(output / 4))
    expect(await evaluate(j, { input: 1, output: 8 })).toEqual({ score: 2 })
  })
})

describe('judge_llm', () => {
  function constant_model(reply: string): Step<string, string> {
    return step('mock_model', () => reply)
  }

  it('parses a single JSON line into a Score', async () => {
    const j = judge_llm<string, string>({
      model: constant_model('{"score": 0.8, "reason": "good enough"}'),
      rubric: 'Score 0..1',
    })
    const out = await evaluate(j, { input: 'hello', output: 'world' })
    expect(out).toEqual({ score: 0.8, reason: 'good enough' })
  })

  it('extracts JSON when the model wraps it in prose', async () => {
    const j = judge_llm<string, string>({
      model: constant_model('Sure! Here is your score: {"score": 4} done.'),
      rubric: 'r',
      scale: { min: 0, max: 5 },
    })
    expect(await evaluate(j, { input: 'a', output: 'b' })).toEqual({ score: 4 })
  })

  it('clamps scores to the supplied scale', async () => {
    const j = judge_llm<string, string>({
      model: constant_model('{"score": 99}'),
      rubric: 'r',
      scale: { min: 0, max: 5 },
    })
    expect(await evaluate(j, { input: 'a', output: 'b' })).toEqual({ score: 5 })
  })

  it('abstains when the reply cannot be parsed', async () => {
    const j = judge_llm<string, string>({
      model: constant_model('not json at all'),
      rubric: 'r',
    })
    expect(await evaluate(j, { input: 'a', output: 'b' })).toBeUndefined()
  })

  it('abstains when score is missing/non-numeric', async () => {
    const j = judge_llm<string, string>({
      model: constant_model('{"reason": "no score"}'),
      rubric: 'r',
    })
    expect(await evaluate(j, { input: 'a', output: 'b' })).toBeUndefined()
  })

  it('embeds rubric and the input/output blob in the prompt sent to the model', async () => {
    let captured = ''
    const capture: Step<string, string> = step('capture', (prompt: string) => {
      captured = prompt
      return '{"score": 1}'
    })
    const j = judge_llm<{ topic: string }, { answer: string }>({
      model: capture,
      rubric: 'check that the answer addresses the topic',
    })
    await evaluate(j, { input: { topic: 'bench' }, output: { answer: 'bench is great' } })
    expect(captured).toContain('check that the answer addresses the topic')
    expect(captured).toContain('bench')
    expect(captured).toContain('bench is great')
  })
})

import { describe as describe_flow, run, step } from '#core'
import type { FlowNode, Step } from '#core'
import { afterEach, describe, expect, it } from 'vitest'
import type { JudgeArgs, Score } from '../bench.js'
import {
  deep_equal,
  extract_json_object,
  is_record,
  judge_equals,
  judge_llm,
  judge_with,
  parse_score,
  render_prompt,
} from '../judges.js'

afterEach(() => {
  for (const l of process.listeners('SIGINT')) process.off('SIGINT', l)
  for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l)
})

const zero_fn = (): number => 0

function collect_ids(node: FlowNode): string[] {
  const ids = [node.id]
  for (const child of node.children ?? []) ids.push(...collect_ids(child))
  return ids
}

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

const is_record_cases: Array<[string, unknown, boolean]> = [
  ['empty object', {}, true],
  ['populated object', { a: 1 }, true],
  ['null', null, false],
  ['array', [], false],
  ['number', 5, false],
  ['string', 'x', false],
  ['undefined', undefined, false],
  ['boolean', true, false],
]

describe('is_record (internal)', () => {
  it.each(is_record_cases)('is_record(%s) -> %s', (_label, value, expected) => {
    expect(is_record(value)).toBe(expected)
  })
})

const deep_equal_cases: Array<[string, unknown, unknown, boolean]> = [
  ['identical numbers', 1, 1, true],
  ['different numbers', 1, 2, false],
  ['identical strings', 'a', 'a', true],
  ['different strings', 'a', 'b', false],
  ['equal booleans', true, true, true],
  ['different booleans', true, false, false],
  ['number vs string', 1, '1', false],
  ['NaN vs NaN', Number.NaN, Number.NaN, false],
  ['null vs null', null, null, true],
  ['null vs number', null, 5, false],
  ['number vs null', 5, null, false],
  ['null vs object', null, {}, false],
  ['object vs null', {}, null, false],
  ['undefined vs undefined', undefined, undefined, true],
  ['equal records', { a: 1, b: 2 }, { a: 1, b: 2 }, true],
  ['records differing in value', { a: 1 }, { a: 2 }, false],
  ['records differing in key name', { a: 1 }, { b: 1 }, false],
  ['records differing in size', { a: 1 }, { a: 1, b: 2 }, false],
  ['records with reordered keys', { a: 1, b: 2 }, { b: 2, a: 1 }, true],
  ['equal arrays', [1, 2, 3], [1, 2, 3], true],
  ['arrays differing in element', [1, 2, 3], [1, 2, 4], false],
  ['arrays differing in length', [1, 2], [1, 2, 3], false],
  ['empty arrays', [], [], true],
  ['array vs record', [1], { 0: 1 }, false],
  ['record vs array', { 0: 1 }, [1], false],
  ['empty array vs empty string', [], '', false],
  ['nested equal', { a: [1, { x: 2 }] }, { a: [1, { x: 2 }] }, true],
  ['nested differing', { a: [1, { x: 2 }] }, { a: [1, { x: 3 }] }, false],
]

describe('deep_equal (internal)', () => {
  it.each(deep_equal_cases)('%s', (_label, a, b, expected) => {
    expect(deep_equal(a, b)).toBe(expected)
  })
})

describe('render_prompt (internal)', () => {
  it('emits the exact evaluator prompt with scale, rubric, and serialized io', () => {
    const prompt = render_prompt('be concise', { min: 2, max: 7 }, {
      input: { topic: 'x' },
      output: { answer: 'y' },
    })
    expect(prompt).toBe(
      [
        'You are an evaluator. Score the model output against the rubric below.',
        '',
        'Rubric:',
        'be concise',
        '',
        'Return a single line of JSON with exactly two keys: {"score": <number 2..7>, "reason": "<short>"}.',
        'Do not include prose outside the JSON.',
        '',
        'Input:',
        '{"topic":"x"}',
        '',
        'Output:',
        '{"answer":"y"}',
      ].join('\n'),
    )
  })
})

describe('parse_score (internal)', () => {
  const scale01 = { min: 0, max: 1 }

  it('parses score and reason', () => {
    expect(parse_score('{"score":0.8,"reason":"good"}', scale01)).toStrictEqual({
      score: 0.8,
      reason: 'good',
    })
  })

  it('omits reason when absent (no undefined reason key)', () => {
    expect(parse_score('{"score":0.5}', scale01)).toStrictEqual({ score: 0.5 })
  })

  it('omits reason when present but non-string', () => {
    expect(parse_score('{"score":0.5,"reason":5}', scale01)).toStrictEqual({ score: 0.5 })
  })

  it('abstains when score is missing', () => {
    expect(parse_score('{"reason":"x"}', scale01)).toBeUndefined()
  })

  it('abstains when score is non-finite (Infinity from 1e999)', () => {
    expect(parse_score('{"score":1e999}', scale01)).toBeUndefined()
  })

  it('clamps to the scale max and min', () => {
    expect(parse_score('{"score":99}', { min: 0, max: 5 })).toStrictEqual({ score: 5 })
    expect(parse_score('{"score":-99}', { min: 0, max: 5 })).toStrictEqual({ score: 0 })
  })

  it('abstains on non-JSON', () => {
    expect(parse_score('not json', scale01)).toBeUndefined()
  })

  it('abstains on malformed JSON (parse throws inside the try)', () => {
    expect(parse_score('{bad json', scale01)).toBeUndefined()
  })

  it('trims surrounding whitespace before extracting', () => {
    expect(parse_score('  {"score":0.3}  ', scale01)).toStrictEqual({ score: 0.3 })
  })

  it('trim makes leading-ws + trailing-junk a strict parse failure', () => {
    expect(parse_score(' {"score":0.5} trailing', scale01)).toBeUndefined()
  })
})

describe('extract_json_object (internal)', () => {
  it('returns the whole string when it already starts with a brace', () => {
    expect(extract_json_object('{"a":1}')).toBe('{"a":1}')
    expect(extract_json_object('{"a":1} after')).toBe('{"a":1} after')
  })

  it('slices from the first brace to the last when wrapped in prose', () => {
    expect(extract_json_object('prefix {"a":1} suffix')).toBe('{"a":1}')
  })

  it('abstains when there is no opening brace', () => {
    expect(extract_json_object('hello}')).toBeUndefined()
    expect(extract_json_object('plain text')).toBeUndefined()
  })

  it('abstains when the closing brace precedes the opening brace', () => {
    expect(extract_json_object('} {')).toBeUndefined()
  })
})

describe('judge step ids', () => {
  it('judge_equals is a step named judge_equals', () => {
    expect(judge_equals().id).toBe('judge_equals')
  })

  it('judge_with is a step named judge_with', () => {
    expect(judge_with(zero_fn).id).toBe('judge_with')
  })

  it('judge_llm composes named build_prompt and parse steps', () => {
    const j = judge_llm<string, string>({ model: step('m', (s: string) => s), rubric: 'r' })
    const ids = collect_ids(describe_flow.json(j))
    expect(ids).toContain('judge_llm_build_prompt')
    expect(ids).toContain('judge_llm_parse')
  })
})

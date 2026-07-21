/**
 * Stock judges for `bench`.
 *
 * A `Judge<I, O, S>` is a `Step<{ input, output, meta }, S>`: just a step
 * that scores a flow's input/output/metadata triple. Returning `undefined`
 * (or throwing) means the judge abstains; bench records the absence as a
 * missing key in `case.scores` and excludes the case from that judge's
 * `mean_scores` denominator.
 *
 *   judge_equals: strict equality vs. `meta.expected`
 *   judge_with:   wrap a user-supplied scoring function
 *   judge_llm:    prompt a model + parse the rubric score out of the reply
 *
 * `judge_llm` is engine-agnostic: callers pass their already-configured
 * model_call step (`Step<string, string>`), which keeps composites decoupled
 * from engine. The user-facing wiring lives in their own code.
 */

import { compose, sequence, step } from '#core'
import type { Step } from '#core'
import { normalize_score } from './bench.js'
import type { Judge, JudgeArgs, Score } from './bench.js'

/**
 * Narrows an unknown value to a plain string-keyed record (non-null object,
 * not an array).
 */
export function is_record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Structural equality over JSON-shaped values: primitives by `===`, arrays
 * element-wise, records key-by-key with sorted keys. Anything else (class
 * instances, functions) only compares equal by reference.
 */
export function deep_equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // null, primitives, and array/record mismatches all fall through to the
  // Array.isArray and is_record guards below, so no separate null/typeof
  // pre-checks are needed.
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (!deep_equal(a[i], b[i])) return false
    }
    return true
  }
  if (!is_record(a) || !is_record(b)) return false
  const ak = Object.keys(a).toSorted()
  const bk = Object.keys(b).toSorted()
  if (ak.length !== bk.length) return false
  for (let i = 0; i < ak.length; i += 1) {
    const ka = ak[i]
    const kb = bk[i]
    if (ka === undefined || kb === undefined || ka !== kb) return false
    if (!deep_equal(a[ka], b[kb])) return false
  }
  return true
}

/**
 * Judge that scores 1 when the output deep-equals `meta.expected`, 0
 * otherwise. Abstains when the case has no `meta` or no `expected` key.
 */
export function judge_equals<O>(): Judge<unknown, O> {
  return step('judge_equals', (args: JudgeArgs<unknown, O>): Score | undefined => {
    if (args.meta === undefined) return undefined
    if (!('expected' in args.meta)) return undefined
    const expected = args.meta['expected']
    const matches = deep_equal(args.output, expected)
    return { score: matches ? 1 : 0, reason: matches ? 'match' : 'mismatch' }
  })
}

export type JudgeWithFn<I, O> = (
  args: JudgeArgs<I, O>,
) => number | Score | undefined | Promise<number | Score | undefined>

/**
 * Wraps a plain scoring function as a Judge. The function may return a bare
 * number, a `Score`, or `undefined` to abstain; the result is normalized
 * via `normalize_score`.
 */
export function judge_with<I, O>(fn: JudgeWithFn<I, O>): Judge<I, O> {
  return step('judge_with', async (args: JudgeArgs<I, O>): Promise<Score | undefined> => {
    const raw = await fn(args)
    return normalize_score(raw)
  })
}

export type JudgeLlmConfig = {
  readonly model: Step<string, string>
  readonly rubric: string
  readonly scale?: { readonly min: number; readonly max: number }
}

/**
 * Judge that prompts a model with a rubric and parses the score out of the
 * reply.
 *
 * Built as a three-step sequence: render the rubric prompt, run the
 * caller-supplied model step, parse the JSON score from the reply. An
 * unparseable reply makes the judge abstain rather than fail the case.
 */
export function judge_llm<I, O>(config: JudgeLlmConfig): Judge<I, O> {
  const scale = config.scale ?? { min: 0, max: 1 }
  const build_prompt = step('judge_llm_build_prompt', (args: JudgeArgs<I, O>): string =>
    render_prompt(config.rubric, scale, args),
  )
  const parse = step('judge_llm_parse', (reply: string): Score | undefined =>
    parse_score(reply, scale),
  )
  const inner = sequence([build_prompt, config.model, parse])
  return compose('judge_llm', inner)
}

/**
 * Renders the evaluator prompt: rubric, required JSON reply shape with the
 * score scale, and the case's input/output serialized as JSON.
 */
export function render_prompt<I, O>(
  rubric: string,
  scale: { min: number; max: number },
  args: JudgeArgs<I, O>,
): string {
  return [
    `You are an evaluator. Score the model output against the rubric below.`,
    ``,
    `Rubric:`,
    rubric,
    ``,
    `Return a single line of JSON with exactly two keys: {"score": <number ${String(scale.min)}..${String(scale.max)}>, "reason": "<short>"}.`,
    `Do not include prose outside the JSON.`,
    ``,
    `Input:`,
    JSON.stringify(args.input),
    ``,
    `Output:`,
    JSON.stringify(args.output),
  ].join('\n')
}

/**
 * Parses a model reply into a `Score`, or `undefined` (abstain) when no
 * valid JSON object with a finite numeric `score` can be extracted.
 *
 * Tolerates prose around the JSON via `extract_json_object` and clamps the
 * score into the configured scale rather than rejecting out-of-range values.
 */
export function parse_score(
  reply: string,
  scale: { min: number; max: number },
): Score | undefined {
  const trimmed = reply.trim()
  const candidate = extract_json_object(trimmed)
  if (candidate === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return undefined
  }
  if (!is_record(parsed)) return undefined
  const raw_score = parsed['score']
  if (typeof raw_score !== 'number' || !Number.isFinite(raw_score)) return undefined
  const clamped = Math.max(scale.min, Math.min(scale.max, raw_score))
  const raw_reason = parsed['reason']
  const reason = typeof raw_reason === 'string' ? raw_reason : undefined
  return reason === undefined ? { score: clamped } : { score: clamped, reason }
}

/**
 * Pulls the outermost `{...}` slice out of a reply that may wrap the JSON
 * in prose or code fences. Returns the text as-is when it already starts
 * with `{`.
 */
export function extract_json_object(text: string): string | undefined {
  if (text.startsWith('{')) return text
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return undefined
  return text.slice(start, end + 1)
}

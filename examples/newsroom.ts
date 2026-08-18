/**
 * newsroom: the vocabulary tour. A brief goes in, a signed-off article
 * comes out, and every primary primitive appears once, in its suggested
 * role, visible in one builder. This is a tour, not a template: a real app
 * needs the subset its problem calls for (docs/blueprint.md, anti-pattern 8).
 *
 * The shape is three layers: model boundaries as leaves (`model_step`, one
 * `model_call` where the shell wants the usage envelope), named arms
 * composed from primitives (hardening, selection, verification), and a
 * `chain` spine that sequences the arms with `ctx.call`, declaring each as
 * `arm` metadata so `describe` renders the full tree.
 *
 *   chain 'brief'
 *     ├ inputs    ← parallel { corpus: branch(update? prior : research), style }
 *     │             research = sequence(urls → map(fetch hardened by
 *     │             retry/timeout/fallback, checkpoint per url) → widen loop)
 *     ├ stage 'gathered' (narrow the record)
 *     ├ outline   ← outliner (model_step)
 *     ├ article   ← adversarial(draft ensemble_step judged by a model, critique)
 *     ├ checked   ← consensus of three fact checkers
 *     ├ headline  ← model_call (the envelope carries usage for the cost line)
 *     ├ stage 'editorial'
 *     ├ signed    ← suspend (editor sign-off; resumed via run.until_suspended)
 *     └ output: render the article markdown
 *
 * Demoted vocabulary, deliberately absent: `scope`/`stash`/`use` (the
 * low-level state primitives `chain` supersedes), `tournament` and plain
 * `ensemble` (pick-best variants; see ensemble_judge.ts), and the
 * self-improvement pair `improve`/`learn` (see improve.ts and learn.ts;
 * `learn` runs over recorded trajectories, never in the request path).
 *
 * Runs keyless against a stub engine routed by system-prompt prefix. The
 * run suspends at the editor gate; main resumes it with canned approval.
 *
 * Run directly:
 *   pnpm exec tsx examples/newsroom.ts
 */

import { z } from 'zod'

import {
  adversarial,
  branch,
  chain,
  checkpoint,
  compose,
  consensus,
  describe,
  ensemble_step,
  fallback,
  loop,
  map,
  model_call,
  model_step,
  parallel,
  pipe,
  retry,
  run,
  sequence,
  step,
  suspend,
  timeout,
} from 'fascicle'
import { make_stub_engine } from 'fascicle/testing'
import type { AdversarialBuildInput, Engine, Step } from 'fascicle'

// ---- domain types and schemas ---------------------------------------------

type Brief = { readonly kind: 'fresh' | 'update'; readonly topic: string }
type Corpus = ReadonlyArray<{ readonly url: string; readonly summary: string }>

const outline_schema = z.object({ angle: z.string(), sections: z.array(z.string()).min(1) })
const draft_schema = z.object({ body: z.string() })
const score_schema = z.object({ score: z.number() })
const critique_schema = z.object({ notes: z.string(), verdict: z.enum(['ship', 'revise']) })
const verdict_schema = z.object({ ok: z.boolean() })
const headline_schema = z.object({ title: z.string() })

type Draft = z.infer<typeof draft_schema>

// ---- a tiny in-memory web, so the research arm has something to do --------

const WEB: Record<string, string> = {
  'site:a': 'Chains compose named steps over a typed record.',
  'site:b': 'Stage boundaries narrow state between phases.',
  'site:archive-only': 'Direct-style bodies call steps with ctx.call.',
}

function fetch_page(url: string): string {
  const page = WEB[url]
  if (page === undefined || url.includes('archive-only')) throw new Error(`fetch failed: ${url}`)
  return page
}

function fetch_archive(url: string): string {
  return WEB[url] ?? `archived stub for ${url}`
}

// ---- the flow -------------------------------------------------------------

export function build_flow(engine: Engine): Step<Brief, string> {
  // leaves: every model boundary, one role each, routed by system prefix
  const summarize = model_step({ engine, system: 'newsroom/summarize', id: 'summarize' })
  const outliner = model_step({ engine, system: 'newsroom/outline', schema: outline_schema, id: 'outline' })
  const draft_as = (voice: string) =>
    model_step({ engine, system: `newsroom/draft_${voice}`, schema: draft_schema, id: `draft_${voice}` })
  const style_judge = model_step({ engine, system: 'newsroom/judge', schema: score_schema, id: 'style_judge' })
  const critic = model_step({ engine, system: 'newsroom/critique', schema: critique_schema, id: 'critique' })
  const checker = (n: number) =>
    model_step({ engine, system: 'newsroom/check', schema: verdict_schema, id: `check_${n}` })
  // model_call, not model_step: the output step below reads usage off the envelope
  const headliner = model_call({ engine, system: 'newsroom/headline', schema: headline_schema, id: 'headline' })

  // research arm: harden the fetch, cache per url, fan out with a cap
  const research_one: Step<string, Corpus[number]> = checkpoint(
    sequence([
      fallback(timeout(retry(step('fetch', fetch_page), { max_attempts: 2 }), 5_000), step('fetch_archive', fetch_archive)),
      pipe(summarize, (summary) => ({ url: 'source', summary })),
    ]),
    { key: (url) => `research:${url}` },
  )
  const research = compose(
    'research',
    sequence([
      step('urls', (b: Brief) => Object.keys(WEB).filter(() => b.kind === 'fresh')),
      map({ items: (urls: ReadonlyArray<string>) => urls, do: research_one, concurrency: 2 }),
    ]),
  )

  // widen until coverage suffices; the loop body is itself a small chain
  const widen = loop<Corpus, Corpus, Corpus>({
    name: 'widen',
    init: (c) => c,
    body: chain<Corpus, 'corpus'>('corpus')
      .step('more', ({ corpus }) => (corpus.length < 3 ? [{ url: 'follow-up', summary: 'related coverage stub' }] : []))
      .output(({ corpus, more }) => [...corpus, ...more]),
    guard: step('enough', (c: Corpus) => ({ stop: c.length >= 3, state: c })),
    finish: (c) => c,
    max_rounds: 3,
  })

  // drafting arm: pick the best voice with a model judge, then critique-revise
  const draft_best = ensemble_step_of_drafts(draft_as, style_judge)
  const polish = adversarial({
    build: sequence([
      step('draft_prompt', (b: AdversarialBuildInput<string, Draft>) =>
        b.critique === undefined ? b.input : `${b.input}\n\nRevise per: ${b.critique}`),
      draft_best,
    ]),
    critique: sequence([step('critique_prompt', (d: Draft) => d.body), critic]),
    accept: (c) => c['verdict'] === 'ship',
    max_rounds: 3,
    project: (r) => r.candidate,
  })

  // verification arm: three independent checkers must agree
  const fact_gate = consensus({
    members: { first: checker(1), second: checker(2), third: checker(3) },
    agree: (verdicts) => Object.values(verdicts).every((v) => v.ok),
    max_rounds: 2,
    project: (v) => v.converged,
  })

  // the human gate: suspend until the editor resumes with a decision
  const editor_gate = suspend({
    id: 'editor_signoff',
    on: () => {},
    resume_schema: z.object({ approved: z.boolean(), notes: z.string() }),
    combine: (draft: Draft, resume) => ({ ...draft, editor_notes: resume.notes }),
  })

  // the spine; each binding that invokes an arm also declares it as `arm`
  // metadata, so `describe` renders the arm's subtree under the binding
  const gather = parallel_inputs(research, widen)
  return chain<Brief, 'brief'>('brief')
    .step('inputs', ({ brief }, ctx) => ctx.call(gather, brief), { arm: gather })
    .stage('gathered', ({ brief, inputs }) => ({ brief, corpus: inputs.corpus, style: inputs.style }))
    .step('outline', ({ brief, corpus }, ctx) =>
      ctx.call(outliner, `Topic: ${brief.topic}\nSources:\n${corpus.map((c) => c.summary).join('\n')}`),
      { arm: outliner })
    .step('article', ({ outline, style }, ctx) =>
      ctx.call(polish, `Angle: ${outline.angle}\nSections: ${outline.sections.join(', ')}\nStyle: ${style}`),
      { arm: polish })
    .step('verified', ({ article }, ctx) => ctx.call(fact_gate, article.body), { arm: fact_gate })
    .step('headline', ({ outline }, ctx) => ctx.call(headliner, outline.angle), { arm: headliner })
    .stage('editorial')
    .step('signed', ({ article }, ctx) => ctx.call(editor_gate, article), { arm: editor_gate })
    .output(({ signed, headline, verified }) => {
      const tokens = headline.usage.input_tokens + headline.usage.output_tokens
      const check = verified ? 'fact-checked' : 'UNVERIFIED'
      return `# ${headline.content.title}\n\n${signed.body}\n\n(${check}; editor: ${signed.editor_notes}; headline cost: ${tokens} tokens)\n`
    })
}

/**
 * The pick-best drafting step: two voices, scored by a model judge.
 * `project` unwraps the winner at the source, so the arm's type is the
 * draft itself rather than the pick-best envelope.
 */
function ensemble_step_of_drafts(
  draft_as: (voice: string) => Step<string, Draft>,
  style_judge: Step<string, { score: number }>,
): Step<string, Draft> {
  return ensemble_step({
    members: { formal: draft_as('formal'), breezy: draft_as('breezy') },
    score: sequence([step('to_text', (d: Draft) => d.body), style_judge]),
    rank_by: (s) => s.score,
    project: (e) => e.winner,
  })
}

/**
 * Heterogeneous gather: research plus the style guide, concurrently.
 */
function parallel_inputs(research: Step<Brief, Corpus>, widen: Step<Corpus, Corpus>) {
  return parallel({
    corpus: branch({
      when: (b: Brief) => b.kind === 'update',
      then: step('prior_corpus', (): Corpus => [{ url: 'archive', summary: 'prior coverage' }]),
      otherwise: sequence([research, widen]),
    }),
    style: step('style_guide', () => 'concise, active voice'),
  })
}

// ---- canned responses routed by system prefix (fascicle/testing) ----------

const CANNED: ReadonlyArray<{ readonly prefix: string; readonly content: unknown }> = [
  { prefix: 'newsroom/summarize', content: 'summarized source material' },
  { prefix: 'newsroom/outline', content: { angle: 'Composition you can read', sections: ['spine', 'arms', 'leaves'] } },
  { prefix: 'newsroom/draft_formal', content: { body: 'The topology is the file.' } },
  { prefix: 'newsroom/draft_breezy', content: { body: 'Read the flow top to bottom and you have the app.' } },
  { prefix: 'newsroom/judge', content: { score: 0.9 } },
  { prefix: 'newsroom/critique', content: { notes: 'clean', verdict: 'ship' } },
  { prefix: 'newsroom/check', content: { ok: true } },
  { prefix: 'newsroom/headline', content: { title: 'The Topology Is the File' } },
]

// ---- main: print the topology, run to the gate, resume, print the article -

export async function run_newsroom(): Promise<string> {
  const engine = make_stub_engine(CANNED)
  const flow = build_flow(engine)
  const brief: Brief = { kind: 'fresh', topic: 'legible agent composition' }
  try {
    const outcome = await run.until_suspended(flow, brief, { install_signal_handlers: false })
    if (outcome.kind !== 'suspended') throw new Error('expected the editor gate to suspend')
    const resumed = await outcome.resume({ approved: true, notes: 'ship it' })
    if (resumed.kind !== 'done') throw new Error('expected the resumed run to finish')
    return resumed.output
  } finally {
    await engine.dispose()
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const engine = make_stub_engine(CANNED)
  console.log(describe(build_flow(engine)))
  console.log('--- run: suspends at the editor gate, resumes with approval ---\n')
  run_newsroom()
    .then((article) => {
      console.log(article)
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}

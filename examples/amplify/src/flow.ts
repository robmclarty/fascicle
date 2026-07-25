/**
 * amplify flow: pure fascicle composition.
 *
 * Read top-to-bottom and you see the agent topology:
 *
 *   scope
 *     ├ stash BRIEF      ← the task, target dir, and metric
 *     ├ stash BASELINE   ← score the starter file as it stands
 *     ├ stash RESEARCH   ← fallback(web researcher, offline researcher)
 *     ├ seed round state ← parent contents + baseline + budget
 *     └ loop({ max_rounds, guard: budget/plateau })
 *         └ scope
 *             ├ stash ROUND      ← open the round (bumps the counters)
 *             ├ stash CANDIDATES ← map(propose, N) → map(score, 1)
 *             └ branch (round accepted?)
 *                 then ─ commit the winner as the new parent
 *                 otherwise ─ keep the parent, bank the lessons
 *
 * Three things this shape buys over the imperative version: the stop rule is
 * a `guard` on the `loop` rather than a `while` condition, the accept/reject
 * decision is a `branch` that shows up in the trajectory, and round-to-round
 * progress is loop carry-state instead of mutable closure variables.
 *
 * Proposals fan out concurrently; scoring runs at concurrency 1 because each
 * candidate is swapped into the metric's mutable path while it is evaluated.
 */

import {
  branch,
  fallback,
  loop,
  map,
  scope,
  sequence,
  stash,
  step,
  use,
  type Engine,
  type GenerateResult,
  type LoopResult,
  type Step,
} from 'fascicle'

import { stop_reason } from './budget.js'
import { format_propose_message, format_research_message } from './messages.js'
import {
  begin_round,
  build_proposer_inputs,
  decide_round,
  initial_round_state,
  summarize_run,
} from './round.js'
import type { CandidateScorer } from './services/evaluate.js'
import type { Workspace } from './services/workspace.js'
import {
  K,
  read_baseline,
  read_brief,
  read_candidates,
  read_proposer,
  read_research,
  read_round,
} from './state.js'
import { make_proposer_call, type Proposal } from './stages/proposer.js'
import { make_offline_researcher_call, make_web_researcher_call } from './stages/researcher.js'
import type {
  Brief,
  BudgetConfig,
  Candidate,
  CandidateSpec,
  FlowModels,
  ProposerInput,
  RoundOutcome,
  RoundState,
  RunSummary,
} from './types.js'

const RESEARCH_MAX_CHARS = 2_000

export type ResearchMode = 'web' | 'offline'

export type FlowEnv = {
  readonly candidates_per_round: number
  readonly budget: BudgetConfig
  readonly research: ResearchMode
  /** File-system surface: reading, committing, and caching artifacts. */
  readonly workspace: Workspace
  /** Cascade evaluator: archive, syntax, gate, measure. */
  readonly score: CandidateScorer
  /** Injected so tests can pin the clock; defaults to the real one. */
  readonly now?: () => number
}

function clamp_research(s: string): string {
  return s.length <= RESEARCH_MAX_CHARS ? s : `${s.slice(0, RESEARCH_MAX_CHARS)}\n…(truncated)`
}

export function build_flow(engine: Engine, models: FlowModels, env: FlowEnv): Step<Brief, RunSummary> {
  const now = env.now ?? (() => Date.now())
  const proposer_call = make_proposer_call(engine, models.proposer)

  const baseline_subflow: Step<unknown, number> = sequence([
    use([K.BRIEF], (s) => read_brief(s)),
    step('measure_baseline', async (brief: Brief) => {
      const parent = await env.workspace.read_parent(brief.metric.mutable_path)
      const candidate = await env.score(brief, 0, {
        content: parent,
        rationale: 'baseline: the starter file, unmodified',
        proposer_id: 'baseline',
      })
      if (!candidate.score.accepted) {
        throw new Error(
          `baseline: starter file failed the ${String(candidate.score.stage_failed)} stage. Tail:\n${candidate.score.tail ?? '(no tail)'}`,
        )
      }
      return candidate.score.value
    }),
  ])

  const extract_research = step(
    'extract_research',
    (r: GenerateResult) => clamp_research(r.content),
  )

  const web_research: Step<unknown, string> = sequence([
    use([K.BRIEF], (s) => format_research_message(read_brief(s))),
    make_web_researcher_call(engine, models.researcher),
    extract_research,
  ])

  const offline_research: Step<unknown, string> = sequence([
    use([K.BRIEF], (s) => format_research_message(read_brief(s))),
    make_offline_researcher_call(engine, models.researcher),
    extract_research,
  ])

  // The web tool is absent on older CLIs and can fail outright; degrading to
  // the offline researcher is an edge in the topology, not a buried try/catch.
  const research_subflow: Step<unknown, string> = sequence([
    env.research === 'offline' ? offline_research : fallback(web_research, offline_research),
    use([K.BRIEF], async (s, summary: string) => {
      await env.workspace.cache_research(read_brief(s).run_dir, summary)
      return summary
    }),
  ])

  const seed_round_state: Step<unknown, RoundState> = sequence([
    use([K.BRIEF], (s) => read_brief(s).metric.mutable_path),
    step('read_parent', (path: string) => env.workspace.read_parent(path)),
    use([K.BASELINE], (s, parent_content: string) =>
      initial_round_state(parent_content, read_baseline(s), env.budget, now()),
    ),
  ])

  const propose_subflow: Step<ProposerInput, CandidateSpec> = scope([
    stash(K.PROPOSER, step('init_proposer', (i: ProposerInput) => i)),
    use([K.PROPOSER], (s) => format_propose_message(read_proposer(s))),
    proposer_call,
    use([K.PROPOSER], (s, r: GenerateResult<Proposal>) => ({
      proposer_id: read_proposer(s).proposer_id,
      rationale: r.content.rationale,
      content: r.content.content,
    })),
  ])

  const score_subflow: Step<CandidateSpec, Candidate> = sequence([
    use([K.BRIEF, K.ROUND], (s, spec: CandidateSpec) => ({
      brief: read_brief(s),
      round: read_round(s).round,
      spec,
    })),
    step('score_candidate', (a: { brief: Brief; round: number; spec: CandidateSpec }) =>
      env.score(a.brief, a.round, a.spec),
    ),
    step('record_candidate', (c: Candidate, ctx) => {
      ctx.trajectory.record({
        kind: 'amplify.candidate',
        proposer_id: c.spec.proposer_id,
        accepted: c.score.accepted,
        stage_failed: c.score.stage_failed ?? null,
        value: c.score.accepted ? c.score.value : null,
      })
      return c
    }),
  ])

  const candidates_subflow: Step<unknown, ReadonlyArray<Candidate>> = sequence([
    use([K.BRIEF, K.RESEARCH, K.ROUND], (s) =>
      build_proposer_inputs(read_brief(s), read_research(s), read_round(s), env.candidates_per_round),
    ),
    map({
      name: 'propose',
      items: (inputs: ReadonlyArray<ProposerInput>) => inputs,
      do: propose_subflow,
      concurrency: env.candidates_per_round,
    }),
    map({
      name: 'score',
      items: (specs: ReadonlyArray<CandidateSpec>) => specs,
      do: score_subflow,
      concurrency: 1,
    }),
  ])

  const commit_winner: Step<RoundOutcome, RoundState> = sequence([
    use([K.BRIEF], async (s, o: RoundOutcome) => {
      await env.workspace.commit_parent(read_brief(s).metric.mutable_path, o.next_state.parent_content)
      return o
    }),
    step('take_next_state', (o: RoundOutcome) => o.next_state),
  ])

  const round_body: Step<RoundState, RoundState> = scope([
    stash(K.ROUND, step('open_round', (s: RoundState) => begin_round(s))),
    stash(K.CANDIDATES, candidates_subflow),
    use([K.BRIEF, K.ROUND, K.CANDIDATES], (s) =>
      decide_round(read_brief(s), read_round(s), read_candidates(s)),
    ),
    step('record_round', (o: RoundOutcome, ctx) => {
      ctx.trajectory.record({ kind: 'amplify.round', ...o.record })
      return o
    }),
    branch<RoundOutcome, RoundState>({
      name: 'round_accepted',
      when: (o) => o.accepted,
      then: commit_winner,
      otherwise: step('keep_parent', (o: RoundOutcome) => o.next_state),
    }),
  ])

  const round_loop = loop<RoundState, RoundState, RoundState>({
    name: 'amplify_rounds',
    init: (input) => input,
    body: round_body,
    guard: step('check_budget', (s: RoundState) => ({
      stop: stop_reason(s.budget, now()) !== undefined,
      state: s,
    })),
    finish: (state) => state,
    max_rounds: env.budget.max_rounds,
  })

  return scope([
    stash(K.BRIEF, step('init_brief', (b: Brief) => b)),
    stash(K.BASELINE, baseline_subflow),
    stash(K.RESEARCH, research_subflow),
    seed_round_state,
    round_loop,
    use([K.BRIEF], (s, r: LoopResult<RoundState>) =>
      summarize_run(r.value, read_brief(s).metric.direction, stop_reason(r.value.budget, now()) ?? 'max_rounds'),
    ),
  ])
}

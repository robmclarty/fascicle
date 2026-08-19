/**
 * amplify flow: pure Fascicle composition.
 *
 * Read top-to-bottom and you see the agent topology:
 *
 *   chain 'brief'
 *     ├ baseline ← score the starter file as it stands
 *     ├ research ← fallback(web researcher, offline researcher), cached
 *     ├ seeded   ← parent contents + baseline + budget
 *     └ rounds   ← loop({ max_rounds, guard: budget/plateau })
 *         └ chain 'carry' (one round)
 *             ├ round      ← open the round (bumps the counters)
 *             ├ inputs     ← per-proposer inputs (research + lessons)
 *             ├ specs      ← map(propose, N concurrent)
 *             ├ candidates ← map(score, concurrency 1)
 *             ├ outcome    ← decide_round (winner, accept/reject, lessons)
 *             └ settled    ← branch (accepted? commit winner : keep parent)
 *
 * Three things this shape buys over the imperative version: the stop rule is
 * a `guard` on the `loop` rather than a `while` condition, the accept/reject
 * decision is a `branch` that shows up in the trajectory, and round-to-round
 * progress is loop carry-state (`{ brief, research, state }`) instead of
 * mutable closure variables or ambient scope keys.
 *
 * Proposals fan out concurrently; scoring runs at concurrency 1 because each
 * candidate is swapped into the metric's mutable path while it is evaluated.
 */

import {
  branch,
  chain,
  fallback,
  loop,
  map,
  pipe,
  sequence,
  step,
  type Engine,
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
import { make_proposer_step } from './stages/proposer.js'
import { make_offline_researcher_step, make_web_researcher_step } from './stages/researcher.js'
import type {
  Brief,
  BudgetConfig,
  Candidate,
  CandidateSpec,
  FlowModels,
  ProposerInput,
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

// Loop carry-state for the round loop: the brief and research summary ride
// alongside the mutable round state so the loop body is a static Step.
type RoundCarry = {
  readonly brief: Brief
  readonly research: string
  readonly state: RoundState
}

type ScoreItem = {
  readonly brief: Brief
  readonly round: number
  readonly spec: CandidateSpec
}

function clamp_research(s: string): string {
  return s.length <= RESEARCH_MAX_CHARS ? s : `${s.slice(0, RESEARCH_MAX_CHARS)}\n…(truncated)`
}

export function build_flow(engine: Engine, models: FlowModels, env: FlowEnv): Step<Brief, RunSummary> {
  const now = env.now ?? (() => Date.now())
  const proposer = make_proposer_step(engine, models.proposer)

  // The web tool is absent on older CLIs and can fail outright; degrading to
  // the offline researcher is an edge in the topology, not a buried try/catch.
  const research_prompt = step('research_prompt', (b: Brief) => format_research_message(b))
  const web_research: Step<Brief, string> = sequence([
    research_prompt,
    pipe(make_web_researcher_step(engine, models.researcher), clamp_research),
  ])
  const offline_research: Step<Brief, string> = sequence([
    research_prompt,
    pipe(make_offline_researcher_step(engine, models.researcher), clamp_research),
  ])
  const research_arm: Step<Brief, string> =
    env.research === 'offline' ? offline_research : fallback(web_research, offline_research)

  const propose_one: Step<ProposerInput, CandidateSpec> = step(
    'propose_one',
    async (input, ctx) => {
      const proposal = await ctx.call(proposer, format_propose_message(input))
      return {
        proposer_id: input.proposer_id,
        rationale: proposal.rationale,
        content: proposal.content,
      }
    },
  )
  const propose_each = map({
    name: 'propose',
    items: (inputs: ReadonlyArray<ProposerInput>) => inputs,
    do: propose_one,
    concurrency: env.candidates_per_round,
  })

  const score_one: Step<ScoreItem, Candidate> = step('score_candidate', async (item, ctx) => {
    const candidate = await env.score(item.brief, item.round, item.spec)
    ctx.trajectory.record({
      kind: 'amplify.candidate',
      proposer_id: candidate.spec.proposer_id,
      accepted: candidate.score.accepted,
      stage_failed: candidate.score.stage_failed ?? null,
      value: candidate.score.accepted ? candidate.score.value : null,
    })
    return candidate
  })
  const score_each = map({
    name: 'score',
    items: (items: ReadonlyArray<ScoreItem>) => items,
    do: score_one,
    concurrency: 1,
  })

  const settle = branch<{ brief: Brief; next_state: RoundState; accepted: boolean }, RoundState>({
    name: 'round_accepted',
    when: (o) => o.accepted,
    then: step('commit_winner', async (o) => {
      await env.workspace.commit_parent(o.brief.metric.mutable_path, o.next_state.parent_content)
      return o.next_state
    }),
    otherwise: step('keep_parent', (o) => o.next_state),
  })

  const round_body = chain<RoundCarry, 'carry'>('carry')
    .step('round', ({ carry }) => begin_round(carry.state))
    .step('inputs', ({ carry, round }) =>
      build_proposer_inputs(carry.brief, carry.research, round, env.candidates_per_round))
    .step('specs', ({ inputs }, ctx) => ctx.call(propose_each, inputs), { arm: propose_each })
    .step('candidates', ({ carry, round, specs }, ctx) =>
      ctx.call(score_each, specs.map((spec) => ({ brief: carry.brief, round: round.round, spec }))),
      { arm: score_each })
    .step('outcome', ({ carry, round, candidates }, ctx) => {
      const outcome = decide_round(carry.brief, round, candidates)
      ctx.trajectory.record({ kind: 'amplify.round', ...outcome.record })
      return outcome
    })
    .step('settled', ({ carry, outcome }, ctx) =>
      ctx.call(settle, { brief: carry.brief, next_state: outcome.next_state, accepted: outcome.accepted }),
      { arm: settle })
    .output(({ carry, settled }): RoundCarry => ({ ...carry, state: settled }))

  const round_loop = loop<RoundCarry, RoundCarry, RoundState>({
    name: 'amplify_rounds',
    init: (c) => c,
    body: round_body,
    guard: step('check_budget', (c: RoundCarry) => ({
      stop: stop_reason(c.state.budget, now()) !== undefined,
      state: c,
    })),
    finish: (c) => c.state,
    max_rounds: env.budget.max_rounds,
  })

  return chain<Brief, 'brief'>('brief')
    .step('baseline', async ({ brief }) => {
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
    })
    .step('research', async ({ brief }, ctx) => {
      const summary = await ctx.call(research_arm, brief)
      await env.workspace.cache_research(brief.run_dir, summary)
      return summary
    }, { arm: research_arm })
    .step('seeded', async ({ brief, baseline }) => {
      const parent = await env.workspace.read_parent(brief.metric.mutable_path)
      return initial_round_state(parent, baseline, env.budget, now())
    })
    .step('rounds', ({ brief, research, seeded }, ctx) =>
      ctx.call(round_loop, { brief, research, state: seeded }), { arm: round_loop })
    .output(({ brief, rounds }) =>
      summarize_run(rounds, brief.metric.direction, stop_reason(rounds.budget, now()) ?? 'max_rounds'),
    )
}

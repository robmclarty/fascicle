/**
 * improve: bounded online self-improvement with a toy scoring function.
 *
 * Optimizes a single integer toward a fixed target. The propose step walks
 * `parent + 1` each round; the score step rewards proximity to `TARGET` via
 * `-(value - TARGET)^2`. Once the loop overshoots, plateau detection trips
 * and the run stops. No engine layer, no network, no LLM calls — every step
 * is pure TypeScript.
 *
 * Run directly:
 *   pnpm exec tsx examples/improve.ts
 */

import {
  improve,
  run,
  step,
  type Candidate,
  type ImproveResult,
  type ImproveRoundInput,
  type ScoredCandidate,
} from '@repo/fascicle'

const TARGET = 7

const seed = step('seed', () => ({
  content: 0,
  score: -((0 - TARGET) ** 2),
}))

const propose = step(
  'propose',
  (input: ImproveRoundInput<number>): Candidate<number> => ({
    content: input.parent + 1,
    proposer_id: 'p0',
    rationale: `walk toward target=${String(TARGET)}`,
  }),
)

const score = step(
  'score',
  (candidate: Candidate<number>): ScoredCandidate<number> => {
    const value = candidate.content
    const distance_squared = (value - TARGET) ** 2
    return {
      candidate,
      score: -distance_squared,
      accepted: true,
      reason: distance_squared === 0 ? 'on target' : `off by ${String(value - TARGET)}`,
    }
  },
)

export async function run_improve(): Promise<ImproveResult<number>> {
  const flow = improve<unknown, number>({
    seed,
    propose,
    score,
    budget: { max_rounds: 12, patience: 2 },
  })
  return run(flow, undefined, { install_signal_handlers: false })
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_improve()
    .then((result) => {
      console.log(`stopped by: ${result.stopped_by}`)
      console.log(`rounds:     ${String(result.rounds_used)}`)
      console.log(`best:       value=${String(result.best.content)} score=${String(result.best.score)}`)
      console.log('history:')
      for (const entry of result.history) {
        const mark = entry.accepted ? '+' : ' '
        console.log(
          `  ${mark} round ${String(entry.round)}: value=${String(entry.winner.candidate.content)} score=${String(entry.winner.score)}`,
        )
      }
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}

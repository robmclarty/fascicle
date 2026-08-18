/**
 * End-to-end flow tests through the real `run()` with a stub engine and
 * in-memory ports. Canned proposals are validated through the real proposal
 * schema, so a schema change breaks any test shipping stale fixture data.
 *
 * What these pin is the loop's decision-making: which candidate wins, when a
 * round is accepted, when the parent is committed, and which of the three stop
 * rules ends the run.
 */

import { run } from 'fascicle'
import { make_stub_engine } from 'fascicle/testing'
import { describe, expect, it } from 'vitest'

import { build_flow, type FlowEnv } from '../flow.js'
import type { CandidateScorer } from '../services/evaluate.js'
import type { Workspace } from '../services/workspace.js'
import type { Brief, Candidate, CandidateSpec, Metric } from '../types.js'

const MODELS = { proposer: 'stub', researcher: 'stub' }

const METRIC: Metric = {
  name: 'latency',
  direction: 'minimize',
  mutable_path: '/virtual/target.ts',
  gate: { command: ['true'], cwd: '/virtual' },
  score: () => 0,
}

const BRIEF: Brief = {
  task: 'make it faster',
  target_dir: '/virtual',
  metric: METRIC,
  run_id: 'test-run',
  run_dir: '/virtual/.runs/test-run',
}

function stub_engine() {
  return make_stub_engine([
    { prefix: 'amplify/researcher', content: '- use a single pass' },
    {
      prefix: 'amplify/proposer',
      content: { rationale: 'single pass', content: 'export const x = 1' },
    },
  ])
}

/** In-memory workspace: records what the flow committed, never touches disk. */
function memory_workspace(initial: string): Workspace & { readonly commits: ReadonlyArray<string> } {
  const commits: string[] = []
  let parent = initial
  return {
    commits,
    read_parent: async () => parent,
    commit_parent: async (_path, content) => {
      parent = content
      commits.push(content)
    },
    cache_research: async () => {},
  }
}

/**
 * Score candidates from a script of values, one per call after the baseline.
 * A `null` entry means the candidate died at the gate.
 */
function scripted_scorer(baseline: number, values: ReadonlyArray<number | null>): CandidateScorer {
  let i = 0
  return async (_brief, round, spec: CandidateSpec): Promise<Candidate> => {
    if (round === 0) return { spec, score: { value: baseline, accepted: true } }
    const value = values[i++ % values.length] ?? null
    if (value === null) {
      return { spec, score: { value: Number.POSITIVE_INFINITY, accepted: false, stage_failed: 'gate', tail: 'gate failed' } }
    }
    return { spec, score: { value, accepted: true } }
  }
}

function env_with(
  workspace: Workspace,
  score: CandidateScorer,
  overrides: Partial<FlowEnv> = {},
): FlowEnv {
  return {
    candidates_per_round: 1,
    research: 'offline',
    budget: { max_rounds: 5, max_wallclock_ms: 1_000_000, patience: 99 },
    workspace,
    score,
    now: () => 1_000_000,
    ...overrides,
  }
}

describe('amplify flow', () => {
  it('accepts a round that beats the parent and commits the winner', async () => {
    const workspace = memory_workspace('export const x = 0')
    const env = env_with(workspace, scripted_scorer(100, [50]), {
      budget: { max_rounds: 1, max_wallclock_ms: 1_000_000, patience: 99 },
    })
    const summary = await run(build_flow(stub_engine(), MODELS, env), BRIEF)

    expect(summary.baseline).toBe(100)
    expect(summary.final_score).toBe(50)
    expect(summary.history[0]?.accepted).toBe(true)
    expect(workspace.commits).toEqual(['export const x = 1'])
  })

  it('rejects a round that does not beat the parent and commits nothing', async () => {
    const workspace = memory_workspace('export const x = 0')
    const env = env_with(workspace, scripted_scorer(100, [120]), {
      budget: { max_rounds: 1, max_wallclock_ms: 1_000_000, patience: 99 },
    })
    const summary = await run(build_flow(stub_engine(), MODELS, env), BRIEF)

    expect(summary.final_score).toBe(100)
    expect(summary.history[0]?.accepted).toBe(false)
    expect(workspace.commits).toEqual([])
  })

  it('keeps the best of several candidates in a round', async () => {
    const workspace = memory_workspace('export const x = 0')
    const env = env_with(workspace, scripted_scorer(100, [90, 40, 70]), {
      candidates_per_round: 3,
      budget: { max_rounds: 1, max_wallclock_ms: 1_000_000, patience: 99 },
    })
    const summary = await run(build_flow(stub_engine(), MODELS, env), BRIEF)

    expect(summary.final_score).toBe(40)
    expect(summary.history[0]?.candidates).toBe(3)
  })

  it('stops on plateau before exhausting max_rounds', async () => {
    const workspace = memory_workspace('export const x = 0')
    const env = env_with(workspace, scripted_scorer(100, [120]), {
      budget: { max_rounds: 10, max_wallclock_ms: 1_000_000, patience: 2 },
    })
    const summary = await run(build_flow(stub_engine(), MODELS, env), BRIEF)

    expect(summary.stopped_by).toBe('plateau')
    expect(summary.rounds_used).toBe(2)
  })

  it('stops on the wall-clock budget', async () => {
    const workspace = memory_workspace('export const x = 0')
    let clock = 1_000_000
    const env = env_with(workspace, scripted_scorer(100, [90, 80, 70]), {
      budget: { max_rounds: 10, max_wallclock_ms: 5_000, patience: 99 },
      now: () => {
        clock += 3_000
        return clock
      },
    })
    const summary = await run(build_flow(stub_engine(), MODELS, env), BRIEF)

    expect(summary.stopped_by).toBe('budget')
    expect(summary.rounds_used).toBeLessThan(10)
  })

  it('banks a lesson when a candidate dies at the gate', async () => {
    const workspace = memory_workspace('export const x = 0')
    const env = env_with(workspace, scripted_scorer(100, [null]), {
      budget: { max_rounds: 1, max_wallclock_ms: 1_000_000, patience: 99 },
    })
    const summary = await run(build_flow(stub_engine(), MODELS, env), BRIEF)

    expect(summary.history[0]?.accepted).toBe(false)
    expect(summary.history[0]?.winner_value).toBeNull()
    expect(workspace.commits).toEqual([])
  })

  it('reports improvement as a positive percentage when minimizing', async () => {
    const workspace = memory_workspace('export const x = 0')
    const env = env_with(workspace, scripted_scorer(100, [75]), {
      budget: { max_rounds: 1, max_wallclock_ms: 1_000_000, patience: 99 },
    })
    const summary = await run(build_flow(stub_engine(), MODELS, env), BRIEF)

    expect(summary.improvement_pct).toBeCloseTo(25)
  })
})

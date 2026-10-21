import { describe as describe_flow, sequence, step } from '#core'
import { describe, expect, it } from 'vitest'
import { adversarial } from '../adversarial.js'
import { consensus } from '../consensus.js'
import { ensemble_step } from '../ensemble_step.js'
import { gate } from '../gate.js'
import { improve, type Candidate, type ImproveRoundInput, type ScoredCandidate } from '../improve.js'
import { name_parts } from '../parts.js'

const draft = step('draft', (text: string) => text, { description: 'writes a draft' })
const other = step('other', (text: string) => text)

/**
 * The draft-and-check loop from the course's commit-message lesson, as an
 * adversarial: a sequence that builds the request and calls the writer, and a
 * check written in code.
 */
function commit_loop() {
  return adversarial({
    build: sequence([
      step('ask', ({ input }: { input: string }) => input),
      step('write', (request: string) => request, { description: 'drafts a message' }),
    ]),
    critique: step('check', (message: string) => ({ notes: message.endsWith('.') ? 'drop the period' : '' }), {
      description: 'checks the house rules',
    }),
    accept: (verdict) => verdict.notes === '',
    max_rounds: 3,
  })
}

describe('composite parts', () => {
  it('draws adversarial as its build and its critique', () => {
    expect(describe_flow.diagram(commit_loop())).toBe(
      [
        'adversarial         compose',
        '├─ build  sequence',
        '│  ├─ ask           step',
        '│  └─ write         drafts a message',
        '└─ critique  check  checks the house rules',
      ].join('\n'),
    )
  })

  it('still draws the insides when asked for them', () => {
    expect(describe_flow.diagram(commit_loop(), { internals: true })).toBe(
      [
        'adversarial                 compose',
        '└─ loop',
        '   ├─ scope',
        '   │  ├─ stash',
        '   │  │  └─ snapshot        step',
        '   │  ├─ to_build_input     step',
        '   │  ├─ sequence',
        '   │  │  ├─ ask             step',
        '   │  │  └─ write           drafts a message',
        '   │  └─ use',
        '   └─ guard  scope',
        '      ├─ stash',
        '      │  └─ snapshot        step',
        '      ├─ extract_candidate  step',
        '      ├─ check              checks the house rules',
        '      └─ use',
      ].join('\n'),
    )
  })

  it('draws consensus as its members, by key', () => {
    const flow = consensus({ members: { first: draft, second: other }, agree: () => true, max_rounds: 2 })
    expect(describe_flow.diagram(flow)).toBe(
      ['consensus         compose', '├─ first  draft   writes a draft', '└─ second  other  step'].join('\n'),
    )
  })

  it('draws ensemble_step as its members and its score, keeping a member named score apart', () => {
    const judge = step('judge', (text: string) => text.length)
    const flow = ensemble_step({ members: { a: draft, score: other }, score: judge, rank_by: (n) => n })
    expect(describe_flow.diagram(flow)).toBe(
      ['ensemble_step      compose', '├─ a  draft        writes a draft', '├─ score  other    step', '└─ score_2  judge  step'].join(
        '\n',
      ),
    )
  })

  it('draws gate as its work and its approval', () => {
    const flow = gate(step('paid', (text: string) => text, { description: 'the paid work' }), { id: 'approve' })
    expect(describe_flow.diagram(flow)).toBe(['gate        compose', '├─ paid     the paid work', '└─ approve  suspend'].join('\n'))
  })

  it('draws improve as its seed, its proposer, and its score', () => {
    const flow = improve<unknown, number>({
      seed: step('seed', () => ({ content: 0, score: 0 })),
      propose: step('propose', (_input: ImproveRoundInput<number>): Candidate<number> => ({ content: 1, proposer_id: 'p0' })),
      score: step('score', (c: Candidate<number>): ScoredCandidate<number> => ({ candidate: c, score: c.content, accepted: true })),
      budget: { max_rounds: 1, patience: 1 },
    })
    expect(describe_flow.diagram(flow)).toBe(['improve     compose', '├─ seed     step', '├─ propose  step', '└─ score    step'].join('\n'))
  })

  it('names colliding roles apart, and reads a role like toString as free', () => {
    const parts = name_parts([
      ['a', draft],
      ['a', other],
      ['a', draft],
      ['toString', other],
    ])
    expect(Object.keys(parts)).toStrictEqual(['a', 'a_2', 'a_3', 'toString'])
    expect(parts['a_2']).toBe(other)
  })
})

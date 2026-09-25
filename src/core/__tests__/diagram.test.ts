import { describe as vdescribe, expect, it } from 'vitest'
import { z } from 'zod'
import { branch } from '../branch.js'
import { chain } from '../chain.js'
import { describe } from '../describe.js'
import { render_diagram } from '../diagram.js'
import { describe_cycle_error } from '../errors.js'
import { fallback } from '../fallback.js'
import { loop } from '../loop.js'
import { parallel } from '../parallel.js'
import { pipe } from '../pipe.js'
import { retry } from '../retry.js'
import { sequence } from '../sequence.js'
import { step } from '../step.js'
import { suspend } from '../suspend.js'
import type { AnyStep, Step } from '../types.js'

function leaf(id: string, description?: string): Step<number, number> {
  return description === undefined
    ? step(id, (x: number) => x)
    : step(id, (x: number) => x, { description })
}

function as_step(node: object): AnyStep {
  return node as unknown as AnyStep
}

// The shape of volley's flow, the diagram that motivated the renderer: a loop
// over a sequence, a branch, two steps that declare the arms they ctx.call,
// and a fallback over a retry and a pipe.
function volley_flow(): Step<number, number> {
  const builder = leaf('builder', 'one agentic session in the build root')
  const critic = fallback(
    retry(leaf('critic_tools', 'with read-only workspace tools'), {
      max_attempts: 2,
      description: 'one more try after a stream death, local providers only',
    }),
    pipe(leaf('critic_toolless', 'judging from the check output and a file list'), (x: number) => x),
    { name: 'critic', description: "judge without tools if a local critic's stream keeps dying" },
  )
  const build = step('build', (s: number) => s, {
    description: 'open the iteration, run the builder, measure the change',
    arm: builder,
  })
  const critique = step('critique', (s: number) => s, {
    description: "the read-only critic's verdict and feedback",
    arm: critic,
  })
  const verify = branch({
    name: 'verify',
    description: 'did the build alone cross the cost cap?',
    when: () => true,
    then: leaf('skip_verify', 'record the check as skipped and call no critic'),
    otherwise: sequence([leaf('check', 'the deterministic gate: checkride, a command, or none'), critique]),
  })
  return loop({
    name: 'volley',
    description: 'one round per iteration, up to max_iterations',
    init: (x: number) => x,
    body: sequence([build, verify, leaf('record', 'archive the iteration and rewrite the run summary')], {
      name: 'iteration',
    }),
    guard: step('gate', (s: number) => ({ stop: true, state: s }), {
      description: 'stop on approval over a green check, the cost cap, or a gate edit',
    }),
    finish: (s) => s,
    max_rounds: 3,
  })
}

const VOLLEY = [
  'volley                                loop: one round per iteration, up to max_iterations',
  '├─ iteration                          sequence',
  '│  ├─ build                           open the iteration, run the builder, measure the change',
  '│  │  └─ builder                      one agentic session in the build root',
  '│  ├─ verify                          branch: did the build alone cross the cost cap?',
  '│  │  ├─ then  skip_verify            record the check as skipped and call no critic',
  '│  │  └─ else  sequence',
  '│  │     ├─ check                     the deterministic gate: checkride, a command, or none',
  "│  │     └─ critique                  the read-only critic's verdict and feedback",
  "│  │        └─ critic                 fallback: judge without tools if a local critic's stream keeps dying",
  '│  │           ├─ retry               one more try after a stream death, local providers only',
  '│  │           │  └─ critic_tools     with read-only workspace tools',
  '│  │           └─ pipe',
  '│  │              └─ critic_toolless  judging from the check output and a file list',
  '│  └─ record                          archive the iteration and rewrite the run summary',
  '└─ guard  gate                        stop on approval over a green check, the cost cap, or a gate edit',
].join('\n')

const VOLLEY_WRAPPED = [
  ' * volley                                loop: one round per iteration,',
  ' * │                                     up to max_iterations',
  ' * ├─ iteration                          sequence',
  ' * │  ├─ build                           open the iteration, run the',
  ' * │  │  │                               builder, measure the change',
  ' * │  │  └─ builder                      one agentic session in the',
  ' * │  │                                  build root',
  ' * │  ├─ verify                          branch: did the build alone',
  ' * │  │  │                               cross the cost cap?',
  ' * │  │  ├─ then  skip_verify            record the check as skipped and',
  ' * │  │  │                               call no critic',
  ' * │  │  └─ else  sequence',
  ' * │  │     ├─ check                     the deterministic gate:',
  ' * │  │     │                            checkride, a command, or none',
  " * │  │     └─ critique                  the read-only critic's verdict",
  ' * │  │        │                         and feedback',
  ' * │  │        └─ critic                 fallback: judge without tools',
  " * │  │           │                      if a local critic's stream",
  ' * │  │           │                      keeps dying',
  ' * │  │           ├─ retry               one more try after a stream',
  ' * │  │           │  │                   death, local providers only',
  ' * │  │           │  └─ critic_tools     with read-only workspace tools',
  ' * │  │           └─ pipe',
  ' * │  │              └─ critic_toolless  judging from the check output',
  ' * │  │                                  and a file list',
  ' * │  └─ record                          archive the iteration and',
  ' * │                                     rewrite the run summary',
  ' * └─ guard  gate                        stop on approval over a green',
  ' *                                       check, the cost cap, or a gate',
  ' *                                       edit',
].join('\n')

vdescribe('describe.diagram', () => {
  it('draws a whole flow as an annotated tree', () => {
    expect(describe.diagram(volley_flow())).toBe(VOLLEY)
  })

  it('wraps descriptions to a width and prefixes every line, keeping the bars unbroken', () => {
    expect(describe.diagram(volley_flow(), { width: 72, prefix: ' * ' })).toBe(VOLLEY_WRAPPED)
  })

  it('renders the same bytes for the same flow however many flows were built first', () => {
    const first = describe.diagram(volley_flow())
    const second = describe.diagram(volley_flow())
    expect(second).toBe(first)
    expect(second).not.toMatch(/_\d/)
  })

  it('labels a node by its display name, then a chosen id, then its kind', () => {
    const flow = sequence([
      leaf('chosen'),
      step('named_id', (x: number) => x, { name: 'Shown name' }),
      step((x: number) => x),
      sequence([leaf('inner')], { name: 'group' }),
      sequence([leaf('inner2')]),
    ])
    expect(describe.diagram(flow)).toBe(
      [
        'sequence',
        '├─ chosen      step',
        '├─ Shown name  step',
        '├─ step',
        '├─ group       sequence',
        '│  └─ inner    step',
        '└─ sequence',
        '   └─ inner2   step',
      ].join('\n'),
    )
  })

  it('labels a suspend by its id', () => {
    const approve = suspend({
      id: 'approve',
      on: () => {},
      resume_schema: z.boolean(),
      combine: (x: number) => x,
    })
    expect(describe.diagram(approve)).toBe('approve  suspend')
  })

  it('labels a hand-built kind by its id, which its author chose', () => {
    expect(render_diagram({ kind: 'custom', id: 'mine' })).toBe('mine  custom')
  })

  it('shows a composer description after its kind, and alone when the kind is the label', () => {
    const flow = sequence(
      [retry(leaf('work'), { max_attempts: 2, description: 'try it twice' })],
      { name: 'top', description: 'does the work' },
    )
    expect(describe.diagram(flow)).toBe(
      ['top         sequence: does the work', '└─ retry    try it twice', '   └─ work  step'].join('\n'),
    )
  })

  it('treats an empty description as absent and collapses whitespace in the rest', () => {
    const flow = sequence([leaf('blank', ''), leaf('spread', '  spread\n   over  lines ')], { name: 'top' })
    expect(describe.diagram(flow)).toBe(
      ['top        sequence', '├─ blank   step', '└─ spread  spread over lines'].join('\n'),
    )
  })

  it("names a branch's arms then and else", () => {
    const flow = branch({ when: () => true, then: leaf('yes'), otherwise: leaf('no') })
    expect(describe.diagram(flow)).toBe(['branch', '├─ then  yes  step', '└─ else  no   step'].join('\n'))
  })

  it("names a loop's guard, including the anonymous one a predicate becomes", () => {
    const stepped = loop({
      init: (x: number) => x,
      body: leaf('body'),
      guard: step('done', (s: number) => ({ stop: true, state: s })),
      finish: (s) => s,
      max_rounds: 2,
    })
    const predicate = loop({
      init: (x: number) => x,
      body: leaf('body'),
      guard: (s: number) => s > 2,
      finish: (s) => s,
      max_rounds: 2,
    })
    const unguarded = loop({ init: (x: number) => x, body: leaf('body'), finish: (s) => s, max_rounds: 2 })
    expect(describe.diagram(stepped)).toBe(['loop', '├─ body         step', '└─ guard  done  step'].join('\n'))
    expect(describe.diagram(predicate)).toBe(['loop', '├─ body         step', '└─ guard  step'].join('\n'))
    expect(describe.diagram(unguarded)).toBe(['loop', '└─ body  step'].join('\n'))
  })

  it('names parallel members by key, unless the key repeats the label', () => {
    const flow = parallel({ same: leaf('same'), key: leaf('other') })
    expect(describe.diagram(flow)).toBe(['parallel', '├─ same        step', '└─ key  other  step'].join('\n'))
  })

  it("nests a chain's entries under the stage that spans them, arms beneath their bindings", () => {
    const flow = chain<number>()
      .step('a', (s) => s.input)
      .step('called', leaf('callee'), (s) => s.a)
      .stage('review')
      .step('b', (s) => s.a, { arm: leaf('inner') })
      .output((s) => s.b)
    expect(describe.diagram(flow)).toBe(
      [
        'chain',
        '├─ a              step',
        '├─ called         step',
        '│  └─ callee      step',
        '└─ stage  review',
        '   ├─ b           step',
        '   │  └─ inner    step',
        '   └─ output      step',
      ].join('\n'),
    )
  })

  it('draws every child of a chain node that carries no plan', () => {
    const node = { kind: 'chain', id: 'chain_1', children: [{ kind: 'step', id: 'a' }] }
    expect(render_diagram(node)).toBe(['chain', '└─ a   step'].join('\n'))
  })

  it('skips plan entries that have no child to draw', () => {
    const node = {
      kind: 'chain',
      id: 'chain_1',
      config: { plan: ['a', 'missing', 'output'] },
      children: [{ kind: 'step', id: 'a' }],
    }
    expect(render_diagram(node)).toBe(['chain', '└─ a   step'].join('\n'))
  })

  it('reads only the string keys of a parallel node, and none from a node without keys', () => {
    const keyed = {
      kind: 'parallel',
      id: 'parallel_1',
      config: { keys: [7, 'first'] },
      children: [{ kind: 'step', id: 'x' }],
    }
    const keyless = { kind: 'parallel', id: 'parallel_2', children: [{ kind: 'step', id: 'x' }] }
    expect(render_diagram(keyed)).toBe(['parallel', '└─ first  x  step'].join('\n'))
    expect(render_diagram(keyless)).toBe(['parallel', '└─ x      step'].join('\n'))
  })

  it('wraps at the width, carrying the bars of the rows that continue below', () => {
    const flow = sequence([leaf('first', 'alpha beta gamma delta'), leaf('second', 'epsilon')], {
      name: 'top',
      description: 'one two three',
    })
    expect(describe.diagram(flow, { width: 30 })).toBe(
      [
        'top        sequence: one two',
        '│          three',
        '├─ first   alpha beta gamma',
        '│          delta',
        '└─ second  epsilon',
      ].join('\n'),
    )
  })

  it('fits a word exactly as wide as the room left, and gives a longer one its own line', () => {
    const flow = sequence([leaf('a', 'abcd efgh supercalifragilistic ij')], { name: 's' })
    expect(describe.diagram(flow, { width: 14 })).toBe(
      [
        's     sequence',
        '└─ a  abcd',
        '      efgh',
        '      supercalifragilistic',
        '      ij',
      ].join('\n'),
    )
    expect(describe.diagram(flow, { width: 15 })).toBe(
      ['s     sequence', '└─ a  abcd efgh', '      supercalifragilistic', '      ij'].join('\n'),
    )
  })

  it('leaves no trailing whitespace on any line', () => {
    const lines = describe.diagram(volley_flow(), { width: 60, prefix: ' * ' }).split('\n')
    for (const line of lines) {
      expect(line.startsWith(' * ')).toBe(true)
      expect(line).not.toMatch(/\s$/)
    }
  })

  it('draws a cycle as <cycle> in loose mode and throws under strict', () => {
    const root: { id: string; kind: string; run: (x: number) => number; children: unknown[] } = {
      id: 'root',
      kind: 'k',
      run: (x: number) => x,
      children: [],
    }
    root.children.push(root)
    expect(describe.diagram(as_step(root))).toBe(['root        k', '└─ <cycle>'].join('\n'))
    expect(() => describe.diagram(as_step(root), { strict: true })).toThrow(describe_cycle_error)
  })
})

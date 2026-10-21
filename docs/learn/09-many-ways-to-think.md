# Many Ways to Think

People think about programs in different ways. Some picture data flowing
through a pipe of small functions. Some write top to bottom, one statement after
another. Some think in objects, which hold their own state and know how to do
things. Some draw boxes and arrows, states and transitions. None of these is the
right way, and Fascicle doesn't ask you to give yours up.

In this lesson you'll write the word problem solver five times, once in each of
those styles, and run all five against the same stub to show they agree. Then
you'll see why they can be mixed freely. About thirty minutes.

## Shared Pieces

Every style uses the same two model steps, so put them in one place. First, in
`solver/flow.ts`, change `const EXTRACT =` to `export const EXTRACT =`, and do
the same for `EXPLAIN`, so that other files can use the two prompts.

Then make a `styles` folder and create `styles/leaves.ts`:

```ts
// styles/leaves.ts
import { model_step } from 'fascicle'
import type { Engine, Step } from 'fascicle'
import { problem_schema } from '../solver/calc.js'
import type { Problem } from '../solver/calc.js'
import { EXPLAIN, EXTRACT } from '../solver/flow.js'

export type Leaves = { extract: Step<string, Problem>; explain: Step<string, string> }

/** The two model steps that every style shares. */
export function make_leaves(engine: Engine, model: string): Leaves {
  return {
    extract: model_step({ engine, model, system: EXTRACT, schema: problem_schema, id: 'extract' }),
    explain: model_step({ engine, model, system: EXPLAIN, id: 'explain' }),
  }
}

export function explain_prompt(question: string, answer: number): string {
  return `Problem: ${question}\nAnswer: ${answer}`
}
```

The `Leaves` type says that both steps take a plain string. A model step
accepts a list of chat messages too, and saying "just a string" up front keeps
the types simple once the steps get combined with others.

## The Pipeline

*For when you think in data flowing through functions.*

Every stage is a transformation that takes the previous stage's output.
When a value has to travel past a stage that doesn't need it, a `parallel`
forks it around that stage. Create `styles/pipeline.ts`:

```ts
// styles/pipeline.ts
import { parallel, sequence, step } from 'fascicle'
import type { Engine, Step } from 'fascicle'
import { calculate } from '../solver/calc.js'
import type { Problem } from '../solver/calc.js'
import { explain_prompt, make_leaves } from './leaves.js'

type Read = { question: string; problem: Problem }
type Solved = { question: string; answer: number }
type Told = { answer: number; explanation: string }

export function build_pipeline(engine: Engine, model: string): Step<string, string> {
  const { extract, explain } = make_leaves(engine, model)
  return sequence([
    parallel({ question: step('keep_question', (q: string) => q), problem: extract }),
    step('solve', ({ question, problem }: Read): Solved => ({ question, answer: calculate(problem) })),
    parallel({
      answer: step('keep_answer', ({ answer }: Solved) => answer),
      explanation: sequence([step('to_prompt', ({ question, answer }: Solved) => explain_prompt(question, answer)), explain]),
    }),
    step('format', ({ answer, explanation }: Told) => `${answer}\n${explanation}`),
  ])
}
```

Every joint is typed, every stage works only on what the stage before it
handed over, and the data never waits in a variable. It's more ceremony than
the chain. In fact, it's the bucket brigade from [lesson 4](./04-the-spine.md),
done on purpose. If you like this style, you'll like one more idea that comes
with it. A function that takes steps and returns a step is a composer of your
own, as good as any built in. Try it in a scratch file, such as `styles/scratch.ts`, that imports `retry`
and `timeout` from `fascicle`, and the `Step` type:

```ts
const hardened = <i, o>(leaf: Step<i, o>) => timeout(retry(leaf, { max_attempts: 3 }), 30_000)
```

Fascicle's own `model_step` is built exactly like that, as a small function
over a lower-level piece.

## The Chain

*For when you think in named results.*

This is the solver you already know. Each stage writes a named value, and any
later stage reads whatever names it needs. Create `styles/chain.ts`:

```ts
// styles/chain.ts
import { chain } from 'fascicle'
import type { Engine, Step } from 'fascicle'
import { calculate } from '../solver/calc.js'
import { explain_prompt, make_leaves } from './leaves.js'

export function build_chained(engine: Engine, model: string): Step<string, string> {
  const { extract, explain } = make_leaves(engine, model)
  return chain('question').input<string>()
    .step('problem', extract, ({ question }) => question)
    .step('answer', ({ problem }) => calculate(problem))
    .step('explanation', explain, ({ question, answer }) => explain_prompt(question, answer))
    .output(({ answer, explanation }) => `${answer}\n${explanation}`)
}
```

It reads like a list of `const` declarations, with the difference that every
one of them shows up in the diagram and in the viewer.

## The Direct Style

*For when you think top to bottom, in statements.*

One named step, and inside it, ordinary TypeScript. `ctx.call` runs another
step from inside the body, so the model calls still show up in the viewer, and
the `arm` option tells `describe` which steps the body uses. Create
`styles/direct.ts`:

```ts
// styles/direct.ts
import { step } from 'fascicle'
import type { Engine, Step } from 'fascicle'
import { calculate } from '../solver/calc.js'
import { explain_prompt, make_leaves } from './leaves.js'

export function build_direct(engine: Engine, model: string): Step<string, string> {
  const { extract, explain } = make_leaves(engine, model)
  return step('solve', async (question: string, ctx) => {
    // direct style, for comparison: lesson 8 writes this same check as a branch
    if (!/\d/.test(question)) return 'I can only solve word problems that have numbers in them.'
    const problem = await ctx.call(extract, question)
    const answer = calculate(problem)
    const explanation = await ctx.call(explain, explain_prompt(question, answer))
    return `${answer}\n${explanation}`
  }, { arm: [extract, explain] })
}
```

Notice the early `return` on the first line of the body. A question without
numbers never reaches a model, and that kind of decision, made on the data
while it runs, is where the direct style shines. Its diagram is the shortest of
the five:

```text
solve       step
├─ extract  step
└─ explain  step
```

What it gives up is that the `if` is invisible to `describe`. Fascicle's
[blueprint](../blueprint.md) accepts that trade when the control flow really
does depend on the data, as long as the step has a name and a comment says why
it couldn't be a tree. This check could be a tree, since lesson 8 wrote it as a
`branch`, so the comment in `direct.ts` says that it's written this way for
comparison.

## The Class

*For when you think in objects.*

Apart from its error types, Fascicle's own code has no classes, but yours can.
A class can hold its dependencies and its settings, and hand out steps built
from its own methods.
Create `styles/class.ts`:

```ts
// styles/class.ts
import { chain } from 'fascicle'
import type { Engine, Step } from 'fascicle'
import { calculate } from '../solver/calc.js'
import type { Problem } from '../solver/calc.js'
import { explain_prompt, make_leaves } from './leaves.js'

export class WordProblemSolver {
  private readonly extract: Step<string, Problem>
  private readonly explain: Step<string, string>
  private readonly decimals: number

  constructor(engine: Engine, model: string, decimals: number) {
    const leaves = make_leaves(engine, model)
    this.extract = leaves.extract
    this.explain = leaves.explain
    this.decimals = decimals
  }

  compute(problem: Problem): number {
    return Number(calculate(problem).toFixed(this.decimals))
  }

  as_step(): Step<string, string> {
    return chain('question').input<string>()
      .step('problem', this.extract, ({ question }) => question)
      .step('answer', ({ problem }) => this.compute(problem))
      .step('explanation', this.explain, ({ question, answer }) => explain_prompt(question, answer))
      .output(({ answer, explanation }) => `${answer}\n${explanation}`)
  }
}
```

One thing to watch in this style. A step calls your function on its own, so a
method that you hand over by name loses its `this`. Pull `compute` off an
instance and call it, and you'll see the problem:

```text
TypeError: Cannot read properties of undefined (reading 'decimals')
```

That's why the `answer` binding wraps the call in an arrow function,
`({ problem }) => this.compute(problem)`, since an arrow function keeps the
`this` from where it was written.

One more trick is worth knowing if you think in objects. A step is a plain
object with an `id`, a `kind`, and a `run` function, so an instance of a class that has those
three things is a step. Try it in the same scratch file, with `run`, `sequence`,
and `step` added to its import:

```ts
class AddStep {
  readonly id = 'add'
  readonly kind = 'step'
  readonly run = ({ a, b }: { a: number; b: number }) => a + b
}

const add_then_double = sequence([new AddStep(), step('double', (n: number) => n * 2)])
console.log(await run(add_then_double, { a: 2, b: 3 }))
```

```text
10
```

It's a curiosity more than a recommendation, since `step()` does the same job
in one line, but it shows how little a step really is.

## The State Machine

*For when you think in states and transitions, the way AWS Step Functions
does.*

You've already written this one. Look at the hardened solver from
[lesson 8](./08-when-things-break.md) and read it as a state machine:

| State | Kind | What happens | Next |
| --- | --- | --- | --- |
| HasNumbers | Choice | no digits in the question? | Refuse, or ReadProblem |
| Refuse | Succeed | say what this solver can't do | end |
| ReadProblem | Task, with Retry, TimeoutSeconds, and Catch | ask the model, up to three tries in thirty seconds, and on failure go to Guess | Calculate |
| Guess | Task | read the numbers with code | Calculate |
| Calculate | Task | do the arithmetic | Explain |
| Explain | Task | ask the model to explain | end |

Every row maps to a piece that you've used:

| In a state machine | In Fascicle |
| --- | --- |
| a Task state | `step`, or `model_step` |
| `Next`, from one state to another | `sequence`, or the bindings of a `chain` |
| a Choice state | `branch` |
| a Parallel state | `parallel` |
| a Map state, with `MaxConcurrency` | `map`, with `concurrency` |
| a `Retry` field | `retry` |
| a `Catch` field | `fallback` |
| `TimeoutSeconds` | `timeout` |
| waiting for a callback (a task token) | `suspend`, or `gate` |
| the state document, with `ResultPath` | the chain's record, where each binding writes its result under a name |
| a Choice that loops back to an earlier state | `loop`, which always has a `max_rounds` |

You haven't met three of these yet. `loop` arrives in
[lesson 11](./11-build-a-real-tool.md), and `suspend` and `gate` pause a run
until a person answers, which [human-in-the-loop.md](../human-in-the-loop.md)
covers.

One real difference is worth knowing. A state machine is a graph, a set of
states that point at each other, so a loop is an arrow pointing back. A
Fascicle flow is a tree, steps nested inside steps, so a loop is a `loop` step
with a limit on its rounds. In return, the whole tree is a value that you can
print, test, and hand to `describe.json(flow)`, which gives you the full
structure as JSON, the way a state machine has its definition.

## Run All Five

Create `styles/compare.ts`:

```ts
// styles/compare.ts
import { run } from 'fascicle'
import { build_solver } from '../solver/flow.js'
import { make_solver_stub } from '../solver/stub.js'
import { build_chained } from './chain.js'
import { WordProblemSolver } from './class.js'
import { build_direct } from './direct.js'
import { build_pipeline } from './pipeline.js'

const question = 'Sam has 3 apples and buys 4 more. How many apples does Sam have?'
const engine = make_solver_stub()

const styles = {
  pipeline: build_pipeline(engine, 'stub'),
  chain: build_chained(engine, 'stub'),
  direct: build_direct(engine, 'stub'),
  class: new WordProblemSolver(engine, 'stub', 2).as_step(),
  machine: build_solver(engine, 'stub'),
}

try {
  for (const [name, flow] of Object.entries(styles)) {
    const answer = await run(flow, question)
    console.log(`${name.padEnd(9)} ${answer.replace('\n', ' | ')}`)
  }
} finally {
  await engine.dispose()
}
```

```bash
pnpm exec tsx styles/compare.ts
```

```text
pipeline  7 | Sam started with 3 apples and bought 4 more, so Sam has 7.
chain     7 | Sam started with 3 apples and bought 4 more, so Sam has 7.
direct    7 | Sam started with 3 apples and bought 4 more, so Sam has 7.
class     7 | Sam started with 3 apples and bought 4 more, so Sam has 7.
machine   7 | Sam started with 3 apples and bought 4 more, so Sam has 7.
```

Five ways of thinking, one answer. That's possible because each of them is a
`Step<string, string>` in the end, and nothing that runs it can tell them apart.
(They agree on this question. Ask one with no numbers in it and only the direct
style and the state machine turn it away, since they're the two that carry that
check.)

## Mix Them

Since every style produces a step, they combine freely. A direct-style step can
be one binding in a chain. A class can hand out an arm that a pipeline uses. A
pipeline can sit inside a `map`. You don't have to pick one style for a whole
project, and a good flow often uses two: a chain for the spine, so the shape
stays visible, and a direct-style step or two where the control flow really is
dynamic.

| Style | Feels like | Reach for it when |
| --- | --- | --- |
| Pipeline | composing functions | each stage transforms the one before it |
| Chain | naming your results | values come together from different places, which makes it the usual spine |
| Direct | writing ordinary code | what happens next depends on the data, in a way a tree can't show ahead of time |
| Class | objects with settings and methods | your app already models its world as objects |
| State machine | drawing states and arrows | the process has clear states, choices, retries, and catches |

## With Your Agent

Your agent can translate between these styles faster than you can, and asking
it to is a good way to learn the one you like least.

> Rewrite styles/pipeline.ts in the direct style, keep the same output, and
> print both diagrams so I can compare them.

Or ask it to explain a flow in somebody else's terms:

> Explain lesson 8's solver to me as if I were an AWS Step Functions developer,
> state by state.

## Try It

1. Pick the style that feels most natural to you, and add a "power" operation
   to it from scratch.
2. Put `build_direct` inside a `chain` as one binding of a bigger flow.
3. Print `JSON.stringify(describe.json(build_solver(engine, 'stub')), null, 2)`
   and find the Choice state in it.

## Remember

- Pipeline, chain, direct, class, and state machine are five ways to write the
  same thing, and every one produces a step.
- Steps from any style mix with steps from any other.
- A chain spine with a direct-style step where it's really needed is a strong
  default.
- In a class, wrap methods in arrow functions so they keep their `this`.

[← When Things Break](./08-when-things-break.md) · [Test without a Network →](./10-test-without-a-network.md)

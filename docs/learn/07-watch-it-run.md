# Watch It Run

So far you've seen two things about a flow: its shape, from `describe`, and its
final answer, from `run`. A lot happens in between. Steps start and finish,
models get called, time passes, money gets spent. This lesson records all of
that and lets you watch it in your browser. About fifteen minutes.

## Label the Map

A diagram is only as good as its labels, so start by telling the solver what
each part is for. Update `solver/flow.ts`, adding a `description` to each model
step and one to the `answer` binding:

```ts
// solver/flow.ts
import { chain, model_step } from 'fascicle'
import type { Engine, Step } from 'fascicle'
import { calculate, problem_schema } from './calc.js'

const EXTRACT = `solver/extract
Read an arithmetic word problem and pull out the two numbers and the one
operation that answers it. Use "subtract" when something is taken away and
"divide" when something is shared out. Reply with JSON only, shaped
like this: {"a": 10, "b": 2, "op": "subtract"}`

const EXPLAIN = `solver/explain
You get a word problem and its answer. Explain the answer in one short,
friendly sentence. Use the answer you are given and do no math of your own.`

export function build_solver(engine: Engine, model: string): Step<string, string> {
  const extract = model_step({
    engine, model, system: EXTRACT, schema: problem_schema,
    id: 'extract', description: 'the model reads the numbers out of the question',
  })
  const explain = model_step({
    engine, model, system: EXPLAIN,
    id: 'explain', description: 'the model puts the answer into words',
  })

  return chain('question').input<string>()
    .step('problem', extract, ({ question }) => question)
    .step('answer', ({ problem }) => calculate(problem), { description: 'code does the math, exactly' })
    .step('explanation', explain, ({ question, answer }) => `Problem: ${question}\nAnswer: ${answer}`)
    .output(({ answer, explanation }) => `${answer}\n${explanation}`)
}
```

## Draw It from the Command Line

Fascicle ships a command that prints a flow's diagram without you writing any
code to print it. It needs one small file that builds the flow, and it builds
it with the stub, so drawing never needs a key. The command can't build the
solver from `flow.ts` alone, because `build_solver` wants an engine, and
loading `main.ts` would run the solver. This file holds no printing code. It
tells the command how to build the flow, and the stub is never asked anything,
because drawing a flow doesn't run it. Create `solver/diagram.ts`:

```ts
// solver/diagram.ts
import { build_solver } from './flow.js'
import { make_solver_stub } from './stub.js'

export const flow = () => build_solver(make_solver_stub(), 'stub')
```

```bash
pnpm exec fascicle-diagram solver/diagram.ts
```

```text
chain
├─ problem      step
│  └─ extract   the model reads the numbers out of the question
├─ answer       code does the math, exactly
├─ explanation  step
│  └─ explain   the model puts the answer into words
└─ output       step
```

Now the picture explains itself. It's the kind of thing you paste into a pull
request, or into a comment at the top of `flow.ts`. For the comment, add
`--prefix ' * '`:

```bash
pnpm exec fascicle-diagram solver/diagram.ts --prefix ' * '
```

```text
 * chain
 * ├─ problem      step
 * │  └─ extract   the model reads the numbers out of the question
 * ├─ answer       code does the math, exactly
 * ├─ explanation  step
 * │  └─ explain   the model puts the answer into words
 * └─ output       step
```

## Record a Run

A diagram shows what a flow can do. A **trajectory** records what one run of it
actually did: the structure first, system prompts included, then an event each
time a step starts or ends, an event for each model request and reply with its
token counts but not its text, what each call cost, and how the run ended. You record one by handing `run` a logger. Update `solver/main.ts`:

```ts
// solver/main.ts
import { run } from 'fascicle'
import { filesystem_logger } from 'fascicle/adapters'
import { engine_from_env } from '../engine.js'
import { build_solver } from './flow.js'
import { make_solver_stub } from './stub.js'

const question = process.argv[2] ?? 'Sam has 3 apples and buys 4 more. How many apples does Sam have?'

const { engine, model } = engine_from_env(make_solver_stub)
try {
  const answer = await run(build_solver(engine, model), question, {
    trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }),
  })
  console.log(answer)
} finally {
  await engine.dispose()
}
```

Run it live, so there's something worth watching:

```bash
FASCICLE_PROVIDER=openrouter pnpm exec tsx --env-file=.env solver/main.ts "A theater has 12 rows with 9 seats in each row. How many seats are there?"
```

The answer prints as usual, and a new file appears, `.trajectory.jsonl`, with
one JSON event on each line. Each run adds its events to the end of that file,
so delete it whenever you want a clean slate.

## Watch It

Now point the viewer at that file. The viewer ships with Fascicle too:

```bash
pnpm exec fascicle-viewer .trajectory.jsonl
```

It opens your browser at `http://127.0.0.1:4242` and draws the run left to
right: `extract`, then `answer`, then `explain`, then the `output` at the end.
Under each name is how long that step took. The header across the top sums up
the whole run, with its id, how long it ran, how many retries it absorbed, how
many steps failed outright (the viewer calls those scars), and what it cost. On
a live run of the solver you'll see something like `T+3.25S` and `$0.0002`.
You'll also see straight away that almost all of that time went to the two
model calls, while the code that did the arithmetic took about a millisecond.

The run is already over, so the canvas shows it finished. To see it happen,
press **PLAY**, and the viewer performs the run again close to its real
timing, with long waits shortened and very quick steps slowed down so you can
follow them. The light enters on the left, each step lights up while it's
running, and the line fills in behind it. Press **STEP**, then **NEXT** or the
space bar, to walk the run one moment at a time, or use the arrow keys to move
along the timeline at the bottom.

Leave the viewer open and run the solver again with a different question. From
Fascicle 0.16 on, the viewer follows the file and switches to the newest run as
it happens. Version 0.15 gets confused by more than one run in a file, so there,
stop the viewer with Ctrl-C, delete `.trajectory.jsonl`, run the solver, and
start the viewer again.

## What the Viewer Is For

It's a debugging tool first, and that's [the next lesson](./08-when-things-break.md).
It's also the fastest way to explain a flow to somebody else, because a
diagram that lights up while it runs teaches faster than any paragraph. And
it's how you check that what ran is what you drew. When a step you expected
isn't there, or one you didn't expect is, the viewer shows you before a user
finds out.

## Another Way to Watch

A trajectory is plain JSON lines, so anything that reads text can read one,
including you, `grep`, `jq`, and your agent. And when you'd rather watch a run
from inside your own program, `run.stream(flow, input)` hands you the same
events while they happen, which is how you'd build a progress display of your
own. You won't need that for a while, but it's good to know that the viewer
isn't magic. It just reads the same events that you can.

## With Your Agent

> Read .trajectory.jsonl from my last run and tell me what happened, step by
> step, and how long each model call took.

Your agent can read a trajectory as well as you can, and it doesn't get bored.
Handing it the trajectory is one of the best debugging habits you can build.

> Give every step in solver/flow.ts that doesn't have a description a short one,
> then print the diagram with fascicle-diagram.

## Try It

1. Delete `.trajectory.jsonl`, run the solver live with a word problem of your
   own, and watch it with **PLAY**.
2. Run the solver against the stub (no `FASCICLE_PROVIDER`) and look at it in
   the viewer. How long did the "model" take this time?
3. Paste the output of
   `pnpm exec fascicle-diagram solver/diagram.ts --prefix ' * '` into a comment
   at the top of `flow.ts`.

## Remember

- `describe.diagram` and the `fascicle-diagram` command show what a flow can do.
- `trajectory: filesystem_logger({ output_path })` records what one run did.
- `pnpm exec fascicle-viewer <file>` lets you watch it, and **PLAY** replays it.
- A trajectory is plain text, so you and your agent can both read it.

[← Going Live](./06-going-live.md) · [When Things Break →](./08-when-things-break.md)

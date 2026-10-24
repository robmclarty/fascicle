# The Model Is Just Another Step

Everything so far has been arithmetic, which a computer already does perfectly
well. Now for a job that plain code can't do: read a word problem written in
English, and answer it.

> Sam has 3 apples and buys 4 more. How many apples does Sam have?

A language model is good at reading that sentence and unreliable at the
arithmetic. Code is the other way around. So you split the work. The model reads
the question, the code does the math, and the model explains the answer. The
model proposes and the code decides, a pattern that you'll use over and over.

You still don't need an API key. In this lesson a stand-in plays the part of
the model, and the next lesson swaps in a real one. About twenty-five minutes.

## Sketch It First

Before writing any code, sketch the flow as a tree:

```text
chain 'question'
├─ problem      read the numbers and the operation out of the question (model)
├─ answer       do the arithmetic (code)
├─ explanation  put the answer into words (model)
└─ output
```

It's a chain, because the explanation needs the original question from the top
and the answer from the middle. That's the fan-in rule from
[the last lesson](./04-the-spine.md).

## Start with the Math

Make a `solver` folder in your workbench and create `solver/calc.ts`:

```ts
// solver/calc.ts
import { z } from 'zod'

export const problem_schema = z.object({
  a: z.number(),
  b: z.number(),
  op: z.enum(['add', 'subtract', 'multiply', 'divide']),
})

export type Problem = z.infer<typeof problem_schema>

export function calculate({ a, b, op }: Problem): number {
  if (op === 'add') return a + b
  if (op === 'subtract') return a - b
  if (op === 'multiply') return a * b
  if (b === 0) throw new Error('cannot divide by zero')
  return a / b
}
```

`problem_schema` is a zod schema, a description of a shape of data that does
two jobs. At run time it checks that a value really has that shape, and at
compile time `z.infer` turns it into the TypeScript type `Problem`. The model is
going to have to hand back data in exactly this shape, and the schema is how
you'll hold it to that.

## Fake the Model

Before you bring a model in, fake it. Create `solver/flow.ts` with two plain
steps standing in for the two model calls:

```ts
// solver/flow.ts
import { chain, step } from 'fascicle'
import type { Step } from 'fascicle'
import { calculate } from './calc.js'
import type { Problem } from './calc.js'

export function build_solver(): Step<string, string> {
  // stand-ins for the model, for now
  const extract = step('extract', (_question: string): Problem => ({ a: 3, b: 4, op: 'add' }))
  const explain = step('explain', (_prompt: string) => 'Sam started with 3 apples and bought 4 more, so Sam has 7.')

  return chain('question').input<string>()
    .step('problem', extract, ({ question }) => question)
    .step('answer', ({ problem }) => calculate(problem))
    .step('explanation', explain, ({ question, answer }) => `Problem: ${question}\nAnswer: ${answer}`)
    .output(({ answer, explanation }) => `${answer}\n${explanation}`)
}
```

And `solver/main.ts` to run it:

```ts
// solver/main.ts
import { run } from 'fascicle'
import { build_solver } from './flow.js'

const question = process.argv[2] ?? 'Sam has 3 apples and buys 4 more. How many apples does Sam have?'

console.log(await run(build_solver(), question))
```

```bash
pnpm exec tsx solver/main.ts
```

```text
7
Sam started with 3 apples and bought 4 more, so Sam has 7.
```

(Imports between your own files end in `.js` even though the files end in
`.ts`. That's how TypeScript's module settings want it, and `tsx` follows
along.)

The whole flow works, end to end, and no model is involved. That's worth doing
every time you build something, because it proves the shape before you spend a
cent on a model.

## Swap in a Model

Now replace the two fakes with real model steps. Rewrite `solver/flow.ts`:

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
  const extract = model_step({ engine, model, system: EXTRACT, schema: problem_schema, id: 'extract' })
  const explain = model_step({ engine, model, system: EXPLAIN, id: 'explain' })

  return chain('question').input<string>()
    .step('problem', extract, ({ question }) => question)
    .step('answer', ({ problem }) => calculate(problem))
    .step('explanation', explain, ({ question, answer }) => `Problem: ${question}\nAnswer: ${answer}`)
    .output(({ answer, explanation }) => `${answer}\n${explanation}`)
}
```

Look at what changed. The two `const` lines did, and the function now takes an
engine and a model name. The chain didn't change by a single character.

`model_step` makes a step that asks a model. Here's what you told it:

- **`engine`** is who to ask. An engine knows how to reach model providers, and
  you'll build a real one in the next lesson.
- **`model`** is which model to ask, by the name that its provider uses.
- **`system`** is the model's standing instructions. The first line,
  `solver/extract`, is a role id: a short, stable label that never changes even
  when you reword the rest of the prompt. Things that need to recognize this
  model call (a stand-in engine, or you reading a run log) look for it.
- **`schema`** is the shape that the answer has to have. The engine checks what
  comes back, and if it doesn't fit, asks the model to fix it before giving up.
  From the next lesson on, the solver talks to real providers over what
  Fascicle calls the native transport. In Fascicle 0.16.3 and earlier, the
  schema on that transport checks the answer but never reaches the model, so the
  prompt shows an example with the exact field names. Leave the example out
  there and a big model has to guess, then spend a second round trip fixing its
  guess, while a small one may never get there. Later releases show the model
  the schema itself, and the example does no harm.
- **`id`** is the step's name, the same as `step('extract', ...)` had.

Hover over `extract` and its type is `Step<string | readonly Message[], Problem>`.
A model step takes either a plain prompt or a list of chat messages, and in these
lessons you'll always hand it a plain string.

## A Stand-in Engine

Now you need an engine to hand it. Create `solver/stub.ts`:

```ts
// solver/stub.ts
import { make_stub_engine } from 'fascicle/testing'

export function make_solver_stub() {
  return make_stub_engine([
    { prefix: 'solver/extract', content: { a: 3, b: 4, op: 'add' } },
    { prefix: 'solver/explain', content: 'Sam started with 3 apples and bought 4 more, so Sam has 7.' },
  ])
}
```

A stub engine is a pretend engine that answers from a script. For each call, it
looks at the system prompt and answers with the first entry whose `prefix` the
prompt starts with. That's what the role ids are for. It never touches the
network, it costs nothing, and it gives the same answer every time.

Update `solver/main.ts` to build the stub and hand it to the solver:

```ts
// solver/main.ts
import { run } from 'fascicle'
import { build_solver } from './flow.js'
import { make_solver_stub } from './stub.js'

const question = process.argv[2] ?? 'Sam has 3 apples and buys 4 more. How many apples does Sam have?'

const engine = make_solver_stub()
try {
  console.log(await run(build_solver(engine, 'stub'), question))
} finally {
  await engine.dispose()
}
```

```bash
pnpm exec tsx solver/main.ts
```

```text
7
Sam started with 3 apples and bought 4 more, so Sam has 7.
```

`engine.dispose()` releases whatever the engine holds open. A stub holds
nothing, but a real engine can, so the habit of disposing in `finally` starts
now.

## What Just Happened

The same chain has now run two ways, once with plain functions and once with
model steps backed by a stub, and in the next lesson it runs against a real
model. The chain never noticed, because a fake extractor and a model extractor are both
a `Step` that takes a string and gives back a `Problem`, and anything with the
same input and output types can stand in for anything else.

That's the payoff of everything being a `Step<i, o>`. It's why you can build a
flow before you've chosen a model, test it without a network, and change
providers without touching your logic.

## The Model Remembers Nothing

Look at the explanation step again. It hands the explainer the question as
well as the answer, even though the extract step read that same question a
moment earlier. That isn't waste. A model remembers nothing from one call to
the next, so the explainer has never seen the question unless its own call
sends it.

Every time a `model_step` runs, the engine builds a fresh request for that one
model call, out of your system prompt and the input that the step was handed.
It sends the whole request, hands you the reply, and keeps nothing afterwards.
The extract call and the explain call are two separate requests, and neither
knows that the other happened. Leave the question out of the explain step's
input and the model reads `Answer: 7`, with nothing to say seven of what, so it
has to guess at the apples.

So when a model step needs something, the flow hands it over on purpose, and
that's the job a chain does here. [The next lesson](./06-going-live.md) shows
you one of those requests on its way to a real provider.

## Break the Contract

Change the stub's extract answer to `{ a: 'three', b: 4, op: 'add' }` and run
it again:

```text
schema_validation_error: make_stub_engine: canned response for prefix 'solver/extract' failed the caller's schema: a: Invalid input: expected number, received string
```

Even the stand-in is held to your schema. A real model's answer gets the same
check, so code downstream of a model step never sees a malformed value. Put the
`3` back before you go on.

## Another Way to Write It

`model_step` hands you the answer and nothing else, which is what a flow
usually wants. Its sibling `model_call` takes the same settings and hands you
the whole envelope instead: the answer in `content`, plus `usage` (tokens in and
out), `cost` when it's known, and `finish_reason`. Reach for `model_call` when
you want to log what a call cost.

Prompts don't have to live in your code, either. In a bigger app each prompt
gets its own markdown file, which keeps prompt changes easy to review, and
[lesson 13](./13-grow-into-the-blueprint.md) shows how.

## With Your Agent

> Read solver/flow.ts and tell me which jobs belong to the model and which
> belong to code, and why the arithmetic isn't left to the model.

Then ask for a change that should leave the chain alone:

> Add a "power" operation (a to the power of b) to the schema and to
> calculate, and update the stub so I can check it. Don't touch the chain.

Check that the enum gained `'power'`, that `calculate` handles it, and that the
chain in `flow.ts` is untouched. If your agent changed the chain, ask it why it
needed to. When you're done, have it put the stub's canned answers back, since
later lessons expect them.

## Try It

1. Change the default question in `main.ts` and run it. Does the answer change?
   Why not? (The stub only knows its script, which is exactly what makes it
   useful for testing, and why the next lesson swaps in a real model.)
2. Change the stub's extract answer to `{ a: 12, b: 4, op: 'divide' }`. What
   comes out, and what's wrong with the sentence underneath it? Then put it back
   to `{ a: 3, b: 4, op: 'add' }`, since later lessons expect the original.
3. Print `describe.diagram(build_solver(engine, 'stub'))` and find the two
   model steps in it.

## Remember

- `model_step({ engine, model, system, schema, id })` is a leaf like any other
  step.
- Let the model read and write, and let code compute and decide.
- A schema is a contract, and the engine holds every answer to it.
- A stub engine stands in for a model, with no key, no network, and no cost.

[← The Spine](./04-the-spine.md) · [Going Live →](./06-going-live.md)

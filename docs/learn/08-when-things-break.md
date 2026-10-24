# When Things Break

Things break. You wire two steps together wrong, a model hands back something
odd, a provider has a bad minute, or somebody asks your flow a question that it
was never built for. This lesson is about two skills: finding where a flow
broke, and shaping it so that the next breakage does less damage. About
twenty-five minutes.

## Three Times Things Break

A flow can fail at three different moments, and the earlier the moment, the
cheaper the fix:

1. **When it compiles.** A string where a number should be, or a name that
   doesn't exist. TypeScript tells you before anything runs, which is why you
   run `pnpm exec tsc --noEmit` so often.
2. **When it's built.** A step id with a space in it, or a composer that's handed
   the wrong kind of thing. These throw the moment the flow is constructed, with
   a message that says what to do.
3. **When it runs.** Code that throws, a model whose answer doesn't fit the
   schema, a provider that's down. This lesson is mostly about these.

## Find Where It Broke

Make the stub misread a question so that the code has to divide by zero. In
`solver/stub.ts`, change the extract answer to `{ a: 5, b: 0, op: 'divide' }`,
then run it:

```bash
pnpm exec tsx solver/main.ts "Share 5 cookies among 0 friends."
```

You'll get `Error: cannot divide by zero`, with a stack trace under it. That
tells you *what* happened. Back in [lesson 1](./01-a-step.md), dividing by zero
quietly gave you `Infinity`. `calculate` throws instead, so a bad reading fails
loudly rather than handing the explainer a nonsense number. To learn *where*, ask the error. Every error that's
thrown inside a run carries a path, the ids of the steps that led to it, from
the outside in, and `error_path` reads it. Update `solver/main.ts` to catch the
failure and say where it happened:

```ts
// solver/main.ts
import { error_path, run } from 'fascicle'
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
} catch (err) {
  console.error(`failed at ${error_path(err)?.join(' > ') ?? 'an unknown step'}`)
  console.error(String(err))
  process.exitCode = 1
} finally {
  await engine.dispose()
}
```

```text
failed at chain_1 > answer
Error: cannot divide by zero
```

The last id in the path is the step that threw, `answer`, the one doing the
arithmetic. (Ids like `chain_1` are made up by Fascicle for the composers that
you didn't name.) The trajectory recorded it too. Open it in the viewer and the
`answer` step shows a scar, a broken ring with a small red ✕, and the header
counts one. Put the stub back to `{ a: 3, b: 4, op: 'add' }` before you go on.

## The Failure That Doesn't Throw

In [lesson 6](./06-going-live.md) you asked a real model "What is the capital of
France?" When this course was being checked, the solver answered `0`, and the
explanation underneath it apologized for an answer that didn't fit the
question. Yours may say something else, but it won't have refused. Nothing threw, so nothing pointed
at the problem. The model had to return two numbers and an operation, so it
made some up.

That's the worst kind of failure, a confident answer that's wrong, and no
amount of retrying fixes it, because nothing failed. The fix is a check in
code, in front of the model, that turns away questions the solver can't
answer. You'll add it in a moment as a `branch`, and it's a decision worth
making on purpose: this check refuses any question without digits in it, so it
also refuses "Sam has three apples," which the model would have handled. Maybe
that's the right trade for your users, and maybe it isn't. Either way, the
decision now lives in code where you can see it, test it, and change it,
instead of in the hope that a model will notice.

## When the Provider Has a Bad Minute

Providers fail sometimes. They hit rate limits, their servers get overloaded,
the network blips. Most of the time the fix is to try again a moment later.
`retry` wraps a step and runs it again when it throws, waiting a little longer
each time:

```ts
retry(extract, { max_attempts: 3, backoff_ms: 500 })
```

(The engine already retries some network failures on its own, inside a single
model call. `retry` works one level up, around a whole step, so it also catches
an answer that failed its schema, and anything else the step throws.)

## When It Takes Too Long

`timeout` gives up on a step after a deadline, and throws `timeout_error`:

```ts
timeout(retry(extract, { max_attempts: 3, backoff_ms: 500 }), 30_000)
```

Notice that the timeout wraps the retry, so the 30 seconds covers all three
attempts together. Wrap them the other way around and each attempt gets its own
30 seconds. The order you nest them in is the order the words read in:
"time out the retries" versus "retry the time-outs."

## Plan B

`fallback(primary, backup)` runs the backup when the primary throws. The
solver's plan B doesn't need a model at all. It's a rough reader, written in
plain code, that takes the first two numbers in the question and picks an
operation by keyword. Create `solver/guess.ts`:

```ts
// solver/guess.ts
import type { Problem } from './calc.js'

/**
 * A rough reading of a word problem that needs no model: the first two
 * numbers in the question, and an operation picked by keyword. It's often
 * wrong, and that's fine for a plan B that runs only when the model can't.
 */
export function guess_problem(question: string): Problem {
  const [a = 0, b = 0] = (question.match(/\d+(\.\d+)?/g) ?? []).map(Number)
  const q = question.toLowerCase()
  if (/share|split|equal/.test(q)) return { a, b, op: 'divide' }
  if (/left|away|lost|ate/.test(q)) return { a, b, op: 'subtract' }
  if (/each|times|rows/.test(q)) return { a, b, op: 'multiply' }
  return { a, b, op: 'add' }
}
```

A worse answer, on time, beats no answer at all, for a lot of real jobs. And
when it doesn't, leave the fallback out and let the error surface.

## The Hardened Solver

Now put all of it together. Update `solver/flow.ts`:

```ts
// solver/flow.ts
import { branch, chain, fallback, model_step, retry, step, timeout } from 'fascicle'
import type { Engine, Step } from 'fascicle'
import { calculate, problem_schema } from './calc.js'
import { guess_problem } from './guess.js'

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

  // try the model up to three times, give up after 30 seconds, and fall back to a guess
  const read_problem = fallback(
    timeout(retry(extract, { max_attempts: 3, backoff_ms: 500 }), 30_000),
    step('guess', guess_problem, { description: 'plan B: a rough reading, with no model' }),
  )

  const solve = chain('question').input<string>()
    .step('problem', read_problem, ({ question }) => question)
    .step('answer', ({ problem }) => calculate(problem), { description: 'code does the math, exactly' })
    .step('explanation', explain, ({ question, answer }) => `Problem: ${question}\nAnswer: ${answer}`)
    .output(({ answer, explanation }) => `${answer}\n${explanation}`)

  // a question with no numbers in it isn't one this solver can answer
  return branch({
    when: (question: string) => !/\d/.test(question),
    then: step('refuse', () => 'I can only solve word problems that have numbers in them.'),
    otherwise: solve,
  })
}
```

```bash
pnpm exec fascicle-diagram solver/diagram.ts
```

```text
branch
├─ then  refuse            step
└─ else  chain
   ├─ problem              step
   │  └─ fallback
   │     ├─ timeout
   │     │  └─ retry
   │     │     └─ extract  the model reads the numbers out of the question
   │     └─ guess          plan B: a rough reading, with no model
   ├─ answer               code does the math, exactly
   ├─ explanation          step
   │  └─ explain           the model puts the answer into words
   └─ output               step
```

Read the diagram out loud and it says what you built. Turn away questions with
no numbers. Otherwise read the problem with the model, retrying and timing out,
and falling back to a guess. Then do the math, explain it, and answer.

Look at what *didn't* change. The `extract` leaf is exactly what it was, and the
chain only changed which step `problem` uses. Hardening is arms wrapped around a
leaf, and that's why it was cheap to add. Now that the chain sits inside a
branch, the error path from earlier grows a level, to
`branch_1 > chain_1 > answer`.

## Watch It Recover

You can't make a real provider fail on cue, but you can script a stand-in that
does. Create `solver/flaky.ts`:

```ts
// solver/flaky.ts
import { run } from 'fascicle'
import type { GenerateOptions } from 'fascicle'
import { filesystem_logger } from 'fascicle/adapters'
import { make_stub_engine } from 'fascicle/testing'
import { build_solver } from './flow.js'

// a stand-in provider that fails the first time it's asked to read a question
const engine = make_stub_engine([
  {
    prefix: 'solver/extract',
    content: (_opts: GenerateOptions, call: number) => {
      if (call === 0) throw new Error('503: the provider is having a bad minute')
      return { a: 3, b: 4, op: 'add' }
    },
  },
  { prefix: 'solver/explain', content: 'Sam started with 3 apples and bought 4 more, so Sam has 7.' },
])

try {
  console.log(await run(build_solver(engine, 'stub'), 'Sam has 3 apples and buys 4 more. How many apples does Sam have?', {
    trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }),
  }))
} finally {
  await engine.dispose()
}
```

A stub's `content` can be a function. Its first argument, a `GenerateOptions`,
holds what the engine was asked to do on that call (the prompt, the system
prompt, and the schema), and the second is how many times this answer has been
asked for already. Here the first ask throws,
the way a struggling provider would.

```bash
rm -f .trajectory.jsonl
pnpm exec tsx solver/flaky.ts
pnpm exec fascicle-viewer .trajectory.jsonl
```

The answer prints as if nothing went wrong, and the viewer shows you why. The
`extract` step is drawn with a retry loop around it, attempt 2 of 3, a small ✕
marks the attempt that failed, and the header says `1 RETRY ABSORBED`. Under it
all sits the fallback, drawn as a path that the run never needed to take.

## What the Trajectory Doesn't Hold

A trajectory records where things happened, how long they took, how many tokens
they used, and what they cost. It also holds your system prompts, once each,
inside the flow's structure at the top of the file, so treat the file with the
same care as your code. What it doesn't hold, unless you ask, is the message
sent on each call, or the model's reply. So when the problem is *what* a model
said, go to the error instead. A `schema_validation_error` carries the model's
raw reply on `raw_text`, and its complaints on `schema_issues`. Then copy the
reply that caused the trouble into a stub, and you can reproduce the failure as
many times as you like, for free, while you fix it.

From Fascicle 0.17.0, you can ask. Give a model step `capture: 'turns'`, or
set it in an engine's `defaults`, and the trajectory holds each model turn's
request and reply as well. A model turn is one request to the provider and the
reply that comes back, so each of the solver's model calls takes one, or two
when the first answer fails the schema and the engine asks the model to fix it.
The first request of a call goes in whole and each later one as the messages
that it added, and `captured_turns` reads them back into whole requests. That
puts a reply that failed the schema right beside the one that fixed it, and
[What a Harness Does](../what-a-harness-does.md#what-the-model-saw) shows how
to read a turn back and send it again. Capture stays off until you turn it on,
because a captured request holds everything that your user typed, so a
trajectory that captures needs even more care than one that doesn't.

## A Debugging Checklist

1. **Read the whole message.** Fascicle's errors say what happened and, most of
   the time, what to do.
2. **Find where.** `error_path(err)`, or the scar in the viewer.
3. **Find what.** For a model's reply, read `raw_text` on the error.
4. **Reproduce it with a stub.** Script the exact answer that broke things, so
   the failure happens every time, with no key and no cost.
5. **Fix it at the right level.** A bug in code gets fixed in code. A misreading
   model gets a clearer prompt, or a better example in it. A flaky provider gets
   a `retry` or a `fallback`. A question the flow shouldn't answer gets a guard.

## With Your Agent

Agents are good debuggers when you make them look before they touch. Try:

> The solver failed. Here's the error: (paste it). Read .trajectory.jsonl, find
> the step that broke, and tell me why before you change anything.

"Before you change anything" matters. An agent that starts editing before it
understands a failure tends to fix the symptom it can see.

> Wrap the explain step in a retry with two attempts, then print the diagram so
> I can see where the retry went.

Undo that one when you've seen it, since the next lessons expect the solver as
this lesson left it.

## Try It

1. Make the flaky stub fail on every call, not just the first. What happens now,
   and what does the viewer show?
2. Ask the hardened solver "What is the capital of France?" against the stub
   and against a live model.
3. Write a step that waits two seconds, wrap it in `timeout(slow, 500)`, run it,
   and read the error.

## Remember

- `error_path(err)` names the steps that led to a failure, and the last one is
  where it threw.
- `retry` is for flaky, `timeout` is for slow, and `fallback` is for plan B, and
  each is an arm that you wrap around a leaf.
- A confident wrong answer is worse than an error, so guard your inputs in code.
- Reproduce a failure with a stub before you fix it.

[← Watch It Run](./07-watch-it-run.md) · [Many Ways to Think →](./09-many-ways-to-think.md)

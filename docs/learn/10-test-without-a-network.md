# Test without a Network

So far you've checked your work by running it and reading what it printed.
That works until there are more than a few things to check, or until you change
something and want to know what else you broke. This lesson puts the solver
under automated tests that run in a couple of seconds with no key and no
network, and that check the real flow. About twenty minutes.

## Stub the Engine, Not the Flow

The idea is short. A flow is plain composition, and the only part of it that's
slow, costly, or unpredictable is the engine. So in a test you swap the engine
for a stand-in, and let everything else run for real. The chain,
the branch, the retries, the schema checks, and the error paths all run exactly
as they do in production. You've been doing this since
[lesson 5](./05-the-model-is-a-step.md), so a test is just that habit written
down.

Install a test runner:

```bash
pnpm add -D vitest
```

## The Tests

Create `solver/solver.test.ts`:

```ts
// solver/solver.test.ts
import { describe, expect, it } from 'vitest'
import { describe as describe_flow, error_path, run } from 'fascicle'
import type { GenerateOptions } from 'fascicle'
import { make_script_engine, make_stub_engine, text_of } from 'fascicle/testing'
import { build_solver } from './flow.js'

const QUESTION = 'Sam has 3 apples and buys 4 more. How many apples does Sam have?'
const quiet = { install_signal_handlers: false }

describe('the word problem solver', () => {
  it('answers with the number that the code computed, then the explanation', async () => {
    const engine = make_stub_engine([
      { prefix: 'solver/extract', content: { a: 3, b: 4, op: 'add' } },
      { prefix: 'solver/explain', content: 'Sam has 7 apples.' },
    ])
    expect(await run(build_solver(engine, 'stub'), QUESTION, quiet)).toBe('7\nSam has 7 apples.')
  })

  it('hands the explainer the answer that the code computed', async () => {
    const prompts: string[] = []
    const engine = make_stub_engine([
      { prefix: 'solver/extract', content: { a: 20, b: 4, op: 'divide' } },
      {
        prefix: 'solver/explain',
        content: (opts: GenerateOptions) => {
          prompts.push(text_of(opts))
          return 'Five each.'
        },
      },
    ])
    await run(build_solver(engine, 'stub'), 'Share 20 pens among 4 people.', quiet)
    expect(prompts[0]).toContain('Answer: 5')
  })

  it('turns away a question with no numbers, without asking a model', async () => {
    const engine = make_script_engine([])
    const answer = await run(build_solver(engine, 'stub'), 'What is the capital of France?', quiet)
    expect(answer).toContain('only solve word problems that have numbers')
  })

  it('fails at the answer step when asked to divide by zero', async () => {
    const engine = make_script_engine([{ a: 5, b: 0, op: 'divide' }])
    const failure = await run(build_solver(engine, 'stub'), 'Share 5 cookies among 0 friends.', quiet)
      .catch((err: unknown) => err)
    expect(String(failure)).toContain('cannot divide by zero')
    expect(error_path(failure)?.at(-1)).toBe('answer')
  })

  it('falls back to a guess when the model is down', async () => {
    const engine = make_stub_engine([
      { prefix: 'solver/extract', content: () => { throw new Error('the provider is down') } },
      { prefix: 'solver/explain', content: 'Four each.' },
    ])
    expect(await run(build_solver(engine, 'stub'), 'Share 12 cookies equally among 3 friends.', quiet)).toBe('4\nFour each.')
  })

  it('keeps its shape', () => {
    expect(describe_flow.diagram(build_solver(make_stub_engine([]), 'stub'))).toMatchInlineSnapshot()
  })
})
```

```bash
pnpm exec vitest run
```

```text
  Snapshots  1 written
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

Two small things at the top of the file are worth knowing before you write a
test of your own.

- **Both vitest and Fascicle export a `describe`.** Vitest's groups tests, and
  Fascicle's draws flows. Import Fascicle's under another name,
  `describe as describe_flow`, and the clash goes away.
- **`install_signal_handlers: false`** tells `run` to leave Ctrl-C alone. A
  normal run listens for Ctrl-C so it can stop cleanly, which is right for a
  program and wrong inside a test runner that owns the process.

## Four Engines for Tests

`fascicle/testing` gives you four stand-in engines, and each one answers a
different testing question:

- **`make_stub_engine`** answers by system prompt, the way you've used it all
  along. Use it when you care what each model call returns. Its `content` can
  be a function, and the second test uses that to record the prompt that the
  explainer was sent, with `text_of` pulling the text out.
- **`make_script_engine`** answers strictly in order, first call first, and
  throws if it's asked one more time than you scripted. That makes it the way to
  prove a model was *not* asked. In the third test the script is empty, so any
  model call would fail the test.
- **`make_capture_engine`** records the full options of every call, so you can
  check exactly what was sent, including the model, the system prompt, and the
  schema.
- **`make_loop_engine`** keeps the real engine and scripts only the model, so
  the tools you hand a model call really run, and it keeps every request that
  the model was sent. The solver's model calls use no tools, so none of these
  tests needs it. It ships from 0.17.0, and [testing.md](../testing.md#make_loop_engine)
  shows it at work.

## What the Tests Prove

Read the test names again. Together they say what the solver promises: the
number comes from code, the explainer is told that number, a question with no
numbers never reaches a model, a divide by zero fails at the `answer` step, and
a dead provider falls back to a guess. Each one runs the real flow through the
real `run`. The only fake is the engine, so if a test passes, the flow works.

(The fallback test takes a second or two, because `retry` really does wait
between attempts. That's the real flow being honest.)

## Hold the Shape in Place

The last test is different. `toMatchInlineSnapshot()` started out empty, and the
first time it ran, vitest wrote the diagram straight into your test file:

```ts
  it('keeps its shape', () => {
    expect(describe_flow.diagram(build_solver(make_stub_engine([]), 'stub'))).toMatchInlineSnapshot(`
      "branch
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
         └─ output               step"
    `)
  })
```

From now on, any change to the flow's shape fails this test, and the failure
shows you the old diagram beside the new one. When the change was on purpose,
run `pnpm exec vitest run -u` to accept it. When it wasn't, you've caught a
change that nobody meant to make, before anyone else did. It's a small thing
that pays off most when an agent is editing the flow, because the diff of a
diagram is very easy to read.

## Another Way to Write It

`calculate` and `guess_problem` are plain functions, so they need no Fascicle at
all to test. Call them, and check what they return, in a new file,
`solver/guess.test.ts`, that starts with `import { expect, it } from 'vitest'`:

```ts
import { guess_problem } from './guess.js'

it('reads a sharing question as division', () => {
  expect(guess_problem('Share 12 cookies equally among 3 friends.')).toEqual({ a: 12, b: 3, op: 'divide' })
})
```

That's the habit from [lesson 1](./01-a-step.md) paying off. The more of your
logic lives in plain functions, the more of it you can test with nothing but a
function call.

## With Your Agent

Tests are how an agent checks its own work. Get in the habit of asking for them,
and of asking your agent to run them after every change it makes.

> Write a test that proves the solver never does arithmetic in a model: the
> prompt sent to the explainer must contain the answer that code computed. Use a
> stub engine, not a mocking library.

And later, whenever a flow changes:

> I changed solver/flow.ts. Run the tests, and if the snapshot test fails, show
> me the two diagrams and tell me whether the change looks intended.

## Try It

1. In `flow.ts`, change `Answer:` to `Result:` in the message that the
   `explanation` binding builds, and run the tests. Which one fails, and why?
   Then change it back.
2. Add a binding to the solver's chain, watch the snapshot test fail, then
   accept the change with `-u`. Then take the binding back out, and accept
   again, since lesson 13 expects the original diagram.
3. Write three tests for `guess_problem`, one for each keyword group, and find a
   question that it gets wrong.

## Remember

- Stub the engine, not the flow, so the real composition runs in every test.
- `make_stub_engine` answers by prompt, `make_script_engine` by order, and
  `make_capture_engine` records everything.
- Import Fascicle's `describe` as `describe_flow` in vitest files.
- A diagram snapshot holds the shape of a flow in place.

[← Many Ways to Think](./09-many-ways-to-think.md) · [Build a Real Tool →](./11-build-a-real-tool.md)

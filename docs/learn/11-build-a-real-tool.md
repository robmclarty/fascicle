# Build a Real Tool

Everything so far has been practice. Now you'll build something that you'll use
tomorrow: a tool that reads the changes you've staged in git and writes the
commit message for you. It uses almost everything you've learned, including a
step that talks to the outside world, a model with a schema, code that checks
the model's work, and the stub, the engine, and the viewer. It adds one new
shape, a `loop`. About forty-five minutes.

## Think before You Type

Start with the job, in a paragraph of plain words:

> Read what git has staged. Ask a model for a commit message with a subject and
> a body. Check the subject against the house rules: 72 characters at most, no
> period at the end, and written as a command ("Add", not "Added"). If it breaks
> a rule, tell the model what's wrong and ask again, three tries at most. Print
> the message.

Now turn it into a tree. The verbs that do work become leaves, and the words
that shape the work become composers. "Ask again, three tries at most" is a
loop:

```text
chain 'repo'
├─ diff      read what git has staged (code)
├─ message   loop: redraft until the checks pass, three tries at most
│  └─ draft  the model writes, then code checks
└─ output
```

That's the whole design, before a line of code. [The next
lesson](./12-from-a-thought-to-a-flow.md) turns this habit into a method.

## Read the Diff

Make a `commit` folder in your workbench, and create `commit/git.ts`:

```ts
// commit/git.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec_file = promisify(execFile)
const MAX_DIFF_CHARS = 20_000

/** The staged diff of the repository at `repo`, cut short when it runs long. */
export async function staged_diff(repo: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await exec_file('git', ['diff', '--staged', '--no-color'], {
    cwd: repo,
    maxBuffer: 10 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  })
  if (stdout.trim() === '') {
    throw new Error('nothing is staged: run `git add` on the changes you want described, then try again')
  }
  return stdout.length > MAX_DIFF_CHARS ? `${stdout.slice(0, MAX_DIFF_CHARS)}\n[diff cut short]` : stdout
}
```

It's a plain function with no Fascicle in it, so it stays easy to test and to
reuse. Three choices in it are worth copying into your own tools:

- **It takes a `signal`.** When somebody presses Ctrl-C, Fascicle signals every
  running step to stop, and passing the signal along lets `git` stop too.
- **It caps the diff.** Models charge by the word, and a 2 MB diff is an
  expensive way to describe a lockfile change.
- **Its error says what to do.** "Nothing is staged" is a mistake you'll make,
  and the message tells you the fix.

## The Contract and the Rules

Create `commit/message.ts`, which holds the schema, the rules, and the text
handling:

```ts
// commit/message.ts
import { z } from 'zod'

export const commit_schema = z.object({
  subject: z.string(),
  body: z.string(),
})

export type CommitMessage = z.infer<typeof commit_schema>

/** Everything wrong with a draft, in words the model can act on. Empty means clean. */
export function problems_with({ subject }: CommitMessage): string[] {
  const problems: string[] = []
  if (subject.length > 72) problems.push(`The subject is ${subject.length} characters long. Keep it to 72.`)
  if (subject.endsWith('.')) problems.push('The subject ends with a period. Drop it.')
  if (/^(added|fixed|updated|changed|removed|refactored)\b/i.test(subject)) {
    problems.push('The subject is in the past tense. Use the imperative: "Add", not "Added".')
  }
  return problems
}

export function render_message({ subject, body }: CommitMessage): string {
  return body.trim() === '' ? subject : `${subject}\n\n${body.trim()}`
}

export function format_request(diff: string, last: CommitMessage | null, problems: string[]): string {
  const ask = `Write a commit message for this staged diff:\n\n${diff}`
  if (last === null) return ask
  return `${ask}\n\nYour last draft was:\n\n${render_message(last)}\n\nFix these problems:\n${problems.join('\n')}`
}
```

`problems_with` is the heart of the tool, and it's plain code. The model
writes, and the code decides whether the writing is acceptable, the same split
as the solver's. Each problem is written as an instruction, because the model
is going to read it.

## Draft until It's Clean

Create `commit/flow.ts`:

```ts
// commit/flow.ts
import { chain, loop, model_step } from 'fascicle'
import type { Engine, Step } from 'fascicle'
import { staged_diff } from './git.js'
import { commit_schema, format_request, problems_with, render_message } from './message.js'
import type { CommitMessage } from './message.js'

const WRITER = `commit/write
You write git commit messages. Say what the change does and why it matters,
using only what the diff shows. The subject is one line in the imperative mood
("Add", not "Added"), at most 72 characters, with no period at the end. The
body says what changed and why in plain sentences, and it's empty for a
trivial change. Reply with JSON only, shaped like this:
{"subject": "Fix the thing", "body": "Why it needed fixing."}`

/** One round of drafting: what the loop carries from each round to the next. */
type Round = { diff: string; draft: CommitMessage | null; problems: string[] }

export function build_commit_writer(engine: Engine, model: string): Step<string, string> {
  const write: Step<string, CommitMessage> = model_step({
    engine, model, system: WRITER, schema: commit_schema,
    id: 'write', description: 'the model drafts a message from the diff',
  })

  const write_and_check: Step<Round, Round> = chain('round').input<Round>()
    .step('draft', write, ({ round }) => format_request(round.diff, round.draft, round.problems))
    .output(({ round, draft }) => ({ diff: round.diff, draft, problems: problems_with(draft) }))

  const draft_until_clean = loop({
    name: 'draft_until_clean',
    description: 'redraft until the checks pass, three tries at most',
    init: (diff: string): Round => ({ diff, draft: null, problems: [] }),
    body: write_and_check,
    guard: (round) => round.problems.length === 0,
    finish: (round) => (round.draft === null ? '' : render_message(round.draft)),
    max_rounds: 3,
  })

  return chain('repo').input<string>()
    .step('diff', ({ repo }, ctx) => staged_diff(repo, ctx.abort), { description: 'read what git has staged' })
    .step('message', draft_until_clean, ({ diff }) => diff)
    .output(({ message }) => message)
}
```

The `loop` is the new piece, so take it one setting at a time:

- **`init`** turns the loop's input (the diff) into its starting state. A loop
  carries one value from each round to the next, and here it's a `Round`: the
  diff, the latest draft, and its problems. Before the first round there's no
  draft yet, so it starts as `null`.
- **`body`** is the step that runs each round. It takes a `Round` and returns
  the next one, and here it's a small chain that writes a draft and checks it.
- **`guard`** decides when to stop. It's asked after every round, and `true`
  means done. Here that's "no problems left."
- **`max_rounds`** is the limit, and every loop has to have one. A loop that
  waits for a model to get something right might wait forever, and forever is
  expensive.
- **`finish`** turns the final state into the loop's output. By the time it runs
  there's always a draft, but TypeScript can't know that, so it checks.

Notice where `ctx.abort` goes, too. The `diff` binding hands the run's stop
signal to `staged_diff`, which hands it to `git`.

## A Stand-in That Gets It Wrong First

You'll want to see the loop actually loop, so make the stub's first draft break
two rules. Create `commit/stub.ts`:

```ts
// commit/stub.ts
import type { GenerateOptions } from 'fascicle'
import { make_stub_engine } from 'fascicle/testing'

/** A stand-in writer whose first draft breaks two rules, so the redraft shows up. */
export function make_commit_stub() {
  return make_stub_engine([{
    prefix: 'commit/write',
    content: (_opts: GenerateOptions, round: number) => round === 0
      ? { subject: 'Updated the solver to handle division by zero.', body: '' }
      : {
          subject: 'Handle division by zero in the solver',
          body: 'calculate() now throws a clear error instead of returning Infinity,\nso a bad question fails loudly.',
        },
  }])
}
```

## The Shell

Create `commit/main.ts`. It reads the repository path from the command line, or
uses the current folder:

```ts
// commit/main.ts
import { run } from 'fascicle'
import { filesystem_logger } from 'fascicle/adapters'
import { engine_from_env } from '../engine.js'
import { build_commit_writer } from './flow.js'
import { make_commit_stub } from './stub.js'

const repo = process.argv[2] ?? process.cwd()

const { engine, model } = engine_from_env(make_commit_stub)
try {
  const message = await run(build_commit_writer(engine, model), repo, {
    trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }),
  })
  console.log(message)
} finally {
  await engine.dispose()
}
```

And `commit/diagram.ts`, so you can draw it:

```ts
// commit/diagram.ts
import { build_commit_writer } from './flow.js'
import { make_commit_stub } from './stub.js'

export const flow = () => build_commit_writer(make_commit_stub(), 'stub')
```

```bash
pnpm exec fascicle-diagram commit/diagram.ts
```

```text
chain
├─ diff                  read what git has staged
├─ message               step
│  └─ draft_until_clean  loop: redraft until the checks pass, three tries at most
│     ├─ chain
│     │  ├─ draft        step
│     │  │  └─ write     the model drafts a message from the diff
│     │  └─ output       step
│     └─ guard  step
└─ output                step
```

Compare it with the tree you sketched at the top of the lesson. It's the same
tree, with the loop's insides drawn in.

## Run It

Your workbench is a git repository (you ran `git init` in
[lesson 0](./00-set-up.md)), so it can describe its own changes. Stage
something and run the tool against the stub:

```bash
git add solver
rm -f .trajectory.jsonl
pnpm exec tsx commit/main.ts
```

```text
Handle division by zero in the solver

calculate() now throws a clear error instead of returning Infinity,
so a bad question fails loudly.
```

That's the stub's second draft, the one that passed the checks. Open the
trajectory in the viewer (`pnpm exec fascicle-viewer .trajectory.jsonl`) and
you'll see the loop drawn as a box around the steps that it repeated, with
`write` marked `×2`, because it ran twice. The last puck in the box is the
loop's guard, the check that decides whether to go round again. On 0.16.3 and
earlier, the box is labelled `LOOP_1`, the loop's id, and the guard
`loop_1_guard`, an id that Fascicle made up for a plain function, and both
`output` steps show the runs of the two added together. Later releases label
them `DRAFT_UNTIL_CLEAN`, from the loop's `name`, and `guard`, and count each
step on its own.

Now run it live, on your real changes:

```bash
FASCICLE_PROVIDER=openrouter pnpm exec tsx --env-file=.env commit/main.ts
```

And when you like what it writes, commit with it:

```bash
FASCICLE_PROVIDER=openrouter pnpm exec tsx --env-file=.env commit/main.ts > /tmp/commit-message.txt
git commit --edit --file /tmp/commit-message.txt
```

`--edit` opens your editor with the draft already filled in, so you read it
before anything is committed. The tool proposes, and you decide. That's a good
rule for every tool that you build with a model in it.

## What You Used

| Lesson | In this tool |
| --- | --- |
| [A step is a function](./01-a-step.md) | `staged_diff` and `problems_with` are plain functions |
| [The spine](./04-the-spine.md) | the outer `chain`, and a small one inside the loop |
| [The model is a step](./05-the-model-is-a-step.md) | `write`, a `model_step` with a schema and a role id, where the model proposes and code decides |
| [Going live](./06-going-live.md) | `engine_from_env`, shared with the solver |
| [Watch it run](./07-watch-it-run.md) | the trajectory, and the loop in the viewer |
| [When things break](./08-when-things-break.md) | a stub whose `content` function answers differently on each call, and an error that says what to do |
| [Test without a network](./10-test-without-a-network.md) | no tests yet, so a stub test of the loop is a good next step |

## Another Way to Write It

Drafting, checking, and redrafting is common enough that Fascicle has a
composer named for it, `adversarial`. It takes a `build` step, a `critique`
step, an `accept` test, and a round limit, and it feeds the critique back into
the next build for you:

```ts
const draft = adversarial({
  build: sequence([
    step('ask', ({ input, prior, critique }: AdversarialBuildInput<string, CommitMessage>) =>
      format_request(input, prior ?? null, critique ? critique.split('\n') : [])),
    write,
  ]),
  critique: step('check', (message: CommitMessage) => ({ notes: problems_with(message).join('\n') })),
  accept: (verdict) => verdict.notes === '',
  max_rounds: 3,
  project: (result) => render_message(result.candidate),
})
```

It does the same job, and the critic can be a model instead of code, which is
where it really earns its keep. On 0.16.3 and earlier, its diagram also shows
the scopes and stashes that it's built from, which is why this lesson started
with `loop`. Later releases draw it as its `build` and its `critique`, and
`describe.diagram(draft, { internals: true })` shows the rest.

## With Your Agent

> Add a rule to problems_with: the subject must start with a capital letter.
> Mention the rule in the writer's prompt too, change the stub so its first draft
> breaks the new rule, then run the tool and print the diagram.

Then have it explain the shape back to you:

> Read commit/flow.ts and explain the loop to me in plain words: what it
> carries from round to round, and when it stops.

## Try It

1. Use the tool for real. Commit your lesson work with a message it drafted,
   and fix anything you don't like in the editor.
2. Make the stub break a rule every time. What does the tool print after three
   rounds? `finish` takes a second argument, `{ converged, rounds }`, so use it
   to warn yourself when the drafts never came out clean.
3. Add `"commit-message": "tsx --env-file=.env commit/main.ts"` to the
   `scripts` in `package.json`, and run it as `pnpm commit-message`. It runs live
   only when `.env` sets `FASCICLE_PROVIDER`, as lesson 6 suggested, and
   otherwise it runs the stub.

## Remember

- Write the job as a paragraph, then as a tree, then as code.
- The model drafts, code checks, and a loop feeds the problems back.
- A `loop` carries state from round to round, and it always has a limit.
- A tool with a model in it should propose, and leave the decision to you.

[← Test without a Network](./10-test-without-a-network.md) · [From a Thought to a Flow →](./12-from-a-thought-to-a-flow.md)

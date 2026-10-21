# Grow into the Blueprint

Your workbench now holds three small apps, each a handful of files. That's the
right size for them today. As an app grows, with more model roles, longer
prompts, and more people changing it, it pays to give each kind of code a home
of its own. Fascicle's [blueprint](../blueprint.md) describes that layout, and
this lesson walks the solver into it, explaining why each piece lives where it
does. About twenty minutes.

## Grow into It, Don't Start from It

The blueprint says it plainly: a single-role agent can be one file, and the
full layout earns its keep only when roles multiply, when prompts deserve their
own review, or when a second person needs to change one piece without reading
the rest. Don't start a new tool by laying out every file in the blueprint. Start with one file,
and move pieces out as they ask to be moved. This lesson does the moving, so
you'll recognize the moment when it comes.

## The Layout

Here's where the solver ends up, and what each file is allowed to hold:

| File | Holds | Never holds |
| --- | --- | --- |
| `main.ts` | input, the `run` call, output | composition |
| `flow.ts` | the topology, in Fascicle's words | string building, file access, business rules |
| `../engine.ts` | the only `create_engine` call | anything about any one flow |
| `stages/*.ts` | one factory per model role | message text |
| `prompts/*.md` | each role's standing instructions | code, or anything that changes from call to call |
| `messages.ts` | the text that goes to models or back to the person, built from typed values | anything from Fascicle |
| `calc.ts`, `guess.ts` | the domain's own logic, and its schema | anything from Fascicle |

The blueprint keeps schemas in a `types.ts`. With one schema sitting beside the
arithmetic that it describes, `calc.ts` is a fine home, and a second schema is
the signal to move both. The blueprint also gives the text that goes back to
the person its own `render.ts`, which an app this small doesn't need yet.

## Prompts Become Files

A prompt is part of your app's behavior, so a change to a prompt deserves a
diff of its own that anyone can read, including people who don't read
TypeScript. Make a `solver/prompts` folder, and move each prompt into a
markdown file. Create `solver/prompts/extract.md`:

```markdown
---
name: extract
description: Reads the two numbers and the operation out of a word problem
---

solver/extract
Read an arithmetic word problem and pull out the two numbers and the one
operation that answers it. Use "subtract" when something is taken away and
"divide" when something is shared out. Reply with JSON only, shaped
like this: {"a": 10, "b": 2, "op": "subtract"}
```

And `solver/prompts/explain.md`:

```markdown
---
name: explain
description: Puts a computed answer into one friendly sentence
---

solver/explain
You get a word problem and its answer. Explain the answer in one short,
friendly sentence. Use the answer you are given and do no math of your own.
```

The block at the top, between the `---` lines, is frontmatter, a few labels
about the prompt that sit beside it. The role id stays on the first line of the
prompt itself, where the stub looks for it. One piece of the blueprint's advice
doesn't fit the native transport. It suggests keeping field rules in
`.describe()` on the schema and out of the prompt, which works only where the
transport sends the schema to the model. The native transport doesn't, so keep
the example JSON in the prompt. Reading a prompt back takes a few
lines of code. Create `solver/prompts/load.ts`:

```ts
// solver/prompts/load.ts
import { readFileSync } from 'node:fs'

/** The body of a markdown prompt, without the frontmatter at its top. */
export function load_prompt(url: URL): string {
  const text = readFileSync(url, 'utf8')
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(text)
  return (frontmatter ? text.slice(frontmatter[0].length) : text).trim()
}
```

## One Factory per Role

Each model role gets a small file that turns its prompt into a step. Make a
`solver/stages` folder, and create `solver/stages/extract.ts`:

```ts
// solver/stages/extract.ts
import { model_step } from 'fascicle'
import type { Engine, Step } from 'fascicle'
import { problem_schema } from '../calc.js'
import type { Problem } from '../calc.js'
import { load_prompt } from '../prompts/load.js'

export function make_extract_step(engine: Engine, model: string): Step<string, Problem> {
  return model_step({
    engine, model, schema: problem_schema,
    system: load_prompt(new URL('../prompts/extract.md', import.meta.url)),
    id: 'extract', description: 'the model reads the numbers out of the question',
  })
}
```

And `solver/stages/explain.ts`:

```ts
// solver/stages/explain.ts
import { model_step } from 'fascicle'
import type { Engine, Step } from 'fascicle'
import { load_prompt } from '../prompts/load.js'

export function make_explain_step(engine: Engine, model: string): Step<string, string> {
  return model_step({
    engine, model,
    system: load_prompt(new URL('../prompts/explain.md', import.meta.url)),
    id: 'explain', description: 'the model puts the answer into words',
  })
}
```

`new URL('../prompts/extract.md', import.meta.url)` finds the prompt relative
to the file that asks for it, so it works no matter which folder you run the
program from.

The factory's return type, `Step<string, Problem>`, is the contract, and it's
the whole point of the layer. Behind that type you can change the model, give
the model tools, wrap it in a retry, or swap it for something else entirely,
and the flow never knows.

## Text Lives in Its Own Module

The flow has been building strings inline, like the prompt for the explainer.
Strings are details, and details move out. Create `solver/messages.ts`:

```ts
// solver/messages.ts
export const REFUSAL = 'I can only solve word problems that have numbers in them.'

export function format_explain_request(question: string, answer: number): string {
  return `Problem: ${question}\nAnswer: ${answer}`
}

export function format_answer(answer: number, explanation: string): string {
  return `${answer}\n${explanation}`
}
```

The regular expression that checks for digits is a business rule, so it moves
too, to the bottom of `solver/calc.ts`:

```ts
export function has_numbers(question: string): boolean {
  return /\d/.test(question)
}
```

## The Composition Layer

Now `solver/flow.ts` can hold the shape of the solver and nothing else. Replace
it with this:

```ts
// solver/flow.ts
/**
 * The word problem solver.
 *
 * branch
 * ├─ then  refuse            turn away a question with no numbers in it
 * └─ else  chain
 *    ├─ problem              step
 *    │  └─ fallback
 *    │     ├─ timeout
 *    │     │  └─ retry
 *    │     │     └─ extract  the model reads the numbers out of the question
 *    │     └─ guess          plan B: a rough reading, with no model
 *    ├─ answer               code does the math, exactly
 *    ├─ explanation          step
 *    │  └─ explain           the model puts the answer into words
 *    └─ output               step
 */
import { branch, chain, fallback, retry, step, timeout } from 'fascicle'
import type { Engine, Step } from 'fascicle'
import { calculate, has_numbers } from './calc.js'
import { guess_problem } from './guess.js'
import { REFUSAL, format_answer, format_explain_request } from './messages.js'
import { make_explain_step } from './stages/explain.js'
import { make_extract_step } from './stages/extract.js'

export function build_solver(engine: Engine, model: string): Step<string, string> {
  const extract = make_extract_step(engine, model)
  const explain = make_explain_step(engine, model)

  const read_problem = fallback(
    timeout(retry(extract, { max_attempts: 3, backoff_ms: 500 }), 30_000),
    step('guess', guess_problem, { description: 'plan B: a rough reading, with no model' }),
  )

  const solve = chain('question').input<string>()
    .step('problem', read_problem, ({ question }) => question)
    .step('answer', ({ problem }) => calculate(problem), { description: 'code does the math, exactly' })
    .step('explanation', explain, ({ question, answer }) => format_explain_request(question, answer))
    .output(({ answer, explanation }) => format_answer(answer, explanation))

  return branch({
    when: (question: string) => !has_numbers(question),
    then: step('refuse', () => REFUSAL, { description: 'turn away a question with no numbers in it' }),
    otherwise: solve,
  })
}
```

Read it top to bottom. Every line is either a Fascicle word or the name of
something that lives in another file, with no template strings, no regular
expressions, and no prompts. The comment at the top is the diagram, pasted in
from `pnpm exec fascicle-diagram solver/diagram.ts --prefix ' * '`, so anyone
who opens the file sees the whole solver before they read a line of code. That
file is the blueprint's one rule in practice: one place where the entire
topology is visible, written only in the vocabulary.

## Let the Compiler Find What Broke

You moved the prompts out of `flow.ts`, and something else was using them.
Ask TypeScript:

```bash
pnpm exec tsc --noEmit
```

```text
styles/leaves.ts(6,10): error TS2305: Module '"../solver/flow.js"' has no exported member 'EXPLAIN'.
styles/leaves.ts(6,19): error TS2305: Module '"../solver/flow.js"' has no exported member 'EXTRACT'.
```

The style lessons built their own model steps from the prompts. Now they can
use the solver's real stages instead. Replace `styles/leaves.ts`:

```ts
// styles/leaves.ts
import type { Engine, Step } from 'fascicle'
import type { Problem } from '../solver/calc.js'
import { make_explain_step } from '../solver/stages/explain.js'
import { make_extract_step } from '../solver/stages/extract.js'

export type Leaves = { extract: Step<string, Problem>; explain: Step<string, string> }

/** The two model steps that every style shares, built by the solver's own stages. */
export function make_leaves(engine: Engine, model: string): Leaves {
  return { extract: make_extract_step(engine, model), explain: make_explain_step(engine, model) }
}

export function explain_prompt(question: string, answer: number): string {
  return `Problem: ${question}\nAnswer: ${answer}`
}
```

Run `tsc` again, and it's clean. A refactor in a typed codebase works like
that: move the piece, and let the compiler give you the list of everything
that needs to follow it.

## Let the Tests Catch What Changed

Now run the tests from [lesson 10](./10-test-without-a-network.md):

```bash
pnpm exec vitest run
```

Every test passes except one, the snapshot of the diagram. The `refuse` step gained
a description in the move, so its row in the diagram changed, and the test
shows you the old line beside the new one. The change was on purpose, so accept
it:

```bash
pnpm exec vitest run -u
```

The others passing is the important part. Everything about how the solver
*behaves* is the same as before the refactor, and you know that without having
run it by hand once.

## Enforce It

Conventions fade unless something checks them. The blueprint's reference app
keeps a few [ast-grep](https://ast-grep.github.io/) rules in
[examples/pr-improve/rules/](../../examples/pr-improve/rules/), which turn the
layout into build failures. One allows `create_engine` in a single file, one
keeps loops out of the composition layer, and one keeps Fascicle out of the
plain modules. Copy them into your own app, and change their `files` globs to
match its layout, when it's big enough that you'd like a machine to remember the
rules for you.

## Where to Go Next

You know enough now to build real tools, and the rest of Fascicle's docs will
read differently than they would have this morning.

- [blueprint.md](../blueprint.md) is the full app architecture, with the
  reasons behind each rule.
- [leaf-arm-spine.md](../leaf-arm-spine.md) helps you choose the right
  primitive at each layer.
- [cookbook.md](../cookbook.md) has worked patterns for retries, fan-out,
  judges, tool loops, and people in the loop.
- [testing.md](../testing.md) covers the three stand-in engines in depth.
- [troubleshooting.md](../troubleshooting.md) maps errors to their causes.
- [examples/release-notes/](../../examples/release-notes/) is a whole agent in
  one file, and [examples/pr-improve/](../../examples/pr-improve/) is the full
  layout at work.

## With Your Agent

> Read ../fascicle/docs/blueprint.md, then review my commit tool against it.
> List what you'd move where and why, but don't change anything yet.

When the list looks right:

> First write a stub test for the commit tool that checks its output and
> snapshots its diagram. Then reshape it into the same layout as the solver,
> running tsc and the tests after each move, and stop if anything other than
> the snapshot fails.

## Try It

1. Reshape the commit tool into this layout, file by file, running
   `pnpm exec tsc --noEmit` after each move.
2. Change `prompts/explain.md` to ask for two sentences instead of one, and run
   the solver live. You changed the solver's behavior without touching any code.
3. Move `problem_schema` and `Problem` into a new `solver/types.ts`, and let the
   compiler tell you every import that has to follow.

## Remember

- Grow into the layout, because one file is fine until it isn't.
- `flow.ts` holds the shape and nothing else.
- Prompts are files, stages are factories, and messages are functions.
- The compiler finds what a refactor broke, and the snapshot shows what it
  changed.

That's the course. You started with a function that added two numbers, and
you've finished with a model-backed tool that you'll use tomorrow, a method for
turning ideas into flows, and a shared vocabulary with your agent. Go build
something.

[← From a Thought to a Flow](./12-from-a-thought-to-a-flow.md) · [Back to the course map](./README.md)

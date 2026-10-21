# From a Thought to a Flow

Every program starts as a thought, usually something like "I wish this happened
on its own." An algorithm is that thought made precise enough for a machine to
follow. A flow is an algorithm built out of steps that you can draw, run, watch,
test, and swap, and that's what makes Fascicle a medium for thinking rather than
only a library for calling models. The shape of your idea stays visible the
whole way from your head to production.

This lesson is a method for getting from the thought to the flow, with your
agent alongside you. It's the most important lesson in the course, and the one
that you'll come back to. About forty-five minutes, plus however long you spend
on the exercise at the end, which is where the learning happens.

## Six Moves

1. **Say it in a paragraph.** Plain words, no code. What goes in, what comes
   out, and what a good result looks like.
2. **Underline the verbs.** Each verb that does work becomes a leaf. Mark each
   one as needing judgment (reading, writing, sorting, summarizing, which is a
   model's job) or precision (arithmetic, rules, lookups, files, which is code's).
3. **Circle the shape words.** "For each," "at the same time," "if," "until,"
   "try again." Each one names a composer, and the table below has the list.
4. **Draw the tree.** Plain text, shaped like the diagrams you've been printing.
   Give every binding a name.
5. **Hand the tree to your agent, in the vocabulary.** Then print the diagram of
   what it built and compare it with your drawing. When the two match, the code
   does what you meant.
6. **Run it on a stub, then live, and watch it.** Then make it better one change
   at a time, and look at the diagram after each one.

## The Words and What They Build

This table is the vocabulary that you and your agent share. When you say the
words in the first column, a good agent writes the code in the second, and when
you read a diagram, you can turn the code back into the words.

| When you say | You mean | And you'll see |
| --- | --- | --- |
| "first, then" | `sequence([a, b])` | each step gets the output of the one before it |
| "remember this for later" | a `chain` binding | `.step('name', ...)`, read by any later step |
| "at the same time," "independently" | `parallel({ a, b })` | `{ a, b }` |
| "for each" | `map({ items, do, concurrency })` | an array, in order |
| "if this, otherwise that" | `branch({ when, then, otherwise })` | one arm runs |
| "keep going until" | `loop({ init, body, guard, finish, max_rounds })` | a bounded repeat |
| "ask the model" | `model_step({ engine, model, system, schema })` | a leaf |
| "try again if it fails" | `retry(step, { max_attempts })` | |
| "if that fails, do this instead" | `fallback(primary, backup)` | |
| "give up after" | `timeout(step, ms)` | |
| "check its work and redo it" | a `loop` with a code guard, or `adversarial` | |
| "pick the best of a few" | `ensemble_step({ members, score, rank_by })` | the winner |
| "only if they agree" | `consensus({ members, agree, max_rounds })` | |
| "ask a person first" | `suspend`, or `gate`, run with `run.until_suspended` | a pause |
| "don't redo the expensive part" | `checkpoint(step, { key })` | a saved result |
| "tidy up the output" | `pipe(step, fn)` | |

The last few rows are composers that this course hasn't used. You don't need to
know them in advance. Knowing that the word exists is enough to ask for it, and
[composition.md](../composition.md) has one line on each when you want more.

## A Worked Example

Here's a thought: *I'd like a digest of the morning's bug reports, with the
scary ones at the top.*

### Say It in a Paragraph

> Every morning, go through the new bug reports. Sort each one by which part of
> the product it's about, how bad it is, and whether it could be a security
> problem. Anything about security, or anything bad, goes at the top for a
> person to look at. Group the rest by area, and sum up each area in a sentence
> or two for the team that owns it.

### Underline the Verbs

| Verb | Leaf | Needs |
| --- | --- | --- |
| sort each report | `judge`, a model step with a schema | judgment |
| pick out the scary ones | `urgent`, a filter | precision, since it's a rule |
| group the rest | `areas`, a function | precision |
| sum up each area | `summarize`, a model step | judgment |
| put the digest together | `output` | precision |

Notice how much of the job is code. Only two of the five verbs need a model.
That's typical, and it's good news, since code is free, fast, and does the same
thing every time.

### Circle the Shape Words

"Sort **each** one" is a `map`. "Sum up **each** area" is another. "Goes at the
top" and "the rest" split a list in two, which is a filter in code and not a
`branch`, because a branch picks a path for one input, not a group. And the
digest at the end needs the urgent reports and the summaries together, which
is fan-in, so the spine is a `chain`.

### Draw the Tree

```text
chain 'reports'
├─ triaged    for each report, the model sorts it
├─ urgent     code picks the security and high-severity reports
├─ areas      code groups the rest by area
├─ summaries  for each area, the model sums it up
└─ output     code writes the digest, urgent first
```

Drawing the tree also shows something that the paragraph only implied. The
urgent reports never reach `areas`, so the model that writes the summaries never
sees a security report at all, and a security problem's details can't leak into
a digest that the whole team reads. That's a property of the *system*, not of
any one step, and the tree is where it became visible. Properties like that are
the reason to draw first.

### Build It

Here's the tree, built. Make a `digest` folder and create `digest/flow.ts`:

```ts
// digest/flow.ts
import { z } from 'zod'
import { chain, map, model_step } from 'fascicle'
import type { Engine, Step } from 'fascicle'

export type Report = { id: number; title: string; body: string }

export const verdict_schema = z.object({
  area: z.enum(['billing', 'login', 'search', 'other']),
  severity: z.enum(['low', 'medium', 'high']),
  security: z.boolean(),
})

type Verdict = z.infer<typeof verdict_schema>
type Triaged = Report & Verdict
type Area = { area: string; reports: Triaged[] }
type Summary = { area: string; summary: string }

const TRIAGE = `digest/triage
You triage one bug report. Say which area of the product it's about, how bad
it is, and whether it could be a security problem. Reply with JSON only, shaped
like this: {"area": "login", "severity": "high", "security": false}`

const SUMMARIZE = `digest/summarize
You get the titles of the bug reports for one area of the product. Summarize
them in one or two sentences for the team that owns that area.`

export function build_digest(engine: Engine, model: string): Step<Report[], string> {
  const judge: Step<string, Verdict> = model_step({
    engine, model, system: TRIAGE, schema: verdict_schema,
    id: 'judge', description: 'the model sorts one report',
  })
  const summarize: Step<string, string> = model_step({
    engine, model, system: SUMMARIZE,
    id: 'summarize', description: 'the model sums up one area',
  })

  const triage_one: Step<Report, Triaged> = chain('report').input<Report>()
    .step('verdict', judge, ({ report }) => `${report.title}\n\n${report.body}`)
    .output(({ report, verdict }) => ({ ...report, ...verdict }))

  const summarize_one: Step<Area, Summary> = chain('group').input<Area>()
    .step('summary', summarize, ({ group }) => group.reports.map((r) => `- ${r.title}`).join('\n'))
    .output(({ group, summary }) => ({ area: group.area, summary }))

  return chain('reports').input<Report[]>()
    .step('triaged', map({ items: (reports: Report[]) => reports, do: triage_one, concurrency: 4 }), ({ reports }) => reports)
    .step('urgent', ({ triaged }) => triaged.filter(is_urgent),
      { description: 'code picks what a person should see first' })
    .step('areas', ({ triaged }) => group_by_area(triaged.filter((r) => !is_urgent(r))),
      { description: 'code groups the rest by area' })
    .step('summaries', map({ items: (areas: Area[]) => areas, do: summarize_one, concurrency: 4 }), ({ areas }) => areas)
    .output(({ urgent, summaries }) => render_digest(urgent, summaries))
}

/** The rule for what a person must see: anything about security, or anything bad. */
function is_urgent(report: Triaged): boolean {
  return report.security || report.severity === 'high'
}

function group_by_area(reports: Triaged[]): Area[] {
  const areas = new Map<string, Triaged[]>()
  for (const report of reports) areas.set(report.area, [...(areas.get(report.area) ?? []), report])
  return [...areas].map(([area, grouped]) => ({ area, reports: grouped }))
}

function render_digest(urgent: Triaged[], summaries: Summary[]): string {
  const first = urgent.map((r) => `- #${r.id} ${r.title} (${r.area}, ${r.severity}${r.security ? ', security' : ''})`)
  const rest = summaries.map((s) => `- ${s.area}: ${s.summary}`)
  return ['Look at these first:', ...first, '', 'Everything else, by area:', ...rest].join('\n')
}
```

A stand-in that sorts by keyword, `digest/stub.ts`:

```ts
// digest/stub.ts
import type { GenerateOptions } from 'fascicle'
import { make_stub_engine, text_of } from 'fascicle/testing'

/** A stand-in that triages by keyword and counts what it's asked to summarize. */
export function make_digest_stub() {
  return make_stub_engine([
    {
      prefix: 'digest/triage',
      content: (opts: GenerateOptions) => {
        const text = text_of(opts).toLowerCase()
        const area = ['billing', 'login', 'search'].find((a) => text.includes(a)) ?? 'other'
        return { area, severity: text.includes('nothing') ? 'high' : 'low', security: text.includes('password') }
      },
    },
    {
      prefix: 'digest/summarize',
      content: (opts: GenerateOptions) => `${text_of(opts).split('\n').length} report(s) about the same part of the product.`,
    },
  ])
}
```

And `digest/main.ts`, with five reports to sort:

```ts
// digest/main.ts
import { run } from 'fascicle'
import { filesystem_logger } from 'fascicle/adapters'
import { engine_from_env } from '../engine.js'
import { build_digest } from './flow.js'
import type { Report } from './flow.js'
import { make_digest_stub } from './stub.js'

const reports: Report[] = [
  { id: 1, title: 'Password reset email shows another login', body: 'The login reset email named a different account.' },
  { id: 2, title: 'Search ignores the date filter', body: 'Search results include old items when a date range is set.' },
  { id: 3, title: 'Invoice PDF has the wrong currency', body: 'Billing shows dollars for customers in euros.' },
  { id: 4, title: 'Search is slow for long queries', body: 'Search takes ten seconds on queries over 50 characters.' },
  { id: 5, title: 'Login button does nothing on Safari', body: 'Clicking the login button does nothing at all.' },
]

const { engine, model } = engine_from_env(make_digest_stub)
try {
  console.log(await run(build_digest(engine, model), reports, {
    trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }),
  }))
} finally {
  await engine.dispose()
}
```

### Compare the Tree

Give the digest a `digest/diagram.ts`, shaped like the solver's:

```ts
// digest/diagram.ts
import { build_digest } from './flow.js'
import { make_digest_stub } from './stub.js'

export const flow = () => build_digest(make_digest_stub(), 'stub')
```

Then print the diagram with `pnpm exec fascicle-diagram digest/diagram.ts` and
put it beside your drawing:

```text
chain
├─ triaged                step
│  └─ map
│     └─ chain
│        ├─ verdict       step
│        │  └─ judge      the model sorts one report
│        └─ output        step
├─ urgent                 code picks what a person should see first
├─ areas                  code groups the rest by area
├─ summaries              step
│  └─ map
│     └─ chain
│        ├─ summary       step
│        │  └─ summarize  the model sums up one area
│        └─ output        step
└─ output                 step
```

Same five bindings, in the same order, with the details drawn in. That match is
how you know the code does what you meant.

### Run It, Then Run It Live

```bash
pnpm exec tsx digest/main.ts
```

```text
Look at these first:
- #1 Password reset email shows another login (login, low, security)
- #5 Login button does nothing on Safari (login, high)

Everything else, by area:
- search: 2 report(s) about the same part of the product.
- billing: 1 report(s) about the same part of the product.
```

The stub sorts by keyword, so it calls the password report low, and its
summaries only count. Now run it live:

```bash
rm -f .trajectory.jsonl
FASCICLE_PROVIDER=openrouter pnpm exec tsx --env-file=.env digest/main.ts
```

```text
Look at these first:
- #1 Password reset email shows another login (login, high, security)
- #5 Login button does nothing on Safari (login, high)

Everything else, by area:
- search: Two open bugs affect search: the date filter is ignored, and long queries run slowly. Both point to problems in query handling that the search team should look at.
- billing: One open bug reports that invoice PDFs show the wrong currency. The title gives no further detail, so the scope and cause are unknown until someone triages it.
```

Seven model calls, four at a time, for a fraction of a cent. Open it in the
viewer (`pnpm exec fascicle-viewer .trajectory.jsonl`) and watch the two `map`s
fan out.

## Questions to Ask of Any Flow

A flow is a small system, and these are the questions that systems thinkers
ask. Ask them of every flow you draw, before you build it, and again after you
watch it run.

- **Where does judgment live, and where does precision?** Give the model the
  reading and writing, and give code the rules, the math, and anything that
  must come out the same every time.
- **What checks the judgment?** Every model output that matters should be
  checked by something: a schema, a rule in code, a second model, or a person.
  An unchecked model is the place where a confident wrong answer gets in.
- **What happens when a part fails?** Decide which failures to retry, which to
  route around, and which should stop everything and say so.
- **What does it cost, and where does the time go?** Count the model calls. Use
  the cheapest model that does the job well, and watch the viewer's header.
- **What's going to change?** Prompts, models, providers, and rules all change.
  Put a step boundary wherever change is likely, so changing that piece never
  means touching the others.
- **How would you know it worked?** A stub test for the shape, a snapshot of the
  diagram, and a trajectory of a real run.

## Patterns Worth Knowing

Most flows are a few of these, combined. Each one is a shape that you've either
built in this course or can now ask for by name.

- **The model proposes, code decides.** The model reads, code checks and acts.
  It's the solver, and the digest's `urgent` filter.
- **Draft, check, redraft.** A `loop` whose guard is a check, or `adversarial`
  when the critic is a model. It's the commit tool.
- **Fan out, fan in.** A `map` or `parallel` that spreads the work, and a chain
  binding that brings it back together. It's the digest.
- **Cheap first, escalate when unsure.** Ask a small model for an answer and how
  sure it is, then `branch` to a bigger model when it isn't sure.
- **Many minds.** Several models, or several tries, then `ensemble_step` to
  pick the best, or `consensus` to wait until they agree.
- **Ask a person.** `suspend` pauses the flow until somebody decides, and
  [human-in-the-loop.md](../human-in-the-loop.md) shows how to resume it.
- **Don't pay twice.** `checkpoint` saves an expensive step's result, so a rerun
  skips it.

## With Your Agent

This is where the vocabulary pays off. Run a design session with your agent
before any code exists:

> Here's a job I want to automate: (your paragraph). Don't write any code yet.
> Underline the verbs, say which ones need a model and which need code, name
> the composer for each shape word, and draw the tree in plain text. Then
> stop and wait for me.

Read its tree the way you'd review a colleague's design. Argue with it. Move
things between the model and code. When the tree is right:

> Build it exactly as drawn, with a stub engine first. Print the diagram with
> fascicle-diagram, and show it to me beside the tree we agreed on.

You stay the architect, and the agent does the typing. The tree is the contract
between you, and the diagram is how you check it was kept.

## Try It

Pick a real task from your own work, something that you do by hand at least
once a week and that has some reading or writing in it. A few ideas, if nothing
comes to mind:

- Read a long log file and list the most likely causes of an error.
- Turn a meeting transcript into action items, each with an owner.
- Read a pull request's diff and flag anything risky for a reviewer.
- Sort support emails, and draft replies for the easy ones.

Do all six moves on paper, or in a text file, before you touch the keyboard for
code. Then run the design session with your agent, build it on a stub, and
watch it run. When it works, ask the six questions again.

## Remember

- Paragraph, verbs, shape words, tree, build, run. Draw before you build.
- Verbs become leaves, shape words become composers, and fan-in makes a chain.
- Give the model judgment, give code precision, and check the model's work.
- The tree is your contract with your agent, and the diagram shows whether it
  was kept.

[← Build a Real Tool](./11-build-a-real-tool.md) · [Grow into the Blueprint →](./13-grow-into-the-blueprint.md)

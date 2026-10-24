# Fascicle Primer for Coding Agents

This file is for a coding agent (Claude Code, Codex, Cursor, or another) that's
working in a project which uses the published `fascicle` package. A person who
is learning Fascicle will usually import it from their `CLAUDE.md`, as
[lesson 0](./00-set-up.md) shows. Every shape, rule, and error message below
was checked against `fascicle` 0.16.3, and against 0.15.0 where the two differ,
except what's marked 0.17.0 and later, which was checked against 0.17.0. A rule
that a later release changes says what changed.

Your training data probably holds little or nothing about Fascicle, so treat
this file and the installed type declarations as the truth, and don't fill gaps
from other agent frameworks.

## Ground Truth

- **The installed types are authoritative.** Before you use an API that you
  haven't used yet in this session, read its declaration in
  `node_modules/fascicle/dist/index.d.ts`, or in `adapters.d.ts`,
  `testing.d.ts`, `agents.d.ts`, or `viewer.d.ts` for the subpaths. Don't
  invent options. Follow the imports, too. Core types such as `Step`,
  `RunContext` (which holds `ctx.call` and `ctx.abort`), and `StepOptions` live
  in files with generated names like `dist/types-<hash>.d.ts`, so search
  `dist/*.d.ts` for a name when `index.d.ts` only re-exports it.
- **The package README** ships at `node_modules/fascicle/README.md`, and
  releases after 0.16.3 ship this primer too, at
  `node_modules/fascicle/dist/AGENTS.md`, with its links pointed at GitHub.
- **The repository**, when the person has it cloned (often at `../fascicle`),
  holds the docs and the runnable examples. `docs/blueprint.md` is the app
  architecture, and `docs/composition.md` has one line on every composer.
- **0.16.3 and 0.15.0 differ only in the viewer.** On 0.15 it mishandles a
  trajectory file that holds more than one run, so delete `.trajectory.jsonl`
  between runs, and from 0.16 on it follows the newest run. What's marked 0.17.0
  and later (the tool-loop double, capture, and the duplicate-name check) isn't
  there at all on either of them.

## The Model in Four Sentences

Everything is a `Step<i, o>`, a plain object with an `id`, a `kind`, and a
`run` function. Composers take steps and return a step, so a whole flow is one
step, and a tree of plain objects that you can print before it runs.
`run(flow, input, options?)` executes it and returns a promise of the output.
An engine (`create_engine`) talks to model providers, and `model_step` or
`model_call` turns an engine call into a step.

## Words with One Meaning

The docs use these words in one sense each, and the API's names lean on them
(`docs/concepts.md` ends with the full glossary):

- **Model call.** One `engine.generate`, which a `model_step` or `model_call`
  makes each time it runs.
- **Model turn.** One request to the provider and the reply that comes back. A
  call with tools takes one per pass of its tool loop. The engine's API calls a
  model turn a step, in `max_steps`, `step_index`, `prepare_step`, and
  `GenerateResult.steps`, and that step is never a `Step`.
- **Tool loop.** The loop inside a model call that has `tools`. It runs the
  calls that a reply makes, appends the calls and their results, and sends the
  whole conversation again, until a reply makes no call or `max_steps` runs out.
- **Transcript.** The array of messages that a tool loop keeps across its
  turns. `prepare_step` changes what one turn sends and leaves the transcript
  alone.
- **Capture.** What the `capture` option records (0.17.0 and later), each model
  turn's request and reply. It has nothing to do with `make_capture_engine`.
- **Prompt cache.** A provider's short-lived store of a request's prefix, which
  the `cache` option asks for (0.17.0 and later).

## Imports

| From | What |
| --- | --- |
| `fascicle` | `run`, `step`, `sequence`, `parallel`, `branch`, `map`, `pipe`, `chain`, `loop`, `retry`, `fallback`, `timeout`, `compose`, `adversarial`, `ensemble_step`, `consensus`, `checkpoint`, `suspend`, `gate`, `describe`, `model_step`, `model_call`, `create_engine`, `define_tool`, `error_path`, `captured_turns` and `replay_turn` (0.17.0 and later), the error classes, and the types (`Step`, `Engine`, `RunContext`, `GenerateOptions`, ...) |
| `fascicle/adapters` | `filesystem_logger`, `http_logger`, `stderr_logger`, `tee_logger`, `noop_logger`, `filesystem_store` |
| `fascicle/testing` | `make_stub_engine`, `make_script_engine`, `make_capture_engine`, `make_loop_engine` and `assert_prefix_stable` (0.17.0 and later), `text_of`, `engine_from_generate` |
| `fascicle/agents` | `define_agent` |
| `fascicle/viewer` | `start_viewer` |

Two commands ship in the package: `fascicle-viewer <trajectory.jsonl>` and
`fascicle-diagram <module.ts>`, both run with `pnpm exec`. `fascicle-diagram`
reads the module's `flow` export, which is either a Step or a function with no
arguments that builds one, and it takes `--prefix ' * '`, `--width <n>`, and
`--export <name>`, plus `--internals` after 0.16.3.

## The Core Vocabulary

```ts
step('add', ({ a, b }: Pair) => a + b)                    // Step<Pair, number>
step('add', fn, { name: 'Add two numbers', description: 'shown in diagrams' })
step('solve', async (question: string, ctx) => ctx.call(inner, question), { arm: inner })
step('diff', (repo: string, ctx) => staged_diff(repo, ctx.abort))  // ctx.abort is the run's AbortSignal

await run(flow, input)                                    // resolves to the output
await run(flow, input, { trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }) })
await run(flow, input, { install_signal_handlers: false })  // tests and long-running hosts

sequence([a, b, c])                          // each step gets the previous output
parallel({ sum: add, product: multiply })    // same input to all; returns { sum, product }
branch({ when: (x: X) => boolean, then: step_a, otherwise: step_b })  // either arm's output
map({ items: (input: In) => list, do: per_item, concurrency: 4 })    // array out, in order
pipe(step_a, (value) => reshape(value))      // one step and one plain function, no more

chain('question').input<string>()            // record starts as { question }
  .step('problem', extract, ({ question }) => question)  // step form: a Step plus a selector
  .step('answer', ({ problem }) => calculate(problem), { description: 'code does the math' })  // function form, with options
  .output(({ answer }) => `${answer}`)                    // closes into a Step<string, string>

loop({
  init: (input: In): State => initial,       // input to starting state
  body: one_round,                           // Step<State, State>, runs before the guard
  guard: (state) => done(state),             // true stops; or a Step returning { stop, state }
  finish: (state, { converged, rounds }) => result,
  max_rounds: 3,                             // required
})

retry(leaf, { max_attempts: 3, backoff_ms: 500 })  // reruns on a throw, never on abort or suspend
timeout(leaf, 30_000)                              // throws timeout_error
fallback(primary, backup)                          // backup runs when primary throws

describe(flow)                               // text tree (prints system prompts in full)
describe.diagram(flow)                       // compact annotated tree; best for showing a person
describe.diagram(flow, { prefix: ' * ' })    // ready to paste into a doc comment
describe.json(flow)                          // the tree as data
```

Model steps and engines:

```ts
const engine = create_engine({ providers: { openrouter: { api_key, transport: 'native' } } })

const extract = model_step({
  engine, model: 'anthropic/claude-haiku-5.5',
  system: EXTRACT_PROMPT,          // first line is a role id, such as 'solver/extract'
  schema: problem_schema,          // any Standard Schema, usually zod; the output is typed by it
  id: 'extract', description: 'the model reads the numbers out of the question',
})                                 // Step<string | readonly Message[], Problem>

model_call({ ...same config })     // the GenerateResult envelope: content, usage, cost, finish_reason
await engine.dispose()             // always, in finally

const look_up = define_tool({ name: 'look_up', description: 'when to call it', input_schema: z.object({ key: z.string() }), execute: ({ key }) => find(key) })
model_step({ engine, model, system, tools: [look_up], max_steps: 6 })  // a tool loop; max_steps (default 10) caps its model turns
model_step({ ...config, on_tool_approval })   // asked before any tool flagged needs_approval runs
model_step({ ...config, capture: 'turns' })   // 0.17.0 and later: each turn's request and reply go into the trajectory
captured_turns(events)                        // 0.17.0 and later: each captured turn's whole request, rebuilt
```

Five providers need no extra package on `transport: 'native'`. They're
`openrouter`, `anthropic`, and `openai`, each with an `api_key`, and `ollama`
and `lmstudio`, each with a `base_url`, usually `http://localhost:11434` and
`http://localhost:1234/v1`.

## Rules That Bite

Each of these was hit while the lessons were being checked, and the quoted
messages are the real ones.

1. **Step ids are identifiers.** `step('add numbers', ...)` throws at
   construction: `TypeError: step id "add numbers" is not a valid identifier:
   ids are read back as property names, so use add_numbers and put the label in
   meta.name`. Put prose in `{ name }`.
2. **A step takes one input.** Bundle several values into an object.
3. **Open a chain with its input type**, `chain('name').input<T>()` or the
   equivalent `chain<T, 'name'>('name')`. Without it, through 0.16.3 the input
   type is `never`, and you'll see `Property 'a' does not exist on type 'never'`.
   Later releases type it as `ChainInputUndeclared<"call .input<T>() on the chain to say what it takes">`, which says the same thing outright.
4. **A mis-wired literal `sequence`** reports `TS2769: No overload matches this
   call`. Through 0.16.3 it reports it on more than one element, so read the
   last `Type 'X' is not assignable to type 'Y'` line, which names the joint.
   Later releases report it once, on the step that can't take its input, and
   the type names the joint, what arrives there, and what the step accepts, as
   in `SequenceJointMismatch<"after children[1]", string, number>`.
5. **Through 0.16.3, `branch` arms must share an output type.** Otherwise
   you'll get `Type 'Step<Pair, number>' is not assignable to type 'Step<Pair, string>'`,
   so state the union, as in `branch<Pair, number | null>({ ... })`. Later
   releases return the union of the arms' outputs, and naming one output type
   still holds both arms to it.
6. **`model_step`'s input type is `string | readonly Message[]`.** Annotate a
   model leaf as `Step<string, T>` before you combine it. Through 0.16.3, an
   unannotated model leaf beside a string step in a `parallel` makes the input
   `string & readonly Message[]`, which no value satisfies. Later releases take
   the input that every member accepts, a `string` there, and the annotation
   still keeps the types easy to read.
7. **Through 0.16.3, the schema never reaches the model on the native
   transport.** The engine asks for JSON that matches "the expected schema,"
   validates the reply, and repairs once after a failure
   (`schema_repair_attempts`, default 1). So on those versions, put an example
   of the exact JSON shape, with its field names, in the system prompt:
   `Reply with JSON only, shaped like this: {"a": 10, "b": 2, "op": "subtract"}`.
   Without one, the first reply usually fails and costs a second round trip, and
   small local models may never recover. Text in a zod `.describe()` doesn't
   reach the model on those versions either. Releases after 0.16.3 put the JSON
   Schema itself in that instruction, so the example becomes optional and the
   advice in `docs/blueprint.md` to keep field rules in `.describe()` holds.
   The installed version is in `node_modules/fascicle/package.json`.
8. **The system prompt's first line is a stable role id**, like
   `solver/extract`. `make_stub_engine` routes canned answers by prefix on it,
   and an unmatched system prompt throws
   `make_stub_engine: no canned response for system: ...`.
9. **Through 0.16.3, a stub's `content` function has no inferred parameter
   types**, because `content` is typed `unknown`, so annotate them:
   `(opts: GenerateOptions, call_index: number) => ...`. Later releases infer
   them for a function written inline.
10. **Inside a step body, run other steps with `ctx.call(step, input)`**, never
    `step.run(...)`, which loses the span and cancellation. Declare what the body
    calls with `{ arm: step }` or `{ arm: [a, b] }`, so `describe` shows it.
11. **`pipe` is binary.** To chain steps, use `sequence`.
12. **Model ids go to the provider verbatim**, and each provider spells them its
    own way: `anthropic/claude-haiku-5.5` on OpenRouter, `claude-haiku-5-5` on
    Anthropic, `gpt-5-mini` on OpenAI, `qwen3:4b-instruct-2507-q4_K_M` on Ollama.
    A wrong id fails with the provider's own message, such as
    `provider_error: openrouter API error 400: anthropic/claude-haiku-9 is not a
    valid model ID`.
13. **The engine never reads `process.env`.** Your code reads keys and passes
    them in. Keep keys in `.env` and run with `pnpm exec tsx --env-file=.env`.
    A bad key throws `provider_auth_error`.
14. **`create_engine` belongs in one module**, and everything else receives an
    `Engine`. Dispose engines in `finally`.
15. **Run TypeScript with `tsx`.** Local imports end in `.js` under NodeNext
    resolution, and plain `node` won't map a `.js` specifier to a `.ts` file.
16. **In vitest files, rename Fascicle's `describe`**, as
    `import { describe as describe_flow } from 'fascicle'`, since vitest has
    one too. Pass `install_signal_handlers: false` to `run` in tests.
17. **`describe(flow)` prints counter ids** like `chain_1`, which also appear in
    `error_path`, and it prints system prompts in full. `describe.diagram` never
    shows counter ids, so it's stable enough to snapshot in a test.
18. **A trajectory holds no per-call message or reply text unless the call
    captures.** Its first event, `flow_structure`, does carry every model step's
    system prompt, so treat the file as sensitive. Beyond that it records spans,
    timings, token counts, cost, and how the run ended. Under `capture` (rule
    23) it also holds each model turn's request and reply. Without it, for a
    model's reply, read `raw_text` and `schema_issues` on a
    `schema_validation_error`.
19. **Through 0.16.3, `adversarial` draws its inner machinery** in a diagram:
    `scope` and `stash` nodes, and internal steps such as `snapshot`. For a
    draft, check, and redraft loop that a person has to read, a `loop` with a
    code guard draws more simply there. Later releases draw a named composite
    as the steps that it was built from (`build` and `critique`), and
    `describe.diagram(flow, { internals: true })` draws the rest.
20. **The `then` key in `branch`** can trip the `unicorn/no-thenable` lint rule.
    It's a false positive.
21. **The engine retries some network failures itself**, inside a model call.
    `retry` works one level up and reruns the whole step when it fails, a schema
    failure included, while an abort or a suspend passes straight through.
22. **From 0.17.0, two tools under one name throw.** A call whose `tools` hold
    a name twice fails before any request, with ``engine_config_error: duplicate
    tool names: search (2); give each tool its own name, or pass `name_prefix`
    to mcp_client for one server's tools``. Earlier releases let the later tool
    replace the earlier one without a word. Give each tool its own name, and
    give an MCP server's tools a prefix with `mcp_client(config, { name_prefix: 'gh_' })`.
23. **From 0.17.0, capture is off until a call asks for it.** Set
    `capture: 'turns'` on a model step, a `generate` call, or the engine's
    `defaults`, and each model turn's request lands on `request_sent` (the first
    turn whole, each later one as what it added) and its reply on
    `response_received`. `'wire'` also records the exact body that each attempt
    sent on a native transport, and on `ai_sdk` it records `option_ignored` and
    captures as `'turns'`. `captured_turns(events)` rebuilds the whole requests,
    and `replay_turn(engine, turn)` sends one again without running a tool. A
    captured trajectory holds everything that the person typed and every tool
    result, so ask before you turn capture on, and keep the file out of git.

## Decision Rules

- **Leaves, arms, spine.** A leaf is one boundary (a function step or a model
  step). An arm composes around leaves (`retry`, `timeout`, `fallback`,
  `checkpoint`, `map`, `parallel`, `sequence`, and the multi-model composites).
  One `chain` per flow is the spine, and `branch` and `loop` steer it.
- **`sequence` or `chain`.** If every step needs only its predecessor's output,
  use `sequence`. Once any step needs something older, use `chain`.
- **`model_step` or `model_call`.** Use `model_step` for the answer, and
  `model_call` when you need usage, cost, tool calls, or the finish reason.
- **Declarative or direct.** Compose by default, so the shape shows in the
  diagram. Use a named step with `ctx.call` when the control flow depends on the
  data, and say why in a comment.
- **Don't over-compose.** A decision or a loop that's part of the flow's story
  gets a composer. A detail inside one piece of work stays plain code in a step.
  Wrapping a single step in `compose` or `sequence` only to name it adds nothing.
- **The model proposes, code decides.** Keep arithmetic, rules, filtering, and
  file or network access in code. Give the model reading and writing.
- **Check every model output that matters**, with a schema, a rule in code, a
  second model, or a person.
- **Suggest hardening, don't impose it.** Offer `retry`, `timeout`, and
  `fallback` around network calls. Add them when asked.

## From the Person's Words to Code

| They say | You build |
| --- | --- |
| "first, then" | `sequence` |
| "remember this for later," "use the original input" | a `chain` binding |
| "at the same time," "independently" | `parallel` |
| "for each," "every item" | `map`, with `concurrency` when they say "at most N at once" |
| "if, otherwise," "depending on" | `branch` |
| "until," "keep going while" | `loop`, always with `max_rounds` |
| "ask the model," "have it read or write" | `model_step` with a `schema` |
| "try again" | `retry` |
| "if that fails" | `fallback` |
| "give up after" | `timeout` |
| "check its work and redo it" | a `loop` with a code guard, or `adversarial` |
| "pick the best of" | `ensemble_step` |
| "only if they agree" | `consensus` |
| "ask me first," "wait for approval" | `suspend` or `gate`, with `run.until_suspended` |
| "let it look things up," "give it a tool" | `define_tool`, and `tools` with `max_steps` on the `model_step` |
| "ask me before it runs that tool" | `needs_approval` on the tool, and `on_tool_approval` on the model step |
| "don't redo the expensive part" | `checkpoint`, with a `checkpoint_store` |

## Check Your Own Work

Before you tell the person that a flow is done:

1. `pnpm exec tsc --noEmit` is clean.
2. Print the diagram (`describe.diagram(flow)`, or
   `pnpm exec fascicle-diagram <module>` against a module that exports
   `flow`), compare it with what was asked, and show it to the person.
3. Run it against a stub engine, which is free and gives the same answer every
   time.
4. Run the tests (`pnpm exec vitest run`) if the project has any.
5. Run it live only after that, and only with the person's go-ahead when it
   costs money. Offer `--env-file=.env` and the viewer command,
   `pnpm exec fascicle-viewer .trajectory.jsonl`.

When something fails, read the whole message, then `error_path(err)` for where,
then the trajectory for timing and cost, then reproduce it with a stub before
you change anything.

## Shapes to Copy

These are minimal sketches, not the course's code. When the person is working
through a lesson, the lesson's code wins.

One engine module that picks the provider from settings, with a stub when none
is set:

```ts
// engine.ts
import { create_engine } from 'fascicle'
import type { Engine } from 'fascicle'

export function engine_from_env(make_stub: () => Engine, env = process.env): { engine: Engine; model: string } {
  const provider = env['FASCICLE_PROVIDER'] ?? 'stub'
  if (provider === 'stub') return { engine: make_stub(), model: 'stub' }
  if (provider === 'openrouter') {
    const api_key = env['OPENROUTER_API_KEY']
    if (!api_key) throw new Error('OPENROUTER_API_KEY is not set: add it to .env, or export it in your shell')
    return {
      engine: create_engine({ providers: { openrouter: { api_key, transport: 'native' } } }),
      model: env['FASCICLE_MODEL'] ?? 'anthropic/claude-haiku-5.5',
    }
  }
  throw new Error(`unknown FASCICLE_PROVIDER "${provider}": use stub or openrouter`)
}
```

A spine with a model leaf, where the model reads and code computes:

```ts
// calc_flow.ts
import { chain, model_step } from 'fascicle'
import type { Engine, Step } from 'fascicle'
import { calculate, problem_schema } from './calc.js'
import type { Problem } from './calc.js'

const EXTRACT = `calc/extract
Read an arithmetic word problem and pull out the two numbers and the one
operation that answers it. Reply with JSON only, shaped like this:
{"a": 10, "b": 2, "op": "subtract"}`

export function build_calculator(engine: Engine, model: string): Step<string, number> {
  const extract: Step<string, Problem> = model_step({ engine, model, system: EXTRACT, schema: problem_schema, id: 'extract' })
  return chain('question').input<string>()
    .step('problem', extract, ({ question }) => question)
    .step('answer', ({ problem }) => calculate(problem))
    .output(({ answer }) => answer)
}
```

A test that runs the real flow on a stub:

```ts
// calc_flow.test.ts
import { describe, expect, it } from 'vitest'
import { describe as describe_flow, run } from 'fascicle'
import { make_stub_engine } from 'fascicle/testing'
import { build_calculator } from './calc_flow.js'

describe('the calculator', () => {
  it('computes the answer in code', async () => {
    const engine = make_stub_engine([{ prefix: 'calc/extract', content: { a: 3, b: 4, op: 'add' } }])
    expect(await run(build_calculator(engine, 'stub'), 'Sam has 3 apples and buys 4 more.', { install_signal_handlers: false })).toBe(7)
  })

  it('keeps its shape', () => {
    expect(describe_flow.diagram(build_calculator(make_stub_engine([]), 'stub'))).toMatchInlineSnapshot()
  })
})
```

## Where to Look Next

- [blueprint.md](../blueprint.md) for the layout of a growing app.
- [leaf-arm-spine.md](../leaf-arm-spine.md) for choosing a primitive at each
  layer.
- [composition.md](../composition.md) for one line on every composer.
- [cookbook.md](../cookbook.md) for worked patterns, including tool loops with
  `define_tool`.
- [testing.md](../testing.md) for the stand-in engines.
- [troubleshooting.md](../troubleshooting.md) for errors and their causes.

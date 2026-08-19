# Composition

The composition layer of `fascicle`. A thin set of primitives you own, for
composing agentic workflows out of plain values, with no framework, no classes,
and no ambient state.

## Public Surface

You import everything below from `fascicle`. The primitives live in
[`src/core/`](../src/core/) and the built-in composites in
[`src/composites/`](../src/composites/); the umbrella re-exports both.

| Export | Kind | Purpose |
| --- | --- | --- |
| `run(flow, input, options?)` | function | execute a flow to completion |
| `run.stream(flow, input, options?)` | function | execute a flow and observe events |
| `run.until_suspended(flow, input, options?)` | function | execute a flow; a `suspend` gate returns a typed `RunOutcome` with a `resume` closure |
| `describe(step, options?)` | function | render the composition as a text tree; `describe.json(step)` returns the structured `FlowNode` tree instead |
| `flow_schema` | JSON value | JSON Schema for the YAML flow representation |
| `step` | factory | atomic or anonymous step |
| `sequence` | composer | chain steps, threading output into input |
| `parallel` | composer | run a named map of steps concurrently |
| `branch` | composer | run `then` or `otherwise` based on `when(input)` |
| `map` | composer | run a step per item with optional concurrency cap |
| `pipe` | composer | post-process a step's output with a plain function |
| `retry` | composer | re-run an inner step with exponential backoff |
| `fallback` | composer | run a backup step on primary failure |
| `timeout` | composer | cancel an inner step after a deadline |
| `loop` | composer | bounded iteration with carry-state and optional guard (`LoopConfig`, `LoopGuardResult`, `LoopOutcome`) |
| `compose` | composer | label a composite step for trajectory output |
| `adversarial` | composer | build-and-critique loop |
| `ensemble` | composer | N-of-M pick best by score |
| `ensemble_step` | composer | pick best where the scorer is itself a `Step` |
| `tournament` | composer | single-elimination bracket |
| `consensus` | composer | multi-round concurrent agreement |
| `gate` | composer | checkpoint-then-suspend approval envelope; paid work survives the pause |
| `improve` | composer | bounded online propose → score → accept/reject loop |
| `learn` | function | offline reflection over recorded trajectories |
| `bench` / `normalize_score` | functions | run a flow over fixture cases, score every output with every judge, return a `BenchReport` |
| `judge_equals` / `judge_llm` / `judge_with` | factories | the stock judges for `bench` |
| `read_baseline` / `write_baseline` / `regression_compare` | functions | persist a report as JSON, load one back, diff a fresh report against it |
| `checkpoint` | composer | memoize an inner step by key |
| `suspend` | composer | pause awaiting external input |
| `chain` | builder | named steps over a growing typed record (`Chain`, `ChainStepOptions`); the spine |
| `scope` / `stash` / `use` | composers | named state across non-adjacent steps |
| `STEP_KINDS` / `is_step_kind` | value / guard | the closed list of step kinds and its narrowing guard (type: `StepKind`) |
| `parse_trajectory_event`, `is_span_start_event` / `is_span_end_event` / `is_emit_event` / `is_custom_trajectory_event` | fn / guards | parse a recorded trajectory line, then narrow it by shape |
| `timeout_error` | error | thrown by `timeout` |
| `suspended_error` | error | thrown by `suspend` on first pass |
| `resume_validation_error` | error | thrown by `suspend` on invalid resume data |
| `aborted_error` | error | thrown on SIGINT/SIGTERM or user abort |
| `describe_cycle_error` | error | thrown when `describe` meets a cycle in the tree |
| `bench_suspend_error` | error | thrown when a benched flow suspends (`bench` has no resume path) |
| `RunContext` | type | per-run execution context |
| `RunOutcome` | type | the `done` / `suspended` result of `run.until_suspended` |
| `TrajectoryLogger` | type | structured-event observer |
| `TrajectoryEvent` | type | one structured event |
| `CheckpointStore` | type | persistent key-value store |
| `Step<i, o>` | type | the step contract, so `id`, `kind`, and a `run(input, ctx)` function property, plus optional `config`, `children`, `anonymous`, and `meta`. `run` is a function property rather than a method, so strict mode checks `i` contravariantly and a step wired to an input it can't accept is a compile error |
| `AnyStep` | type | the erased supertype (`Step<never, unknown>`) held by `children` |
| `StepMetadata` | type | display name, description, and port labels surfaced by `describe` |
| `DescribeOptions` / `FlowNode` / `FlowValue` | types | `describe` options and the structured tree `describe.json` returns |

The composites also export their config, result, and judge types (`Judge`,
`Score`, `BenchCase`, `EnsembleResult`, `AdversarialConfig`, ...); the full
enumeration is in [api-reference.md](./api-reference.md#exported-types).

## The Step-as-Value Thesis

Every composable unit you write is a `Step<i, o>`, a plain object that has an
`id`, a `kind`, and an async `run`. Every composer is a function that accepts one or
more `Step<i, o>` values and returns a single `Step<i, o>` value. No separate
`Workflow`, `Agent`, or `Graph` type exists, and nothing needs to be registered,
constructed, or initialized. Anywhere a step fits, any
composition of steps fits (including arbitrarily deep nestings) because
everything shares the same shape.

That one invariant buys you the rest:

- **Substitutability.** You can swap any step for any composition of steps
  that has the same I/O type. `retry(adversarial(ensemble(...)))` works
  because each composer treats its children as opaque `step` values.
- **Introspectability.** The full flow is a tree of plain objects that
  `describe(step)` can walk, and so can any code of yours that wants to
  render it.
- **No coupling.** Steps are values, not registered entities. Two
  unrelated flows share no state unless you inject it.

## The 22 Primitives

Copy these one-liners into an LLM's system prompt and it will write you flows
from English specifications:

- `step(id, fn)` / `step(fn)` — atomic unit. Anonymous form can't be
  checkpointed.
- `sequence([a, b, c])` — run in order, thread output into input. Literal
  tuples are joint-checked at compile time, so each child must accept its
  predecessor's output, and a mismatch errors on the offending element
  (arrays built at runtime degrade to `unknown` boundaries). A straight
  pipe belongs in `sequence`; reach for `chain` when a step needs fan-in,
  phases, or named per-joint types.
- `parallel({ a, b, c })` — run concurrently, return `{ a, b, c }`.
- `branch({ when, then, otherwise })` — route on `when(input)`.
- `map({ items, do, concurrency? })` — run `do` per item; cap in-flight.
- `pipe(inner, fn)` — post-process `inner`'s output. Strictly binary, so one
  Step, one plain mapping function. To chain Steps use `sequence([...])`;
  passing a Step as `fn` throws at construction.
- `retry(inner, { max_attempts, backoff_ms?, max_delay_ms?, jitter?, on_error? })`
  — re-run on failure with exponential backoff, jittered by up to one
  `backoff_ms` and clamped to `max_delay_ms` (default 30s). `jitter`
  defaults on.
- `fallback(primary, backup, { handoff? })` — run `backup` if `primary`
  throws. `handoff(input, err)` builds the backup's input, so the backup can
  be told why the primary failed; without it the backup gets the original
  input. Control-flow signals (suspend, abort) propagate without triggering
  the backup or the handoff. When the backup fails too, the backup's error is
  thrown with the primary's error attached as `cause`, so neither failure is
  lost.
- `timeout(inner, ms)` — cancel `inner` after `ms`.
- `loop({ init, body, guard?, finish, max_rounds })` — bounded iteration
  with carry-state, returning whatever `finish` projects. Non-convergence is
  data, not error, and `finish(state, { converged, rounds })` receives it, so a
  projection folds in as much or as little of the outcome as it needs
  (`finish: (s) => s` to carry the state straight out,
  `finish: (s, outcome) => ({ value: s, ...outcome })` for the whole thing).
- `compose(name, inner)` — label a composite step so it shows up by intent
  in trajectories and `describe` output.
- `adversarial({ build, critique, accept, max_rounds, project? })` — propose,
  critique, loop.
- `ensemble({ members, score, select?, project? })` — pick the best of several.
- `ensemble_step({ members, score, rank_by, select?, project? })` — pick-best
  where scoring is itself a `Step` (a model judge with its own span); returns
  the winner plus its structured score.
- `tournament({ members, compare, project? })` — single-elimination bracket.
- `consensus({ members, agree, max_rounds, project? })` — multi-round
  concurrent agreement.
  Each of these five returns a result envelope; the optional `project` maps
  it into the step's output at the source (`project: (r) => r.winner`), so
  no downstream unwrap step is needed.
- `checkpoint(inner, { key })` — memoize `inner` by key.
- `suspend({ id, on, resume_schema, combine })` — pause for external input.
- `gate(inner, { id, store?, format?, name? })` — persist paid work, then
  pause for approval; resume returns the inner result unchanged.
- `scope([...])` / `stash(key, source)` / `use(keys, fn)` — named state at
  the key-value level; `chain` is the typed front door over the same idea.
- `chain<i>(input_name?)` with `.step(name, arm, select)` /
  `.step(name, fn, options?)` / `.stage(name, project?)` / `.output(fn)` —
  named steps over a growing typed record. State the input type as
  `chain<i>()` or `chain('name').input<i>()` (unannotated chains default to
  `never` and fail at `run`). `.step` merges its output under `name`, and the
  arm form dispatches a composed `Step` on the selected slice of the record
  and records it as the binding's describe child in one statement. `.stage`
  concludes a phase (a grouping span in the trajectory; with `project`, it
  replaces the record so earlier bindings go out of scope), and `.output`
  projects the final result and returns an ordinary `Step`. A body that must
  wrap the call itself uses `ctx.call` and passes the same value as
  `options.arm` so `describe` still renders the subtree.
- `improve({ seed, propose, score, budget, project? })` — bounded online
  self-improvement loop of propose → score → accept/reject with plateau
  detection; `project` maps the result envelope (for example,
  `(r) => r.best.content`).
- `learn({ flow, source, analyzer })` — offline reflection over recorded
  trajectories; returns the analyzer's proposals plus summary metadata.

Not all 22 are peers. The primary vocabulary and the decision rules for
choosing at each layer live in [leaf-arm-spine.md](./leaf-arm-spine.md);
the advanced tier (`scope`/`stash`/`use`, plain `ensemble`, `tournament`,
`improve`/`learn`) is covered in
[advanced-composition.md](./advanced-composition.md), where each entry is
paired with the primary primitive that you should try first.

## Two Ways to Write a Flow

The primitives above are the declarative style, where the program is a visible
tree that you can describe before it runs, and where binding and stage names
become span labels. The direct style is its mirror, a plain `step` body that
uses ordinary `const` / `if` / `for`, and `ctx.call(step, input)` is the one
bridge for invoking another Step (spans, abort, and error paths stay intact). Choose
per flow. Use `chain` when you want the topology visible as data, and a plain body
when the control flow is genuinely dynamic. The two compose freely in both
directions, and the trajectory invariant is identical under each because it
is enforced below both, at the model boundary. The same agent is written
once in each style in
[examples/release_notes.ts](../examples/release_notes.ts) (chain) and
[examples/release_notes_direct.ts](../examples/release_notes_direct.ts)
(direct, with a conditional model boundary as the reason to be direct).

How these primitives layer into a whole app (model boundaries as leaves,
named arms composed around them, one `chain` spine) is the subject of
[leaf-arm-spine.md](./leaf-arm-spine.md), including the decision rules for
choosing between `sequence` and `chain` and between `model_step` and
`model_call`.

## The Helper Tier: Wrapping Primitives Is the Extension Model

`model_step(cfg)` is the shipped example. It's `model_call` projected to its
content (a `string`, or the schema-validated value when `cfg.schema` is
set), one preset `project` in [src/model_call.ts](../src/model_call.ts).
When a pattern in your own flows repeats, wrap it the same way, as a function from
config to `Step<i, o>`, composed from the primitives (a `pipe` over an
existing step is the usual shape), with no runner internals involved. The change-triage example's assessor stage
([examples/change-triage/src/stages/assessor.ts](../examples/change-triage/src/stages/assessor.ts))
is that pattern at app scale, and its flow
([examples/change-triage/src/flow.ts](../examples/change-triage/src/flow.ts))
carries a whole agent with `chain`, `model_step`, and `ctx.call` alone.

## Running a Flow

```typescript
import { run, sequence, step } from 'fascicle';

const flow = sequence([
  step('a', (n: number) => n + 1),
  step('b', (n: number) => n * 2),
]);

const result = await run(flow, 1);
// result === 4
```

Opt out of process-level signal handling when you're embedding into a host that
owns its own signal stack:

```typescript
await run(flow, 1, { install_signal_handlers: false });
```

You inject adapters per run:

```typescript
import { filesystem_logger, filesystem_store } from 'fascicle/adapters';

await run(flow, input, {
  trajectory: filesystem_logger({ output_path: '/tmp/run.jsonl' }),
  checkpoint_store: filesystem_store({ root_dir: '/tmp/checkpoints' }),
});
```

## Streaming

`run.stream(flow, input)` returns `{ events, result }`. Steps call
`ctx.emit(event)` to surface progress, and you iterate the event stream
and await the final result. The underlying graph is identical to
`run(flow, input)`, because streaming is purely observational.

## Checkpoint Key Namespacing (F2)

Your `checkpoint` keys share a single namespace across every flow that reuses
the same `checkpoint_store`. Two unrelated flows that both write
`{ key: 'build' }` will collide — the second one reads the first's value.
That's on purpose, because keys are data and namespacing is your call, but
it means you should prefix keys with a flow name or a content hash:

```typescript
checkpoint(adversarial(...), { key: (i) => `build:${flow_name}:${i.spec_hash}` });
```

Use a content hash when what you want is "if the input is the same, reuse the
result." Use a scoped prefix when two flows share a store but should never
collide.

## Anonymous Steps Cannot Be Checkpointed (F6)

Anonymous steps (`step(fn)` with no id) throw at construction time when
wrapped by `checkpoint`:

```text
Error: checkpoint requires a named step; got anonymous
```

Give the inner step an id and it goes away.

## No Circular Compositions (F7)

Composers build trees, not graphs. A composer that references itself (or a
flow variable that appears inside its own definition) causes infinite
recursion during `describe` or execution. The framework doesn't guard
against this; keep compositions acyclic.

## YAML Representation

A YAML shape of the composition tree exists for documentation and for
LLM-writable specs. It's **not parsed at runtime**, and a loader stays out of
the surface until downstream demand appears. The shape is validated by a
JSON Schema, exported as `flow_schema`:

```typescript
import { flow_schema } from 'fascicle';
// validate a loaded YAML object against flow_schema using any
// draft-2020-12-aware validator (ajv, hyperjump, etc.)
```

## Examples

Runnable references live at the repo root in [`examples/`](../examples/),
in two kinds. Single-file examples (each one
`pnpm exec tsx examples/<name>.ts` away) sit beside seven full example apps in
subdirectories. All of them import the published `fascicle` surface, so
everything there is copy-pasteable into an npm consumer. Highlights among
the single files:

- [`hello.ts`](../examples/hello.ts), the smallest viable harness
- [`newsroom.ts`](../examples/newsroom.ts), the vocabulary tour, every
  primary primitive once, each in its suggested role
- [`release_notes.ts`](../examples/release_notes.ts) /
  [`release_notes_direct.ts`](../examples/release_notes_direct.ts), the same
  agent in the chain and direct styles
- [`adversarial_build.ts`](../examples/adversarial_build.ts), build-and-critique
  with an ensemble of judges
- [`ensemble_judge.ts`](../examples/ensemble_judge.ts), N-of-M pick best
- [`improve.ts`](../examples/improve.ts) / [`learn.ts`](../examples/learn.ts):
  the self-improvement tier
- [`bench_reviewer.ts`](../examples/bench_reviewer.ts), bench and regression
  over a `define_agent` reviewer
- [`streaming_chat.ts`](../examples/streaming_chat.ts), observe emitted tokens
- [`checkpoint_resume.ts`](../examples/checkpoint_resume.ts) /
  [`suspend_resume.ts`](../examples/suspend_resume.ts), durability, pause,
  and resume
- [`hitl_http.ts`](../examples/hitl_http.ts), suspend/confirm/resume over HTTP
- [`ollama_chat.ts`](../examples/ollama_chat.ts), drive a local Ollama model
  through a composed sequence

The seven apps are separate workspace members consuming the published
package: [`pr-improve/`](../examples/pr-improve/) (the canonical
[blueprint](./blueprint.md) reference),
[`change-triage/`](../examples/change-triage/),
[`docs-concierge/`](../examples/docs-concierge/),
[`amplify/`](../examples/amplify/),
[`red-green-refactor/`](../examples/red-green-refactor/),
[`swebench/`](../examples/swebench/), and
[`mcp-server/`](../examples/mcp-server/). The full index, with what each
example shows, is [`examples/README.md`](../examples/README.md).

## Check Command

From the repo root:

```bash
pnpm check
```

This is the single source of truth. If it exits 0, your work is complete.

## Further Reading

- [concepts.md](./concepts.md) — the mental model behind these primitives.
- [getting-started.md](./getting-started.md) — install and run your first flow.

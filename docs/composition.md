# core

The composition layer of `fascicle`. A thin, owned set of primitives for
composing agentic workflows out of plain values — no framework, no classes,
no ambient state.

## Public surface

| Export | Kind | Purpose |
| --- | --- | --- |
| `run(flow, input, options?)` | function | execute a flow to completion |
| `run.stream(flow, input, options?)` | function | execute a flow and observe events |
| `describe(step)` | function | render the composition as a text tree |
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
| `loop` | composer | bounded iteration with carry-state and optional guard |
| `compose` | composer | label a composite step for trajectory output |
| `adversarial` | composer | build-and-critique loop |
| `ensemble` | composer | N-of-M pick best by score |
| `tournament` | composer | single-elimination bracket |
| `consensus` | composer | multi-round concurrent agreement |
| `checkpoint` | composer | memoize an inner step by key |
| `suspend` | composer | pause awaiting external input |
| `scope` / `stash` / `use` | composers | named state across non-adjacent steps |
| `timeout_error` | class | thrown by `timeout` |
| `suspended_error` | class | thrown by `suspend` on first pass |
| `resume_validation_error` | class | thrown by `suspend` on invalid resume data |
| `aborted_error` | class | thrown on SIGINT/SIGTERM or user abort |
| `RunContext` | type | per-run execution context |
| `TrajectoryLogger` | type | structured-event observer |
| `TrajectoryEvent` | type | one structured event |
| `CheckpointStore` | type | persistent key-value store |
| `Step` | type | alias for the `step<i, o>` shape |

## The step-as-value thesis

Every composable unit is a `Step<i, o>` — a plain object with an `id`, a
`kind`, and an async `run`. Every composer is a function that accepts one or
more `Step<i, o>` values and returns a single `Step<i, o>` value. There is
no separate `Workflow`, `Agent`, or `Graph` type, and nothing needs to be
registered, constructed, or initialized. Anywhere a step fits, any
composition of steps fits — including arbitrarily deep nestings — because
everything shares the same shape.

This one invariant buys the rest:

- **Substitutability.** Any step can be swapped with any composition of
  steps having the same I/O type. `retry(adversarial(ensemble(...)))` works
  because each composer treats its children as opaque `step` values.
- **Introspectability.** The full flow is a tree of plain objects, walkable
  by `describe(step)` or by application code that wants to render it.
- **No coupling.** Steps are values, not registered entities. Two
  unrelated flows never share state unless the caller injects it.

## The 22 primitives

Copy these one-liners into an LLM's system prompt and it can write flows
from English specifications:

- `step(id, fn)` / `step(fn)` — atomic unit. Anonymous form cannot be
  checkpointed.
- `sequence([a, b, c])` — run in order, thread output into input.
- `parallel({ a, b, c })` — run concurrently, return `{ a, b, c }`.
- `branch({ when, then, otherwise })` — route on `when(input)`.
- `map({ items, do, concurrency? })` — run `do` per item; cap in-flight.
- `pipe(inner, fn)` — post-process `inner`'s output. Strictly binary: one
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
  the backup or the handoff.
- `timeout(inner, ms)` — cancel `inner` after `ms`.
- `loop({ init, body, guard?, finish, max_rounds })` — bounded iteration
  with carry-state, returning whatever `finish` projects. Non-convergence is
  data, not error: `finish(state, { converged, rounds })` receives it, so a
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
- `scope([...])` / `stash(key, source)` / `use(keys, fn)` — named state at
  the key-value level; `chain` is the typed front door over the same idea.
- `chain(input_name?)` with `.step(name, fn, options?)` /
  `.stage(name, project?)` / `.output(fn)` — named steps over a growing typed
  record: `.step` runs `fn(record, ctx)` and merges its output under `name`;
  `.stage` concludes a phase (a grouping span in the trajectory; with
  `project`, it replaces the record so earlier bindings go out of scope);
  `.output` projects the final result and returns an ordinary `Step`. When a
  binding invokes a composed Step via `ctx.call`, pass it as
  `options.arm` too: the arm is metadata only (dispatch ignores it), but
  `describe` renders its subtree as the binding's child, so the static tree
  shows what the binding runs.
- `improve({ seed, propose, score, budget, project? })` — bounded online
  self-improvement loop: propose → score → accept/reject with plateau
  detection; `project` maps the result envelope (e.g. `(r) => r.best.content`).
- `learn({ flow, source, analyzer })` — offline reflection over recorded
  trajectories; returns the analyzer's proposals plus summary metadata.

## Two ways to write a flow

The primitives above are the declarative style: the program is a visible
tree, describable before it runs, with binding and stage names as span
labels. The direct style is its mirror: a plain `step` body using ordinary
`const` / `if` / `for`, with `ctx.call(step, input)` as the one bridge for
invoking another Step (spans, abort, and error paths stay intact). Choose
per flow: `chain` when you want the topology visible as data; a plain body
when the control flow is genuinely dynamic. The two compose freely in both
directions, and the trajectory invariant is identical under each because it
is enforced below both, at the model boundary. The same agent is written
once in each style in
[examples/release_notes.ts](../examples/release_notes.ts) (chain) and
[examples/release_notes_direct.ts](../examples/release_notes_direct.ts)
(direct, with a conditional model boundary as the reason to be direct).

## The helper tier: wrapping primitives is the extension model

`model_step(cfg)` is the shipped example: `model_call` projected to its
content (a `string`, or the schema-validated value when `cfg.schema` is
set), implemented as one `pipe` in [src/model_call.ts](../src/model_call.ts).
When a pattern in your flows repeats, wrap it the same way: a function from
config to `Step<i, o>`, composed from the primitives, with no runner
internals involved. The change-triage example's assessor stage
([examples/change-triage/src/stages/assessor.ts](../examples/change-triage/src/stages/assessor.ts))
is that pattern at app scale, and its flow
([examples/change-triage/src/flow.ts](../examples/change-triage/src/flow.ts))
carries a whole agent with `chain`, `model_step`, and `ctx.call` alone.

## Running a flow

```typescript
import { run, sequence, step } from 'fascicle';

const flow = sequence([
  step('a', (n: number) => n + 1),
  step('b', (n: number) => n * 2),
]);

const result = await run(flow, 1);
// result === 4
```

Opt out of process-level signal handling when embedding into a host that
owns its own signal stack:

```typescript
await run(flow, 1, { install_signal_handlers: false });
```

Inject adapters on a per-run basis:

```typescript
import { filesystem_logger, filesystem_store } from 'fascicle/adapters';

await run(flow, input, {
  trajectory: filesystem_logger({ output_path: '/tmp/run.jsonl' }),
  checkpoint_store: filesystem_store({ root_dir: '/tmp/checkpoints' }),
});
```

## Streaming

`run.stream(flow, input)` returns `{ events, result }`. Steps call
`ctx.emit(event)` to surface progress; consumers iterate the event stream
and await the final result. The underlying graph is identical to
`run(flow, input)`: streaming is purely observational.

## Checkpoint key namespacing (F2)

`checkpoint` keys share a single namespace across every flow that reuses
the same `checkpoint_store`. Two unrelated flows that both write
`{ key: 'build' }` will collide — the second one reads the first's value.
This is intentional (keys are data; namespacing is the caller's call), but
it means you should prefix keys with a flow name or a content hash:

```typescript
checkpoint(adversarial(...), { key: (i) => `build:${flow_name}:${i.spec_hash}` });
```

Use a content hash when the goal is "if the input is the same, reuse the
result." Use a scoped prefix when two flows share a store but should never
collide.

## Anonymous steps cannot be checkpointed (F6)

Anonymous steps (`step(fn)` with no id) throw at construction time when
wrapped by `checkpoint`:

```text
Error: checkpoint requires a named step; got anonymous
```

The fix is to give the inner step an id.

## No circular compositions (F7)

Composers build trees, not graphs. A composer that references itself — or a
flow variable that appears inside its own definition — causes infinite
recursion during `describe` or execution. The framework does not guard
against this; keep compositions acyclic.

## YAML representation

A YAML shape of the composition tree exists for documentation and for
LLM-writable specs. It is **not parsed at runtime** in v1. The shape is
validated by a JSON Schema, exported as `flow_schema`:

```typescript
import { flow_schema } from 'fascicle';
// validate a loaded YAML object against flow_schema using any
// draft-2020-12-aware validator (ajv, hyperjump, etc.)
```

## Examples

Runnable references live at the repo root in [`examples/`](../examples/).
They import from `fascicle` (the umbrella) and exercise the primitives
exported by this package:

- [`adversarial_build.ts`](../examples/adversarial_build.ts) — build-and-critique
  with an ensemble of judges
- [`ensemble_judge.ts`](../examples/ensemble_judge.ts) — N-of-M pick best
- [`streaming_chat.ts`](../examples/streaming_chat.ts) — observe emitted tokens
- [`suspend_resume.ts`](../examples/suspend_resume.ts) — pause and resume on
  external input
- [`ollama_chat.ts`](../examples/ollama_chat.ts) — drive a local Ollama model
  through a composed sequence
- [`hello.ts`](../examples/hello.ts) — the smallest viable harness

Each file exports an async entry function. A vitest smoke test imports
each entry and asserts its output shape.

## Check command

From the repo root:

```bash
pnpm check
```

This is the single source of truth. If it exits 0, your work is complete.

## Further reading

- [concepts.md](./concepts.md) — the mental model behind these primitives.
- [getting-started.md](./getting-started.md) — install and run your first flow.
</content>

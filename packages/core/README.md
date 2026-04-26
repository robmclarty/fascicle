# @repo/core

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

## The 16 primitives

Copy these one-liners into an LLM's system prompt and it can write flows
from English specifications:

- `step(id, fn)` / `step(fn)` — atomic unit. Anonymous form cannot be
  checkpointed.
- `sequence([a, b, c])` — run in order, thread output into input.
- `parallel({ a, b, c })` — run concurrently, return `{ a, b, c }`.
- `branch({ when, then, otherwise })` — route on `when(input)`.
- `map({ items, do, concurrency? })` — run `do` per item; cap in-flight.
- `pipe(inner, fn)` — post-process `inner`'s output.
- `retry(inner, { max_attempts, backoff_ms?, on_error? })` — re-run on
  failure with exponential backoff.
- `fallback(primary, backup)` — run `backup` if `primary` throws.
- `timeout(inner, ms)` — cancel `inner` after `ms`.
- `adversarial({ build, critique, accept, max_rounds })` — propose, critique,
  loop.
- `ensemble({ members, score, select? })` — pick the best of several.
- `tournament({ members, compare })` — single-elimination bracket.
- `consensus({ members, agree, max_rounds })` — multi-round concurrent
  agreement.
- `checkpoint(inner, { key })` — memoize `inner` by key.
- `suspend({ id, on, resume_schema, combine })` — pause for external input.
- `scope([...])` / `stash(key, source)` / `use(keys, fn)` — named state when
  chaining is not enough.

## Running a flow

```typescript
import { run, sequence, step } from '@repo/core';

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
import { filesystem_logger } from '@repo/observability';
import { filesystem_store } from '@repo/stores';

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
import { flow_schema } from '@repo/core';
// validate a loaded YAML object against flow_schema using any
// draft-2020-12-aware validator (ajv, hyperjump, etc.)
```

## Examples

Runnable references live at the repo root in [`examples/`](../../examples/).
They import from `@repo/fascicle` (the umbrella) and exercise the primitives
exported by this package:

- [`adversarial_build.ts`](../../examples/adversarial_build.ts) — build-and-critique
  with an ensemble of judges
- [`ensemble_judge.ts`](../../examples/ensemble_judge.ts) — N-of-M pick best
- [`streaming_chat.ts`](../../examples/streaming_chat.ts) — observe emitted tokens
- [`suspend_resume.ts`](../../examples/suspend_resume.ts) — pause and resume on
  external input
- [`ollama_chat.ts`](../../examples/ollama_chat.ts) — drive a local Ollama model
  through a composed sequence
- [`hello.ts`](../../examples/hello.ts) — the smallest viable harness

Each file exports an async entry function. A vitest smoke test imports
each entry and asserts its output shape.

## Check command

From the repo root:

```bash
pnpm check
```

This is the single source of truth. If it exits 0, your work is complete.

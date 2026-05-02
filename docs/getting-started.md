# Getting started

A 10-minute tour: install, compose your first flow, run it, observe what happened.

## Install

From npm (as a consumer):

```bash
pnpm add fascicle zod
```

From this repo (as a contributor):

```bash
pnpm install
pnpm check
```

`pnpm check` is the single source of truth for "is the repo healthy". Exit 0 means the workspace is in shape.

> **One package, monorepo for enforcement.** Consumers install **one** thing: `fascicle`. Inside this repo the code is split into `@repo/core`, `@repo/engine`, `@repo/observability`, `@repo/stores`, and `@repo/fascicle` (umbrella) so the workspace graph, `fallow`, and the ast-grep rules in `rules/` can police architectural boundaries directly (e.g. core cannot import adapters, only `packages/config/` reads `process.env`). The `@repo/*` packages are never published.

## Your first flow

A flow is a value. Build one with `step(...)` and compose with `sequence`, `parallel`, `branch`, and friends.

```ts
import { run, sequence, step } from 'fascicle';

const increment = step('increment', (n: number) => n + 1);
const double    = step('double',    (n: number) => n * 2);

const flow = sequence([increment, double]);

const result = await run(flow, 1);
console.log(result); // 4
```

That's all of it. Every composable unit is a `Step<i, o>`. Every composer returns a `Step<i, o>`. You can nest arbitrarily.

## The 18 primitives

The composition layer is small on purpose:

| Primitive             | Shape                                                       |
| --------------------- | ----------------------------------------------------------- |
| `step`                | Lift a plain function into a `Step<i, o>`.                  |
| `sequence`            | Run A then B then C, threading the value.                   |
| `parallel`            | Run steps concurrently, collect into an object.             |
| `branch`              | Pick a branch by predicate on the input.                    |
| `map`                 | Run a step over each element of an array.                   |
| `pipe`                | `sequence` plus an inline reshaping function.               |
| `retry`               | Re-run on failure with a backoff policy.                    |
| `fallback`            | Try A, fall back to B on failure.                           |
| `timeout`             | Abort a step after N milliseconds.                          |
| `loop`                | Bounded iteration with carry-state and an optional guard.   |
| `compose`             | Label a composite step for trajectory output.               |
| `adversarial`         | Build, critique, repeat until accept or `max_rounds`.       |
| `ensemble`            | Run N members, pick the highest-scoring result.             |
| `tournament`          | Pairwise compare members, pick the bracket winner.          |
| `consensus`           | Run N, accept only if `>= quorum` agree.                    |
| `checkpoint`          | Memoize a step's output in a `CheckpointStore`.             |
| `suspend`             | Pause the flow; resume later with `resume_data`.            |
| `scope`/`stash`/`use` | Pass values through a subtree without rewiring signatures.  |

Full surface and signatures: [`packages/core/README.md`](../packages/core/README.md). Runnable references: [`examples/`](../examples/).

## Running

`run(flow, input, options?)` executes the flow and returns its output. `run.stream(flow, input, options?)` returns `{ events, result }` so you can observe the run as it unfolds.

```ts
import { run } from 'fascicle';

// one-shot
const out = await run(flow, input);

// streaming
const handle = run.stream(flow, input);
for await (const event of handle.events) {
  if (event.kind === 'emit') console.log(event);
}
const final = await handle.result;
```

## Adapters

Two adapter slots live on the run options: `trajectory` (observation) and `checkpoint_store` (persistence for `checkpoint` and `suspend`).

```ts
import { filesystem_logger } from '@repo/observability';
import { filesystem_store }  from '@repo/stores';

await run(flow, input, {
  trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }),
  checkpoint_store: filesystem_store({ root_dir: '.checkpoints' }),
});
```

Adapters are plain objects that conform to `TrajectoryLogger` and `CheckpointStore` from `@repo/core`. Writing your own is the expected path once you outgrow the defaults.

## Calling a model

The engine layer handles provider routing. Bridge it into a flow with `model_call`:

```ts
import { create_engine, model_call, sequence, run } from 'fascicle';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY! } },
});

const flow = sequence([
  model_call({ engine, model: 'sonnet', system: 'Be terse.' }),
]);

const result = await run(flow, 'Summarise Rust ownership in one sentence.');
console.log(result.content);

await engine.dispose();
```

`model_call` is the only sanctioned bridge between the composition and engine layers. It auto-threads `ctx.abort`, `ctx.trajectory`, and streaming chunks.

## Where to go next

- [docs/writing-a-harness.md](./writing-a-harness.md) — build a runner around fascicle.
- [docs/concepts.md](./concepts.md) — step-as-value, trajectories, cancellation.
- [docs/configuration.md](./configuration.md) — engine config, aliases, provider setup.
- [docs/providers.md](./providers.md) — per-provider adapter notes.
- [docs/cli.md](./cli.md) — the `claude_cli` subprocess adapter.
- [docs/cookbook.md](./cookbook.md) — retries, fan-out, judges, human-in-the-loop.
- [examples/](../examples/) — runnable reference flows.

# Getting started

A 10-minute tour: install, compose your first flow, run it, observe what happened.

## Install

From npm (as a consumer):

```bash
pnpm add fascicle
```

`ai`, `zod`, and every provider SDK are optional peers — install only the ones you use. Schemas accept any [Standard Schema](https://standardschema.dev) (zod, ArkType, Valibot, …), so nothing beyond `fascicle` itself is required to build and run a flow. (One flag on that promise: the [Calling a model](#calling-a-model) section below drives a hosted provider through its AI SDK adapter, which adds two peer packages and an API key.)

From this repo (as a contributor):

```bash
pnpm install
pnpm check
```

`pnpm check` is the single source of truth for "is the repo healthy". Exit 0 means the workspace is in shape.

> **One package, deep modules for enforcement.** Consumers install **one** thing: `fascicle`. Inside this repo the code is organized as deep modules under `src/` (`src/core`, `src/engine`, `src/adapters`, plus the umbrella at the `src/` root), each reachable only through its barrel via a `#<module>` alias. The ast-grep rules in `rules/` and a directory-level boundary DAG in `fallow.toml` police architectural boundaries directly (for example, core cannot import adapters; `process.env` is confined to audited exceptions).

## Your first flow

A flow is a value. Build one with `step(...)` and compose with `sequence`, `parallel`, `branch`, `chain`, and friends.

```ts
import { run, sequence, step } from 'fascicle';

const increment = step('increment', (n: number) => n + 1);
const double    = step('double',    (n: number) => n * 2);

const flow = sequence([increment, double]);

const result = await run(flow, 1);
console.log(result); // 4
```

That's all of it. Every composable unit is a `Step<i, o>`. Every composer returns a `Step<i, o>`. You can nest arbitrarily.

### Run it

Save the snippet as `index.ts` in a fresh directory. fascicle is ESM-only and requires Node >= 24, so the `package.json` needs `"type": "module"`:

```json
{
  "name": "my-flow",
  "type": "module",
  "private": true
}
```

```bash
pnpm add fascicle
pnpm exec tsx index.ts
# or, with no extra tooling:
node --experimental-strip-types index.ts
```

`pnpm exec tsx` is what every example in this repo uses; plain `node` works too because Node >= 24 strips TypeScript types natively.

## The 22 primitives

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
| `ensemble_step`       | Pick-best where the scorer is itself a `Step` (a model judge). |
| `consensus`           | Run N, accept once your `agree(results)` predicate holds.   |
| `checkpoint`          | Memoize a step's output in a `CheckpointStore`.             |
| `suspend`             | Pause the flow; drive with `run.until_suspended` and resume. |
| `chain`               | Named steps over a growing typed record; one per flow, the spine. |
| `ensemble`            | Pick-best scored by a plain function (advanced).            |
| `tournament`          | Pairwise compare members, pick the bracket winner (advanced). |
| `scope`/`stash`/`use` | Raw named state by string key (advanced; `chain` supersedes). |
| `improve`             | Bounded online propose → score → accept/reject loop (advanced). |
| `learn`               | Offline reflection over recorded trajectories (advanced).   |

The primitives are not all peers: [leaf-arm-spine.md](./leaf-arm-spine.md) is the decision guide for which to reach for at each layer of a flow, and the rows marked advanced are covered in [advanced-composition.md](./advanced-composition.md), each paired with the primary primitive to try first.

Full surface and signatures: [`docs/composition.md`](./composition.md). Runnable references: [`examples/`](../examples/), starting with [`examples/newsroom.ts`](../examples/newsroom.ts), the vocabulary tour.

## Running

`run(flow, input, options?)` executes the flow and returns its output. `run.stream(flow, input, options?)` returns `{ events, result }` so you can observe the run as it unfolds. `run.until_suspended(flow, input, options?)` drives flows that contain a `suspend` gate: a pause surfaces as a typed `{ kind: 'suspended', id, resume }` outcome instead of a thrown error.

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
import { filesystem_logger, filesystem_store } from 'fascicle/adapters';

await run(flow, input, {
  trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }),
  checkpoint_store: filesystem_store({ root_dir: '.checkpoints' }),
});
```

Adapters are plain objects that conform to `TrajectoryLogger` and `CheckpointStore` (both exported from `fascicle`). Writing your own is the expected path once you outgrow the defaults — the bundled `filesystem_logger` writes synchronously, so for long-running servers you'll want a custom logger that buffers and flushes asynchronously. (Span parentage is threaded by the runner, so span trees stay correct even under `parallel`/`map` concurrency.) See [docs/concepts.md](./concepts.md#adapter-limits).

## Calling a model

The engine layer handles provider routing. Bridge it into a flow with `model_step`. This example uses the `anthropic` provider on its default `ai_sdk` transport, which needs two peer packages and an `ANTHROPIC_API_KEY`:

```bash
pnpm add ai @ai-sdk/anthropic
```

```ts
import { create_engine, model_step, run } from 'fascicle';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY! } },
});

const summarize = model_step({ engine, model: 'claude-sonnet-4-6', system: 'Be terse.' });

const result = await run(summarize, 'Summarise Rust ownership in one sentence.');
console.log(result);

await engine.dispose();
```

`model_step` is the default model boundary: it returns the answer itself (a `string`, or the schema-validated value when `schema` is set) and auto-threads `ctx.abort`, `ctx.trajectory`, and streaming chunks. When the caller wants what surrounds the answer (usage, cost, tool calls, finish reason), `model_call` takes the same config and returns the full `GenerateResult` envelope. Note there is no wrapper around `summarize` above: one call is a leaf, and a leaf runs as-is.

Model ids are opaque and sent to the provider verbatim, so use the provider's real id (`claude-sonnet-4-6`, `gpt-4o`, an Ollama tag). Family shorthands like `'sonnet'` work only on the `claude_cli` transport, where the CLI itself resolves them. See [docs/providers.md](./providers.md).

## Try it without a key

No provider account needed to explore. [examples/hello.ts](../examples/hello.ts), [examples/suspend_resume.ts](../examples/suspend_resume.ts), and [examples/viewer_demo.ts](../examples/viewer_demo.ts) use no engine at all, and [examples/newsroom.ts](../examples/newsroom.ts) runs the whole primitive vocabulary against the stub engine from `fascicle/testing` (canned responses routed by system-prompt prefix, zero network). From a clone of this repo:

```bash
pnpm exec tsx examples/newsroom.ts
```

The [examples index](../examples/README.md) flags which examples are keyless and which need a provider.

## Where to go next

- [docs/leaf-arm-spine.md](./leaf-arm-spine.md) — the three-layer shape of a flow and which primitive belongs at each layer.
- [docs/writing-a-harness.md](./writing-a-harness.md) — build a runner around fascicle.
- [docs/blueprint.md](./blueprint.md) — the standard app architecture for a real fascicle app.
- [docs/embedding-under-a-harness.md](./embedding-under-a-harness.md) — run a fascicle agent as somebody's child process.
- [docs/concepts.md](./concepts.md) — step-as-value, trajectories, cancellation.
- [docs/configuration.md](./configuration.md) — engine config, defaults, provider setup.
- [docs/providers.md](./providers.md) — per-provider adapter notes.
- [docs/cli.md](./cli.md) — the `claude_cli` subprocess adapter.
- [docs/cookbook.md](./cookbook.md) — retries, fan-out, judges, human-in-the-loop.
- [docs/troubleshooting.md](./troubleshooting.md) — when the first run fails.
- [examples/](../examples/) — runnable reference flows.

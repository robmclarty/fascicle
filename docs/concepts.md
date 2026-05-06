# Concepts

The mental model behind fascicle. Read this once — the rest of the docs assume it.

## Two layers

fascicle ships two independently useful layers, re-exported from one package.

- **Composition layer** (`@repo/core` + `@repo/composites`, surfaced via `fascicle`). 18 primitives for composing work out of plain values. No network, no LLM calls, no ambient state.
- **Engine layer** (`@repo/engine`, surfaced via `fascicle`). `create_engine(config)` returns a unified `generate` surface over seven provider adapters. No composition, no step plumbing.

They are glued by exactly one value: `model_call` (in the umbrella package). That is the only file allowed to import values from both layers — an ast-grep rule in `rules/` enforces it. Everything else either composes or generates, never both.

## Step-as-value

Every composable unit is a `Step<i, o>`:

```ts
type Step<i, o> = {
  readonly id: string;
  readonly kind: string;
  run(input: i, ctx: RunContext): Promise<o> | o;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly children?: ReadonlyArray<Step<unknown, unknown>>;
  readonly anonymous?: boolean;
};
```

Every composer — `sequence`, `parallel`, `retry`, `adversarial`, and so on — takes one or more `Step<i, o>` values and returns a single `Step<i, o>`. The return type is identical to the input type.

That one invariant buys:

- **Substitutability.** Any step can be replaced with any composition of steps having the same I/O types. `retry(adversarial(ensemble(...)))` works because each composer treats its child as an opaque `Step`.
- **Introspectability.** A flow is a tree of plain objects. Walk it with `describe(step)` or with your own code to render, validate, or transform it.
- **No hidden state.** Steps are values, not instances. Two unrelated flows share nothing unless the caller injects it.

A flow with nothing in it is still a step. A flow with a thousand nested composers is still a step. The surface never widens.

## The primitives

```text
step        lift a plain function into Step<i, o>
sequence    run A then B then C, thread output into input
parallel    run a named map of steps concurrently
branch      pick then/otherwise by a predicate on input
map         run a step per item, optional concurrency cap
pipe        post-process an inner step's output with a plain function
retry       re-run on failure with exponential backoff
fallback    run a backup if the primary throws
timeout     cancel an inner step after N ms
loop        bounded iteration with carry-state and optional convergence guard
compose     label a composite step for trajectory output
adversarial build, critique, loop until accept or max_rounds
ensemble    run N members, pick highest by score
tournament  single-elimination bracket
consensus   run N, accept only if >= quorum agree
checkpoint  memoize a named inner step by key
suspend     pause for external input; resume with resume_data
scope       stash named values and use them later without rewiring
```

Each primitive is described in full with signatures at [`packages/core/README.md`](../packages/core/README.md).

## Running a flow

`run(flow, input, options?)` executes a flow to completion. It constructs a fresh `RunContext`, runs the flow, runs cleanup handlers in LIFO, and returns the output.

```ts
import { run } from 'fascicle';

const output = await run(flow, input);
```

`run.stream(flow, input, options?)` is the streaming variant. It returns `{ events, result }`; consumers iterate the event stream while awaiting the final result. The underlying step graph is identical to `run(...)` — streaming is purely observational.

```ts
const handle = run.stream(flow, input);
for await (const event of handle.events) {
  if (event.kind === 'emit') console.log(event);
}
const output = await handle.result;
```

Both entry points accept the same `RunOptions`:

```ts
type RunOptions = {
  install_signal_handlers?: boolean;   // default true
  trajectory?: TrajectoryLogger;       // default noop
  checkpoint_store?: CheckpointStore;  // required by checkpoint / suspend
  resume_data?: Record<string, unknown>;
};
```

## The run context

Every `step(fn)` body receives `(input, ctx)`. `ctx` is a `RunContext`:

```ts
type RunContext = {
  run_id: string;              // unique per top-level run
  trajectory: TrajectoryLogger;
  state: ReadonlyMap<string, unknown>;  // for scope / stash / use
  abort: AbortSignal;
  emit: (event: Record<string, unknown>) => void;
  on_cleanup: (fn: CleanupFn) => void;
  checkpoint_store?: CheckpointStore;
  resume_data?: Readonly<Record<string, unknown>>;
  streaming: boolean;
};
```

The important seams:

- `ctx.abort` — the current run's abort signal. Pass it to `fetch`, `child_process`, or any abortable API. Check `ctx.abort.aborted` at loop boundaries.
- `ctx.emit(event)` — record a streaming event. Steps call this freely; only `run.stream` delivers events to a consumer, plain `run` drops them.
- `ctx.on_cleanup(fn)` — register teardown. Runs in LIFO order on success, failure, or abort.
- `ctx.trajectory` — the structured-event sink. Either the injected logger or a noop.
- `ctx.streaming` — `true` inside `run.stream`. `model_call` reads this to decide whether to forward provider chunks.

Nothing else is shared between steps. Two siblings in a `parallel({ ... })` cannot observe each other except through their outputs or via `scope` / `stash` / `use`.

## Trajectories

A trajectory is a structured record of what happened during a run. Every composer and every step optionally emits events; the default logger is a noop, so nothing happens until you inject one.

```ts
type TrajectoryEvent = {
  readonly kind: string;
  readonly span_id?: string;
  readonly [key: string]: unknown;
};

type TrajectoryLogger = {
  record: (event: TrajectoryEvent) => void;
  start_span: (name: string, meta?: Record<string, unknown>) => string;
  end_span: (id: string, meta?: Record<string, unknown>) => void;
};
```

The `fascicle/adapters` subpath ships four trajectory loggers:

- `noop_logger` — drops everything. The default when no `trajectory` is passed.
- `filesystem_logger({ output_path })` — appends JSON lines to a file.
- `http_logger({ url })` — POSTs each event as NDJSON; pairs with the viewer's `/api/ingest`.
- `tee_logger(a, b, ...)` — fans one logger contract out to many sinks.

Writing your own is the expected path once you outgrow the defaults (push to Honeycomb, DynamoDB, a TUI, whatever).

### Adapter limits

The bundled loggers have two known limits worth understanding before you wire them into anything long-running:

- **`filesystem_logger` writes synchronously.** It calls `appendFileSync` on every `record`, `start_span`, and `end_span`. That keeps the implementation a dozen lines and makes failures easy to reason about, but it blocks the event loop on each write. Fine for dev tools, CLIs, and short batch runs; not what you want on a hot request path. Swap in a custom logger that buffers and flushes asynchronously if that matters.
- **Span stacks are not async-context-aware.** `filesystem_logger` and `http_logger` track open spans on an in-memory stack, so the recorded `parent_span_id` is "whichever span opened most recently." Two siblings spawned concurrently from the same parent will both see whichever opened last as their parent until proper async-context propagation lands. The wire format is internally consistent within a single sink; what's lossy is the cross-sibling ordering under concurrency.

`http_logger` additionally swallows transport errors by default — pass `on_error` to surface them. Trajectory writes are never load-bearing; a logger that throws does not fail the run.

### What gets recorded

- Every composer records entry and exit spans around its children.
- `model_call` records generate spans, step spans, cost events, and — under `run.stream` — a `model_chunk` event per provider chunk.
- The `claude_cli` provider records `cli_tool_bridge_allowlist_only` events when it drops tools whose `execute` closures cannot cross the subprocess boundary.
- `ctx.emit(event)` records an event with `kind: 'emit'`.

Trajectory writes are never load-bearing — a logger that throws does not fail the run. Keep your own loggers equally forgiving.

## Cancellation

fascicle installs SIGINT/SIGTERM handlers the first time `run(...)` is called and removes them after the last run finishes. When a signal arrives, every active run's abort signal fires with an `aborted_error`.

Steps cooperate by:

- Checking `ctx.abort.aborted` at loop boundaries.
- Passing `ctx.abort` to `fetch`, child processes, and other abortable APIs.
- Registering teardown with `ctx.on_cleanup(fn)`.

For embedded runtimes — tests, Lambda, worker threads, anything that owns its own signal stack — opt out with `install_signal_handlers: false` and forward cancellation yourself.

`timeout(inner, ms)` builds on the same mechanism: it aborts the inner step's signal after the deadline and throws `timeout_error`.

## Scope, stash, and use

Most chains thread values implicitly via `sequence` and `parallel`. When that is not enough — two non-adjacent steps need to agree on a value, or a child step needs a configuration value its parent produced — use `scope`:

```ts
import { scope, stash, use, step } from 'fascicle';

const flow = scope([
  stash('user_id', step('lookup', async (email: string) => find_user(email))),
  use(['user_id'], async ({ user_id }) => publish_event(user_id)),
]);
```

`stash(key, source)` runs `source` and binds its output under `key` in `ctx.state`. `use(keys, fn)` reads those keys and runs `fn` with them. Keys are scoped — two sibling `scope([])` blocks cannot see each other's state.

## Checkpointing

`checkpoint(inner, { key })` memoizes an inner step by key, using a `CheckpointStore` injected via `RunOptions`.

```ts
import { checkpoint, step } from 'fascicle';
import { filesystem_store } from 'fascicle/adapters';

const flow = checkpoint(
  step('expensive', async (spec: { hash: string }) => compute(spec)),
  { key: (spec) => `build:${spec.hash}` },
);

await run(flow, spec, { checkpoint_store: filesystem_store({ root_dir: '.checkpoints' }) });
```

Key rules:

- Keys share a single namespace across every flow that uses the same store. Prefix with a flow name or content hash to avoid collisions.
- Anonymous steps (`step(fn)` with no id) throw at construction when wrapped by `checkpoint`. Give the inner step an id.
- Compositions build trees, not graphs. A composer that references itself causes infinite recursion.

## Suspend and resume

`suspend(...)` pauses a flow until external input arrives. The first run throws `suspended_error`; the caller stores the suspended state, collects input out-of-band, then calls `run(...)` again with `resume_data` to continue.

```ts
import { run, suspend, suspended_error } from 'fascicle';
import { z } from 'zod';

const flow = suspend({
  id: 'approve',
  on: () => notify_operator(),
  resume_schema: z.object({ approved: z.boolean() }),
  combine: (input: { brief: string }, resume) =>
    resume.approved ? `ship:${input.brief}` : `hold:${input.brief}`,
});

try {
  await run(flow, { brief: 'beta' }, { checkpoint_store });
} catch (err) {
  if (!(err instanceof suspended_error)) throw err;
}

// later:
const out = await run(flow, { brief: 'beta' }, {
  checkpoint_store,
  resume_data: { approve: { approved: true } },
});
```

`resume_data` is keyed by `suspend.id` so multiple suspends in the same flow can resume independently. Mismatched shapes throw `resume_validation_error`.

## Errors

Typed errors live in `fascicle`:

| Class                            | Thrown by                                             |
| -------------------------------- | ----------------------------------------------------- |
| `aborted_error`                  | SIGINT / SIGTERM / parent abort                       |
| `timeout_error`                  | `timeout(inner, ms)` tripping                         |
| `suspended_error`                | first pass through `suspend(...)`                     |
| `resume_validation_error`        | `resume_data` does not match `resume_schema`          |
| `describe_cycle_error`           | `describe` hitting a cyclic composition               |
| `provider_error`                 | HTTP failures from AI SDK providers                   |
| `rate_limit_error`               | 429 responses after retry exhaustion                  |
| `tool_error`                     | a tool's `execute` throws                             |
| `schema_validation_error`        | `schema` parsing failed after repair attempts         |
| `engine_config_error`            | invalid `create_engine(config)`                       |
| `engine_disposed_error`          | calling `generate` after `engine.dispose()`           |
| `model_not_found_error`          | alias or `provider:model` not registered              |
| `provider_not_configured_error`  | named provider missing from `providers`               |
| `provider_capability_error`      | a provider refusing an option it cannot honour        |
| `provider_auth_error`            | auth failure detected mid-run                         |
| `tool_approval_denied_error`     | `on_tool_approval` returned false                     |
| `on_chunk_error`                 | a caller's `on_chunk` handler threw                   |
| `claude_cli_error`               | subprocess failure in the `claude_cli` provider       |

Every error bubbles out of `run(...)` as a normal promise rejection. Composition-layer errors carry a `.path` array containing the step ids that led to the failure — surface it in logs to make failures locatable.

## The check contract

Not a runtime concept, but a project one. `pnpm check:all` is the single source of truth for "is this done". The pipeline runs types, lint, structural rules, dead-code analysis, tests, coverage, spelling, markdown, and mutation. Exit 0 means done. Exit non-zero means read `.check/summary.json` for which step failed and the per-tool JSON for diagnostics.

`pnpm check` is the same pipeline minus the opt-in `mutation` step — use it during iteration. See [AGENTS.md](../AGENTS.md) for the full contract.

## Further reading

- [getting-started.md](./getting-started.md) — install and run your first flow.
- [writing-a-harness.md](./writing-a-harness.md) — build a runner around fascicle.
- [configuration.md](./configuration.md) — engine config, aliases, defaults.
- [providers.md](./providers.md) — per-provider adapter notes.
- [cli.md](./cli.md) — the `claude_cli` subprocess provider.
- [cookbook.md](./cookbook.md) — worked patterns (retries, fan-out, judges, HITL).
- [`packages/core/README.md`](../packages/core/README.md) — full composition surface.

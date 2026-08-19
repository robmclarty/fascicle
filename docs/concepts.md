# Concepts

The mental model behind Fascicle. Read it once, because the rest of the docs assume you have.

## Two Layers

Fascicle ships two independently useful layers, re-exported from one package.

- **Composition layer** (the `core` + `composites` modules, surfaced via `fascicle`). 22 primitives for composing work out of plain values. No network, no LLM calls, no ambient state.
- **Engine layer** (the `engine` module, surfaced via `fascicle`). `create_engine(config)` returns a unified `generate` surface over eight provider adapters. No composition, no step plumbing.

They are glued by exactly one value, `model_call`, at the umbrella `src/` root. That's the only file that's allowed to import values from both layers — an ast-grep rule in `rules/` enforces it. Everything else either composes or generates, never both.

## Step-as-Value

Every composable unit you write is a `Step<i, o>`:

```ts
type Step<i, o> = {
  readonly id: string;
  readonly kind: string;
  readonly run: (input: i, ctx: RunContext) => Promise<o> | o;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly children?: ReadonlyArray<AnyStep>;
  readonly anonymous?: boolean;
  readonly meta?: StepMetadata;
};
```

`run` is a function property rather than a method, which makes a step's input
contravariant, so wiring a step to an input its `run` can't accept is a compile
error, and `sequence` builds its per-joint checking on exactly that. The
supertype of every step is `AnyStep` (`Step<never, unknown>`, exported next to
`Step`); it's what type-erased collections like `children` hold, and it can't
be run directly, because pairing an erased step with an input it accepts is the
runner's job.

Every composer (`sequence`, `parallel`, `retry`, `adversarial`, and so on) takes one or more `Step<i, o>` values and returns a single `Step<i, o>`. The return type is identical to the input type.

That one invariant buys you three things:

- **Substitutability.** You can replace any step with any composition of steps that has the same I/O types. `retry(adversarial(ensemble(...)))` works because each composer treats its child as an opaque `Step`.
- **Introspectability.** A flow is a tree of plain objects. Walk it with `describe(step)`, or with your own code, to render, validate, or transform it.
- **No hidden state.** Steps are values, not instances. Two unrelated flows share nothing unless you inject it.

A flow with nothing in it is still a step. A flow with a thousand nested composers is still a step. The surface stays the same size either way.

## The Primitives

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
ensemble_step  pick-best where the scorer is itself a Step
tournament  single-elimination bracket
consensus   run all members each round; accept once agree(results) holds
checkpoint  memoize a named inner step by key
suspend     pause for external input; resume with resume_data
chain       named steps over a growing typed record; one per flow, the spine
scope       stash named values and use them later without rewiring
improve     bounded online propose → score → accept/reject loop
learn       offline reflection over recorded trajectories
```

Two more belong in the everyday vocabulary although they aren't composition primitives. They are `model_step`, the default model leaf (the model's answer as a `Step`, built on `model_call`), and `ctx.call(step, input)`, the direct-style way to run another step from inside a step body with spans, abort, and error paths intact.

Each primitive is described in full with signatures at [`docs/composition.md`](./composition.md). They aren't all peers. [leaf-arm-spine.md](./leaf-arm-spine.md) names the primary vocabulary and the decision rules for picking at each layer, and [advanced-composition.md](./advanced-composition.md) covers the tier you should reach for last (`scope`/`stash`/`use`, plain `ensemble`, `tournament`, `improve`/`learn`).

## Running a Flow

`run(flow, input, options?)` executes your flow to completion. It constructs a fresh `RunContext`, runs the flow, runs your cleanup handlers in LIFO order, and hands back the output.

```ts
import { run } from 'fascicle';

const output = await run(flow, input);
```

`run.stream(flow, input, options?)` is the streaming variant. It returns `{ events, result }`, so you iterate the event stream while awaiting the final result. The underlying step graph is identical to `run(...)` — streaming is purely observational.

`run.until_suspended(flow, input, options?)` is the third entry point, for flows that contain a `suspend` gate, and it surfaces the suspension as a typed outcome instead of a thrown error (see [Suspend and resume](#suspend-and-resume)).

```ts
const handle = run.stream(flow, input);
for await (const event of handle.events) {
  if (event.kind === 'emit') console.log(event);
}
const output = await handle.result;
```

All three entry points accept the same `RunOptions`:

```ts
type RunOptions = {
  install_signal_handlers?: boolean;   // default true
  trajectory?: TrajectoryLogger;       // default noop
  checkpoint_store?: CheckpointStore;  // required by checkpoint / suspend
  resume_data?: Record<string, unknown>;
  abort?: AbortSignal;                 // caller-owned cancellation
};
```

## The Run Context

Every `step(fn)` body you write receives `(input, ctx)`, where `ctx` is a `RunContext`:

```ts
type RunContext = {
  run_id: string;              // unique per top-level run
  trajectory: TrajectoryLogger;
  state: ReadonlyMap<string, unknown>;  // for scope / stash / use
  parent_span_id?: string;     // span parentage, threaded by the runner
  abort: AbortSignal;
  emit: (event: Record<string, unknown>) => void;
  on_cleanup: (fn: CleanupFn) => void;
  call: <ci, co>(this: RunContext, s: Step<ci, co>, input: ci) => Promise<co>;
  checkpoint_store?: CheckpointStore;
  resume_data?: Readonly<Record<string, unknown>>;
  streaming: boolean;
};
```

These are the seams you'll actually use:

- `ctx.abort` — the current run's abort signal. Pass it to `fetch`, `child_process`, or any abortable API. Check `ctx.abort.aborted` at loop boundaries.
- `ctx.emit(event)` — record a streaming event. Your steps call this freely, and only `run.stream` delivers events to you, since plain `run` drops them.
- `ctx.on_cleanup(fn)` — register teardown. Runs in LIFO order on success, failure, or abort.
- `ctx.call(step, input)` — run another `Step` from inside a step body, with spans, abort, and error paths intact. The direct-style counterpart to composing, for control flow too dynamic to declare. (The `this` parameter pins it to the context it came from, so a destructured bare `call` is a compile error rather than a silently detached dispatch.)
- `ctx.trajectory` — the structured-event sink. Either the logger you injected or a noop.
- `ctx.streaming` — `true` inside `run.stream`. `model_call` reads this to decide whether to forward provider chunks.

Nothing else is shared between steps. Two siblings in a `parallel({ ... })` can't observe each other except through their outputs or via `scope` / `stash` / `use`.

## Trajectories

A trajectory is a structured record of what happened during your run. Every composer and every step can emit events, and the default logger is a noop, so nothing happens until you inject one.

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

The `fascicle/adapters` subpath ships five trajectory loggers:

- `noop_logger` — drops everything. The default when no `trajectory` is passed.
- `filesystem_logger({ output_path })` — appends JSON lines to a file.
- `http_logger({ url })` — POSTs each event as NDJSON, and pairs with the viewer's `/api/ingest`.
- `stderr_logger()` — JSONL to stderr, which keeps stdout clean when your process is somebody's child.
- `tee_logger(a, b, ...)` — fans one logger contract out to many sinks.

Once you outgrow the defaults, writing your own is the expected path, whether you push to Honeycomb, DynamoDB, a TUI, or whatever else you run.

### Adapter Limits

The bundled loggers have two limits you should know about before you wire them into anything long-running:

- **`filesystem_logger` writes synchronously.** It calls `appendFileSync` on every `record`, `start_span`, and `end_span`. That keeps the implementation a dozen lines and makes failures easy to reason about, but it blocks the event loop on each write. That's fine for dev tools, CLIs, and short batch runs, and not what you want on a hot request path. If that matters to you, swap in a custom logger that buffers and flushes asynchronously.
- **The in-memory span stack is a fallback only.** `filesystem_logger`, `stderr_logger`, and `http_logger` record the `parent_span_id` the runner threads through `RunContext`, so span trees are correct even for concurrent siblings under `parallel`/`map`. The in-memory open-span stack exists only for spans that are emitted without a parent (an external caller driving a logger directly, outside a run), and that fallback remains best-effort under concurrency.

`http_logger` also swallows transport errors by default, so pass `on_error` if you want to see them. Trajectory writes are never load-bearing, and a logger that throws doesn't fail your run.

### What Gets Recorded

- Every composer records entry and exit spans around its children.
- `model_call` records generate spans, step spans, cost events, and (under `run.stream`) a `model_chunk` event per provider chunk.
- The `claude_cli` provider records `cli_tool_bridge_allowlist_only` events when it drops tools whose `execute` closures can't cross the subprocess boundary.
- `ctx.emit(event)` records an event with `kind: 'emit'`.

Trajectory writes are never load-bearing, and a logger that throws doesn't fail the run. Keep your own loggers equally forgiving.

## Cancellation

Fascicle installs SIGINT/SIGTERM handlers the first time you call `run(...)` and removes them after your last run finishes. When a signal arrives, every active run's abort signal fires with an `aborted_error`.

Your steps cooperate by:

- Checking `ctx.abort.aborted` at loop boundaries.
- Passing `ctx.abort` to `fetch`, child processes, and other abortable APIs.
- Registering teardown with `ctx.on_cleanup(fn)`.

For embedded runtimes (tests, Lambda, worker threads, anything that owns its own signal stack), opt out with `install_signal_handlers: false` and forward cancellation yourself.

**Abort reasons take one of two shapes, by layer.** Composition (`retry`, `timeout`, `parallel`, `map`, `bench`) propagates an `Error` abort reason verbatim and wraps anything else in `aborted_error`, so the cause you aborted with is the error you catch. A SIGINT surfaces as the runner's own `aborted_error('received SIGINT')`, and a `timeout` firing inside a retry still surfaces as `timeout_error`. The engine (`generate` and everything under it) always wraps, so a cancelled model call throws `aborted_error` with your reason on `.reason` and the engine's `step_index` attached. The split is deliberate: `abort()` with no reason sets `signal.reason` to a `DOMException`, and the engine's contract is that only Fascicle errors cross its boundary.

`timeout(inner, ms)` builds on the same mechanism. It aborts the inner step's signal after the deadline and throws `timeout_error`.

### Cancellation Is Cooperative

`timeout` and abort only *signal* intent — they can't kill work that ignores `ctx.abort`. `timeout(inner, ms)` races the inner step against a deadline: when the deadline wins, `timeout_error` throws and `run(...)` returns control to the caller, but the inner step's promise isn't cancelled. If that step never checks `ctx.abort` (a tight CPU-bound loop, a `fetch` call that wasn't given the signal, a tool's `execute` that awaits an unrelated promise), it keeps running in the background after Fascicle has already moved on. The same is true of a SIGINT/SIGTERM abort, and of a `ctx.on_cleanup` handler that outlives its own timeout — it's abandoned, not killed, and the remaining handlers run without waiting for it.

Abandoned work isn't free. A `model_call` step that outlives its `timeout` keeps the underlying HTTP request open and the provider keeps generating (and billing) tokens for a response nothing will read; a subprocess or socket that was never wired to `ctx.abort` keeps holding its resource. Fascicle has no scheduler that can preempt a promise it doesn't control — that would require the language-level cancellation that Node/JS doesn't offer.

The fix is yours as the step author. Thread `ctx.abort` into every long-running operation that a step performs, not just the outermost one. Pass it to `fetch`'s `signal` option, to `child_process` spawn options, and check `ctx.abort.aborted` between iterations of any loop that doesn't otherwise await an abortable call. A step that never touches `ctx.abort` isn't wrong, but it isn't cancellable — treat that as a property to design for, not an edge case to patch later. See [troubleshooting.md](./troubleshooting.md#a-cancelled-run-keeps-consuming-tokens-or-holding-resources) for how to spot this in practice.

## Named State: Chain First

`sequence` and `parallel` thread values implicitly. The moment a step needs a value that isn't its immediate predecessor's output (the brief three steps back, two arms' results combined), reach for `chain`: each `.step(name, fn)` merges its result into a growing typed record, later bindings destructure whatever earlier names they need (checked at compile time), `.stage` marks phase barriers, and `.output` projects the final result into an ordinary `Step`.

```ts
import { chain } from 'fascicle';

const flow = chain<string, 'email'>('email')
  .step('user_id', ({ email }) => find_user(email))
  .step('published', ({ user_id }) => publish_event(user_id))
  .output(({ published }) => published);
```

Underneath sits the raw state tier, where `scope` / `stash` / `use` bind values by string key in `ctx.state`, untyped. `chain` is the typed front door over the same idea; the raw trio remains for the shapes that bindings can't express (writes from deep inside a subtree, state shared across sibling compositions). See [advanced-composition.md](./advanced-composition.md#scope-stash-use-named-state-without-types) before reaching for it.

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

## Suspend and Resume

`suspend(...)` pauses a flow until external input arrives. Drive a suspend-bearing flow with `run.until_suspended`, which returns a discriminated union: `{ kind: 'done', output }` on completion, or `{ kind: 'suspended', id, resume }` when a gate fires. Calling `resume(data)` re-runs the flow from the original input with the decision merged into `resume_data` and resolves to the next outcome, so multi-gate flows are driven by resuming repeatedly.

```ts
import { run, suspend } from 'fascicle';
import { z } from 'zod';

const flow = suspend({
  id: 'approve',
  on: () => notify_operator(),
  resume_schema: z.object({ approved: z.boolean() }),
  combine: (input: { brief: string }, resume) =>
    resume.approved ? `ship:${input.brief}` : `hold:${input.brief}`,
});

const outcome = await run.until_suspended(flow, { brief: 'beta' }, { checkpoint_store });
if (outcome.kind === 'suspended') {
  // collect the decision out-of-band, then:
  const resumed = await outcome.resume({ approved: true });
  // resumed.kind === 'done', resumed.output === 'ship:beta'
}
```

Underneath, the mechanism is unchanged. A gate signals by throwing `suspended_error`, and a plain `run(...)` surfaces that throw directly; the caller can also re-run with `resume_data` by hand (`resume_data` is keyed by `suspend.id` so multiple suspends in the same flow resume independently). Mismatched resume shapes throw `resume_validation_error`. The resume closure can't outlive the process — for durable approval flows, persist the original input and rebuild the outcome after a restart ([human-in-the-loop.md](./human-in-the-loop.md)).

## Errors

Typed errors live in `fascicle`:

| Class                            | Thrown by                                             |
| -------------------------------- | ----------------------------------------------------- |
| `aborted_error`                  | SIGINT / SIGTERM / parent abort                       |
| `timeout_error`                  | `timeout(inner, ms)` tripping                         |
| `suspended_error`                | first pass through `suspend(...)`                     |
| `resume_validation_error`        | `resume_data` doesn't match `resume_schema`          |
| `describe_cycle_error`           | `describe` hitting a cyclic composition               |
| `provider_error`                 | HTTP failures from AI SDK providers                   |
| `rate_limit_error`               | 429 responses after retry exhaustion                  |
| `tool_error`                     | a tool's `execute` throws                             |
| `schema_validation_error`        | `schema` parsing failed after repair attempts         |
| `incomplete_generation_error`    | `schema` set and the call finished on a non-`stop` reason |
| `engine_config_error`            | invalid `create_engine(config)`                       |
| `engine_disposed_error`          | calling `generate` after `engine.dispose()`           |
| `model_required_error`           | no `model` given and no `defaults.model` set          |
| `provider_required_error`        | several providers configured, none named per-call or in `defaults.provider` |
| `provider_not_configured_error`  | named provider missing from `providers`               |
| `provider_capability_error`      | a provider refusing an option it can't honour        |
| `provider_auth_error`            | auth failure detected mid-run                         |
| `tool_approval_denied_error`     | `on_tool_approval` returned false                     |
| `on_chunk_error`                 | a caller's `on_chunk` handler threw                   |
| `claude_cli_error`               | subprocess failure in the `claude_cli` provider       |

Every error bubbles out of `run(...)` as a normal promise rejection. Composition-layer errors carry a `.path` array of the step ids that led to the failure — surface it in logs to make failures locatable.

## The Check Contract

Not a runtime concept, but a project one. `pnpm check:all` is the single source of truth for "is this done". The pipeline runs types, lint, structural rules, dead-code analysis, tests, coverage, spelling, markdown, and mutation. Exit 0 means done. Exit non-zero means read `.check/summary.json` for which step failed and the per-tool JSON for diagnostics.

`pnpm check` runs the default set, every slot except the opt-in ones. `pnpm check:all` adds the opt-in slots (Stryker `mutation`, plus the `build` and packaging gate slots: `publint`, `attw`, `pack`, `smoke`, `snippets`) and is the gate before declaring done. Use `pnpm check` during iteration. See [AGENTS.md](../AGENTS.md) for the full contract.

## Further Reading

- [getting-started.md](./getting-started.md) — install and run your first flow.
- [writing-a-harness.md](./writing-a-harness.md) — build a runner around Fascicle.
- [blueprint.md](./blueprint.md) — the standard app architecture for building on Fascicle.
- [embedding-under-a-harness.md](./embedding-under-a-harness.md) — run a Fascicle agent as somebody's child process.
- [configuration.md](./configuration.md) — engine config, provider setup, defaults.
- [providers.md](./providers.md) — per-provider adapter notes.
- [cli.md](./cli.md) — the `claude_cli` subprocess provider.
- [cookbook.md](./cookbook.md) — worked patterns (retries, fan-out, judges, HITL).
- [`docs/composition.md`](./composition.md) — full composition surface.

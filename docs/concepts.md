# Concepts

The mental model behind Fascicle. Read it once, because the rest of the docs assume you have. [What a Harness Does](./what-a-harness-does.md) covers what happens underneath your model calls, on the wire, and the [Glossary](#glossary) at the end gives each word that the docs lean on its one meaning.

## Two Layers

Fascicle ships two independently useful layers, re-exported from one package.

- **Composition layer** (the `core` + `composites` modules, surfaced via `fascicle`). 23 primitives for composing work out of plain values. No network, no LLM calls, no ambient state.
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
  checkpoint_store?: CheckpointStore;  // checkpoint memoizes here (uncached without one)
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
- `ctx.emit(event)` — record a streaming event. Your steps call this freely. Every entry point writes it to the run's trajectory logger as an `emit` event, and only `run.stream` also hands it to you as it happens.
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
  readonly ts?: number;         // epoch ms, stamped by the runner
  readonly [key: string]: unknown;
};

type TrajectoryLogger = {
  record: (event: TrajectoryEvent) => void;
  start_span: (name: string, meta?: Record<string, unknown>) => string;
  end_span: (id: string, meta?: Record<string, unknown>) => void;
};
```

The `fascicle/adapters` subpath ships five trajectory loggers:

- `noop_logger` — drops everything, which is also what `run` does on its own when no `trajectory` is passed.
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

- The first event of an observed run is `flow_structure`, `{ kind: 'flow_structure', structure }`, where `structure` is `describe.json(flow)` verbatim in loose mode (cycles render as `<cycle>` nodes). Recorded once, before dispatch, only when a `trajectory` logger is configured or the run is observed via `run.stream`, so an unobserved run pays nothing for it.
- Every composer records entry and exit spans around its children.
- `model_call` records generate spans, step spans, cost events, and (under `run.stream`) a `model_chunk` event per provider chunk.
- The `claude_cli` provider records `cli_tool_bridge_allowlist_only` events when it drops tools whose `execute` closures can't cross the subprocess boundary.
- `ctx.emit(event)` records an event with `kind: 'emit'`.
- A `suspend(...)` gate that first fires records `{ kind: 'suspended', suspend_id, step_id }` on the wire before the span-end error the runner logs for the escaping `suspended_error`, so a consumer sees the pause as its own event. `step_id` is the join key back to the `flow_structure` node. A gate that sets `deadline_ms` carries it on the event too.
- A step marked `side_effect` (every `model_call` is) that starts before a resumed run has reached the gates it was resumed at records `{ kind: 'step_replayed', step_id, suspend_ids }`, which names the gates still ahead. It's the event that tells you a resume paid for work twice, and `describe.replays(flow)` finds the same steps from the flow's shape before anything runs.
- An item that throws inside a `map` that settles records `{ kind: 'map_item_failed', step_id, index, error }`, plus `error_kind` when the error had one, so a partial batch shows which items failed and why.
- Every model turn records `{ kind: 'request_sent', step_index, span_id, call_span_id }` as its request goes out. `span_id` is the turn's `engine.generate.step` span, and `call_span_id` is the `engine.generate` span of the call that the turn belongs to, which is how you tell apart the turns of calls that run side by side under `parallel`. When you turn on `capture` (see [configuration.md](./configuration.md#generate-options)), the event carries the `request` too, in one of the shapes in the table below.
- Every model turn records `{ kind: 'response_received', step_index, span_id, input_tokens, output_tokens, finish_reason }` once the provider answers, where `span_id` is the turn's `engine.generate.step` span and `input_tokens` counts cache reads and writes too. The usage splits ride beside them when the provider reported them (`reasoning_tokens`, `cached_input_tokens`, `cache_write_tokens`, and `cache_write_1h_tokens`, the part of the writes made for an hour), as does `cache_hit_ratio`, `cached_input_tokens / input_tokens` to three decimals, on a turn whose reads plus writes are above zero. Timing rides too, as `started_at`, `duration_ms`, and `first_chunk_ms` on a turn that streamed. Every field is a flat number or string, so a log pipeline aggregates them without parsing anything. Under `capture` the event carries `content` as well, the parts that the provider returned: the turn's own parts when its adapter kept them (reasoning, text, calls, and the opaque blocks that only its provider reads), and otherwise a text part, when the turn had text, followed by a part for each call. You see what the provider sent before the loop salvaged or capped any calls, and the next turn's request shows you what the loop kept.
- A turn that reads nothing from the prompt cache right after a turn of the same `generate` call that read or wrote some records `{ kind: 'cache_miss', step_index, span_id, previous_cached_tokens, input_tokens, after_prepare_step }`. `previous_cached_tokens` is the previous turn's reads plus writes, and `after_prepare_step` is `true` when `prepare_step` replaced this turn's messages. See [providers.md](./providers.md#prompt-caching) for what causes a miss.
- A model turn that reached its output limit before it made a tool call, which the loop went on past under `truncated_turn_policy: 'continue'`, records `{ kind: 'turn_truncated', step_index, span_id, output_tokens, max_tokens }`, where `max_tokens` is there only when the call set one. The loop sends back the turn's text, if it showed any, and a user message that says the turn was cut off, and the turn's `StepRecord` says `truncated: true`.
- A model turn that the provider paused partway through its response (Anthropic's `pause_turn`) records `{ kind: 'turn_paused', step_index, span_id }`, where `span_id` is the turn's `engine.generate.step` span. The loop sends the paused turn's assistant message back with nothing after it and asks for another turn. A `prepare_step` hook that reshapes the messages has to leave that message last, or the provider has nothing to continue.

A captured `request` takes one of three shapes:

| Turn | `request` | What it holds |
| --- | --- | --- |
| A call's first | `{ settings, tools, messages }` | The provider, the model, and the call's settings, each tool as `{ name, description, input_schema }`, and every message that the turn sent, system prompts included |
| One that extends the last | `{ appended }` | The messages that the turn added after everything the turn before it sent |
| Any other | `{ messages, reshaped: true }` | The whole array, whenever it doesn't extend the last turn that was recorded: after a `prepare_step` that changed what an earlier turn sent, or after a turn whose payload was dropped |

Each payload is a copy that JSON can hold, taken as the turn goes out, so what you read is what the turn sent, whatever the loop did to the conversation afterward. An image's bytes become their base64 text beside its `media_type`. `settings` holds `provider`, `model_id`, `effort`, and whichever of `cache`, `temperature`, `max_tokens`, `top_p`, `provider_options`, and `schema` your call had. Its `provider_options` are the ones that you and the engine defaults set, before an adapter adds the keys that it derives from `effort` or `cache`, and `schema` and each `input_schema` are JSON Schema, left out when a schema can't be written as one. A value that JSON can't hold, such as a BigInt, drops that turn's payload and leaves your call running.

Under `capture: 'wire'`, each attempt that a native transport sends records `{ kind: 'request_wire', step_index, span_id, provider, url, body }` too, where `body` is the exact object that went out as JSON, so a retried turn records one per attempt. Headers are never recorded, since they carry your key. The `ai_sdk` transport records `option_ignored` for `'wire'` and captures as `'turns'`, because the SDK builds its own body.

An engine's `redact_capture` (see [configuration.md](./configuration.md#the-config-shape)) sees each payload before the trajectory does, and records what it returns. When a payload can't be built, or the redactor throws or returns a promise, nothing is recorded for it, and the turn records `{ kind: 'capture_redaction_failed', step_index, span_id, payload_kind }` instead, where `payload_kind` is `'request'`, `'response'`, or `'wire'` and `span_id` is the turn's `engine.generate.step` span. A `'wire'` payload fails the same way when the redactor returns something other than an object.

Trajectory writes are never load-bearing, and a logger that throws doesn't fail the run. Keep your own loggers equally forgiving.

## Cancellation

Fascicle installs SIGINT/SIGTERM handlers the first time you call `run(...)` and removes them after your last run finishes. When a signal arrives, the abort signal of every run that installed them fires with an `aborted_error`.

Your steps cooperate by:

- Checking `ctx.abort.aborted` at loop boundaries.
- Passing `ctx.abort` to `fetch`, child processes, and other abortable APIs.
- Registering teardown with `ctx.on_cleanup(fn)`.

For embedded runtimes (tests, Lambda, worker threads, anything that owns its own signal stack), opt out with `install_signal_handlers: false` and forward cancellation yourself through `abort`. A run that opts out keeps going through a signal, even while another run's handlers are installed.

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
import { checkpoint, run, step } from 'fascicle';
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
- A store that fails doesn't fail your run. When its `get` throws, the lookup records a `checkpoint` event with `status: 'read_error'` and counts as a miss. When its `set` throws, the step records `status: 'write_error'` and you still get the inner result, since you've already paid for the step that produced it. Your next run with that key misses and runs the step again. When a `suspend` shows that result to an approver, pass `on_write_error: 'fail'`, so a failed write fails the run before anyone is asked to approve a result that the store never kept. `gate` does this for you.
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
| `provider_error`                 | HTTP failures from a provider, on either transport    |
| `rate_limit_error`               | 429 responses after retry exhaustion                  |
| `tool_error`                     | a tool's `execute` throws, under `tool_error_policy: 'throw'` |
| `schema_validation_error`        | `schema` parsing failed after repair attempts         |
| `incomplete_generation_error`    | `schema` set and the call finished on a non-`stop` reason |
| `engine_config_error`            | invalid `create_engine(config)`                       |
| `engine_disposed_error`          | calling `generate` after `engine.dispose()`           |
| `model_required_error`           | no `model` given and no `defaults.model` set          |
| `provider_required_error`        | several providers configured, none named per-call or in `defaults.provider` |
| `provider_not_configured_error`  | named provider missing from `providers`               |
| `provider_capability_error`      | a provider refusing an option it can't honour        |
| `provider_auth_error`            | auth failure detected mid-run                         |
| `tool_approval_denied_error`     | a denied approval under `tool_error_policy: 'throw'`, or a tool that needs approval with no `on_tool_approval` set |
| `on_chunk_error`                 | a caller's `on_chunk` handler threw                   |
| `claude_cli_error`               | subprocess failure in the `claude_cli` provider       |

Every error bubbles out of `run(...)` as a normal promise rejection. Composition-layer errors carry a `.path` array of the step ids that led to the failure — surface it in logs to make failures locatable.

## The Check Contract

Not a runtime concept, but a project one. `pnpm check:all` is the single source of truth for "is this done". The pipeline runs types, lint, structural rules, dead-code analysis, tests, coverage, spelling, markdown, and mutation. Exit 0 means done. Exit non-zero means read `.check/summary.json` for which step failed and the per-tool JSON for diagnostics.

`pnpm check` runs the default set, every slot except the opt-in ones. `pnpm check:all` adds the opt-in slots (Stryker `mutation`, the Playwright `e2e`, and the `build` and packaging gate slots: `publint`, `attw`, `pack`, `smoke`, `snippets`) and is the gate before declaring done. Use `pnpm check` during iteration. See [AGENTS.md](../AGENTS.md) for the full contract.

## Glossary

A few words carry more than one meaning across the field, and some of them carry two in Fascicle's own API. The docs use each one in the sense given here.

- **Harness.** The program around a model, which builds each request, sends it, runs the tools that the model asks for, and decides when to stop. In the field's broad sense the word covers everything that isn't the model, and Fascicle is a library for writing that program ([What a Harness Does](./what-a-harness-does.md) walks through it). [writing-a-harness.md](./writing-a-harness.md) uses the word in a narrower sense, for the outermost program that you write, the one that owns the process and the run.
- **Model call.** One call to `engine.generate`, whether you make it yourself or a `model_call` or `model_step` makes it when it runs. It takes one prompt and returns one result, and the engine records it as an `engine.generate` span. A call that you give tools runs a tool loop of many model turns inside it.
- **Model turn.** One request to the provider and the reply that comes back. A call without tools takes one model turn (or a few, when schema repair asks again), a tool loop takes one per pass, and a retry sends the same model turn again. The engine's API calls a model turn a step, in `max_steps`, `step_index`, `prepare_step`, `StepRecord` (one for each model turn, in `GenerateResult.steps`), and the `engine.generate.step` span. That "step" is always a model turn, and never a `Step`.
- **`Step`.** The unit of composition, a `Step<i, o>` value with an `id` and a `run` (see [Step-as-Value](#step-as-value)). Everything that you compose is a `Step`, and a `model_step` is a single one, however many model turns it takes when it runs.
- **Turn (in ACP).** One prompt that your user sends in an ACP session, and everything that the agent does to answer it. A turn runs the flow once, which can make many model calls, each with its own model turns (see [acp.md](./acp.md#what-a-turn-carries)).
- **Tool loop.** The loop inside a model call that has tools. It sends the conversation, runs the calls that the reply makes, appends the reply and the results, and sends again, until the model answers without a call, a tool flagged `ends_turn` succeeds, or `max_steps` runs out.
- **Transcript.** The array of messages that a tool loop keeps and appends to across its model turns. A `prepare_step` hook lets you change what one model turn sends, and the transcript stays as it was.
- **Context window.** The most that a model can read in one request, counted in tokens, with its reply drawn from the same budget. Every model turn sends the whole transcript, so a long loop spends the window as it goes.
- **Prompt cache.** A provider's short-lived store of a request's processed prefix, which a later request that starts the same way reads back at a fraction of the input price. You ask for one with the `cache` option, and each model turn's `cache_hit_ratio` tells you how much of its input came from it (see [providers.md](./providers.md#prompt-caching)).
- **Trajectory.** The structured record of a run, the events and spans that the `TrajectoryLogger` you hand a run receives (see [Trajectories](#trajectories)).
- **Span.** A named stretch of a trajectory with a start, an end, and a parent, opened for a composer, a `Step`, a model call (`engine.generate`), or a model turn (`engine.generate.step`). An event carries a `span_id` that ties it to one.
- **Capture.** What the `capture` option records when you turn it on (`'turns'` or `'wire'`), which is each model turn's request and reply, written into the trajectory (see [What Gets Recorded](#what-gets-recorded)). It has nothing to do with `make_capture_engine` in `fascicle/testing`, a test double that stands in for the whole engine, records the options that each `generate` call was given, and answers with a canned result, so no model turn ever happens under it.

## Further Reading

- [what-a-harness-does.md](./what-a-harness-does.md) explains what the program around a model does, from the request on the wire to the guards on its tools.
- [getting-started.md](./getting-started.md) — install and run your first flow.
- [writing-a-harness.md](./writing-a-harness.md) — build a runner around Fascicle.
- [blueprint.md](./blueprint.md) — the standard app architecture for building on Fascicle.
- [embedding-under-a-harness.md](./embedding-under-a-harness.md) — run a Fascicle agent as somebody's child process.
- [configuration.md](./configuration.md) — engine config, provider setup, defaults.
- [providers.md](./providers.md) — per-provider adapter notes.
- [cli.md](./cli.md) — the `claude_cli` subprocess provider.
- [cookbook.md](./cookbook.md) — worked patterns (retries, fan-out, judges, HITL).
- [`docs/composition.md`](./composition.md) — full composition surface.

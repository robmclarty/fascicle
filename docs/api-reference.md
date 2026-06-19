# API reference

A one-page map of the public surface. This is a precursor to a generated
reference; for full option shapes and behavior, follow the links into
[configuration.md](./configuration.md), [providers.md](./providers.md), and
[cookbook.md](./cookbook.md).

Everything is exported from two entry points:

```ts
import { /* composition + engine */ } from 'fascicle';
import { /* loggers + stores */ } from 'fascicle/adapters';
```

fascicle is ESM-only and requires Node >= 24. There are no default exports and no
classes other than `Error` subclasses.

## Running a flow

| Export | Shape | Notes |
| --- | --- | --- |
| `run(flow, input, options?)` | `Promise<output>` | Execute a step. `options`: `{ trajectory?, checkpoint_store?, abort?, resume_data? }`. |
| `run.stream(flow, input, options?)` | `{ events, result }` | Same graph as `run`; `events` is an async iterable of `TrajectoryEvent`, `result` resolves to the output. |
| `describe(step, options?)` | `FlowNode` | Static structural description of a step tree. No execution, no model calls. |

```ts
import { run, sequence, step } from 'fascicle';

const flow = sequence([step('inc', (n: number) => n + 1), step('double', (n) => n * 2)]);
await run(flow, 1); // 4
```

## Composition primitives

Every composer takes `Step<i, o>` values and returns a `Step<i, o>`. Anything that
fits a step fits any composition of steps.

**Lift and sequence**

| Primitive | Shape |
| --- | --- |
| `step(id?, fn, meta?)` | lift a plain function into `Step<i, o>` |
| `sequence([a, b, c])` | run in order, threading the value |
| `pipe(inner, fn)` | post-process an inner step's output |
| `compose(label, inner)` | label a composite so it shows up by intent in trajectories |

**Control flow**

| Primitive | Shape |
| --- | --- |
| `branch(predicate, { then, else })` | route on a predicate of the input |
| `map(step, { concurrency? })` | run a step per array element |
| `parallel({ a, b })` | run a named map of steps concurrently |
| `loop(step, { max, guard? })` | bounded iteration with carry-state and optional convergence guard |
| `retry(step, policy)` | re-run on failure with exponential backoff |
| `fallback(primary, backup)` | run a backup if the primary throws |
| `timeout(step, ms)` | cancel an inner step after N ms (throws `timeout_error`) |

**Multi-model**

| Primitive | Shape |
| --- | --- |
| `adversarial({ build, critique, ... })` | build, critique, repeat until accept or `max_rounds` |
| `ensemble([...], score)` | run N members, pick the highest-scoring result |
| `tournament([...])` | single-elimination bracket |
| `consensus([...], { agree })` | run N concurrently, accept when an `agree` predicate holds |

**State and durability**

| Primitive | Shape |
| --- | --- |
| `scope` / `stash` / `use` | named state across non-adjacent steps |
| `checkpoint(key, inner)` | memoize an inner step by key in a `CheckpointStore` |
| `suspend(...)` | pause for external input; resume later with `resume_data` (throws `suspended_error` to signal the pause) |

## The engine

```ts
import { create_engine } from 'fascicle';

const engine = create_engine(config); // EngineConfig -> Engine
```

`create_engine(config)` returns an `Engine`. Only `config.providers` is required;
`config.pricing` and `config.defaults` are optional. See
[configuration.md](./configuration.md#the-config-shape).

| Method | Purpose |
| --- | --- |
| `engine.generate(opts)` | one model call across any configured provider; returns `GenerateResult` |
| `engine.register_price(provider, model_id, pricing)` | add or override a pricing row |
| `engine.dispose()` | terminal and idempotent; aborts in-flight `claude_cli` subprocesses |

### `generate` options (highlights)

`model` and `provider` are the only routing inputs — `model` is an opaque id sent
verbatim, `provider` names the transport. Full shape in
[configuration.md](./configuration.md#generate-options).

| Field | Meaning |
| --- | --- |
| `model`, `provider` | which model / which transport |
| `prompt` | `string \| Message[]` |
| `system` | system prompt |
| `schema` | a zod schema; structured output with repair passes |
| `tools` | agentic tool surface (`Tool[]`) |
| `effort` | `'none' \| 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'`, translated per provider |
| `abort`, `trajectory`, `on_chunk` | cancellation, observation, streaming |
| `retry` | per-call `RetryPolicy` |

### `model_call` — the bridge into a flow

```ts
import { model_call } from 'fascicle';

const ask = model_call({ engine, model: 'sonnet', system: 'Be terse.' });
```

`model_call(config)` returns a `Step`, the only sanctioned bridge between the
composition and engine layers. It threads `ctx.abort`, `ctx.trajectory`, and
streaming chunks. Types: `ModelCallConfig`, `ModelCallInput`.

## Providers

Eight transports behind one `generate`. Provider SDKs are optional peers, loaded
lazily on first use. Full notes in [providers.md](./providers.md).

| Provider | Peer dep | Auth |
| --- | --- | --- |
| `anthropic` | `@ai-sdk/anthropic` | API key |
| `openai` | `@ai-sdk/openai` | API key |
| `google` | `@ai-sdk/google` | API key |
| `openrouter` | `@openrouter/ai-sdk-provider` | API key |
| `bedrock` | `@ai-sdk/amazon-bedrock` | `region` + AWS credentials |
| `ollama` | `ai-sdk-ollama` | local `base_url` |
| `lmstudio` | `@ai-sdk/openai-compatible` | local `base_url` |
| `claude_cli` | none (spawns `claude`) | OAuth session or API key |

Helper: `forward_standard_env()` returns a minimal env (`PATH`, `HOME`, `SHELL`,
`USER`, `LOGNAME`, `LANG`, `TMPDIR`) for sandboxed `claude_cli` runs. See
[cli.md](./cli.md).

## Adapters (`fascicle/adapters`)

Trajectory loggers and checkpoint stores, passed in per run. The
`TrajectoryLogger` and `CheckpointStore` contracts are exported from `fascicle` —
roll your own to target any sink.

| Export | Kind | Notes |
| --- | --- | --- |
| `filesystem_logger(options)` | logger | synchronous JSONL; dev tools and short runs |
| `http_logger(options)` | logger | POST events to an endpoint (pairs with the viewer) |
| `noop_logger()` | logger | discard all events |
| `tee_logger(...loggers)` | logger | fan one event stream out to several loggers |
| `filesystem_store(options)` | store | filesystem-backed `CheckpointStore` |

## Observability viewer

| Export | Purpose |
| --- | --- |
| `start_viewer(options)` | start the embedded viewer server; returns a `ViewerHandle` (`.close()`) |
| `run_viewer_cli(argv)` | the `fascicle-viewer` bin entry point |

The `fascicle-viewer` bin ships with the package. See
[docs/viewer.md](./viewer.md).

## Errors

All are `Error` subclasses. Catch by class.

**Composition (core).** `aborted_error` (abort signal fired), `suspended_error`
(a `suspend` paused the run), `timeout_error` (a `timeout` elapsed),
`resume_validation_error` (bad `resume_data`), `describe_cycle_error` (a cycle in
`describe`).

**Engine.** `provider_not_configured_error`, `model_required_error`,
`engine_config_error`, `engine_disposed_error`, `provider_auth_error`,
`provider_error`, `rate_limit_error`, `provider_capability_error`,
`schema_validation_error`, `tool_error`, `tool_approval_denied_error`,
`on_chunk_error`, `claude_cli_error`.

The [troubleshooting guide](./troubleshooting.md) maps the common ones to causes
and fixes.

## Exported types

For full field-level detail, read the source `.d.ts` (a generated reference is on
the roadmap). The public type exports:

**Composition.** `Step`, `StepMetadata`, `StepKind`, `RunContext`,
`TrajectoryLogger`, `TrajectoryEvent`, `CheckpointStore`, `DescribeOptions`,
`FlowNode`, `FlowValue`, `LoopConfig`, `LoopResult`, `LoopGuardResult`, plus the
trajectory event schemas (`SpanStartEvent`, `SpanEndEvent`, `EmitEvent`,
`CustomTrajectoryEvent`, `ParsedTrajectoryEvent`).

**Engine.** `Engine`, `EngineConfig`, `EngineDefaults`, `GenerateOptions`,
`GenerateResult`, `Message`, `UserContentPart`, `AssistantContentPart`,
`StreamChunk`, `FinishReason`, `Tool`, `ToolExecContext`, `ToolCallRecord`,
`ToolApprovalHandler`, `ToolApprovalRequest`, `StepRecord`, `UsageTotals`,
`CostBreakdown`, `Pricing`, `PricingTable`, `EffortLevel`, `RetryPolicy`,
`RetryFailureKind`, `ProviderConfigMap`, `ProviderInit`, `ResolvedModel`.

**Bridge and viewer.** `ModelCallConfig`, `ModelCallInput`, `StartViewerOptions`,
`ViewerHandle`.

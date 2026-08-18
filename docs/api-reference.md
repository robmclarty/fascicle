# API reference

A one-page map of the public surface. This is a precursor to a generated
reference; for full option shapes and behavior, follow the links into
[configuration.md](./configuration.md), [providers.md](./providers.md), and
[cookbook.md](./cookbook.md).

Everything is exported from the umbrella entry point and its subpaths:

```ts
import { /* composition + engine */ } from 'fascicle';
import { /* loggers + stores */ } from 'fascicle/adapters';
import { /* define_agent */ } from 'fascicle/agents';
import { /* MCP bridge */ } from 'fascicle/mcp';
import { /* stdio child contract */ } from 'fascicle/stdio';
import { /* OpenTelemetry bridge */ } from 'fascicle/otel';
import { /* useChat stream adapters */ } from 'fascicle/ui';
```

fascicle is ESM-only and requires Node >= 24. There are no default exports and no
classes other than `Error` subclasses.

`fascicle` itself has no mandatory peers. Two subpaths need one to do their work:
`fascicle/mcp` needs `@modelcontextprotocol/sdk`, which it loads dynamically and
reports as `mcp_sdk_missing_error` when absent; `fascicle/ui` needs `ai`, which it
imports statically because it speaks the AI SDK's UI message-stream protocol, so a
missing `ai` fails at module resolution rather than with a fascicle error.

## Running a flow

| Export | Shape | Notes |
| --- | --- | --- |
| `run(flow, input, options?)` | `Promise<output>` | Execute a step. `options`: `{ trajectory?, checkpoint_store?, abort?, resume_data? }`. |
| `run.stream(flow, input, options?)` | `{ events, result }` | Same graph as `run`; `events` is an async iterable of `TrajectoryEvent`, `result` resolves to the output. |
| `run.until_suspended(flow, input, options?)` | `Promise<RunOutcome<output>>` | Same graph as `run`, but a `suspend` gate resolves `{ kind: 'suspended', id, resume }` instead of throwing; `resume(data)` re-runs with the decision and resolves to the next outcome. Completion is `{ kind: 'done', output }`; real errors still throw. |
| `describe(step, options?)` | `string` | Static text-tree description of a step tree. No execution, no model calls. `describe.json(step)` returns the structured `FlowNode` tree instead. |
| `ctx.call(step, input)` | `Promise<output>` | On `RunContext`, inside any step body: run another Step with spans, abort, and error paths intact. The direct-style counterpart to composing. |

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
| `sequence([a, b, c])` | run in order, threading the value; literal tuples are joint-checked at compile time (each child must accept its predecessor's output) |
| `pipe(inner, fn)` | post-process an inner step's output |
| `compose(label, inner)` | label a composite so it shows up by intent in trajectories |

A straight pipe belongs in `sequence`; reach for `chain` when a step needs
fan-in, phases, or named per-joint types.

**Control flow**

| Primitive | Shape |
| --- | --- |
| `branch({ when, then, otherwise })` | route on `when(input)` |
| `map({ items, do, concurrency? })` | run `do` per item of `items(input)`, optional in-flight cap |
| `parallel({ a, b })` | run a named map of steps concurrently; the step's input is the intersection of the members' inputs |
| `loop({ init, body, guard?, finish, max_rounds })` | bounded iteration with carry-state and optional convergence guard; returns `finish(state, { converged, rounds })` |
| `retry(step, policy)` | re-run on failure with exponential backoff |
| `fallback(primary, backup, { handoff? })` | run a backup if the primary throws; `handoff(input, err)` maps the backup's input |
| `timeout(step, ms)` | cancel an inner step after N ms (throws `timeout_error`) |

**Multi-model**

| Primitive | Shape |
| --- | --- |
| `adversarial({ build, critique, accept, max_rounds, project? })` | build, critique, repeat until accept or `max_rounds` |
| `ensemble({ members, score, select?, project? })` | run named members, pick the highest-scoring result |
| `ensemble_step({ members, score, rank_by, select?, project? })` | pick-best where the scorer is itself a `Step`; returns the winner plus its structured score |
| `tournament({ members, compare, project? })` | single-elimination bracket |
| `consensus({ members, agree, max_rounds, project? })` | run all members each round, accept when the `agree` predicate holds |

Each of these returns a result envelope (`{ candidate, converged, rounds }`, `{ winner, scores }`, ...). The optional `project` maps that envelope into the step's output at the source (`project: (r) => r.candidate`), so downstream steps see the value instead of the wrapper; omitted, the envelope itself is the output.

**Self-improvement**

| Primitive | Shape |
| --- | --- |
| `improve({ seed, propose, score, budget, project? })` | bounded online propose → score → accept/reject loop with plateau detection; `project` maps the result envelope (e.g. `(r) => r.best.content`) |
| `learn({ flow, source, analyzer })` | offline reflection over recorded trajectories; returns the analyzer's proposals |

**State and durability**

| Primitive | Shape |
| --- | --- |
| `scope` / `stash` / `use` | named state across non-adjacent steps |
| `chain()` → `.step` / `.stage` / `.output` | named steps over a typed record: `.step(name, fn, { arm? })` merges a binding (`arm` records a `ctx.call`ed Step as describe-only child metadata), `.stage(name, project?)` concludes a phase (with `project`, narrows the record), `.output(fn)` projects the result into a `Step` |
| `checkpoint(inner, { key })` | memoize an inner step by key in a `CheckpointStore` |
| `suspend({ id, on, resume_schema, combine })` | pause for external input; resume later with `resume_data` (throws `suspended_error` to signal the pause; `run.until_suspended` surfaces it as a typed outcome instead) |

## The engine

```ts
import { create_engine } from 'fascicle';

const engine = create_engine(config); // EngineConfig -> Engine
```

`create_engine(config)` returns an `Engine`. Only `config.providers` is required;
`custom_providers`, `pricing`, `default_retry`, `default_effort`,
`default_max_steps`, and `defaults` are optional. See
[configuration.md](./configuration.md#the-config-shape).

| Method | Purpose |
| --- | --- |
| `engine.generate(opts)` | one model call across any configured provider; returns `GenerateResult` |
| `engine.register_price(provider, model_id, pricing)` | add or override a pricing row |
| `engine.resolve_price(provider, model_id)` | look up the effective pricing row, if any |
| `engine.list_prices()` | the effective `PricingTable` |
| `engine.with_providers(providers, custom_providers?)` | derive a new engine with added/overridden providers; this engine is untouched, the derived one disposes independently |
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
| `tools` | agentic tool surface (`Tool[]`); a tool may set `ends_turn: true` to end the loop on a successful call |
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

### `model_step`: the answer, not the envelope

```ts
import { model_step } from 'fascicle';

const ask = model_step({ engine, model: 'sonnet', system: 'Be terse.' });
```

`model_step(config)` takes the same config as `model_call` and returns a
`Step` whose output is the content alone: a `string`, or the schema-validated
value when `config.schema` is set. Use it when the flow only wants the
answer; use `model_call` when the caller needs the `GenerateResult` envelope
(usage, cost, tool calls, finish reason). Implemented as one `pipe` over
`model_call`, and worth reading as the pattern for helpers of your own.

### `define_agent` — markdown-driven agents

```ts
import { define_agent } from 'fascicle/agents';

const reviewer = define_agent({ md_path, schema, engine, build_prompt });
```

`define_agent(config)` folds a markdown file (frontmatter `name` / `description`
/ `model` / `temperature`, body as the prompt) and an output schema into a
`Step<i, o>`. Types: `DefineAgentConfig`, `AgentBuiltPrompt`. See
[blueprint.md](./blueprint.md#prompts-markdown-not-string-literals).

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
| `stderr_logger(options?)` | logger | JSONL to stderr; keeps stdout clean when your process is somebody's child |
| `tee_logger(...loggers)` | logger | fan one event stream out to several loggers |
| `filesystem_store(options)` | store | filesystem-backed `CheckpointStore` |

### Reading a trajectory back

Exported from `fascicle` for anything consuming a recorded JSONL stream (the
viewer, `learn`, your own studio). The gate is permissive on purpose: any
non-array object with a string `kind` is an event, so a consumer never drops a
line a newer producer emits. The guards are how you narrow one.

| Export | Kind | Notes |
| --- | --- | --- |
| `parse_trajectory_event(value)` | fn | `{ success: true, data }` or `{ success: false, error }`; `data` is the value itself, uncopied |
| `is_span_start_event(value)` | guard | `span_start` with a string `span_id` and `name` |
| `is_span_end_event(value)` | guard | `span_end` with a string `span_id` |
| `is_emit_event(value)` | guard | a `ctx.emit` event; the payload is the caller's |
| `is_custom_trajectory_event(value)` | guard | the fallback shape: any string `kind`, well-known ones included |

## MCP bridge (`fascicle/mcp`)

Connects flows to the Model Context Protocol both ways. Pure adapter glue over
the existing `Tool` and `run` contracts; `@modelcontextprotocol/sdk` is an
optional peer dependency, installed only when this subpath is used.

| Export | Kind | Notes |
| --- | --- | --- |
| `mcp_client(config, options?)` | fn | connect to an MCP server (stdio / HTTP / existing client), returns `{ tools, close }` |
| `serve_flow(options)` | fn | register a composed flow as an MCP tool on a caller-provided `McpServer` |
| `json_schema_to_standard(schema)` | fn | wraps a server's JSON Schema as the `ToolSchema` inbound tools carry; emits it back verbatim, save for the `additionalProperties: false` every tool schema is closed with |
| `mcp_error`, `mcp_sdk_missing_error` | error | tool-level failure / missing optional peer |

`serve_flow` over a stdio transport is a stateful session for MCP hosts. For a
single-shot child under a plain JSON-over-stdio parent, use `run_stdio` below.

## Stdio agent contract (`fascicle/stdio`)

Run a flow as a single-shot child process: JSON on stdin, one JSON result on
stdout, trajectory on stderr, exit code as the verdict (0 = result on stdout is
authoritative, 1 = flow failure, 2 = contract violation). See
[embedding-under-a-harness.md](./embedding-under-a-harness.md).

| Export | Kind | Notes |
| --- | --- | --- |
| `run_stdio(flow, options?)` | fn | the whole child contract in one call, from your own entry point |
| `execute_stdio(flow, options, io)` | fn | the same contract over injected io; returns a `StdioOutcome` instead of exiting |
| `RunStdioOptions`, `StdioFailure`, `StdioOutcome`, `StdioIo` | type | options and the machine-readable failure envelope |

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
`schema_validation_error`, `incomplete_generation_error`, `tool_error`,
`tool_approval_denied_error`, `on_chunk_error`, `claude_cli_error`.

The [troubleshooting guide](./troubleshooting.md) maps the common ones to causes
and fixes.

## Exported types

For full field-level detail, read the source `.d.ts` (a generated reference is on
the roadmap). The public type exports:

**Composition.** `Step`, `AnyStep`, `StepMetadata`, `StepKind`, `RunContext`,
`TrajectoryLogger`, `TrajectoryEvent`, `CheckpointStore`, `DescribeOptions`,
`FlowNode`, `FlowValue`, `LoopConfig`, `LoopOutcome`, `LoopGuardResult`, plus the
trajectory event shapes (`SpanStartEvent`, `SpanEndEvent`, `EmitEvent`,
`CustomTrajectoryEvent`, `ParsedTrajectoryEvent`, `TrajectoryParseResult`).

**Engine.** `Engine`, `EngineConfig`, `EngineDefaults`, `GenerateOptions`,
`GenerateResult`, `Message`, `UserContentPart`, `AssistantContentPart`,
`StreamChunk`, `FinishReason`, `Tool`, `ToolExecContext`, `ToolCallRecord`,
`ToolApprovalHandler`, `ToolApprovalRequest`, `StepRecord`, `UsageTotals`,
`CostBreakdown`, `Pricing`, `PricingTable`, `EffortLevel`, `RetryPolicy`,
`RetryFailureKind`, `ProviderConfigMap`, `ProviderInit`, `ResolvedModel`.

**Bridge and viewer.** `ModelCallConfig`, `ModelCallInput`, `StartViewerOptions`,
`ViewerHandle`.

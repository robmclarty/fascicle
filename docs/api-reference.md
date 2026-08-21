# API Reference

A one-page map of the public surface. It's a precursor to a generated
reference, so for full option shapes and behavior follow the links into
[configuration.md](./configuration.md), [providers.md](./providers.md),
[leaf-arm-spine.md](./leaf-arm-spine.md), and
[cookbook.md](./cookbook.md).

You import everything from the umbrella entry point and its subpaths:

```ts
import { /* composition + engine */ } from 'fascicle';
import { /* loggers + stores */ } from 'fascicle/adapters';
import { /* define_agent */ } from 'fascicle/agents';
import { /* MCP bridge */ } from 'fascicle/mcp';
import { /* stdio child contract */ } from 'fascicle/stdio';
import { /* OpenTelemetry bridge */ } from 'fascicle/otel';
import { /* stub + capture engines */ } from 'fascicle/testing';
import { /* useChat stream adapters */ } from 'fascicle/ui';
```

Fascicle is ESM-only and needs Node >= 24. It has no default exports, and no
classes other than `Error` subclasses.

`fascicle` itself has no mandatory peers. Three subpaths need one to do their
work. `fascicle/mcp` needs `@modelcontextprotocol/sdk`, which it loads
dynamically and reports as `mcp_sdk_missing_error` when absent, and
`fascicle/otel` needs `@opentelemetry/api`. `fascicle/ui` needs `ai`, which it
imports statically because it speaks the AI SDK's UI message-stream protocol,
so a missing `ai` fails at module resolution rather than with a Fascicle error.

## Running a Flow

| Export | Shape | Notes |
| --- | --- | --- |
| `run(flow, input, options?)` | `Promise<output>` | Execute a step. `options`: `{ trajectory?, checkpoint_store?, abort?, resume_data?, install_signal_handlers? }`. |
| `run.stream(flow, input, options?)` | `{ events, result }` | Same graph as `run`; `events` is an async iterable of `TrajectoryEvent`, `result` resolves to the output. |
| `run.until_suspended(flow, input, options?)` | `Promise<RunOutcome<output>>` | Same graph as `run`, but a `suspend` gate resolves `{ kind: 'suspended', id, payload, resume }` instead of throwing; `payload` is the value that the gate surfaced, and `resume(data)` re-runs with the decision and resolves to the next outcome. Completion is `{ kind: 'done', output }`; real errors still throw. |
| `describe(step, options?)` | `string` | Static text-tree description of a step tree. No execution, no model calls. `describe.json(step)` returns the structured `FlowNode` tree instead. |
| `ctx.call(step, input)` | `Promise<output>` | On `RunContext`, inside any step body, runs another Step with spans, abort, and error paths intact. The direct-style counterpart to composing. |

```ts
import { run, sequence, step } from 'fascicle';

const flow = sequence([step('inc', (n: number) => n + 1), step('double', (n) => n * 2)]);
await run(flow, 1); // 4
```

## Composition Primitives

Every composer takes `Step<i, o>` values and returns a `Step<i, o>`, so anything
that fits a step fits any composition of steps you build.

### Lift and Sequence

| Primitive | Shape |
| --- | --- |
| `step(id?, fn, meta?)` | lift a plain function into `Step<i, o>`; `id` is identity and must be a valid identifier, `meta.name` is the free-prose display label |
| `sequence([a, b, c])` | run in order, threading the value; literal tuples are joint-checked at compile time (each child must accept its predecessor's output) |
| `pipe(inner, fn)` | post-process an inner step's output |
| `compose(inner, { name })` | label a composite so it shows up by intent in trajectories; the label is display only and the id is `compose_<n>` |

A straight pipe belongs in `sequence`, and you reach for `chain` when a step
needs fan-in, phases, or named per-joint types.

### Control Flow

| Primitive | Shape |
| --- | --- |
| `branch({ when, then, otherwise })` | route on `when(input)` |
| `map({ items, do, concurrency? })` | run `do` per item of `items(input)`, optional in-flight cap |
| `parallel({ a, b })` | run a named map of steps concurrently; the step's input is the intersection of the members' inputs |
| `loop({ init, body, guard?, finish, max_rounds })` | bounded iteration with carry-state and an optional convergence guard (a `Step` or a bare `(state) => boolean` predicate); returns `finish(state, { converged, rounds })` |
| `retry(step, policy)` | re-run on failure with exponential backoff |
| `fallback(primary, backup, { handoff? })` | run a backup if the primary throws; `handoff(input, err)` maps the backup's input |
| `timeout(step, ms)` | cancel an inner step after N ms (throws `timeout_error`) |

### Multi-Model

| Primitive | Shape |
| --- | --- |
| `adversarial({ build, critique, accept, max_rounds, project? })` | build, critique, repeat until accept or `max_rounds` |
| `ensemble({ members, score, select?, project? })` | run named members, pick the highest-scoring result |
| `ensemble_step({ members, score, rank_by, select?, project? })` | pick-best where the scorer is itself a `Step`; returns the winner plus its structured score |
| `tournament({ members, compare, project? })` | single-elimination bracket |
| `consensus({ members, agree, max_rounds, project? })` | run all members each round, accept when the `agree` predicate holds |

Each of these returns a result envelope (`{ candidate, converged, rounds }`, `{ winner, scores }`, ...). The optional `project` maps that envelope into the step's output at the source (`project: (r) => r.candidate`), so downstream steps see the value instead of the wrapper; omitted, the envelope itself is the output. `ensemble_step` is the primary pick-best; plain `ensemble` and `tournament` are covered in [advanced-composition.md](./advanced-composition.md), as are `improve` / `learn` and the raw state trio.

### Self-Improvement

| Primitive | Shape |
| --- | --- |
| `improve({ seed, propose, score, budget, project? })` | bounded online propose → score → accept/reject loop with plateau detection; `project` maps the result envelope (for example, `(r) => r.best.content`) |
| `learn({ flow, source, analyzer })` | offline reflection over recorded trajectories; returns the analyzer's proposals |

### Benchmarking

| Export | Purpose |
| --- | --- |
| `bench(flow, cases, judges, options?)` | run a flow once per fixture case, score every output with every judge, return a `BenchReport` |
| `judge_equals()` | score 1/0 against `meta.expected`; abstains when no expected value is present |
| `judge_llm({ model, rubric, scale? })` | prompt a model with a rubric and parse the numeric score from the reply; abstains when the reply doesn't parse |
| `judge_with(fn)` | wrap your own scoring function; bare numbers normalize to `{ score }` |
| `normalize_score(raw)` | coerce a raw judge return into a `Score`, or `undefined` for an abstain |
| `read_baseline(path)` / `write_baseline(path, report)` / `regression_compare(current, baseline, options?)` | persist a report as plain JSON, load one back, and diff a fresh report against it; `ok: false` flags a regression |

You can walk the full loop in
[regression-testing-model-behavior.md](./regression-testing-model-behavior.md).

### State and Durability

| Primitive | Shape |
| --- | --- |
| `chain<i>(input_name?)` → `.input` / `.step` / `.stage` / `.output` | named steps over a typed record; state the input type via `chain<i>()` or `chain('name').input<i>()` (unannotated chains default to `never` and fail at `run`): `.step(name, arm, select, options?)` dispatches a composed arm on the selected slice and records it as the binding's child, `.step(name, fn, { arm?, name? })` is the body form (`arm` records a describe-only child), `.stage(name, project?)` concludes a phase (with `project`, narrows the record), `.output(fn)` projects the result into a `Step`. Every binding name is a record key, so it follows the same identifier rule as a step id; `options.name` carries the free-prose label |
| `scope` / `stash` / `use` | named state at the string-key level; the advanced tier under `chain` (see [advanced-composition.md](./advanced-composition.md)) |
| `checkpoint(inner, { key })` | memoize an inner step by key in a `CheckpointStore` |
| `suspend({ id, on, resume_schema, combine })` | pause for external input, then resume later with `resume_data` (throws `suspended_error` to signal the pause; `run.until_suspended` surfaces it as a typed outcome instead) |
| `gate(inner, { id, store?, format?, name? })` | run `inner`, checkpoint its result at `gate:<id>`, then suspend with it as the payload; resume passes the result through, and a restart with the same store replays from the checkpoint instead of re-running `inner` |

## The Engine

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

### `generate` Options (Highlights)

`model` and `provider` are the only routing inputs, where `model` is an opaque id sent
verbatim, `provider` names the transport. `provider` resolves per call, then from
`defaults.provider`, then to the sole configured provider; an engine with several
providers and no default throws `provider_required_error` when a call names none.
Full shape in [configuration.md](./configuration.md#generate-options).

| Field | Meaning |
| --- | --- |
| `model`, `provider` | which model / which transport |
| `prompt` | `string \| Message[]` |
| `system` | system prompt |
| `schema` | any Standard Schema (zod, ArkType, Valibot, ...); structured output with repair passes |
| `tools` | agentic tool surface (`Tool[]`); a tool may set `ends_turn: true` to end the loop on a successful call |
| `effort` | `'none' \| 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'`, translated per provider |
| `abort`, `trajectory`, `on_chunk` | cancellation, observation, streaming |
| `retry` | per-call `RetryPolicy` |

### Timing and Tokens per Second

Every step that the engine loop produces carries a `timing` block
(`StepTiming`). `started_at` and `duration_ms` bracket the successful
provider attempt alone, so failed attempts, retry backoff, and tool
execution never inflate the number, and a streamed turn adds
`first_chunk_ms` (time to first token). `throughput()` derives the rate
that people actually ask about, from a `GenerateResult`, a step array, or
a single step:

```ts
import { throughput } from 'fascicle';

const rate = throughput(result);
// { tokens_per_second: 42.7, basis: 'decode', output_tokens: 512, measured_ms: 11987 }
```

`basis` names what the number means. A streamed turn measures `'decode'`
(output tokens over the window that excludes time to first chunk, the
benchmark-style rate), while a non-streamed turn can only measure
`'blended'` (the whole round trip, network and prefill included), which
understates the model on a long prompt with a short answer. The helper
returns `undefined` when no step carries timing, which is the case for
external adapters (`claude_cli`) and test doubles, or when the measured
window is zero.

### `model_call` — The Bridge into a Flow

```ts
import { model_call } from 'fascicle';

const ask = model_call({ engine, model: 'claude-sonnet-4-6', system: 'Be terse.' });
```

`model_call(config)` returns a `Step`, the only sanctioned bridge between the
composition and engine layers. It threads `ctx.abort`, `ctx.trajectory`, and
streaming chunks. Like the envelope composites, the config takes an optional
`project` mapping the `GenerateResult` into the step's output at the source
(`project: (r) => ({ text: r.content, cost: r.cost })`); the projection runs
inside the step, so `describe` and the trajectory gain no wrapper node.
Omitted, the envelope is the output. The config also carries the caller-shaped
generation knobs (`temperature`, `max_tokens`, `top_p`, `turn_timeout_ms`,
`prepare_step`) alongside `model` / `provider` / `system` / `schema` / `tools`
/ `effort` / `retry`; `abort`, `trajectory`, and `on_chunk` stay runner-owned
and are threaded automatically. Types: `ModelCallConfig`, `ModelCallInput`.

### `model_step`: The Answer, Not the Envelope

```ts
import { model_step } from 'fascicle';

const ask = model_step({ engine, model: 'claude-sonnet-4-6', system: 'Be terse.' });
```

`model_step(config)` takes the same config as `model_call` (minus `project`)
and returns a `Step` whose output is the content alone, so a `string`, or the
schema-validated value when `config.schema` is set. Use it when the flow only
wants the answer, and use `model_call` when you need the `GenerateResult`
envelope (usage, cost, tool calls, finish reason), or its `project` option
for a slice of it. Implemented as `model_call` with `project` preset to
`(r) => r.content`, so the leaf is a single node in `describe` and the
trajectory.

### `define_agent` — Markdown-Driven Agents

```ts
import { define_agent } from 'fascicle/agents';

const reviewer = define_agent({ md_path, schema, engine, build_prompt });
```

`define_agent(config)` folds a markdown file (frontmatter `name` / `description`
/ `model` / `provider` / `effort` / `temperature` / `max_tokens` / `top_p`,
body as the prompt) and an output schema into a `Step<i, o>`. Every knob is
also accepted on the config; code wins over frontmatter, frontmatter over
engine defaults. `name` is the display label and defaults to the frontmatter
name; `config.id` is the step id, defaults to that same label, and has to be a
valid identifier, so an agent labelled in prose needs one set explicitly.
Types: `DefineAgentConfig`, `AgentBuiltPrompt`. See
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

As a helper, `forward_standard_env()` returns a minimal env (`PATH`, `HOME`, `SHELL`,
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

### Reading a Trajectory Back

Exported from `fascicle` for anything consuming a recorded JSONL stream (the
viewer, `learn`, your own studio). The gate is permissive on purpose. Any
non-array object with a string `kind` is an event, so you don't drop a line a
newer producer emits. The guards are how you narrow one.

| Export | Kind | Notes |
| --- | --- | --- |
| `parse_trajectory_event(value)` | fn | `{ success: true, data }` or `{ success: false, error }`; `data` is the value itself, uncopied |
| `is_span_start_event(value)` | guard | `span_start` with a string `span_id` and `name` |
| `is_span_end_event(value)` | guard | `span_end` with a string `span_id` |
| `is_emit_event(value)` | guard | a `ctx.emit` event; the payload is the caller's |
| `is_run_end_event(value)` | guard | the terminal `run_end` event, emitted once per run, where `status` is `'done' \| 'failed' \| 'aborted' \| 'suspended'`; failures carry `error` plus `error_name` / `error_kind` / `error_path` when known |
| `is_checkpoint_event(value)` | guard | a `checkpoint` store lookup, where `status` is `'hit' \| 'miss' \| 'read_error'`, with the step `id` and store `key` |
| `is_custom_trajectory_event(value)` | guard | the fallback shape, meaning any string `kind`, well-known ones included |

## Testing Doubles (`fascicle/testing`)

The engine doubles that an app's tests need, so the real flow runs through the
real `run()` with zero network. The full guide is [testing.md](./testing.md);
the pattern is worked through in
[blueprint.md](./blueprint.md#testing-stub-the-engine-not-the-flow).

| Export | Kind | Notes |
| --- | --- | --- |
| `make_stub_engine(canned, options?)` | fn | routes canned responses by system-prompt prefix, validates canned content through the call's schema, and throws on an unmatched system; `content` may be a function `(opts, call_index) => value` |
| `make_script_engine(responses, options?)` | fn | a strict call-order queue whose entries are plain content values or `{ content?, tool_calls?, finish_reason?, usage?, throw? }`; exhaustion throws with the scripted vs received counts |
| `make_capture_engine(options?)` | fn | records every call's `GenerateOptions` into a live `calls` array, answers with a canned result |
| `text_of(opts)` | fn | the user-visible prompt text of a captured `GenerateOptions`, whatever the prompt shape |
| `engine_from_generate(generate)` | fn | wrap a bare `generate` into a full `Engine`; the shell the factories build on, for rolling your own double |

Types: `StubEngineOptions`, `StubResponse`, `StubContentFn`,
`ScriptResponse`, `ScriptEngineOptions`, `CaptureEngine`,
`CaptureEngineOptions`.

## MCP Bridge (`fascicle/mcp`)

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

## Stdio Agent Contract (`fascicle/stdio`)

Run a flow as a single-shot child process, with JSON on stdin, one JSON result on
stdout, trajectory on stderr, exit code as the verdict (0 = result on stdout is
authoritative, 1 = flow failure, 2 = contract violation). See
[embedding-under-a-harness.md](./embedding-under-a-harness.md).

| Export | Kind | Notes |
| --- | --- | --- |
| `run_stdio(flow, options?)` | fn | the whole child contract in one call, from your own entry point |
| `execute_stdio(flow, options, io)` | fn | the same contract over injected io; returns a `StdioOutcome` instead of exiting |
| `RunStdioOptions`, `StdioFailure`, `StdioOutcome`, `StdioIo` | type | options and the machine-readable failure envelope |

## UI Message Streams (`fascicle/ui`)

Bridges a `run.stream(...)` handle onto the AI SDK UI message-stream protocol,
so a Fascicle flow can back a `useChat` endpoint rendered by AI Elements or
Streamdown. Imports `ai` statically (see the peer note at the top).

| Export | Kind | Notes |
| --- | --- | --- |
| `to_ui_message_response(handle, options?)` | fn | turn a `run.stream(...)` handle into an SSE `Response` a `useChat` endpoint can return directly |
| `pipe_ui_message_stream_to_response(handle, res, options?)` | fn | the same stream piped to a Node `http.ServerResponse`, for `node:http` servers |
| `to_ui_message_chunks(event, state)` | fn | map one run event to zero or more `UIMessageChunk`s, advancing `state`; the low-level mapper both entry points share |
| `close_open_blocks(state)` | fn | the `*-end` chunks for every text/reasoning block still open; flushes a stream whose event iterable ends early |
| `create_ui_mapper_state()` | fn | fresh per-stream mapper state for the low-level API |

Types: `RunStreamLike` (the structural shape of a `run.stream(...)` handle, so
no core import is needed to satisfy it), `ToUiStreamOptions`, `UiMapperState`.

## Observability Viewer (`fascicle/viewer`)

```ts
import { start_viewer } from 'fascicle/viewer';
```

| Export | Purpose |
| --- | --- |
| `start_viewer(options)` | start the embedded viewer server; returns a `ViewerHandle` (`.close()`) |
| `run_viewer_cli(argv)` | the `fascicle-viewer` bin entry point |
| `create_broadcaster(options?)` | fan live trajectory events out to subscribers |
| `start_server(options)` | the bare HTTP server underneath `start_viewer` |
| `start_tail(options)` | follow a trajectory JSONL file as it grows |

Types: `StartViewerOptions`, `ViewerHandle`, `Broadcaster`,
`BroadcasterConfig`, `BroadcastEvent`, `Subscriber`, `ServerConfig`,
`ViewerServer`, `Tail`, `TailConfig`. The `fascicle-viewer` bin ships with
the package and needs no peer. See [docs/viewer.md](./viewer.md).

## Errors

All are `Error` subclasses. Catch by class.

**Composition (core).** `aborted_error` (abort signal fired), `suspended_error`
(a `suspend` paused the run), `timeout_error` (a `timeout` elapsed),
`resume_validation_error` (bad `resume_data`), `describe_cycle_error` (a cycle in
`describe`), `bench_suspend_error` (a benched flow suspended; `bench` has no
resume path).

**Engine.** `provider_required_error` (several providers configured, none named
by the call or `defaults.provider`), `provider_not_configured_error`,
`model_required_error`,
`engine_config_error`, `engine_disposed_error`, `provider_auth_error`,
`provider_error`, `rate_limit_error`, `provider_capability_error`,
`schema_validation_error`, `incomplete_generation_error`, `tool_error`,
`tool_approval_denied_error`, `on_chunk_error`, `claude_cli_error`.

The [troubleshooting guide](./troubleshooting.md) maps the common ones to causes
and fixes.

## Exported Types

For full field-level detail, read the source `.d.ts` (a generated reference is on
the roadmap). The public type exports:

**Composition.** `Step`, `AnyStep`, `StepMetadata`, `StepKind`, `RunContext`,
`RunOutcome`, `Chain`, `ChainStepOptions`, `TrajectoryLogger`,
`TrajectoryEvent`, `CheckpointStore`, `DescribeOptions`, `FlowNode`,
`FlowValue`, `LoopConfig`, `LoopOutcome`, `LoopGuardResult`,
`LoopGuardPredicate`, plus the trajectory event shapes (`SpanStartEvent`,
`SpanEndEvent`, `EmitEvent`, `RunEndEvent`, `RunEndStatus`,
`CheckpointEvent`, `CheckpointStatus`, `CustomTrajectoryEvent`,
`ParsedTrajectoryEvent`, `TrajectoryParseResult`).
The step-kind vocabulary also ships at runtime, where `STEP_KINDS` is the closed
list and `is_step_kind` its narrowing guard. Every config a composer
signature names is exported too: `SequenceOptions`, `ParallelOptions`,
`BranchConfig`, `MapConfig`, `PipeOptions`, `RetryConfig`, `FallbackOptions`,
`TimeoutOptions`, `CheckpointConfig`, `SuspendConfig`, `ScopeOptions`,
`StashOptions`, `UseOptions`, `GateConfig`, alongside `RunOptions`,
`StreamingRunHandle`, `StepFn`, `CleanupFn`, the extractors `StepInput<s>` /
`StepOutput<s>`, and the schema vocabulary (`ToolSchema`, `AnySchema`,
`SchemaIssue`). At runtime `is_step` narrows a value to a `Step`, and
`error_path(err)` reads the `path` that a run attached to a thrown error.

**Composites.** Every deliberation composite carries a config and a result
envelope: `AdversarialConfig` / `AdversarialResult` plus
`AdversarialBuildInput` and `AdversarialCritiqueResult`, `ConsensusConfig` /
`ConsensusResult`, `EnsembleConfig` / `EnsembleResult`, `EnsembleStepConfig` /
`EnsembleStepResult`, and `TournamentConfig` / `TournamentResult` /
`BracketRecord`.

The self-improvement tier adds `ImproveConfig`, `ImproveResult`,
`ImproveBudget`, `ImproveRoundInput`, `Candidate`, `ScoredCandidate`,
`HistoryEntry`, `Lesson`, `LearnConfig`, `LearnResult`, `LearnInput`,
`Improvement`, and `TrajectorySource`.

The bench tier adds `BenchCase`, `BenchOptions`, `BenchReport`, `BenchSummary`,
`CaseResult`, `Judge`, `JudgeArgs`, `Score`, `JudgeLlmConfig`, `JudgeWithFn`,
`RegressionCompareOptions`, `RegressionReport`, `RegressionDelta`, and
`PerCaseDelta`.

**Engine.** `Engine`, `EngineConfig`, `EngineDefaults`, `GenerateOptions`,
`GenerateResult`, `Message`, `UserContentPart`, `AssistantContentPart`,
`StreamChunk`, `FinishReason`, `Tool`, `ToolExecContext`, `ToolCallRecord`,
`ToolApprovalHandler`, `ToolApprovalRequest`, `StepRecord`, `StepTiming`,
`Throughput`, `UsageTotals`,
`CostBreakdown`, `Pricing`, `PricingTable`, `EffortLevel`,
`EffortTranslation`, `RawProviderUsage`, `PrepareStepContext`,
`PrepareStepResult`, `RetryPolicy`, `RetryFailureKind`, `ProviderConfigMap`,
`ProviderInit`, `ResolvedModel`.

**Bridge.** `ModelCallConfig`, `ModelCallInput`. The viewer types live on the
`fascicle/viewer` subpath.

The provider-authoring types (`ProviderAdapter`, `ProviderFactory`,
`NativeProviderAdapter`, `TurnRequest`, `TurnResult`, ...) are enumerated in
[providers.md](./providers.md).

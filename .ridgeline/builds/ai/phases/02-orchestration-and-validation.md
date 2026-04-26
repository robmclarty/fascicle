# Phase 2: Generate Orchestration, Engine Factory, and Full Validation

## Goal

Compose the foundation delivered in phase 1 into the public engine surface and prove correctness against every documented behavior in the spec. After this phase, `generate` is the single callable entry point that resolves models, threads abort, runs the bounded tool-call loop, validates tool inputs, honors human-in-the-loop approval with fail-closed semantics, handles structured output with one repair attempt by default, streams chunks through `on_chunk` without internal buffering, applies the retry policy for provider failures, and emits the full trajectory + cost event stream. `create_engine` returns a fully-isolated engine instance with its own alias and pricing tables. The `@robmclarty/agent-kit` umbrella re-exports the engine surface alongside the existing core re-exports.

The phase is sized around a comprehensive testing sweep that covers all 35 success criteria from spec §10 and all 20 failure modes from spec §9, plus a cross-layer integration test that wires `generate` inside a composition-layer `step` and proves abort propagates cleanly through both layers. Streaming parity — that `generate` produces an identical `GenerateResult` whether `on_chunk` is supplied or omitted, for the same provider response — is tested explicitly because it is the load-bearing invariant that lets composers stay unaware of streaming.

## Context

Phase 1 delivered the standalone modules: `types.ts`, `errors.ts`, `aliases.ts`, `pricing.ts`, `retry.ts`, `streaming.ts`, `trajectory.ts`, `usage.ts`, `schema.ts` (parse + repair-prompt helpers, but not the iteration loop), all six provider adapters under `providers/`, and the architectural rules that govern the package. Every standalone module has unit tests; the package compiles, lints, and architecturally-validates under `pnpm check`. There is no callable `generate` yet — the public export surface in `index.ts` does not exist.

This phase implements the orchestration that composes the foundation: the tool-call loop, the schema repair iteration, the `generate` orchestrator that ties retry + streaming + cost + trajectory + alias resolution together, the `create_engine` factory that owns per-instance alias and pricing tables, and the public `index.ts`. The composition layer (`@robmclarty/core`) is already built; this phase adds the cross-layer integration test that validates engine + composition compose correctly. The umbrella package at `packages/agent-kit/` is updated to re-export the engine.

The orchestration must honor every semantic in spec §6: alias resolution before any I/O, sequential tool execution with abort checks at iteration boundaries and per-tool-call boundaries, tool input validation against zod schemas before `execute` is invoked, fail-closed HITL approval when `needs_approval` is set without an `on_tool_approval` handler, schema repair with the canned repair message that counts against `max_steps`, streaming parity, retry coverage limited to provider failures with the post-stream-start no-retry carve-out, cost computation per turn with proper aggregation, and one `pricing_missing` event per call (deduplicated) when pricing is absent for a non-free provider.

## Acceptance Criteria

### Core orchestration

1. `packages/engine/src/tool_loop.ts` implements the loop exactly as spec §6.4 pseudocode:
   - sequential tool execution within a turn (no parallel dispatch);
   - abort checked at the top of each loop iteration AND before each tool call within a turn;
   - tool input validated against `tool.input_schema` (zod `safeParse`) before `execute` is invoked — invalid input is fed back as a tool result with `error: true` and consumes a step; `execute` is not called;
   - `tool_error_policy` branching: `'feed_back'` (default) serializes the thrown error into a tool result with `{ error: <message> }`; `'throw'` wraps the error in `tool_error` with `{ tool_name, tool_call_id, cause }` and ends the call;
   - `tool.needs_approval` (boolean or predicate) gates `execute`: if truthy, `on_tool_approval` is invoked first; abort fired during the await rejects with `aborted_error`; absent `on_tool_approval` with `needs_approval` truthy fails closed with `tool_approval_denied_error` thrown before `execute`; denial under `feed_back` pushes `{ error: { message: 'tool_approval_denied' } }` and the loop continues; denial under `throw` raises `tool_approval_denied_error` with `{ tool_name, step_index, tool_call_id }`;
   - `max_steps` cap **resolves** with `finish_reason: 'max_steps'` (it does not throw); attempted-but-unexecuted tool calls from the final turn are included in the result's `tool_calls` with `error: { message: 'max_steps_exceeded_before_execution' }` and no `output`.

2. `packages/engine/src/generate.ts` implements the single public `generate` function:
   - alias resolution runs once, synchronously, before any HTTP I/O — `model_not_found_error` surfaces from the start of the promise chain;
   - the resolved `{ provider, model_id }` is recorded in trajectory and stamped on `result.model_resolved`;
   - `prompt: string` is sugar for a single user message; full `Message[]` is passed through; the `system` option is prepended as an additional system message;
   - `effort` is routed to provider-specific reasoning config via the adapter's effort hook; non-reasoning providers cause `{ kind: 'effort_ignored', model_id }` to be recorded;
   - per-turn usage is normalized via the foundation's usage helpers; per-turn cost is computed via `compute_cost` and emitted as `{ kind: 'cost', step_index, ... }` to trajectory;
   - one `{ kind: 'pricing_missing', provider, model_id }` event is emitted per call (deduplicated) when pricing is absent for a non-free provider; for `FREE_PROVIDERS` (Ollama, LM Studio) without pricing the cost breakdown is present with all fields zero;
   - top-level `finish_reason` is the final turn's reason except `'aborted'` and `'max_steps'` take precedence when they apply;
   - usage aggregation across `steps` follows spec §5.3 (absent stays absent on the top-level totals when no step reported the field; arithmetic treats absent as 0);
   - schema gating: with `schema` set, the orchestrator passes the schema to the AI SDK for native structured-output enforcement when supported; for providers without native support (e.g. some Ollama models) the orchestrator falls back to free-text generation with a prepended JSON instruction; final assistant text is parsed via `safeParse`; on failure, the schema repair iteration appends the canned repair message from spec §6.5 and re-runs (the repair turn counts against `max_steps`); after `schema_repair_attempts` exhaustion (default 1), throws `schema_validation_error` carrying the zod error and raw model text;
   - retry policy from `RetryPolicy` is applied to each provider call (not the entire loop): rate-limit / 5xx / network classes are retried per phase 1's `retry_with_policy`; once a streaming response has delivered any chunk, no retry is attempted for that call (subsequent provider-side interruption surfaces `provider_error`);
   - streaming parity: when `on_chunk` is provided, the orchestrator uses the streaming endpoint and dispatches chunks via the foundation's streaming helper synchronously per provider event; when omitted, the orchestrator uses the non-streaming endpoint (or streaming with internal accumulation) — for the same mocked provider response, the returned `GenerateResult` is deeply equal across the two paths;
   - chunk dispatch ordering follows spec §5.6: text and reasoning interleave within a step; `tool_call_start` precedes its `tool_call_input_delta` events and its `tool_call_end`; `tool_result` follows the matching `tool_call_end`; `step_finish` is the last chunk of a step; `finish` is the last chunk of the call;
   - `on_chunk` errors (sync throw or rejected promise) abort the in-flight HTTP request, wrap the error in `on_chunk_error`, throw from `generate`, and prevent further `on_chunk` invocation.

3. `packages/engine/src/create_engine.ts` implements the factory:
   - validates each entry in `EngineConfig.providers` at construction; an empty `api_key` for a credentialed provider throws `engine_config_error`;
   - merges user-supplied aliases over `DEFAULT_ALIASES` and user-supplied pricing over `DEFAULT_PRICING` into per-instance tables;
   - exposes `register_alias`, `unregister_alias`, `resolve_alias`, `list_aliases`, `register_price`, `resolve_price`, `list_prices`;
   - `list_aliases` and `list_prices` return defensive copies (mutating the returned object does not affect engine state);
   - returns an `Engine` object whose `generate` is a closure bound to this engine's configuration;
   - referencing a provider in a `generate` call that was not configured at construction throws `provider_not_configured_error` at call time (not at construction).

4. `packages/engine/src/index.ts` exports exactly: `create_engine`, every type from `./types.js`, every error class from `./errors.js`. Provider adapters, orchestration helpers, and internal constants other than the public types are not re-exported.

5. The `@robmclarty/agent-kit` umbrella package at `packages/agent-kit/` is updated:
   - `package.json` adds `@robmclarty/engine` as a workspace dependency;
   - the umbrella re-exports the engine's public surface (`create_engine` + types + errors) alongside the existing core re-exports;
   - the umbrella compiles and is reachable via `import { create_engine, ... } from '@robmclarty/agent-kit'`.

### Success-criteria coverage (spec §10, all 35 named tests)

6. Each of the 35 success-criteria tests from spec §10 exists as a named test in colocated `*.test.ts` files and passes against mocked provider responses. Tests use Vitest, mock at the AI SDK boundary or via `msw` at HTTP level (a single test file is internally consistent about which strategy it uses), and use fixture pricing values (not `DEFAULT_PRICING`) for cost-related assertions so real-world pricing updates do not churn the suite. Coverage:
   - **#1** plain string completion → `content`, `tool_calls: []`, `steps.length: 1`, `finish_reason: 'stop'`;
   - **#2** multi-turn `Message[]` with `system` option merged as the first system message;
   - **#3** structured output happy path with typed `content`;
   - **#4** schema repair success on second attempt;
   - **#5** schema repair exhausted → `schema_validation_error`;
   - **#6** single-round tool loop with one tool;
   - **#7** multi-tool single-turn sequential dispatch with order preserved;
   - **#8** malformed tool input — `execute` not called, error fed back, next turn succeeds;
   - **#9** tool error `feed_back` continues loop;
   - **#10** tool error `throw` bubbles `tool_error`;
   - **#11** `max_steps` reached → `finish_reason: 'max_steps'` with `max_steps_exceeded_before_execution` markers;
   - **#12** effort mapping per provider; `effort_ignored` recorded on non-reasoning models;
   - **#13** streaming chunks captured in correct order with concatenated text matching;
   - **#14** streaming + tools — chunks include `tool_call_start`, `tool_call_input_delta`, `tool_call_end`, `tool_result`, `step_finish`;
   - **#15** `on_chunk` throws on third chunk → `on_chunk_error`, no further chunks, HTTP mock observed abort;
   - **#16** pre-aborted signal → `aborted_error` synchronously / first-microtask, no HTTP call;
   - **#17** abort fires 50ms into 500ms streaming response → `aborted_error`, HTTP observed abort;
   - **#18** abort during tool execute → `tool_call_in_flight` metadata on `aborted_error`, tool's `ctx.abort` was aborted;
   - **#19** retry rate_limit success on third attempt; trajectory shows two retries;
   - **#20** retry respects numeric `Retry-After` (wait ≥ specified seconds);
   - **#21** retry exhausted → `rate_limit_error`;
   - **#22** no retry after stream starts — one chunk delivered then ECONNRESET → `provider_error` thrown, not retried;
   - **#23** usage aggregation across three-turn tool loop sums correctly;
   - **#24** alias resolution: default alias works, registering then unregistering changes routing;
   - **#25** colon-bypass provider prefix routes (`ollama:gemma3:27b`, `openrouter:anthropic/claude-sonnet-4.5`);
   - **#26** missing credentials → `provider_not_configured_error` at call time;
   - **#27** trajectory spans hierarchical: `engine.generate` parent with `engine.generate.step` children, `request_sent` / `response_received` / `tool_call` records inside;
   - **#28** two engines independent — concurrent calls with different credentials and alias tables show no cross-talk;
   - **#29** cost from default pricing — Sonnet 1000 input / 500 output → `input_usd === 0.003`, `output_usd === 0.0075`, `total_usd === 0.0105`; matching `cost` trajectory event;
   - **#30** cost aggregates across turns within 1e-9 tolerance;
   - **#31** cost with cache hits — Anthropic Sonnet 1500 input / 1000 cached / 200 output → fresh-input covers 500 @ $3/MTok, cached covers 1000 @ $0.30/MTok, output covers 200 @ $15/MTok;
   - **#32** cost missing for unknown model — custom alias with no pricing → `cost: undefined`, exactly one `pricing_missing` event regardless of turn count;
   - **#33** cost zero for free providers — Ollama with no pricing → `cost` present with all fields zero (not `undefined`);
   - **#34** user-overridden pricing applied — `register_price` with zero rates → `total_usd === 0` regardless of defaults;
   - **#35** partial usage fields omit cost components — OpenAI response with only `input_tokens` + `output_tokens` → `CostBreakdown` contains only `input_usd`, `output_usd`, `total_usd`, `currency`, `is_estimate`; no cache keys.

### Failure-mode coverage (spec §9, F1–F20)

7. Each of failure modes F1–F20 from spec §9 has at least one named test asserting the documented behavior, error type, and metadata shape. F1–F5, F16, F17 may be covered by tests already delivered in phase 1 for the underlying helpers; this phase ensures end-to-end coverage through `generate`. F6–F15 and F18–F20 are net-new tests landing in this phase, including:
   - F11 `on_chunk` throws → engine aborts request, throws `on_chunk_error`, no further `on_chunk` invocation;
   - F12 abort during tool execution → `aborted_error` with `tool_call_in_flight` metadata; tool's `ctx.abort` received the signal;
   - F13 content_filter finish reason returned normally without exception;
   - F14 schema fallback path for providers without native JSON mode (Ollama route);
   - F15 cleanup during `generate` covered by the cross-layer integration test (criterion 9 below);
   - F18 tool approval denied under both `feed_back` (fed back as tool result) and `throw` (raises `tool_approval_denied_error`);
   - F19 abort during `on_tool_approval` await — `on_tool_approval` returns a never-resolving promise; abort fires at 100ms; `aborted_error` thrown within one event-loop tick of the abort; `execute` never called;
   - F20 `needs_approval: true` without `on_tool_approval` fails closed — `tool_approval_denied_error` thrown before `execute`.

### Streaming parity and integration

8. Streaming parity test: a single test asserts that for the same mocked provider response, calling `generate` with `on_chunk` and without `on_chunk` produces deeply-equal `GenerateResult` objects (modulo `on_chunk` side-effects). The chunk-ordering invariants from spec §5.6 are verified separately within criterion 6 #13 / #14.

9. Cross-layer integration test at `packages/engine/test/integration/with_composition.test.ts`:
   - constructs a flow using `step` from `@robmclarty/core` and runs it via the composition runner;
   - the step body calls `generate` threading `ctx.abort` as `opts.abort`, `ctx.trajectory` as `opts.trajectory`, and `on_chunk: ctx.emit` (with the engine chunk wrapped or normalized for the composition layer's event channel);
   - mocks the AI SDK at the adapter seam or via `msw`;
   - asserts that (a) chunks flow through `ctx.emit` into `run.stream` events scoped by the originating step's `span_id`; (b) aborting the run propagates to the HTTP mock and causes `generate` to reject with `aborted_error` within one event-loop tick; (c) the runner's `on_cleanup` handlers fire in LIFO order even though the rejection originated inside the engine; (d) the trajectory tree includes both composition-layer spans and nested `engine.generate` spans; (e) cost events emitted by the engine are observable to a user-land trajectory consumer that accumulates totals;
   - the test does not require real network — it uses mocks and is not gated by `RUN_E2E`.

10. A child-process SIGINT harness (under `packages/engine/test/cleanup/` or extending the existing core cleanup harness): spawns a script that runs an engine-backed flow, sends SIGINT during the mocked provider call, asserts the runner's cleanup chain fired and `generate`'s promise rejected with `aborted_error`. (May be folded into the integration test of criterion 9 if structurally cleaner; the substantive assertion is what matters.)

### Architectural invariants and final pnpm check

11. Defensive-copy invariant tests: mutating the return value of `engine.list_aliases()` does not affect the engine's alias table; same for `engine.list_prices()`.

12. No test in default CI invokes a real LLM provider; all real-network tests are gated behind `RUN_E2E=1` and skipped by default.

13. Coverage floor: vitest reports ≥70% lines / functions / branches / statements across `packages/engine/src/` (excluding pure re-exports in `index.ts`).

14. Manual-review gates (called out as a comment in the relevant files or recorded in a CONTRIBUTING / review checklist):
    - `generate` is the sole public entry point for model calls — no exported function outside `packages/engine/src/generate.ts`, `tool_loop.ts`, or `index.ts` invokes Vercel AI SDK's `generateText`, `streamText`, `streamObject`, or a provider SDK function directly (constraints §7 invariant 13);
    - no mutation of caller inputs (`generate_options`, `messages`, `tools`, `schema`, alias/pricing overrides) — constraints §7 invariant 14.

15. Running `pnpm check` from the repository root exits zero with the complete engine implementation in place: every architectural rule from phase 1 continues to hold (no `class` outside the two permitted `errors.ts` files, no `export default`, no `process.env`, no value imports from `@robmclarty/core`, no provider SDK imports outside `providers/`, snake_case for value exports, dependency manifest matches), all unit tests pass, the streaming parity test passes, all 35 success-criteria tests pass, all 20 failure-mode tests pass, the cross-layer integration test passes, the umbrella re-export compiles, and cspell + markdownlint are clean.

## Spec Reference

- **spec.md §5.1–§5.8** — `generate` signature, `GenerateOptions`, `GenerateResult`, `Message`, `Tool`, `StreamChunk`, alias table, `Engine` factory contract, pricing table.
- **spec.md §6 (all subsections)** — alias resolution timing, trajectory event structure, effort mapping, the tool-call loop pseudocode, schema repair, streaming semantics + parity, cancellation propagation, retry policy, cost computation runtime contract.
- **spec.md §9** — every failure mode F1–F20 covered.
- **spec.md §10** — every success criterion 1–35 covered.
- **spec.md §11** — file structure (this phase creates `tool_loop.ts`, `generate.ts`, `create_engine.ts`, `index.ts`, the integration test directory, and the schema-iteration body inside `schema.ts`).
- **spec.md §13** — open questions / deferrals; nothing in the deferred list is implemented (no parallel tool execution, no engine-level cache, no `dry_run`, no partial-result-on-abort, no MCP integration, no per-token trajectory recording, no provider capability negotiation API, no non-USD currency, no hot-swapping providers mid-call, no in-engine budget enforcement).
- **constraints.md §5** — operational non-negotiables (cancellation, cleanup, trajectory plumbing, streaming as observation, tool-call loop semantics including HITL fail-closed, cost reporting, no mutation of caller inputs, synchronous abort observation).
- **constraints.md §6** — v1 scope fence; the engine ships exactly the in-scope items and explicitly skips the out-of-scope items.
- **constraints.md §7** — engine-layer invariants 10–15 mechanically enforced by `pnpm check`; manual-review gates noted in criterion 14.
- **constraints.md §9** — testing requirements: colocation, mocking at the AI SDK boundary or via `msw`, fixture pricing, no real network in default CI, concurrency tests for two-engine independence, SIGINT / cleanup harness, engine cancellation test, streaming parity test, cross-layer integration test, 70% coverage floor.
- **taste.md §1, §4, §5, §6, §7** — substitutability, streaming as observation not separate code path, mandatory cancellation, no ambient state proven by two-engine independence, composers do not know about each other (engine + composition compose through the `step<i, o>` value contract).

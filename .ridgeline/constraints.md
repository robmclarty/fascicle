# Agent-Kit — Constraints

**Document:** `constraints.md` (project-wide, authoritative)
**Sibling documents:** `taste.md` (design philosophy), per-build `spec.md` under `.ridgeline/builds/<build>/`
**Status:** implementation-ready
**Source specs:** `docs/agent-kit-composition-layer-spec.md`, `docs/agent-kit-ai-engine-layer-spec.md`

---

## What a constraint is

A constraint is a non-negotiable: something that, if changed, requires revisiting the entire design. Constraints are the load-bearing walls. They are not opinions about API aesthetics (that belongs in `taste.md`), and they are not interface definitions or behavioral semantics (that belongs in each build's `spec.md`).

This document covers project-wide rules that apply to every package in the workspace — the composition layer (`@robmclarty/core`), the AI engine layer (`@robmclarty/engine`), and adapter packages (`@robmclarty/observability`, `@robmclarty/stores`, `fascicle` umbrella). Where a rule is layer-specific, it is called out explicitly. Treat any item here as fixed unless a formal design revision is opened.

On conflicts with per-build `spec.md` or `constraints.md`: **this file wins**.

---

## Check Command

```bash
pnpm check
```

This is the literal CI gate, defined in `scripts/check.mjs`. It runs the full pipeline: oxlint (+ oxlint-tsgolint), fallow, `tsc --noEmit`, vitest, ast-grep architectural invariant rules, cspell, markdownlint, `scripts/check-deps.mjs`. The invariant checks in §7 are executed as ast-grep rules and dependency-audit scripts inside `pnpm check`. A phase is "done" when `pnpm check` exits zero; no other signal counts.

---

## §1 — Language and Runtime

- **TypeScript:** 6.x with `strict: true`. No looser settings, including in tests. No `any`-escape hatches on public surface. TypeScript 7 (Go-native compiler) is expected later in 2026 and is not adopted until a stable release lands and Vitest/tsdown interop is proven.
- **Compile target:** ES2024 minimum, `lib: ["ES2024"]`. Consumable on Node.js 24 without polyfills.
- **Module format:** ESM only. Source `.ts`, publishes `.js` (ESM) + `.d.ts`. No CommonJS output, no dual-format bundle.
- **Target runtime:** Node.js ≥ 24. Node 20 LTS reached end-of-life April 2026; 22 LTS runs through April 2027, 24 LTS through April 2028. 24 is the development and deployment target; it provides the stable permission model, native WebSocket client, modern `AbortSignal` helpers, and the Node runtime assumptions behind Vercel AI SDK v6.
- **tsconfig basics:** `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `esModuleInterop: true`, `skipLibCheck: true`, `forceConsistentCasingInFileNames: true`, `isolatedModules: true`, `verbatimModuleSyntax: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- **Import specifiers:** relative imports within a package use the `.js` extension even from `.ts` source files (NodeNext resolution). Cross-package imports go through workspace names (`@robmclarty/core`, `@robmclarty/engine`, etc.), never relative paths.
- **No browser build in v1.** The runner installs Node-level `SIGINT`/`SIGTERM` handlers by default. Anthropic/OpenAI/Google provider SDKs via Vercel AI SDK do run in browsers; the engine does not. Exposing a browser build is deferred.

---

## §2 — Code Style (Hard Rules)

Enforced mechanically (AST grep / lint / CI check). Review alone is not sufficient.

- **No `class`.** No `extends`. No `this`. No prototype manipulation. Factory functions return plain objects. Composers are functions that return `step<i, o>`. Provider adapters are factory functions that return plain-object dispatchers.
  - **Permitted exception, narrowly scoped:** `class <name> extends Error` in **`packages/core/src/errors.ts`** and **`packages/engine/src/errors.ts`** for the typed errors enumerated in each layer's spec. Typed errors are conventionally declared this way in Node/TS; `Error` is a built-in, and `instanceof` branching is how composers like `retry` and `fallback` distinguish failure modes. No other file may use `class`. Enforced by `rules/no-class.yml` with scoped `ignores:` for exactly these two files.
- **Functional and procedural.** Side effects live at edges (subprocess spawn, file I/O, trajectory calls, provider HTTP, `tool.execute`). No inheritance chains.
- **Named exports only.** No `export default`. Enforced by `rules/no-default-export.yml`.
- **Naming:**
  - variables, functions, parameters, files → `snake_case`
  - **type aliases and interfaces → `PascalCase`**
  - module-level constants → `SCREAMING_SNAKE_CASE` (e.g. `DEFAULT_ALIASES`, `DEFAULT_PRICING`, `DEFAULT_RETRY`, `FREE_PROVIDERS`, `STREAMING_HIGH_WATER_MARK`)
  - **no camelCase** anywhere in source, including parameter names on public types
- **No ambient module-level mutable state.** No singleton registries, no Mastra-style central registry, no module-level `let` that accumulates across calls. All execution state lives in `run_context`, constructed fresh per top-level `run(...)` call. Engine state (alias tables, pricing tables) lives in the `engine` instance returned by `create_engine(config)`; two `create_engine` calls produce fully independent engines. Default alias and pricing tables are frozen constants (`Object.freeze`); user overrides flow through `engine_config` or the per-engine `register_*` methods, never via mutation of the defaults.
- **No `require()`.** ESM only. Optional provider packages are loaded via dynamic `import()` with explicit error messages when missing.
- **No `process.env` reads in any package source.** The library never reads environment variables; adapters accept paths and credentials at construction time. Application code reads env and passes values into `create_engine(config)`, adapter factories, or `run_options`. Enforced by `rules/no-process-env-in-core.yml` (scope to be extended to `packages/engine/src/**` and other adapter packages).
- **Limit em dashes** in code comments, docstrings, and user-facing error messages. Prefer commas, colons, or separate sentences. Consistent with `CLAUDE.md`.
- **File naming:** `snake_case.ts`. Dots as sub-namespace separators are permitted where they improve readability (`stash.use.ts`, `stream.buffer.ts`) but flat `snake_case.ts` is the default. Provider adapters live at `packages/engine/src/providers/<provider>.ts` with the bare provider name as the filename.

---

## §3 — Architectural Boundaries

Strict downward dependency direction, modeled as sibling workspace packages:

```
Application code (your harnesses, workflows, agents)
      ↓
fascicle (umbrella; re-exports @robmclarty/core, and @robmclarty/engine when engine ships)
      ↓
@robmclarty/core        (composition layer)
      ↓
@robmclarty/engine      (AI engine layer)
      ↓
Vendor SDKs (Vercel AI SDK v6, zod, provider adapters)

@robmclarty/observability, @robmclarty/stores
  — adapter packages; injected into the composition layer via run_context, never imported by it.
```

No layer may import from a layer above it.

### Composition layer import rules (`@robmclarty/core`)

**May import:**
- `zod` (runtime dependency)
- Node built-ins via `node:` prefix
- sibling files within `packages/core/src/`
- `packages/core/src/types.ts` (the shared type surface: `step`, `run_context`, `trajectory_logger`, `trajectory_event`, `checkpoint_store`) via `import type` only

**May NOT import:**
- `@robmclarty/engine` — the composition layer does not know AI exists
- `@robmclarty/observability` or `@robmclarty/stores` — adapters are injected via `run_context`, never imported by composers
- application-level modules (ridgeline CLI, workflows, flavours, etc.)
- `process.env` directly

### Engine layer import rules (`@robmclarty/engine`)

**May import:**
- `ai` (Vercel AI SDK v6) — via the low-level primitives `generateText` / `streamText`. v6's `Agent` and `ToolLoopAgent` abstractions are **not** imported: the engine owns its tool-call loop (§5.6) and the composition-layer `step()` already owns "configure once, call many." Re-exporting `Agent` would duplicate that surface.
- `@ai-sdk/*` provider packages (dynamically, inside provider adapters only)
- `ai-sdk-ollama` (AI SDK v6-compatible Ollama provider), `@openrouter/ai-sdk-provider`, OpenAI-compatible adapters (dynamically, inside provider adapters only)
- `zod` (v4)
- Node built-ins via `node:` prefix
- sibling files within `packages/engine/src/`
- `@robmclarty/core` via **`import type` only** — for `TrajectoryLogger`, `TrajectoryEvent`, and any other shared types. No value imports from core.

**May NOT import:**
- values from `@robmclarty/core` (composers, runner, describe, errors). The engine does not know `step`, `run_context`, composers, or the runner exist at runtime.
- application-level modules (ridgeline CLI, harness helpers, flavours)
- observability adapters (langfuse, etc.) directly. Observability is surfaced only through the `trajectory` parameter on `generate_options`.
- `process.env`. Anywhere. No exceptions.

### Composers do not import other composers

Each composer file in `packages/core/src/` depends only on `./types.ts`, `./runner.ts`, and the narrow surface of `./streaming.ts` / `./cleanup.ts`. `sequence.ts` does not import `parallel.ts`. `adversarial.ts` does not import `retry.ts`. Sharing is via the `step<i, o>` value contract, not via cross-composer calls. Enforced by `rules/no-composer-cross-import.yml`.

### Runner does not special-case kinds

The runner dispatches on `step.kind` but does not contain composer-specific logic beyond the dispatch. Each composer owns its own execution (children orchestration, span bookkeeping, cleanup registration). A proposed design that requires the runner to "know about" adversarial/ensemble/etc. is a design failure; stop and revise.

### Shared types live inside the composition layer

`step<i, o>`, `run_context`, `trajectory_logger`, `trajectory_event`, `cleanup_fn`, and `checkpoint_store` live in `packages/core/src/types.ts`. `@robmclarty/observability`, `@robmclarty/stores`, and `@robmclarty/engine` `import type` from `@robmclarty/core`. The composition layer owns these types; adapter packages conform to them. This keeps the dependency graph acyclic and gives the composition layer its "deep module" shape — narrow public surface, everything that downstream packages need flowing from a single origin.

If a shared type's shape changes (e.g. `trajectory_logger` gains a method), every dependent package must be updated. This coupling is accepted because trajectory plumbing and run-context plumbing are first-class runtime-contract requirements (§5.3).

### Provider SDKs as optional peers

`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `ai-sdk-ollama`, `@openrouter/ai-sdk-provider`, and any OpenAI-compatible adapter for LM Studio are declared in `@robmclarty/engine`'s `peerDependencies` with `peerDependenciesMeta.<pkg>.optional: true`. The engine `import()`s them on demand inside provider adapters. An app that only uses Anthropic need not install OpenAI packages. Missing peer deps surface as clear errors at `create_engine` time (when the provider entry is configured), not at first `generate` call.

Provider SDK packages may only be imported from files under `packages/engine/src/providers/`. Enforced by ast-grep rule (to be added: `rules/no-provider-sdk-outside-providers.yml`).

### `ProviderAdapter` is a discriminated union

`ProviderAdapter = AiSdkProviderAdapter | SubprocessProviderAdapter`. Each branch surfaces only the methods it can implement:

- `AiSdkProviderAdapter`: `{ kind: 'ai_sdk', name, build_model, translate_effort, normalize_usage, supports }`
- `SubprocessProviderAdapter`: `{ kind: 'subprocess', name, generate, dispose, supports }`

Engine-layer callers narrow on `kind` before using branch-specific methods (`generate.ts` dispatches on it). `AiSdkProviderAdapter` has no `dispose`; the engine-level dispose aggregator skips those adapters. `SubprocessProviderAdapter` must implement `dispose` (see §5.10). The union makes each branch honest about what it can do — "every adapter has every method, unused ones return no-ops" is banned.

### Subprocess provider discipline

Subprocess-backed provider adapters live under `packages/engine/src/providers/<provider>/` (e.g. `claude_cli/`). They observe these boundary rules:

1. **`node:child_process` imports are confined to that provider's directory.** No other engine file, no composition-layer file, no shared type file spawns a subprocess. Enforced by a per-provider ast-grep rule (e.g. `rules/no-child-process-outside-claude-cli.yml`).
2. **No Vercel AI SDK imports inside a subprocess provider directory.** The whole point of a subprocess transport is that it bypasses the HTTP-SDK path. `ai`, `@ai-sdk/*`, `ai-sdk-ollama`, `@openrouter/ai-sdk-provider` are all forbidden there. Enforced by a per-provider ast-grep rule. `zod` (including `z.toJSONSchema()`) is permitted.
3. **No `process.env` reads, no `process.cwd()` reads.** Same project-wide rule (§2). Applications resolve env via `@robmclarty/config` and pass values in.
4. **No shell interpretation.** `spawn` only, `shell: false`, argv array-typed. `child_process.exec` and `execSync` are forbidden.
5. **No module-level mutable state.** Per-adapter live-process registries are captured by closure inside the adapter factory. Two engines have two registries.
6. **External CLI binaries are not npm dependencies.** An external binary (e.g. `claude`) is a runtime system prerequisite like Postgres or ffmpeg. No `peerDependency` entry; missing-binary failures surface at first `generate` call with an install-pointing error.

---

## §4 — Runtime Dependencies

### `@robmclarty/core`

**Direct dependencies:**

| Package | Version | Purpose |
|---|---|---|
| `zod` | ^4.0.0 | schema validation for `suspend` resume_schema and optional step input/output schemas |

**Peer dependencies:** none.

### `@robmclarty/engine`

**Direct dependencies:**

| Package | Version | Purpose |
|---|---|---|
| `ai` | ^6.0.0 | Vercel AI SDK v6 — backing multi-provider abstraction for every model call. `generateText` / `streamText` are the imported primitives |
| `zod` | ^4.0.0 | schema validation for tool inputs and structured output. v4 ships `z.toJSONSchema()` built in |

**Optional provider peers** (in `peerDependencies`, each marked `optional: true` in `peerDependenciesMeta`):

| Package | Provider |
|---|---|
| `@ai-sdk/anthropic` | Anthropic (Claude) |
| `@ai-sdk/openai` | OpenAI |
| `@ai-sdk/google` | Google Gemini |
| `ai-sdk-ollama` (^3, AI SDK v6-compatible) | Ollama (local). Replaces the deprecated `ollama-ai-provider` |
| `@ai-sdk/openai-compatible` | LM Studio and other OpenAI-compatible local servers |
| `@openrouter/ai-sdk-provider` | OpenRouter (multiplexer) |

### Adapter packages

| Package | Direct deps | Peer deps |
|---|---|---|
| `@robmclarty/observability` | `@robmclarty/core` (workspace) | `langfuse` ^3 (optional) |
| `@robmclarty/stores` | `@robmclarty/core` (workspace) | none |
| `fascicle` (umbrella) | `@robmclarty/core` (workspace); `@robmclarty/engine` (workspace) when engine ships | none |

### Dev-only (never `dependencies` or `peerDependencies`)

`typescript` (^6), `vitest` (^4), `@vitest/coverage-v8` (^4), `@types/node` (^24), `tsdown` (^0.21+), `oxlint` (^1.60+), `oxlint-tsgolint`, `@ast-grep/cli` (^0.42+), `fallow` (^2.40+), `cspell`, `markdownlint-cli2`, `@stryker-mutator/core`, `@stryker-mutator/vitest-runner`, `msw` (if used for HTTP mocking in engine tests).

All tooling deps live at the workspace root; a devDependency inside a package is a smell.

### Forbidden across all packages

- HTTP client libraries (the composition layer makes no HTTP calls; the AI SDK handles HTTP for the engine)
- logging libraries (observation flows through `trajectory_logger`, not a global logger)
- retry libraries (retry is the `retry` composer's job at the composition layer; the engine has a narrow built-in retry policy for provider errors only — §5.6)
- AI SDK packages in `@robmclarty/core` — those belong to `@robmclarty/engine`
- ORM / DB / framework packages
- state-management libraries (no ambient state by construction)
- caching libraries (caching belongs to composition-layer `checkpoint`; see §6)
- `pty` libraries (`node-pty`, `pty.js`). Subprocess providers use piped stdio; allocating a PTY complicates sandbox integration.
- Shell interpretation anywhere: `child_process.exec`, `execSync`, `spawn` with `shell: true`, template-interpolated argv strings. Argv injection is not a surface we accept.
- `zod-to-json-schema` as a separate dependency. Zod 4 ships `z.toJSONSchema()` built in.

---

## §5 — Operational Non-Negotiables

These are correctness requirements. "Try to" and "best effort" do not apply.

### §5.1 Cancellation

When `run_context.abort` (or `generate_options.abort` at the engine layer) fires — from SIGINT, SIGTERM, `timeout`, or explicit abort:

1. Every in-flight step receives the abort signal via `ctx.abort`.
2. Every step that performs I/O longer than ~50ms MUST pass `ctx.abort` to that I/O (fetch calls, subprocess spawn, file streams, LLM requests). Enforced by review, with grep-assisted audit of `fetch`/`spawn`/`generateText`/`streamText` call sites.
3. Cancellation propagates down the tree: aborting the root fires all descendant `ctx.abort` simultaneously.
4. The runner installs `SIGINT` and `SIGTERM` handlers by default. Opt-out is `run(flow, input, { install_signal_handlers: false })` for library embedders that manage their own signal stack.

**Engine-specific:** when `generate_options.abort` fires:

1. The HTTP request to the provider is aborted via the AI SDK's `abortSignal` parameter — the underlying TCP socket closes. No further tokens are billed past the disconnect point. For subprocess-backed providers (§5.10), the equivalent is SIGTERM → SIGKILL to the subprocess's process group; the TCP socket the external tool holds closes as a consequence of subprocess exit.
2. The tool-call loop exits at the next loop-iteration boundary check **and** at the per-tool-call boundary inside a turn. For subprocess providers that run their own loop (§5.6), abort is checked at stream-event dispatch boundaries instead.
3. In-flight `tool.execute` calls receive the aborted signal via `tool_exec_context.abort`. Tools that ignore it leak.
4. `generate` rejects with the typed `aborted_error`, never resolves with a partial result. Partial output may still be observed via `on_chunk` before the rejection.
5. `aborted_error` carries `{ reason, step_index, tool_call_in_flight? }` metadata.
6. There is no engine-level timeout option; deadlines belong to the composition layer (wrap an LLM step in `timeout(...)`). Subprocess `startup_timeout_ms` and `stall_timeout_ms` are transport health-checks, not deadline enforcement.

A running harness that leaks subprocesses, file handles, or open LLM calls after termination is incorrect. Agentic workflows make expensive network calls; an uncancelled workflow after `Ctrl+C` drains budget and stalls shutdown.

### §5.2 Cleanup

- `ctx.on_cleanup(fn)` registers a cleanup handler. Handlers run on abort, on uncaught error in the root, and on successful completion.
- Execution order: reverse registration (LIFO).
- Each handler has a 5-second timeout; timeouts are recorded in the trajectory but do NOT block other handlers.
- If a handler throws, the error is recorded as `{ kind: 'cleanup_error', error }` in the trajectory; subsequent handlers still execute.
- **Persisted suspend state has no built-in TTL.** `suspend` writes can outlive the process indefinitely. Application builders are responsible for garbage-collecting stale suspended-run state. The composition layer does not GC.

### §5.3 Trajectory plumbing

Every composer MUST wrap child execution in a `trajectory.start_span` / `end_span` pair reflecting its kind and id. Spans are hierarchical. Errors during a span MUST call `end_span` with `{ error: <message> }`. Silently dropping trajectory events is a bug, not a degraded mode.

Trajectory logging is ambient through `ctx.trajectory` but never a module global. Two concurrent `run(...)` calls log to their own loggers.

**Engine-specific:** when `trajectory` is supplied to `generate`:

- engine opens `start_span('engine.generate', { model, provider, model_id, has_tools, has_schema, streaming })` before the first request
- per-step child span: `start_span('engine.generate.step', { index })` for each assistant turn
- inside each step span, `record(...)` for `request_sent`, `response_received`, and each `tool_call`
- `end_span` with `{ usage, finish_reason }` on success; with `{ error }` on rejection
- `record({ kind: 'cost', step_index, total_usd, ...components })` after each turn that produced a cost
- `record({ kind: 'pricing_missing', provider, model_id })` once per `generate` call when pricing is absent for a non-free provider (deduplicated within the call)
- `record({ kind: 'effort_ignored', model_id })` when `effort` is supplied to a non-reasoning model
- `record({ kind: 'option_ignored', option, provider })` when a caller-supplied option under `GenerateOptions.provider_options` can't be honored by the resolved provider. Emitted at most once per `generate` call per `option` key.
- `record({ kind: 'cost', step_index, source: 'engine_derived' | 'provider_reported', total_usd, ...components })` — the `source` discriminant is mandatory. `engine_derived` marks costs computed from `usage × pricing_table`; `provider_reported` marks costs the provider itself returned (e.g. the Claude CLI's `total_cost_usd` field).
- `record({ kind: 'tool_approval_requested' | 'tool_approval_granted' | 'tool_approval_denied', ... })` for HITL approval flows

Per-token `text` deltas are **not** recorded to trajectory. Streaming consumers observe tokens via `on_chunk`.

### §5.4 Streaming is observational, not a separate code path

- `run.stream(flow, input)` is a secondary composition-layer entry point returning `{ events, result }`. It does not change the step graph.
- **Invariant:** `run(flow, input)` and `run.stream(flow, input)` execute identical step graphs and produce identical final results for the same input.
- At the engine layer, `on_chunk` is the streaming opt-in on `generate_options`. Present → streaming path. Absent → non-streaming path (or streaming with internal accumulation). **Both paths must produce identical `generate_result`** for the same input and model response.
- No `generate_stream` function. Streaming is an options field, not a separate entry point. The engine never returns an `AsyncIterable<partial>` from `generate`; the return type is always `Promise<generate_result<t>>`.
- If `on_chunk` throws (sync) or returns a rejected promise: the engine aborts the in-flight HTTP request, wraps the thrown error in `on_chunk_error`, throws from `generate`, and does not call `on_chunk` again. A misbehaving consumer must not silently continue consuming tokens.
- Chunks are delivered synchronously per provider event (no internal buffering). The consumer is responsible for backpressure; the canonical pattern is to forward into the composition layer's `ctx.emit`.
- Streaming step *return values* (where each yielded chunk is a partial output of the step itself) are out of scope for v1. Every step returns exactly once.
- **Unknown event tolerance.** Stream parsers tolerate unknown event types from the transport. An unknown event is recorded to trajectory (e.g. `{ kind: 'cli_unknown_event', ... }` or the provider's equivalent) and parsing continues. Strict rejection would make every upstream feature release a breaking change.

### §5.5 Introspection

`describe(step)` produces a text tree of the composition. Every composer must expose enough metadata (its config, excluding functions) for `describe` to render a complete tree. Function bodies render as `<fn>`. The tree shape must be stable enough that external renderers (Mermaid, React flow) can consume it.

### §5.6 Tool-call loop (engine)

- When `tools` is non-empty, the engine runs a bounded tool-call loop.
- **Tools execute sequentially** within a turn. Parallel execution is deferred.
- `max_steps` (default 10) caps the loop. On cap hit, the engine resolves with `finish_reason: 'max_steps'` (it does not throw) and includes attempted-but-unexecuted tool calls from the final turn in `tool_calls` with `error: { message: 'max_steps_exceeded_before_execution' }` and no `output`.
- Default `tool_error_policy: 'feed_back'` — `execute` errors are serialized and fed back to the model as a tool result. The model can recover. Under `'throw'`, the error propagates as `tool_error` and ends the call.
- Tool input is validated against `tool.input_schema` **before** `execute` is invoked. Validation failures are fed back to the model as a tool result with `error: true` and consume a step; `execute` is not called.
- HITL: if `tool.needs_approval` is truthy (or the predicate returns true for the proposed input), the engine invokes `generate_options.on_tool_approval` before `execute`. Denial under `feed_back` surfaces as a tool result with `error: { message: 'tool_approval_denied' }`; under `throw`, it throws `tool_approval_denied_error`. **With no `on_tool_approval` handler but `needs_approval` truthy, the engine fails closed** — `tool_approval_denied_error` is thrown before `execute`.
- Abort is checked at the top of each loop iteration **and** before each tool call within a turn. Abort during `on_tool_approval` `await` rejects with `aborted_error`.
- Built-in retry policy covers provider-side failures only: `rate_limit` (429, respects `Retry-After`), `provider_5xx`, `network`. Exponential backoff, configurable via `retry_policy`. Streaming responses are not retried after any chunk has been delivered. Not retried: 4xx other than 429, schema validation failures, tool execution errors, `aborted_error`. For higher-level retry, callers wrap `generate` in composition-layer `retry`.
- Structured output (`schema`) repair: one attempt by default (`schema_repair_attempts: 1`); after exhaustion, throws `schema_validation_error`. The repair turn counts against `max_steps`.
- `effort` parameter maps to provider-specific reasoning config. Non-reasoning providers silently ignore the field and record `{ kind: 'effort_ignored', model_id }` to trajectory. This makes switching models safe.

**Provider-owned tool loops.** Some subprocess-backed providers (notably Claude CLI) run their own tool-call loop inside the external tool. When `adapter.kind === 'subprocess'` and the adapter's `generate` owns the loop, the engine's in-process loop does **not** execute. Consequences:

- `max_steps`, `tool_error_policy`, `on_tool_approval` may be partially or fully ignored by the provider. Every option the resolved provider cannot honor is recorded once per call as `{ kind: 'option_ignored', option, provider }` via trajectory. Silent drop is not acceptable.
- `schema_repair_attempts` is honored by re-issuing a call if the provider supports conversation resumption (otherwise ignored and recorded).
- User-defined `Tool` objects with `execute` closures that cannot be bridged to the provider's loop surface via a `provider_options.<provider>.tool_bridge` setting. Default bridging behavior and loud-failure modes (e.g. `'forbid'` → `provider_capability_error`) are provider-specific, documented in the adapter's spec.
- Abort is checked at transport-dispatch boundaries (stream-event batches) instead of loop iterations.

### §5.7 Cost estimation (engine)

- Cost is computed after each assistant turn from `usage` and the engine's `pricing_table` entry for the resolved `{ provider, model_id }`.
- Per-call total is the sum of per-turn breakdowns.
- Free providers (`ollama`, `lmstudio`) yield a zero-cost breakdown when no pricing entry exists, never `undefined`.
- Other providers with no pricing entry yield `cost: undefined` and a single `pricing_missing` trajectory event per call.
- `cost.is_estimate: true` is permanent; the engine does not claim invoice accuracy. Real billing has edge cases the engine cannot see (regional pricing, batch discounts, tier surcharges, promotional credits, negotiated rates, post-billing tokenizer corrections).
- **Budget enforcement is out of scope.** The engine reports cost; harnesses enforce budgets via trajectory `cost` events.
- **Provider-reported cost.** When a provider returns a cost number in its own output (e.g. Claude CLI's `total_cost_usd`), the engine does **not** consult `pricing_table` for that call. `CostBreakdown.total_usd` is the provider-reported number; per-component decomposition is derived from token proportions and is approximate while `total_usd` is exact. Trajectory `cost` events for such providers carry `source: 'provider_reported'` (per §5.3). `pricing_missing` is never emitted for a provider that reports cost directly. `FREE_PROVIDERS` does not include such providers; the cost is not zero, it just does not come from the local table.

### §5.8 No mutation of caller inputs

`generate_options.tools`, `messages`, `schema`, `pricing` overrides, alias overrides — all are treated as immutable inputs. The engine may copy internally but must not mutate caller state. `list_aliases` and `list_prices` return defensive copies. Composition-layer composers likewise do not mutate their `children` arrays or inbound inputs.

### §5.9 Synchronous abort observation

Checks on `abort.aborted` do not await — they read a boolean. This allows tight loops around tool dispatch or composer iteration without yielding the event loop more than necessary.

### §5.10 Subprocess provider lifecycle

When an adapter is a `SubprocessProviderAdapter`, every spawned child observes:

1. **Detached process group.** `spawn(..., { detached: true })` places the child (and any grandchildren it spawns — sandbox helpers, CLI-invoked tool processes) in a new process group. Signals sent to `-pid` reach the whole group.
2. **Live registry membership.** Every live child is inserted into the adapter's `Set<ChildProcess>` at spawn and removed on the `close` event. The set is closure-captured inside the adapter factory, never module-global.
3. **SIGTERM first, SIGKILL escalator.** On abort, stall, startup timeout, or dispose: `process.kill(-pid, 'SIGTERM')` immediately; after an adapter-defined escalation window (typically 2 seconds), `process.kill(-pid, 'SIGKILL')`. The escalator fires unconditionally; if the child has already exited, the thrown error is caught and ignored.
4. **No orphans on engine dispose.** See §5.11.
5. **No orphans on Node exit.** A `process.on('exit')` handler synchronously issues `process.kill(-pid, 'SIGKILL')` for every live-set member. Node's exit window is synchronous; no `await`, no SIGTERM dance. Missed signals here leak to the OS.
6. **Stdin closed after write.** The prompt is written once and stdin is `end()`-ed.
7. **Explicit env object on every `spawn`.** Never omits `env` to inherit implicitly. Env is built by the adapter's auth module from `ProviderConfig`, not from `process.env`.
8. **Array-typed argv.** Option values are separate argv elements (`['--model', model_id]`), never string-interpolated (`` `--model=${model_id}` ``). Prevents argv injection when a user sets a model string containing a flag.

### §5.11 Engine.dispose contract

`Engine.dispose(): Promise<void>` is universal on every `create_engine` return. Callers never branch on provider identity to decide whether to dispose; the correct pattern is "always call `dispose`, always await it, always in a `finally`".

- The dispose aggregator runs every adapter's `dispose` (where present) in parallel and resolves when all have completed.
- HTTPS-only engines resolve a no-op (the `AiSdkProviderAdapter` branch has no `dispose` and is skipped).
- Subprocess adapters signal every live child per §5.10 and resolve only after every `close` event has fired.
- In-flight `generate` promises reject with `aborted_error({ reason: 'engine_disposed' })`.
- After `engine.dispose()` resolves, further `engine.generate(...)` throws `engine_disposed_error` **synchronously** (caught via plain `try/catch`, not `await`).
- `dispose` is idempotent; a second call returns the same (already-resolved) promise.

---

## §6 — v1 Scope Fence

### Composition layer — in scope

- **The 16 primitives:** `step`, `sequence`, `parallel`, `branch`, `map`, `pipe`, `retry`, `fallback`, `timeout`, `adversarial`, `ensemble`, `tournament`, `consensus`, `checkpoint`, `suspend`, plus `scope` / `stash` / `use` (co-located; count as one named-state facility across three exports).
- The `run(flow, input)` runner and the `run.stream(flow, input)` streaming variant.
- `describe(step)` introspection.
- `SIGINT`/`SIGTERM` cleanup handling with LIFO handler execution.
- Filesystem checkpoint store (default, in `@robmclarty/stores`).
- Filesystem JSONL trajectory logger (default, in `@robmclarty/observability`).
- Streaming observation via `ctx.emit` and `run.stream`, with a bounded event buffer (default high-water mark 10,000).
- A plain YAML representation of the composition tree, validated by a JSON Schema published from `@robmclarty/core` (exported as `flow_schema`). Documentation-only in v1 — not parsed at runtime.

### AI engine layer — in scope

- single `generate(opts)` covering text, structured output, tools, streaming, multi-turn, reasoning effort
- `create_engine(config)` factory + per-engine `register_alias` / `unregister_alias` / `resolve_alias` / `list_aliases`
- per-engine `register_price` / `resolve_price` / `list_prices`
- model alias resolution with `DEFAULT_ALIASES` and user extension; `provider:model_id` colon-bypass form
- providers: Anthropic, OpenAI, Google Gemini, Ollama, LM Studio, OpenRouter (HTTPS via Vercel AI SDK); Claude CLI (subprocess transport; OAuth-first, sandboxable, provider-owned tool loop)
- structured output via `schema: z.ZodSchema<t>` with one repair attempt by default
- tool-call loop with `max_steps` cap, sequential execution, abort propagation
- streaming via `on_chunk` with chunk shape per the engine spec
- cancellation via `abort: AbortSignal` with socket-level close
- trajectory plumbing via optional `trajectory` parameter
- `effort` parameter mapped to provider-specific reasoning config; non-reasoning providers ignore the field with an `effort_ignored` trajectory record
- built-in retry for `rate_limit`, `provider_5xx`, `network` errors with configurable `retry_policy`
- per-call cost estimation in USD with configurable pricing table and `cost_breakdown`; richer decomposition sourced from AI SDK v6's `usage.inputTokenDetails` / `usage.outputTokenDetails` where providers emit them
- human-in-the-loop tool approval via `tool.needs_approval` (passthrough to AI SDK v6's `tool({ needsApproval })`) and an engine-wide `on_tool_approval` hook on `generate_options`; abort honored while awaiting approval
- typed errors (class-based, in `packages/engine/src/errors.ts`)

### Explicitly out of scope (both layers)

- **Browser support.** Separate build target; deferred.
- **Runtime YAML parsing.** The YAML representation is documentation-only in v1. A `.flow.yaml` → TypeScript transpiler may be added later.
- **Visual IDE / Studio.** Out of v1.
- **Pre-built MCP server.** Separate package if built. MCP *client* tools (sourced via AI SDK v6's `createMCPClient` by an external adapter) are still plain `tool` objects and remain usable.
- **Distributed execution as a primitive concern.** A step that makes a network call is just a function; no distribution primitive is needed.
- **Streaming step return values** (where each yielded chunk is a partial output of the step itself). Every step returns exactly once.

### AI engine layer — explicitly out of scope

- **`agent()` / `Agent` / `ToolLoopAgent` factory.** `step()` in the composition layer owns "configure once, call many." AI SDK v6 ships `Agent` and `ToolLoopAgent`; neither is re-exported from the engine.
- **Named variants of `generate`** (`generate_with_tools`, `generate_object`, `generate_stream`). One function, optional fields.
- **AI SDK v6 reranking, image editing, DevTools middleware.** Production observability flows through `trajectory`.
- **Response caching.** A composition-layer `checkpoint` wrapping the LLM step covers this. Engine-level cache deferred until a real cross-step deduplication need appears.
- **Multi-provider request batching.** Provider support varies; deferred.
- **Parallel tool execution within a turn.** Sequential only in v1.
- **Partial result return on abort.** Always throws `aborted_error`; partial output is observable via `on_chunk` only.
- **Runtime provider registration beyond the built-in set.** Not surfaced in v1 public API.
- **Per-token trajectory recording.** Volume concern; deferred behind a debug flag.
- **Streaming reasoning on a separate callback channel.** `stream_chunk` carries `kind: 'reasoning'`; consumers branch on `chunk.kind`.
- **Provider capability negotiation API.** V1 throws `provider_capability_error` on unsupported feature use; richer capability queries deferred.
- **Non-USD currencies.** `currency` is reserved at `'USD'`.
- **`dry_run` cost pre-estimation.** Deferred.
- **Hot-swapping providers mid-call.** Composition-layer `fallback` covers cross-call failover.
- **In-engine budget enforcement.** Cost is reported, not capped.

### Deferred with bar-for-promotion

A feature graduates to in-scope when it appears in at least two unrelated application flows and expressing it without the feature is awkward enough to justify the surface-area cost. Same bar applies to both layers. Composition-layer deferrals are tracked in `packages/core/BACKLOG.md`.

---

## §7 — Architectural Invariants (Mechanically Checkable)

CI must verify each of these. A failing check fails the build.

### Cross-package

1. **No `class` keyword in any `packages/*/src/` file** except the permitted exceptions `packages/core/src/errors.ts` and `packages/engine/src/errors.ts`. Also bans `extends` and `this` in source outside those two files. Enforced by `rules/no-class.yml` (ast-grep) with scoped `ignores:`.
2. **Named exports only.** No `export default` in any package source. Enforced by `rules/no-default-export.yml`.
3. **No `process.env` reads** in any `packages/*/src/` file. Adapter packages accept paths and credentials at construction time; engine config flows through `create_engine(config)`. Enforced by `rules/no-process-env-in-core.yml` (**scope to be extended to cover all `packages/*/src/**` paths**).
4. **snake_case for all exported value symbols and public parameter names.** Type aliases and interfaces remain `PascalCase` (§2). Enforced by `rules/snake-case-exports.yml` (**scope to be extended to all `packages/*/src/**`**).
5. **Every async function performing I/O accepts or closes over an `AbortSignal`.** Manual review gate, with grep-assisted audit of `fetch`, `spawn`, file-stream, `generateText`, `streamText`, and `tool.execute` call sites. I/O that ignores the signal is treated as a bug.

### Composition layer (`@robmclarty/core`)

6. **`zod` is the only production `dependency` in `@robmclarty/core`'s `package.json`.** Enforced by `scripts/check-deps.mjs`.
7. **No file in `packages/core/src/` imports from any adapter package** — `@robmclarty/observability`, `@robmclarty/stores`, `@robmclarty/engine`, or any future adapter. Enforced by `rules/no-adapter-import-from-core.yml`.
8. **No composer imports from another composer.** Each composer depends only on `./types`, `./runner`, `./streaming`, `./cleanup`, and its own siblings within `scope.ts`. Enforced by `rules/no-composer-cross-import.yml`.
9. **Anonymous steps cannot be checkpointed.** Enforced at flow-construction time inside `checkpoint.ts`: `checkpoint(step(fn), ...)` without an id throws synchronously before `run` is ever called.

### AI engine layer (`@robmclarty/engine`)

10. **`ai` and `zod` are the only production `dependencies` in `@robmclarty/engine`'s `package.json`.** All provider SDKs live in `peerDependencies` with `optional: true`. Enforced by an extension to `scripts/check-deps.mjs` (to be added).
11. **No value imports from `@robmclarty/core` in `packages/engine/src/`.** Only `import type { ... } from '@robmclarty/core'` is permitted. The engine never calls composers, the runner, or composition-layer errors at runtime. Enforced by ast-grep rule (to be added: `rules/no-core-value-import-in-engine.yml`).
12. **Provider SDK packages are imported only inside `packages/engine/src/providers/*.ts`.** No file elsewhere in the engine imports `@ai-sdk/*`, `ai-sdk-ollama`, `@openrouter/ai-sdk-provider`, or `@ai-sdk/openai-compatible`. Enforced by ast-grep rule (to be added: `rules/no-provider-sdk-outside-providers.yml`).
13. **`generate` is the sole public entry point for model calls.** No exported function outside `packages/engine/src/generate.ts`, `tool_loop.ts`, or `index.ts` invokes Vercel AI SDK's `generateText`, `streamText`, `streamObject`, or a provider SDK function directly. Manual review gate.
14. **No mutation of `generate_options`, `messages`, `tools`, or `schema`.** Manual review gate; consider an `Object.freeze` debug-mode wrapper for tests.
15. **Defensive-copy invariant for `list_aliases` and `list_prices`.** Test that mutating the returned object does not affect engine state.

### Subprocess provider invariants

Applied once per subprocess provider (e.g. `claude_cli`, future `gemini_cli`):

16. **`node:child_process` imports confined to the provider directory.** Enforced by per-provider ast-grep rule (e.g. `rules/no-child-process-outside-claude-cli.yml`). The rule matches both `'node:child_process'` and the legacy `'child_process'` forms.
17. **No provider-SDK imports (`ai`, `@ai-sdk/*`, `ai-sdk-ollama`, `@openrouter/ai-sdk-provider`) under the subprocess provider directory.** Enforced by per-provider ast-grep rule (e.g. `rules/no-provider-sdk-in-claude-cli.yml`).
18. **Every `spawn` call passes `{ detached: true, stdio: [...] }` explicitly** (never omits `stdio` to inherit). Manual review plus grep audit.
19. **Every `spawn` call passes an explicit `env` object** built by the adapter (never omits `env` to inherit implicitly).
20. **Every `spawn` is paired with a live-registry insert and a `close`-handler remove.** Manual review plus grep audit.
21. **No `shell: true` on any `spawn`, no `child_process.exec`, no `execSync` in adapter sources.** Grep rules.
22. **Argv values are array elements, never string-interpolated.** Manual review; aided by rules 18 and 21.
23. **Subprocess adapter factory returns exactly `{ kind: 'subprocess', name, generate, dispose, supports }`.** No `build_model`, `translate_effort`, or `normalize_usage` members (those live on the `AiSdkProviderAdapter` branch). Type-level.
24. **`Engine.dispose` exists unconditionally** on the return of `create_engine`. Type-level; runtime test configures only HTTPS providers and calls `dispose()` → assert resolved no-op.
25. **Frozen auth-error / error-pattern arrays** in subprocess provider modules (e.g. `CLI_AUTH_ERROR_PATTERNS`) are `Object.freeze`-d at module load. Test: attempt to mutate → asserts throw in strict mode.

---

## §8 — Distribution and Versioning

### Packages

A pnpm workspace publishing five npm packages under the `@robmclarty` scope. Each "layer" from §3 is its own deep module: narrow public surface, substantial internals.

| Package | Directory | Purpose |
|---|---|---|
| `@robmclarty/core` | `packages/core/` | composition layer — 16 primitives, `run`, `run.stream`, `describe`, shared types, typed errors, YAML `flow_schema` |
| `@robmclarty/engine` | `packages/engine/` | AI engine layer — `create_engine`, `generate`, provider routing, alias and pricing tables |
| `@robmclarty/observability` | `packages/observability/` | trajectory logger adapters (filesystem JSONL default; langfuse peer) |
| `@robmclarty/stores` | `packages/stores/` | checkpoint store adapters (filesystem default) |
| `fascicle` | `packages/fascicle/` | umbrella meta-package; re-exports the composition API from `@robmclarty/core`, and (when engine ships) the engine API from `@robmclarty/engine` for single-install users |

- **License:** Apache 2.0.
- **Build:** ESM `.js` + `.d.ts` via `tsdown`, per publishable package. Source maps included. No minification of library output. `tsup` and `unbuild` are not used; `tsdown` is the library-shaped counterpart to `vite build` from the same VoidZero toolchain that backs Vitest.

### Semver

- any change to a composer's exported signature → **major** on `@robmclarty/core`
- adding a new composer → **minor** on `@robmclarty/core`
- adding optional fields to an existing composer's config → **minor**
- any signature change to `generate_options`, `generate_result`, `tool`, or `message` → **major** on `@robmclarty/engine`
- new optional fields on `generate_options`, new `stream_chunk` kinds, new built-in alias entries → **minor** on `@robmclarty/engine` (additive)
- removing or renaming a default alias or pricing entry → **major** on `@robmclarty/engine` (callers depend on keys)
- corrections to default pricing values → **minor** on `@robmclarty/engine` (semantically additive: the previous value was wrong)
- flipping a subprocess provider's default `tool_bridge` (or equivalent behavior switch) → **major** (caller-visible behavior change)
- adding patterns to a frozen error-pattern array (e.g. `CLI_AUTH_ERROR_PATTERNS`) → **minor**; removing → **major**
- internal refactors with no public surface change → **patch**
- layer packages version independently; `fascicle` pins matching minors of the packages it re-exports, and a breaking change in any underlying layer bumps the umbrella correspondingly

---

## §9 — Testing Requirements

- **Runner:** `vitest`. Consistent across every package.
- **Coverage:** every composer has a unit test for its happy path and each documented failure mode. Every happy path and every typed error path in `generate` has a unit test. Failure modes in each build's `spec.md` map to at least one named test in that spec's success criteria.
- **Test location:** unit tests colocate with source under a `__tests__/` subfolder (`foo.ts` ↔ `__tests__/foo.test.ts` in the same directory). Cross-cutting harnesses live under `packages/<name>/test/` (e.g. `packages/core/test/cleanup/` for SIGINT harness, `packages/core/test/integration/` for cross-composer tests, `packages/engine/test/integration/` for cross-layer tests).
- **Mocking:**
  - composition layer: at the step function boundary. Composers under test receive `step(...)` values whose `fn` is a test double. The runner and composers are never mocked.
  - engine layer: at the AI SDK boundary OR at HTTP level via `msw`. The codebase may use either, but a single test file should be consistent.
- **Fixture pricing:** engine test suite uses fixture pricing values, not `DEFAULT_PRICING`. A real-world price update does not churn the suite.
- **No real network in default CI.** Any test that would invoke an LLM is gated behind `RUN_E2E=1` and skipped by default. Prevents cost drift and flaky runs on provider hiccups.
- **Concurrency tests:** `parallel`, `map(concurrency: n)`, `ensemble`, `tournament`, `consensus` each need a test that verifies actual in-flight counts via a shared counter, not just end-state equality.
- **SIGINT / cleanup tests** require a child-process harness (spawn a test script, send SIGINT, assert handler side-effects). Live in `packages/core/test/cleanup/`.
- **Engine cancellation test:** `abort` fires, `generate` rejects with `aborted_error`, underlying mock receives the signal.
- **Engine streaming parity test:** identical `generate_result` whether `on_chunk` is provided or omitted, for the same mocked response.
- **Cross-layer integration test:** an LLM-backed step inside the composition runner with `ctx.abort` and `ctx.trajectory` wired through; SIGINT during the HTTP call triggers the runner's cleanup chain and `generate`'s promise rejects with `aborted_error`.
- **Architectural invariants (§7) run as a pre-test CI step.** If any invariant fails, the test suite does not run.
- **Coverage floor:** 70% lines/functions/branches/statements. Raise it as the codebase matures.

### Subprocess provider tests

- **Mock the external binary** via a shell-script fixture (e.g. `test/fixtures/<provider>/mock_binary.sh`) or a `vi.mock`-wrapped `spawn`. Real external binaries are gated behind `RUN_E2E=1` and skipped by default.
- **Subprocess-leak test.** Spawn N children, abort half, `dispose()` the engine, assert every child has exited (`proc.killed` / `proc.exitCode`), the live registry is empty, and no zombies remain. Runs in CI on every commit.
- **Signal-escalation test.** Fixture child that ignores SIGTERM. Assert SIGTERM delivered first, SIGKILL after the escalation window, child exits, `generate` rejects with `aborted_error`.
- **Post-dispose synchronous throw.** `engine.dispose()` resolves, then `engine.generate(...)` throws `engine_disposed_error` synchronously (caught via `try/catch`, not `await`).
- **Argv-injection audit.** Grep that no option value reaches argv via string interpolation (e.g. `` `--model=${x}` ``). All values must travel as separate argv elements.
- **Auth-scrub test** for providers whose auth mode strips environment variables (e.g. `claude_cli`'s `auth_mode: 'oauth'` strips `ANTHROPIC_API_KEY`). Use a fixture that echoes its environment; assert absent.
- **Cross-layer integration test** for a subprocess-backed step inside the composition runner. SIGINT during the subprocess triggers the runner's cleanup chain; `generate` rejects with `aborted_error`; the subprocess's process group observably receives SIGTERM.

---

## §10 — What This Document Does Not Cover

- exact fields on each composer's config / return shape → `docs/agent-kit-composition-layer-spec.md` §5
- exact fields on `generate_options` / `generate_result` / `tool` / `message` / `stream_chunk` → `docs/agent-kit-ai-engine-layer-spec.md` §5
- alias table entries, pricing entries, env var conventions → engine spec §5.7, §5.10
- semantics of the tool-call loop, streaming chunk shape, alias resolution — detailed behavior → engine spec
- `run_context` field definitions → composition spec §2 / §6
- full failure-mode behavior → each spec's §9
- open questions (DSL parser, deferred composers, cancellation granularity, response caching, pricing freshness) → each spec's §13
- code formatting (indentation, semicolons, line length) → `taste.md`
- rationale for step-as-value, uniform-composer-signature, output-chaining-as-default, single-function `generate`, no-`agent()` at the engine layer, alias-as-data → `taste.md`
- anti-patterns and what "good code" looks like → `taste.md`

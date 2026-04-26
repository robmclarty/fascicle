# Composition Layer — Constraints

**Document:** `constraints.md`
**Sibling documents:** `taste.md` (design philosophy), `spec.md` (functional specification)
**Status:** implementation-ready
**Source spec:** `docs/agent-kit-composition-layer-spec.md`

---

## What a constraint is

A constraint is a non-negotiable: something that, if changed, requires revisiting the entire design. Constraints are the load-bearing walls. They are not opinions about API aesthetics (that belongs in `taste.md`), and they are not interface definitions or behavioral semantics (that belongs in `spec.md`).

This document covers: language and runtime, code style rules a lint or AST check would enforce, architectural boundaries, permitted dependency categories, operational non-negotiables around cancellation and streaming, the v1 scope fence, and distribution and versioning policy. Treat any item here as fixed unless a formal design revision is opened.

---

## Check Command

```bash
pnpm check
```

This is the literal CI gate, defined in `scripts/check.mjs`. It runs the full pipeline: oxlint (+ oxlint-tsgolint), fallow, `tsc --noEmit`, vitest, ast-grep architectural invariant rules, cspell, markdownlint. The source spec specifies `vitest` as the test runner and `strict: true` TypeScript; the invariant checks in §7 below are executed as ast-grep rules inside `pnpm check`.

---

## §1 — Language and Runtime

- **TypeScript:** 6.x with `strict: true`. No looser settings, including in tests. No any-escape hatches on public surface.
- **Compile target:** ES2024 minimum, `lib: ["ES2024"]`. Consumable on Node.js 24 without polyfills.
- **Module format:** ESM only. Source `.ts`, publishes `.js` (ESM) + `.d.ts`. No CommonJS output, no dual-format bundle.
- **Target runtime:** Node.js ≥ 24. No browser support in v1. The composition layer uses `AbortSignal`, `AbortController`, and Node's `process` signal APIs.
- **tsconfig basics:** `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `esModuleInterop: true`, `skipLibCheck: true`, `forceConsistentCasingInFileNames: true`, `isolatedModules: true`, `verbatimModuleSyntax: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- **No browser build in v1.** The runner installs Node-level `SIGINT`/`SIGTERM` handlers by default. Browser support is a separate build target, deferred.

---

## §2 — Code Style (Hard Rules)

Enforced mechanically (AST grep / lint / CI check). Review alone is not sufficient.

- **No `class`.** No `extends`. No `this`. No prototype manipulation. Factory functions return plain objects. Composers are functions that return `step<i, o>`.
  - **Single permitted exception:** `class <name> extends Error` in `packages/core/src/errors.ts` for the typed errors enumerated in §5 of `spec.md` (`timeout_error`, `suspended_error`, `resume_validation_error`, `aborted_error`). Typed errors are conventionally declared this way in Node/TS; `Error` is a built-in, and `instanceof` branching is how composers like `retry` and `fallback` distinguish failure modes. No other file may use `class`.
- **Functional and procedural.** Side effects live at edges (subprocess spawn, file I/O, trajectory calls). No inheritance chains.
- **Naming:**
  - variables, functions, parameters, files → `snake_case`
  - type aliases and interfaces → `PascalCase`
  - module-level constants → `SCREAMING_SNAKE_CASE`
  - **no camelCase** anywhere in source, including parameter names on public types
- **No ambient module-level mutable state.** No singleton registries, no Mastra-style central registry, no module-level `let` that accumulates across calls. All execution state lives in `run_context`, constructed fresh per top-level `run(...)` call. Two concurrent `run(...)` calls share nothing.
- **No `require()`.** ESM only.
- **File naming:** `snake_case.ts`. Dots as sub-namespace separators are permitted where they improve readability (`stash.use.ts`, `stream.buffer.ts`) but flat `snake_case.ts` is the default; see §11 in `spec.md` for the v1 layout.

---

## §3 — Architectural Boundaries

Strict downward dependency direction, modeled as sibling workspace packages:

```
Application code (your harnesses, workflows, agents)
      ↓
@robmclarty/agent-kit (umbrella; re-exports @robmclarty/core)
      ↓
@robmclarty/core        (composition layer — this spec)
      ↓
@robmclarty/engine      (AI engine layer — separate spec)
      ↓
Vendor SDKs (Vercel AI SDK v5+, zod, provider adapters)

@robmclarty/observability, @robmclarty/stores
  — adapter packages; injected into the composition layer via run_context, never imported by it.
```

No layer may import from a layer above it.

### Composition layer import rules

**May import:**
- `zod` (runtime dependency)
- Node built-ins via `node:` prefix
- sibling files within `packages/core/src/`
- `packages/core/src/types.ts` (the composition layer's shared type surface: `step`, `run_context`, `trajectory_logger`, `trajectory_event`, `checkpoint_store`) via `import type` only

**May NOT import:**
- `@robmclarty/engine` — the composition layer does not know AI exists
- `@robmclarty/observability` or `@robmclarty/stores` — adapters are injected via `run_context`, never imported by composers
- application-level modules (ridgeline CLI, workflows, flavours, etc.)
- `process.env` directly. The library never reads environment variables; adapters may, but only if the caller passes `process.env.X` explicitly at adapter construction (see `spec.md` §12)

### Composers do not import other composers

Each composer file in `packages/core/src/` depends only on `./types.ts`, `./runner.ts`, and the narrow surface of `./streaming.ts` / `./cleanup.ts`. `sequence.ts` does not import `parallel.ts`. `adversarial.ts` does not import `retry.ts`. Sharing is via the `step<i, o>` value contract, not via cross-composer calls. This keeps the dependency graph flat and makes individual composers independently testable and replaceable.

### Runner does not special-case kinds

The runner dispatches on `step.kind` but does not contain composer-specific logic beyond the dispatch. Each composer owns its own execution (children orchestration, span bookkeeping, cleanup registration). A proposed design that requires the runner to "know about" adversarial/ensemble/etc. is a design failure; stop and revise.

### Shared types live inside the composition layer

`step<i, o>`, `run_context`, `trajectory_logger`, `trajectory_event`, and `checkpoint_store` live in `packages/core/src/types.ts`. `@robmclarty/observability`, `@robmclarty/stores`, and `@robmclarty/engine` `import type` from `@robmclarty/core`. The composition layer owns these types; adapter packages conform to them. This keeps the dependency graph acyclic and gives the composition layer its "deep module" shape — narrow public surface, everything that downstream packages need flowing from a single origin.

---

## §4 — Runtime Dependencies

**Direct dependencies (in `dependencies`):**

| Package | Version | Purpose |
|---|---|---|
| `zod` | ^4.0.0 | schema validation for `suspend` resume_schema and optional step input/output schemas |

**Dev only (never `dependencies` or `peerDependencies`):**

| Package | Version | Purpose |
|---|---|---|
| `typescript` | ^6.0.0 | compiler |
| `vitest` | ^4.1.0 | test runner |
| `@vitest/coverage-v8` | ^4.1.0 | coverage |
| `@types/node` | ^24.0.0 | Node.js types |
| `tsdown` | ^0.15.0 | ESM bundling with `.d.ts` emission |
| `oxlint` | ^1.60.0 | lint (type-aware via `oxlint-tsgolint`) |
| `@ast-grep/cli` | ^0.42.0 | architectural invariant rules (§7) |
| `fallow` | ^2.40.0 | formatter + lint aggregator |

**Peer dependencies:** none on `@robmclarty/core`. Peers belong on the adapter packages that actually use them:

| Package | Peer | Version | Purpose |
|---|---|---|---|
| `@robmclarty/observability` | `langfuse` | ^3.0.0 | optional langfuse trajectory logger (marked `peerDependenciesMeta.langfuse.optional: true`) |
| (future) `@robmclarty/mcp` | `@modelcontextprotocol/sdk` | ^1.0.0 | MCP server adapter when built |

**Forbidden:**
- HTTP client libraries (the composition layer makes no HTTP calls; steps do)
- logging libraries (observation flows through `trajectory_logger`, not a global logger)
- retry libraries (retry is the `retry` composer's job)
- AI SDK packages — those belong to the AI engine layer, not this one
- ORM / DB / framework packages
- state-management libraries (no ambient state by construction)

---

## §5 — Operational Non-Negotiables

These are correctness requirements. "Try to" and "best effort" do not apply.

### 5.1 Cancellation

When `run_context.abort` fires (from SIGINT, SIGTERM, `timeout`, or explicit abort):

1. Every in-flight step receives the abort signal via its `ctx.abort`.
2. Every step that performs I/O longer than ~50ms MUST pass `ctx.abort` to that I/O (fetch calls, subprocess spawn, file streams, LLM requests). Enforced by review, with grep-assisted audit of `fetch`/`spawn`/`generateText`/`streamText` call sites.
3. Cancellation propagates down the tree: aborting the root fires all descendant `ctx.abort` simultaneously.
4. The runner installs `SIGINT` and `SIGTERM` handlers by default. Opt-out is `run(flow, input, { install_signal_handlers: false })` for library embedders that manage their own signal stack.

A running harness that leaks subprocesses, file handles, or open LLM calls after termination is incorrect. This is the core rationale — agentic workflows make expensive network calls, so an uncancelled workflow after `Ctrl+C` drains budget and stalls shutdown.

### 5.2 Cleanup

- `ctx.on_cleanup(fn)` registers a cleanup handler. Handlers run on abort, on uncaught error in the root, and on successful completion.
- Execution order: reverse registration (LIFO).
- Each handler has a 5-second timeout; timeouts are recorded in the trajectory but do NOT block other handlers.
- If a handler throws, the error is recorded as `{ kind: 'cleanup_error', error }` in the trajectory; subsequent handlers still execute.
- Composer obligations around cleanup are enumerated in `spec.md` §6.
- **Persisted suspend state has no built-in TTL.** `suspend` writes can outlive the process indefinitely. Application builders are responsible for garbage-collecting stale suspended-run state (e.g., a cron task that deletes keys older than N days). The composition layer does not GC. Established durable-workflow systems (Temporal, Inngest, AWS Step Functions) enforce this at their layer; ours does not.

### 5.3 Trajectory plumbing

Every composer MUST wrap child execution in a `trajectory.start_span` / `end_span` pair reflecting its kind and id. Spans are hierarchical. Errors during a span MUST call `end_span` with `{ error: <message> }`. Silently dropping trajectory events is a bug, not a degraded mode.

Trajectory logging is ambient through `ctx.trajectory` but never a module global. Two concurrent `run(...)` calls log to their own loggers.

### 5.4 Streaming is observational, not a separate code path

- `run.stream(flow, input)` is a secondary entry point returning `{ events, result }`. It does not change the step graph.
- Invariant: `run(flow, input)` and `run.stream(flow, input)` execute identical step graphs and produce identical final results for the same input. Streaming is purely observational.
- Composers do not need to know streaming exists. The runner threads events automatically.
- No composer returns a stream; every step returns exactly once. Streaming step *return values* (partial outputs) are out of scope for v1 — see §6.

### 5.5 Introspection

`describe(step)` produces a text tree of the composition. Every composer must expose enough metadata (its config, excluding functions) for `describe` to render a complete tree. Function bodies render as `<fn>`. The tree shape must be stable enough that external renderers (Mermaid, React flow) can consume it.

---

## §6 — v1 Scope Fence

### In scope

- **The 16 primitives:** `step`, `sequence`, `parallel`, `branch`, `map`, `pipe`, `retry`, `fallback`, `timeout`, `adversarial`, `ensemble`, `tournament`, `consensus`, `checkpoint`, `suspend`, plus `scope` / `stash` / `use` (co-located; count as one named-state facility across three exports).
- The `run(flow, input)` runner and the `run.stream(flow, input)` streaming variant.
- `describe(step)` introspection.
- `SIGINT`/`SIGTERM` cleanup handling with LIFO handler execution.
- Filesystem checkpoint store (default).
- Filesystem JSONL trajectory logger (default).
- Streaming observation via `ctx.emit` and `run.stream`, with a bounded event buffer (default high-water mark 10,000).
- A plain YAML representation of the composition tree, validated by a JSON Schema published from `@robmclarty/core` (exported as `flow_schema`; source at `packages/core/src/flow-schema.json`). Documentation-only in v1 — not parsed at runtime.

### Explicitly out of scope

- **The AI engine layer.** `generate`, `create_engine`, provider routing, alias resolution — all specified in a separate document. The composition layer does not know AI exists.
- **Browser support.** Separate build target; deferred.
- **Runtime YAML parsing.** The YAML representation is documentation-only in v1. A `.flow.yaml` → TypeScript transpiler may be added later if real usage demands it.
- **Visual IDE / Studio.** Out of v1.
- **Pre-built MCP server.** Separate package if built.
- **Distributed execution as a primitive concern.** A step that makes a network call is just a function; no distribution primitive is needed in the composition layer.
- **Streaming step return values** (where each yielded chunk is a partial output of the step itself). Every step returns exactly once in v1. If this need appears, it is specified in the engine layer.

### Deferred with bar-for-promotion

Additional composers are deferred and tracked in `packages/core/BACKLOG.md`. Bar for promotion into a future version: "this pattern appeared in two unrelated flows and was awkward to express." None are scoped into v1.

---

## §7 — Architectural Invariants (Mechanically Checkable)

CI must verify each of these. A failing check fails the build.

1. **No `class` keyword in `packages/core/src/` except `errors.ts`.** Enforced by `rules/no-class.yml` (ast-grep) with a scoped exemption for `packages/core/src/errors.ts`. Also bans `extends`, `this` in source outside `errors.ts`. Test files may use `this` only if strictly required — prefer not to.
2. **`zod` is the only production `dependency` in `@robmclarty/core`'s `package.json`.** All others live in `peerDependencies` (with `optional: true`) or `devDependencies`. Enforced by `scripts/check-deps.mjs`, run inside `pnpm check`.
3. **No file in `packages/core/src/` imports from any adapter package** — `@robmclarty/observability`, `@robmclarty/stores`, `@robmclarty/engine`, or any future adapter package. Enforced by `rules/no-adapter-import-from-core.yml` (ast-grep).
4. **No composer imports from another composer.** Each composer file depends only on `./types`, `./runner`, `./streaming`, `./cleanup`, and its own siblings within `scope.ts` (which co-locates `scope` / `stash` / `use` by design). Enforced by `rules/no-composer-cross-import.yml` (ast-grep).
5. **No `process.env` reads in `packages/core/src/`.** Enforced by `rules/no-process-env-in-core.yml` (ast-grep). Adapter packages (`@robmclarty/stores`, `@robmclarty/observability`) may accept paths as arguments but must not read `process.env` directly either.
6. **snake_case for all exported symbols and public type field names.** Enforced by `rules/snake-case-exports.yml` (ast-grep).
7. **Every async function in `packages/core/src/` that performs I/O accepts or closes over an `AbortSignal`.** Manual review gate, with grep-assisted audit of `fetch`, `spawn`, file-stream, and provider call sites. Combined with the `ctx.abort` convention: I/O that ignores the signal is treated as a bug.
8. **Anonymous steps cannot be checkpointed.** Enforced at flow-construction time inside `checkpoint.ts`: `checkpoint(step(fn), ...)` without an id throws synchronously before `run` is ever called. See `spec.md` §9 F6.

---

## §8 — Distribution and Versioning

- **Packages:** a pnpm workspace publishing five npm packages under the `@robmclarty` scope. Each "layer" from §3 is its own deep module: narrow public surface, substantial internals.

  | Package | Directory | Purpose |
  |---|---|---|
  | `@robmclarty/core` | `packages/core/` | the composition layer — 16 primitives, `run`, `run.stream`, `describe`, shared types, typed errors, YAML `flow_schema` |
  | `@robmclarty/engine` | `packages/engine/` | AI engine layer (separate spec) |
  | `@robmclarty/observability` | `packages/observability/` | trajectory logger adapters (filesystem JSONL default; langfuse peer) |
  | `@robmclarty/stores` | `packages/stores/` | checkpoint store adapters (filesystem default) |
  | `@robmclarty/agent-kit` | `packages/agent-kit/` | umbrella meta-package; re-exports the composition API from `@robmclarty/core` for single-install users |

- **License:** Apache 2.0.
- **Semver:**
  - any change to a composer's exported signature → **major** on `@robmclarty/core`
  - adding a new composer → **minor** on `@robmclarty/core`
  - adding optional fields to an existing composer's config → **minor**
  - internal refactors with no public surface change → **patch**
  - layer packages version independently; `@robmclarty/agent-kit` pins matching minors of the packages it re-exports, and a breaking change in any underlying layer bumps the umbrella correspondingly
- **Build:** ESM `.js` + `.d.ts` via `tsdown`, per publishable package. Source maps included. No minification of library output.

---

## §9 — Testing Requirements

- **Runner:** `vitest`. Matches user preference and the engine layer.
- **Coverage:** every composer has a unit test for its happy path and each documented failure mode. Success criteria in `spec.md` §10 enumerate the minimum surface.
- **Mocking:** at the step function boundary. Composers under test receive `step(...)` values whose `fn` is a test double. The runner and composers are never mocked.
- **No real network in default CI.** Any test that would invoke an LLM belongs in the engine layer's suite and is gated there behind `RUN_E2E=1`.
- **Concurrency tests:** `parallel`, `map(concurrency: n)`, `ensemble`, `tournament`, `consensus` each need a test that verifies actual in-flight counts via a shared counter, not just end-state equality.
- **SIGINT / cleanup tests** require a child-process harness (spawn a test script, send SIGINT, assert handler side-effects). These live in `test/cleanup/`.
- **Architectural invariants (§7) run as a pre-test CI step.** If any invariant fails, the test suite does not run.

---

## §10 — What This Document Does Not Cover

- exact fields on each composer's config / return shape → `spec.md` §5
- semantics of the tool-call loop, streaming chunk shape, alias resolution → engine layer's spec (out of scope here)
- the `run_context` field definitions → `spec.md` §2 / §6
- full failure-mode behavior → `spec.md` §9
- open questions (DSL parser, deferred composers, cancellation granularity in agent-pattern composers) → `spec.md` §13
- code formatting (indentation, semicolons, line length) → `taste.md`
- rationale for step-as-value, uniform-composer-signature, output-chaining-as-default → `taste.md`
- anti-patterns and what "good code" looks like → `taste.md`

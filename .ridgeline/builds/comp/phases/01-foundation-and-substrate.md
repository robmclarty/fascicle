# Phase 1: Foundation and Runtime Substrate

## Goal

Stand up the five-package pnpm workspace and land every piece of the composition layer that composers will sit on top of. This phase delivers the shared type surface, the typed error classes, the `step` factory, the runner dispatch skeleton, streaming observation (event buffer with bounded high-water mark and `events_dropped` marker), cancellation plumbing (SIGINT/SIGTERM installation, root `AbortSignal`, cleanup registry with LIFO execution and per-handler timeout), the `describe` tree renderer, and the `flow_schema` JSON Schema export.

The phase also establishes the architectural invariants that every subsequent phase must respect, expressed as ast-grep rules and a dependency-check script: no `class` outside `errors.ts`, no composer cross-imports, no adapter imports from core, no `process.env` reads in core, snake_case for exported symbols, anonymous-step-checkpoint rejection at construction time, and the constraint that `zod` is the only runtime dependency in `@robmclarty/core`. These rules must be authored such that the green-field state passes cleanly and any future violation fails the build loudly.

The exit bar is `pnpm check` exiting 0 on a clean clone. The substrate is independently testable — every test in this phase exercises the runner, streaming, or cleanup against trivial step functions; no composer beyond `step` itself need exist for the substrate to be proven correct.

## Context

The repository already contains the `pnpm check` pipeline (`scripts/check.mjs`) and the workspace tooling. This phase's work consists of creating the `packages/` directory structure, populating `packages/core/src/` with the substrate files enumerated below, declaring the four sibling packages (`engine`, `observability`, `stores`, `agent-kit`) with at minimum a `package.json` so the workspace file structure in spec.md §11 is satisfied, and authoring the ast-grep rules + dependency-check script that lock in the architectural invariants from constraints.md §7.

No composer files (`sequence.ts`, `parallel.ts`, etc.) are written in this phase — only the substrate they will plug into. The `step` factory and the runner's dispatch skeleton are sufficient to exercise the trajectory, streaming, and cleanup machinery against a trivial atomic step.

`@robmclarty/engine` is created in this phase with `package.json` and an empty `src/index.ts` solely to satisfy the workspace shape in spec.md §11. Its full spec is separate; it remains a stub through phases 02, 03, 04, and 05 of this build. No code in this build imports from `@robmclarty/engine` and no subsequent phase's acceptance criteria mention it.

## Acceptance Criteria

1. `pnpm-workspace.yaml` (or equivalent) declares five workspace packages: `@robmclarty/core`, `@robmclarty/engine`, `@robmclarty/observability`, `@robmclarty/stores`, `@robmclarty/agent-kit`. Each has a `package.json` with the correct name, version, and `type: "module"`. `@robmclarty/engine`'s body may be a placeholder (its full spec is separate) but its `package.json` and an empty `src/index.ts` must exist.
2. `packages/core/package.json` declares exactly one entry under `dependencies`: `zod ^4.0.0`. No other entry. `peerDependencies` is absent or empty. Tooling (`typescript`, `vitest`, `@vitest/coverage-v8`, `@types/node`, `tsdown`, `oxlint`, `@ast-grep/cli`, `fallow`) lives in `devDependencies` (root or workspace, per repo convention).
3. The root `tsconfig.json` (which globs `packages/*/src/**/*`) continues to be the sole TypeScript config and already sets `strict: true`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `target: "ES2024"`, `lib: ["ES2024"]`, `esModuleInterop: true`, `skipLibCheck: true`, `forceConsistentCasingInFileNames: true`, `isolatedModules: true`, `verbatimModuleSyntax: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. Do NOT add a per-package `tsconfig.json` in this phase — per AGENTS.md, per-package overrides are added only when a package genuinely needs different behavior.
4. `packages/core/src/types.ts` exports the `step<i, o>` value type, `run_context`, `trajectory_logger`, `trajectory_event`, and `checkpoint_store` interfaces with snake_case field names matching spec.md §2 and §6 exactly.
5. `packages/core/src/errors.ts` is the only source file in `packages/core/src/` containing the `class` keyword. It exports exactly four classes extending `Error`: `timeout_error`, `suspended_error`, `resume_validation_error`, `aborted_error`.
6. `packages/core/src/step.ts` exports the `step()` factory with both forms: named `step(id, fn)` and anonymous `step(fn)`. Anonymous form auto-generates an id of the form `anon_<counter>` and carries an internal flag indicating anonymity (so `checkpoint` can reject it later).
7. `packages/core/src/runner.ts` exports `run(flow, input, ctx?)` and a module-internal `register_kind(kind, fn)` function. The dispatch is a `Map<string, (step, input, ctx) => Promise<unknown>>` populated by each composer file's top-level `register_kind(...)` call. `runner.ts` itself contains no composer-specific logic beyond looking up the entry for `step.kind` and invoking it; an unknown `step.kind` throws a typed error. Adding a new composer means creating a new file that calls `register_kind`; it never means editing `runner.ts`. `run` constructs a fresh `run_context` per top-level call and installs `SIGINT` and `SIGTERM` handlers by default using `process.once`. The handlers are idempotent against double-install. Opt-out is `run(flow, input, { install_signal_handlers: false })`. Constraints §3.3 is thereby enforced mechanically: any `switch` or `if` on `step.kind` inside `runner.ts` is a design failure.
8. `packages/core/src/streaming.ts` exports `run.stream(flow, input)` returning `{ events: AsyncIterable<trajectory_event>, result: Promise<output> }`. The event buffer has a default high-water mark of 10,000. When the consumer never iterates, emissions past the mark drop the oldest events and record a single `{ kind: 'events_dropped', count }` marker. The `result` promise still resolves correctly under buffer pressure.
9. `packages/core/src/cleanup.ts` implements the cleanup registry wired into `run_context.on_cleanup`. Handlers fire in LIFO (reverse registration) order on abort, on uncaught error in the root, and on successful completion. Each handler has a 5-second timeout; timeouts are recorded in the trajectory as `{ kind: 'cleanup_timeout', ... }` but do not block other handlers. A handler that throws is recorded as `{ kind: 'cleanup_error', error }` in the trajectory; subsequent handlers still execute.
10. `packages/core/src/describe.ts` exports `describe(step)` returning a multi-line string with hierarchical indentation; function bodies render as `<fn>`. Calling it on a single `step` produces output covering at least the kind and id.
11. `packages/core/src/flow-schema.json` exists and is re-exported from `packages/core/src/index.ts` as the named constant `flow_schema`. The JSON Schema describes the composer key contracts in spec.md §5.17 (every composer key, the `scope` entry shape, the `ref` cross-flow reference shape, lambdas as strings, function/schema references as strings).
12. `packages/core/src/index.ts` exports the substrate's public surface: `run`, `step`, `describe`, `flow_schema`, all five shared types from `types.ts`, and all four typed errors from `errors.ts`. Composer factory exports are added to this barrel in phases 02–04; the barrel is also where the composer side-effect imports (that trigger `register_kind` at module load time) will live.
13. `packages/agent-kit/src/index.ts` re-exports from `@robmclarty/core` (e.g. `export * from '@robmclarty/core'`). Because `@robmclarty/core`'s exports will grow across phases 02–04, this file's contents are stable and need not be revised.
14. ast-grep rules exist (under `rules/` or the repo's existing rules location) and are invoked by `pnpm check`:
    - `no-class.yml` — bans `class`, `extends`, and `this` in `packages/core/src/` with a scoped exemption for `packages/core/src/errors.ts`.
    - `no-adapter-import-from-core.yml` — bans imports of `@robmclarty/observability`, `@robmclarty/stores`, `@robmclarty/engine`, and `@robmclarty/agent-kit` from any file under `packages/core/src/`.
    - `no-composer-cross-import.yml` — authored to enforce the rule that composer files depend only on `./types`, `./runner`, `./streaming`, `./cleanup`, and their own siblings within co-located facilities. In phase 1 there are no composer files yet, so the rule is in place but matches nothing; phase 02 will exercise it.
    - `no-process-env-in-core.yml` — bans `process.env` reads in `packages/core/src/`.
    - `snake-case-exports.yml` — flags exported symbol names and public type field names that are not snake_case (or PascalCase for type aliases / interfaces).
    - `no-kind-switch-in-runner.yml` — bans `switch` statements and `if`-chains on `step.kind` inside `packages/core/src/runner.ts`. Phase 1's green state satisfies this trivially (runner has no such constructs); phases 02–04 are held to it when composers start registering kinds.
15. `scripts/check-deps.mjs` exists and fails the build if any package other than `zod` appears in `@robmclarty/core`'s `dependencies`.
16. The following automated tests pass under `vitest`:
    - **Atomic step:** `run(step('id', (x) => x + 1), 1)` returns `2` (spec.md §10 criterion 1).
    - **Anonymous id generation:** `step((x) => x).id` matches `/^anon_\d+$/`.
    - **Describe:** `describe(step('s', fn))` returns a string containing `s` and `<fn>`.
    - **Streaming order:** events emitted via `ctx.emit` arrive at the consumer in emission order (criterion 21, substrate portion).
    - **Streaming equivalence:** for a non-trivial substrate-only flow (e.g. a `step` that emits then returns), `run(flow, input)` and the resolved `result` from `run.stream(flow, input)` produce identical final values.
    - **Streaming drop:** a flow that emits 15,000 events with no consumer iteration produces at most 10,000 buffered events plus a single `events_dropped` marker; `result` still resolves (criterion 22).
    - **SIGINT cleanup:** a child-process harness under `packages/core/test/cleanup/` spawns a test script that runs a step performing a slow `fetch` with `ctx.abort` wired and registers a cleanup handler via `ctx.on_cleanup`. Sending SIGINT mid-flight triggers the handler (verified via marker file) and aborts the in-flight fetch (verified via `AbortSignal.reason`). Process exits non-zero (criterion 23).
    - **Cleanup LIFO order:** three handlers registered in order A, B, C fire in order C, B, A on abort (criterion 24).
    - **Cleanup handler error:** first of two handlers throws; second still executes; trajectory contains a `cleanup_error` record (criterion 25).
    - **Abort reason typing — aborted:** a step that inspects `ctx.abort.reason` after an explicit `abort()` sees `instanceof aborted_error`.
    - **Idempotent signal handlers:** calling `run(...)` twice in the same process does not register the SIGINT handler twice (verified by `process.listenerCount('SIGINT')`).
    - **`flow_schema` validates the spec example:** the YAML example in spec.md §5.17 (parsed via any YAML library available in test scope, or transcribed to equivalent JSON in the test) validates successfully against `flow_schema`.
17. Running `pnpm check` from the repo root exits with status 0 on a clean install. The pipeline runs oxlint (+ oxlint-tsgolint), fallow, `tsc --noEmit`, vitest, ast-grep architectural rules, cspell, and markdownlint as defined in `scripts/check.mjs`.

## Spec Reference

- **spec.md §2** — Solution Overview, layer position, primitive inventory, step context (`run_context` field shape).
- **spec.md §5.1** — `step` atomic unit signature.
- **spec.md §5.17** — YAML representation, `flow_schema` JSON Schema contract.
- **spec.md §6.1** — Execution model (recursive dispatch, no framework state, no implicit globals).
- **spec.md §6.2** — Trajectory logging interface and span obligations.
- **spec.md §6.6** — Introspection (`describe`).
- **spec.md §6.7** — Streaming observation channel (events, result, buffer policy with 10,000 high-water mark).
- **spec.md §6.8** — Cancellation and cleanup (SIGINT/SIGTERM installation, abort propagation, cleanup contract, LIFO order, per-handler timeout).
- **spec.md §9** — Failure modes F8 (SIGINT during long-running flow), F9 (cleanup handler throws), F10 (streaming consumer drops the iterator).
- **spec.md §10** — Automated tests 1, 19, 21, 22, 23, 24, 25, 27. Architectural validation bullets (no cross-layer imports, zod as the only runtime dep).
- **spec.md §11** — File structure, particularly `packages/core/src/` substrate files.
- **constraints.md §1** — TypeScript 6.x, `strict: true`, ESM only, Node ≥ 24, tsconfig basics.
- **constraints.md §2** — No `class` outside `errors.ts`, snake_case naming, no ambient module-level mutable state, no `require()`, file naming.
- **constraints.md §3** — Architectural boundaries; composition layer import rules; runner does not special-case kinds; shared types live in `packages/core/src/types.ts`.
- **constraints.md §4** — Runtime dependencies: `zod` only.
- **constraints.md §5.1, §5.2, §5.3, §5.4, §5.5** — Operational non-negotiables: cancellation, cleanup, trajectory plumbing, streaming as observational, introspection.
- **constraints.md §7** — Architectural invariants 1–8 (mechanically checkable).
- **constraints.md §9** — Testing requirements (vitest, SIGINT harness via child-process).
- **taste.md** — Principles 4 (streaming observational), 5 (cancellation mandatory), 6 (no ambient state), 7 (composers do not know about each other), 8 (small public surface).

# Phase 3: Resilience Composers

## Goal

Implement the resilience family of composers on top of the phase 1 substrate and the phase 2 control-flow composers: `retry`, `fallback`, and `timeout`. After this phase, the runner's dispatch registry has eight registered kinds; arbitrary nesting of control-flow and resilience composers works end-to-end; the per-composer cleanup contracts for retry (LIFO cleanup handler accumulation across attempts) and timeout (typed abort reason) are proven by test.

Each composer file lives in its own module under `packages/core/src/`, depends only on `./types`, `./runner`, `./streaming`, `./cleanup`, and registers itself via `register_kind(...)` at module top level. `timeout` passes a composed abort signal (`AbortSignal.any([ctx.abort, timeout_local])`) to its inner step and throws `timeout_error` on expiry; the inner step is responsible for honoring the abort signal. `retry` re-runs its inner with a fresh per-attempt `run_context` but shares the outer `ctx.abort` so a pending abort interrupts the retry loop.

The phase ends with a green `pnpm check`. Agent-pattern, state, and scope composers (phase 04) are not in scope.

## Context

Phases 1 and 2 delivered the substrate, the runner's dispatch registry, the five control-flow composers, and the architectural invariant rules. Every file written in this phase registers itself via `register_kind(...)` and is held to every phase 1 invariant from the moment it is saved.

This phase's composers register themselves with the runner via `register_kind(...)` calls at module top level. `runner.ts` is not modified in this phase. Tests inject in-memory test doubles for `trajectory_logger` directly into `run_context`.

## Acceptance Criteria

1. One file per composer exists under `packages/core/src/`: `retry.ts`, `fallback.ts`, `timeout.ts`. Each calls `register_kind(...)` at module top level.
2. Each composer exports a factory function whose TypeScript signature matches spec.md §5.7 through §5.9 exactly, with snake_case field names.
3. `packages/core/src/index.ts` re-exports each resilience factory and imports each composer file for its registration side effect.
4. The `no-composer-cross-import.yml` ast-grep rule passes: no composer file imports from another composer file.
5. Every composer wraps its child execution in `trajectory.start_span` / `end_span` with its `kind` and `id`. Errors during a span call `end_span` with `{ error: <message> }`. Verified by a span-bookkeeping test per composer.
6. **Tests** pass under vitest:
   - **Retry (criterion 5):** a step that throws twice then succeeds with `max_attempts: 3` returns success on the third attempt. Exponential backoff is observable. `on_error` fires on each failure.
   - **Retry cleanup accumulation (criterion 28, F11):** a retry with `max_attempts: 3` and an inner step that registers one cleanup handler per attempt fires three handlers in LIFO order on completion.
   - **Fallback (criterion 6):** primary throws, backup runs with the same input, output is backup's. A separate test verifies that when both throw, the backup error propagates.
   - **Timeout (criterion 7):** a long-running step wrapped in `timeout(step, 50)` throws `timeout_error` within 100ms.
   - **Timeout abort reason typing (criterion 27):** `timeout(step, 50)` applied to a step that inspects `ctx.abort.reason` after expiry sees `instanceof timeout_error`. A complementary test wraps an explicitly aborted step and sees `instanceof aborted_error`.
   - **Timeout fire-and-forget hazard (F4):** wrap a step that ignores `ctx.abort` with `timeout(step, 100)`; assert `timeout_error` is thrown at ~100ms even though the inner step continues running. The hazard is documented behavior; the test asserts it.
7. Every architectural invariant from phase 1 still passes across the enlarged composer set.
8. Running `pnpm check` from the repo root exits with status 0.

## Spec Reference

- **spec.md §5.7 – §5.9** — Interface definitions for `retry`, `fallback`, `timeout`.
- **spec.md §6.1** — Execution model (recursive dispatch).
- **spec.md §6.2** — Trajectory logging obligations.
- **spec.md §6.8** — Per-composer cleanup and abort obligations: `timeout`, `retry`.
- **spec.md §9** — Failure modes F4 (timeout on a step that ignores ctx.abort), F11 (cleanup handler registered inside a retried step).
- **spec.md §10** — Automated tests 5, 6, 7, 27, 28.
- **constraints.md §3** — Composers do not import other composers.
- **constraints.md §5.1, §5.2** — Cancellation mandatory, cleanup contract.
- **constraints.md §7** — Invariants 1, 4, 6, 8 (re-verified in this phase).
- **taste.md** — Principles 1 (step is a value), 5 (cancellation mandatory), 7 (composers do not know about each other).

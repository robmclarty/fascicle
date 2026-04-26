# Phase 2: Control-Flow Composers

## Goal

Implement the control-flow family of composers on top of the phase 1 substrate: `sequence`, `parallel`, `branch`, `map`, and `pipe`. After this phase, arbitrary nesting of control-flow composers works end-to-end, the runner's dispatch registry has five registered kinds, and the `no-composer-cross-import.yml` ast-grep rule is exercised against real composer files for the first time.

Each composer file lives in its own module under `packages/core/src/`, depends only on `./types`, `./runner`, `./streaming`, `./cleanup`, and wraps child execution in the trajectory `start_span` / `end_span` pair. `parallel` and `map` propagate `ctx.abort` to in-flight children via per-child `AbortSignal.any([ctx.abort, child_local])` composition; on abort the composer awaits all in-flight children before rethrowing `ctx.abort.reason`.

The phase ends with a green `pnpm check`. Resilience composers (phase 03) and agent-pattern / state / scope composers (phase 04) are not in scope.

## Context

Phase 1 delivered the substrate, the runner's dispatch registry (`register_kind`), the architectural invariant rules, and the `pnpm check` gate. Every composer file written in this phase registers itself with the runner via a top-level `register_kind(...)` call and is held to the phase 1 invariants from the moment it is saved: no `class`, no cross-composer imports, no adapter imports, no `process.env` reads, no `switch`/`if` on `step.kind` inside `runner.ts`, snake_case exported symbols.

This phase's composers register themselves with the runner via `register_kind(...)` calls at module top level. `runner.ts` is not modified in this phase. Tests inject in-memory test doubles for `trajectory_logger` directly into `run_context` — no real adapters are imported.

## Acceptance Criteria

1. One file per composer exists under `packages/core/src/`: `sequence.ts`, `parallel.ts`, `branch.ts`, `map.ts`, `pipe.ts`. Each calls `register_kind(...)` at module top level.
2. Each composer exports a factory function whose TypeScript signature matches spec.md §5.2 through §5.6 exactly, with snake_case field names and proper generic inference (chain compatibility for `sequence`, common input for `parallel`, output adaptation for `pipe`).
3. `packages/core/src/index.ts` re-exports each control-flow factory and imports each composer file for its registration side effect.
4. The `no-composer-cross-import.yml` ast-grep rule from phase 1 passes against these new files: no composer file imports from another composer file. Sharing happens only through the `step<i, o>` value contract and the substrate types in `./types`.
5. Every composer wraps its child execution in `trajectory.start_span` / `end_span` with its `kind` and `id`. Errors during a span call `end_span` with `{ error: <message> }`. Verified by a span-bookkeeping test per composer.
6. `parallel` and `map` propagate `ctx.abort` to in-flight children via per-child `AbortSignal.any([ctx.abort, child_local])` composition. On abort the runner awaits all in-flight children (success, failure, or aborted) before returning, then the composer rethrows `ctx.abort.reason`.
7. **Tests** pass under vitest:
   - **Sequence (criterion 2):** three steps adding 1, 2, 3 run in declared order; output is `input + 6`.
   - **Parallel (criterion 3):** two concurrent children with the same input return `{ a, b }` keyed by child name; total elapsed time is less than the sum of individual delays.
   - **Parallel abort propagation (criterion 26, parallel portion):** one child is in-flight when abort fires; both children's `ctx.abort` fire; the runner awaits all before returning; the composer rethrows `ctx.abort.reason`.
   - **Branch (criterion 4):** `when: (x) => x > 0` routes positive inputs to `then`, non-positive to `otherwise`.
   - **Map (criterion 18):** `items: [1, 2, 3, 4, 5]` with `concurrency: 2` never has more than 2 in-flight (verified via a shared in-flight counter inside the per-item step). Output preserves input order.
   - **Map abort propagation:** same shape as the parallel abort test, adapted to `map`'s child population.
   - **Pipe (criterion 17):** output shape adaptation works on a real flow; type-mismatch is caught at compile time via a `// @ts-expect-error` negative test.
   - **Error path (criterion 20):** an error thrown inside a `sequence(branch(step(...)))` carries a `path` property — an array of composer ids from root to the failure point.
8. Every architectural invariant from phase 1 still passes: `no-class.yml`, `no-composer-cross-import.yml`, `no-adapter-import-from-core.yml`, `no-process-env-in-core.yml`, `snake-case-exports.yml`, `no-kind-switch-in-runner.yml`, `check-deps.mjs` (zod still the only runtime dep).
9. Running `pnpm check` from the repo root exits with status 0.

## Spec Reference

- **spec.md §5.2 – §5.6** — Interface definitions for `sequence`, `parallel`, `branch`, `map`, `pipe`.
- **spec.md §6.1** — Execution model (recursive dispatch).
- **spec.md §6.2** — Trajectory logging obligations on every composer.
- **spec.md §6.5** — Error propagation and the `path` property on errors.
- **spec.md §6.8** — Per-composer cleanup and abort obligations for `parallel` and `map(concurrency)`.
- **spec.md §10** — Automated tests 2, 3, 4, 17, 18, 20, 26 (parallel portion).
- **constraints.md §3** — Composers do not import other composers; runner does not special-case kinds.
- **constraints.md §5.1, §5.2** — Cancellation mandatory, cleanup contract.
- **constraints.md §7** — Invariants 1, 4, 6, 8 (re-verified in this phase).
- **constraints.md §9** — Concurrency tests verify actual in-flight counts via a shared counter.
- **taste.md** — Principles 1 (step is a value, composers take/return steps), 3 (readable top-down), 7 (composers do not know about each other).

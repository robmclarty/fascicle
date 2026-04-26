# Phase 4: Agent-Pattern, State, and Scope Composers

## Goal

Complete the composer inventory by implementing the agent-pattern family (`adversarial`, `ensemble`, `tournament`, `consensus`), the state family (`checkpoint`, `suspend`), and the named-state facility (`scope` / `stash` / `use`, co-located in one file). After this phase, the public surface of `@robmclarty/core` exposes all 16 primitives plus the substrate from phase 1, the runner's dispatch registry has all 16 kinds registered, and the uniform-composer-signature invariant is provable end-to-end: every composer takes `step<i, o>` values and returns a `step<i, o>` value, and arbitrary nesting (`retry(adversarial(...))`, `ensemble` used as an `adversarial` `critique`, `checkpoint` wrapping `adversarial`) works without any composer knowing about another.

Each composer file registers itself via `register_kind(...)` at module top level. Concurrency composers (`ensemble`, `tournament`, `consensus`) propagate `ctx.abort` to in-flight children via per-child `AbortSignal.any([ctx.abort, child_local])` composition and await all in-flight children on abort before rethrowing `ctx.abort.reason`. `checkpoint` reads anonymous-step flags at construction time and throws synchronously when wrapping an anonymous inner step (F6). `suspend` throws `suspended_error` on first encounter; `resume` with schema-invalid data throws `resume_validation_error` whose payload is constructed from zod 4's `.flatten()` output.

The phase delivers the full taste.md exemplar flow (`scope` + `stash` + `checkpoint` + `adversarial` + `ensemble` + `pipe` + `use`) and the cross-composer substitutability tests that prove the uniform-composer-signature invariant.

## Context

Phases 1, 2, and 3 delivered the substrate, the runner's dispatch registry, the eight control-flow and resilience composers, and the architectural invariant rules. This phase's composers register themselves with the runner via `register_kind(...)` calls at module top level. `runner.ts` is not modified in this phase. Tests inject in-memory test doubles for `trajectory_logger` and `checkpoint_store` directly into `run_context` — no real adapters are imported.

Anonymous steps from phase 1 carry an internal flag; `checkpoint.ts` reads that flag and throws synchronously at flow-construction time when it sees an anonymous inner step. This is the F6 fail-fast check.

## Acceptance Criteria

1. One file per composer exists under `packages/core/src/`: `adversarial.ts`, `ensemble.ts`, `tournament.ts`, `consensus.ts`, `checkpoint.ts`, `suspend.ts`, and `scope.ts` (co-locating `scope`, `stash`, and `use`). Each calls `register_kind(...)` at module top level.
2. Each composer exports a factory function whose TypeScript signature matches spec.md §5.10 through §5.16 exactly, with snake_case field names.
3. `packages/core/src/index.ts` re-exports every remaining composer factory and `stash` / `use`, and imports each composer file for its registration side effect. After this phase, the public surface of `@robmclarty/core` matches spec.md §11 (the substrate from phase 1 plus all 16 composer exports).
4. The `no-composer-cross-import.yml` ast-grep rule passes: no composer file imports from another composer file. The co-located `scope.ts` is treated as a single module for the purposes of the rule.
5. Every composer wraps its child execution in `trajectory.start_span` / `end_span` with its `kind` and `id`. Errors during a span call `end_span` with `{ error: <message> }`. Verified by a span-bookkeeping test per composer.
6. Every composer that performs concurrent work (`ensemble`, `tournament`, `consensus`) propagates `ctx.abort` to in-flight children via per-child `AbortSignal.any([ctx.abort, child_local])` composition. On abort, the runner awaits all in-flight children before returning, then the composer rethrows `ctx.abort.reason`.
7. **Agent-pattern tests** pass:
   - **Adversarial convergence (criterion 8):** critique accepts on round 2; output shape is `{ converged: true, rounds: 2, candidate }`.
   - **Adversarial non-convergence (criterion 9, F3):** critique always rejects with `max_rounds: 2`; output is `{ converged: false, rounds: 2, candidate: <last_built> }`. Does not throw.
   - **Adversarial round wiring:** `build` on round 2+ receives `{ input, prior, critique }` correctly populated from the prior round's candidate and critique notes.
   - **Ensemble (criterion 10):** three members with `score: (r) => r.n` produce `winner` equal to the highest-`n` result and a complete `scores` map. A separate test verifies `select: 'min'` returns the lowest-scoring result. Tie-breaking is asserted as defined-undefined (any tied result is acceptable).
   - **Tournament (criterion 11):** four members produce a 3-match single-elimination bracket. A complementary test with five members produces a bye record per affected round. `bracket` records carry `{ round, a_id, b_id, winner_id }`.
   - **Consensus (criterion 12):** two members agree on round 2; output is `{ result, converged: true }`. A complementary test with non-converging members and `max_rounds: 2` returns the last result with `converged: false`.
   - **Agent-pattern abort propagation (criterion 26, agent-pattern portion):** `ensemble`, `tournament`, and `consensus` each have a test where one child is in-flight when abort fires; both the in-flight and the queued children receive the abort signal; the runner awaits all before returning; the composer rethrows `ctx.abort.reason`.
8. **State tests** pass:
   - **Checkpoint hit (criterion 13):** the same key run twice does not invoke the inner step's `fn` on the second run (verified via a spy). Result equals the persisted value.
   - **Checkpoint miss (criterion 14):** with no prior result, inner runs and the result is persisted via the injected `checkpoint_store` test double.
   - **Checkpoint corrupted-read-as-miss:** an injected store that returns malformed data on `get` causes the inner to run as if the key were absent, never throws.
   - **Anonymous-step checkpoint (F6):** wrapping `step(fn)` (no id) with `checkpoint` throws synchronously at flow-construction time with the message `checkpoint requires a named step; got anonymous`. The `checkpoint` factory throws before `run` is ever invoked.
   - **Checkpoint key as function:** `key: (i) => \`build:${i.spec_hash}\`` is invoked with the input and the derived key is used.
   - **Suspend first encounter (criterion 15):** first run calls `on(input, ctx)`, throws `suspended_error` carrying run state, and the runner surfaces a suspension sentinel rather than propagating the error.
   - **Suspend resume valid:** resume with schema-valid data invokes `combine(input, resume, ctx)` and returns its result.
   - **Suspend resume invalid (F5):** resume with schema-invalid data throws `resume_validation_error` whose payload is constructed from zod 4's `.flatten()` output (the shape `{ formErrors, fieldErrors }`). `combine` is not called. The run remains in suspended state and a subsequent resume with valid data succeeds.
9. **Scope / stash / use tests** pass:
   - **Scope stash/use (criterion 16):** a `scope` with two `stash` entries and a terminal `use` reads both stashed values via the projection.
   - **Scope chain pass-through:** `stash(key, source)` passes its source's output through as the entry's output, so subsequent steps can chain normally.
   - **Nested scope reads outer state:** an inner `scope` can read outer-scope keys via `use`. The outer scope cannot read inner keys (verified by attempting and observing `undefined` or absent key).
   - **Scope output:** the final output of a `scope` equals the output of its last child.
   - **Stash outside scope (F1):** calling `stash(...)` at the top level (not inside a `scope`) and running it throws a runtime error with the exact message `stash() may only appear inside scope(); got: top-level`.
   - **Use outside scope:** analogous runtime error for `use(...)` at the top level.
10. **Cross-composer substitutability tests** pass (proving the uniform-composer-signature invariant):
    - `retry(adversarial(...), { max_attempts: 2 })` runs the adversarial under retry without any composer needing knowledge of the other.
    - `ensemble` used as the `critique` step inside `adversarial` (per the taste.md exemplar) works; the adversarial loop receives the `critique` result and feeds the `winner` field into its `accept` predicate via a `pipe`.
    - The full taste.md exemplar (`scope` + `stash` + `checkpoint` + `adversarial` + `ensemble` + `pipe` + `use`) constructs without error and runs to completion against test-double `trajectory_logger` and `checkpoint_store`.
11. **Describe tree (criterion 19):** `describe(sample_flow)` produces a multi-line string with correct nesting and at least one entry for every composer kind exercised. `sample_flow` is a composition that touches every composer kind the build has introduced.
12. Every architectural invariant from phase 1 still passes after this phase's additions: `no-class.yml` (no new class declarations outside `errors.ts`), `no-composer-cross-import.yml`, `no-adapter-import-from-core.yml`, `no-process-env-in-core.yml`, `snake-case-exports.yml`, `no-kind-switch-in-runner.yml`, `check-deps.mjs` (zod still the only runtime dep).
13. Running `pnpm check` from the repo root exits with status 0.

## Spec Reference

- **spec.md §5.10 – §5.16** — Interface definitions for `adversarial`, `ensemble`, `tournament`, `consensus`, `checkpoint`, `suspend`, `scope` / `stash` / `use`.
- **spec.md §6.1** — Execution model (recursive dispatch).
- **spec.md §6.2** — Trajectory logging obligations.
- **spec.md §6.3** — Checkpoint store interface (consumed via injected test double in this phase).
- **spec.md §6.4** — Suspend / resume mechanics.
- **spec.md §6.6** — Introspection (`describe`).
- **spec.md §6.8** — Per-composer cleanup and abort obligations: `ensemble` / `tournament` / `consensus`, `suspend`, `checkpoint`.
- **spec.md §9** — Failure modes F1 (stash/use outside scope), F3 (adversarial non-convergence), F5 (suspend resume validation), F6 (anonymous step checkpointed).
- **spec.md §10** — Automated tests 8–16, 19, 26 (agent-pattern portion).
- **constraints.md §3** — Composers do not import other composers; runner does not special-case kinds.
- **constraints.md §5.1, §5.2** — Cancellation mandatory, cleanup contract.
- **constraints.md §7** — Invariants 1, 4, 6, 8 (re-verified in this phase).
- **constraints.md §9** — Concurrency tests verify actual in-flight counts via a shared counter.
- **taste.md** — Principles 1 (step is a value, composers take/return steps), 2 (output chaining default, named state opt-in), 3 (readable top-down), 7 (composers do not know about each other).

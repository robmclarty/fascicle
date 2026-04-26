# Phase 5: Adapters, Umbrella, Examples, and End-to-End Integration

## Goal

Complete the workspace with the two first-party adapter packages (`@robmclarty/observability` and `@robmclarty/stores`), finalize the `@robmclarty/agent-kit` umbrella re-export, deliver the four reference examples enumerated in spec.md §11, write `BACKLOG.md` and the public `README.md` for `@robmclarty/core`, and add integration tests that wire real filesystem-backed adapters into complete flows. The result is the full shippable `v1` workspace described in spec.md §11, with every architectural invariant from phase 1 still passing across the enlarged code surface and the full 28-test success-criteria matrix from spec.md §10 green.

`@robmclarty/observability` ships the default no-op trajectory logger and a filesystem-backed JSONL trajectory logger. `@robmclarty/stores` ships the filesystem-backed JSON checkpoint store, including the all-or-nothing write behavior required by spec.md §6.8 (a write interrupted mid-flush reads as a cache miss on the next `get`, never as corrupted data). Both packages `import type` from `@robmclarty/core` only — no runtime imports — and conform to the `trajectory_logger` and `checkpoint_store` interfaces. Adapters are injected into the composition layer exclusively through `run_context`; no composer in `packages/core/src/` imports them.

`@robmclarty/agent-kit` is the umbrella meta-package. Its `src/index.ts` re-exports the full public surface of `@robmclarty/core` unchanged, so `import { run, step, sequence, adversarial, ensemble, scope, stash, use, checkpoint } from '@robmclarty/agent-kit'` resolves to the core's exports and an application can install a single package to consume the composition API.

The four reference examples (`adversarial_build.ts`, `ensemble_judge.ts`, `streaming_chat.ts`, `suspend_resume.ts`) compile against the library as shipped and serve both as smoke tests and as the canonical forms an LLM reads when asked to write a flow. Integration tests wire real filesystem adapters into flows that exercise: checkpoint persistence across two runs with the same key (second run skips inner execution), JSONL trajectory output containing hierarchical spans matching the composition tree, and the `run` / `run.stream` equivalence invariant against the same adapter set. A separate integration test simulates a crashed checkpoint write (partial file on disk) and asserts the next `get` treats it as a miss.

The phase closes by re-running every architectural invariant authored in phase 1 across the now-enlarged workspace and confirming the full 28-test matrix passes.

## Context

Phase 1 delivered the substrate, architectural invariants, and `pnpm check` gate. Phases 2, 3, and 4 delivered all 16 composers and exhaustive unit coverage against test-double `trajectory_logger` and `checkpoint_store` instances. Adapter packages and the umbrella have empty or placeholder bodies left over from phase 1's workspace declaration.

This phase adds no new composers and no new substrate. It adds: adapter implementations conforming to the type interfaces owned by `@robmclarty/core`; the umbrella's re-exports; example flows; documentation; integration tests using real filesystem backends.

The architectural invariant rules in `rules/` continue to hold the line: any new file must not violate the no-class / no-cross-composer-import / no-adapter-import-from-core / no-process-env-in-core / snake-case-exports rules. The `check-deps.mjs` script continues to enforce that `zod` is the only runtime dependency in `@robmclarty/core`. Adapter packages have their own dependency surface; `langfuse` (where applicable to the optional langfuse trajectory logger) is declared under `peerDependencies` with `peerDependenciesMeta.langfuse.optional: true`.

## Acceptance Criteria

1. `packages/observability/` exists with `package.json` and `src/`. `src/index.ts` re-exports a no-op trajectory logger from `src/noop.ts` and a filesystem JSONL trajectory logger from `src/filesystem.ts`. Both implementations satisfy the `trajectory_logger` interface imported from `@robmclarty/core` via `import type` only. TypeScript settings come from the root `tsconfig.json`; no per-package `tsconfig.json` is added.
2. `packages/observability/package.json` declares `@robmclarty/core` as a dependency (or workspace dependency per the repo's pnpm convention). Any optional integration (e.g. langfuse) lives under `peerDependencies` with `peerDependenciesMeta.<peer>.optional: true`. No file under `packages/observability/src/` reads `process.env` directly; paths are accepted as constructor arguments.
3. The filesystem JSONL trajectory logger's `record`, `start_span`, and `end_span` calls each append a single JSON object on its own line to the configured output file. Hierarchical span ids reflect the composition tree (each `start_span` returns an id; nested spans carry their parent's id in metadata). Concurrent `run(...)` calls log to their own files (per the constructor's path argument); no module-level mutable state is introduced.
4. `packages/stores/` exists with `package.json` and `src/`. `src/index.ts` re-exports a filesystem-backed `checkpoint_store` from `src/filesystem.ts` whose `get`, `set`, and `delete` satisfy the `checkpoint_store` interface from `@robmclarty/core` (via `import type` only). TypeScript settings come from the root `tsconfig.json`; no per-package `tsconfig.json` is added.
5. The filesystem `checkpoint_store`'s `set` is all-or-nothing: writes go to a temporary file and are atomically renamed into place, so an interrupted write never leaves a partially-written file at the target key. On `get`, a missing or unreadable target file (including JSON parse failure) returns `null` — never throws.
6. No file in any adapter package's `src/` reads `process.env` directly. All paths and configuration come through constructor arguments.
7. `packages/agent-kit/src/index.ts` re-exports the full public surface of `@robmclarty/core`: `run`, `describe`, `flow_schema`, every composer factory (`step`, `sequence`, `parallel`, `branch`, `map`, `pipe`, `retry`, `fallback`, `timeout`, `adversarial`, `ensemble`, `tournament`, `consensus`, `checkpoint`, `suspend`, `scope`, `stash`, `use`), every typed error (`timeout_error`, `suspended_error`, `resume_validation_error`, `aborted_error`), and every shared type (`step`, `run_context`, `trajectory_logger`, `trajectory_event`, `checkpoint_store`) as type-only exports.
8. `packages/core/examples/adversarial_build.ts`, `packages/core/examples/ensemble_judge.ts`, `packages/core/examples/streaming_chat.ts`, and `packages/core/examples/suspend_resume.ts` all exist, compile, **and execute** cleanly under `pnpm check`. Execution is verified by `packages/core/test/examples/run_examples.test.ts`, a vitest test that imports each example module and invokes its exported entry (e.g. `run_adversarial_build()`). Each example file exports an async entry function; the file's module top level only defines the flow and the entry. Example bodies use deterministic stub `fn` bodies (no engine layer exists yet, no network, no LLM calls). The test asserts each entry resolves without throwing and that its returned value matches the example's documented output shape. Each example is ~50 lines or fewer — the goal is copy-paste legibility for an LLM or human writing their first flow, not comprehensive feature coverage.
9. `packages/core/BACKLOG.md` exists and contains a curated list of deferred composers per spec.md §13 / constraints.md §6, each with the bar-for-promotion statement: "this pattern appeared in two unrelated flows and was awkward to express."
10. `packages/core/README.md` documents the public surface, the step-as-value thesis (per taste.md principle 1), the 16 primitives with one-line descriptions, the checkpoint-key-namespacing recommendation per spec.md §9 F2, the "don't create circular compositions" warning per spec.md §9 F7, the YAML representation as documentation-only and how to validate against `flow_schema`, and links to the four runnable examples.
11. **Integration tests** in `packages/core/test/integration/` (or an equivalent location) wire real filesystem adapters and assert:
    - **Checkpoint persistence across runs:** a flow with `checkpoint(adversarial(...), { key })` runs once with a fresh filesystem store, then runs a second time with the same store and key, and the second run does not invoke the `adversarial` inner work (verified via a spy or counter). The output of both runs is identical.
    - **Trajectory hierarchy:** a non-trivial composed flow run with the filesystem JSONL logger emits a JSONL file whose span structure (each line a JSON object, with `start_span` / `end_span` pairs and parent-id linkage) reflects the composition tree.
    - **Run / run.stream equivalence:** for the same flow, the same input, and the same adapter set, the final value returned by `run(flow, input)` equals the resolved `result` from `run.stream(flow, input)`.
    - **Crashed checkpoint write:** a partial file at a checkpoint key's expected location (simulating a crashed write) causes the next `get` to return `null` and the flow to execute the inner work fresh.
12. Every architectural invariant from phase 1 still passes across the enlarged workspace:
    - `no-class.yml` — no `class` appears in any `packages/*/src/` file except `packages/core/src/errors.ts`. Adapter packages do not introduce new class declarations.
    - `no-adapter-import-from-core.yml` — no file under `packages/core/src/` imports from `@robmclarty/observability`, `@robmclarty/stores`, `@robmclarty/engine`, or `@robmclarty/agent-kit`.
    - `no-composer-cross-import.yml` — no composer file imports from another composer file.
    - `no-process-env-in-core.yml` — no `process.env` read appears in `packages/core/src/`.
    - `snake-case-exports.yml` — every exported symbol in every package conforms to the naming convention.
    - `check-deps.mjs` — `zod` remains the only runtime dependency in `@robmclarty/core`'s `package.json`.
13. **Audit:** every async function under `packages/core/src/` that performs I/O (fetch, spawn, file streams, future LLM call sites) accepts or closes over an `AbortSignal`. Verified by a grep-assisted review of the full `packages/core/src/` tree (recorded in the phase's PR description or commit message).
14. All 28 automated tests enumerated in spec.md §10 pass.
15. Running `pnpm check` from the repo root exits with status 0.

## Spec Reference

- **spec.md §2** — Layer position; adapter packages sit alongside the composition layer and are injected via `run_context`.
- **spec.md §6.3** — Checkpoint storage interface; default implementation is filesystem-backed JSON; corrupted reads must be treated as cache miss.
- **spec.md §6.7** — Streaming observation channel; the `run` / `run.stream` equivalence invariant is tested against real adapters in this phase.
- **spec.md §6.8** — Composer obligations around cleanup, including the all-or-nothing checkpoint write requirement.
- **spec.md §8** — Dependencies; peer dependency policy on adapter packages (`langfuse` optional on `@robmclarty/observability`).
- **spec.md §9** — Failure modes F2 (checkpoint key collision; documented as intentional global namespace, with namespacing recommendation in README), F7 (circular composition; documented in README).
- **spec.md §10** — Final pass over the full 28-test matrix; architectural validation bullets; learning-outcomes section preserved as commentary in BACKLOG.md or README.md.
- **spec.md §11** — File structure; this phase completes the directory tree under `packages/observability/`, `packages/stores/`, `packages/agent-kit/`, and `packages/core/examples/`, plus `packages/core/BACKLOG.md` and `packages/core/README.md`.
- **spec.md §12** — Environment variables: no package reads `process.env` implicitly; adapter packages accept paths as constructor arguments.
- **spec.md §13** — Open questions, captured in `BACKLOG.md`.
- **constraints.md §3** — Architectural boundaries; adapter packages `import type` from `@robmclarty/core` only.
- **constraints.md §4** — Peer-dependency placement on adapters.
- **constraints.md §6** — v1 scope fence; this phase delivers the in-scope filesystem checkpoint store, filesystem JSONL trajectory logger, and YAML representation as documentation-only with `flow_schema`.
- **constraints.md §7** — Architectural invariants 1, 2, 3, 5, 6 re-verified across the enlarged workspace.
- **constraints.md §8** — Distribution and versioning; five npm packages under the `@robmclarty` scope, Apache 2.0 license, semver policy.
- **constraints.md §9** — Testing requirements; integration tests live in `test/integration/`.
- **taste.md** — Principles 4 (streaming observational), 6 (no ambient state — adapters accept config at construction, not from globals), 7 (composers do not know about each other), 8 (small public surface, deep internal surface; adapters live in sibling packages).

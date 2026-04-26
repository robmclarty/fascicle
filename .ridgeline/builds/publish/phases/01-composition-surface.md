# Phase 1: Composition Surface — describe.json and model_call

## Goal

Extend the umbrella's public API with the two symbols this build adds to the library itself: `describe.json(step)` for structured introspection of composition trees, and `model_call({ engine, model, ... })` as the one sanctioned bridge between the composition and engine layers. Together these are the only net-new source-code additions this build introduces; every subsequent phase is packaging and release ritual.

`describe.json` returns a `FlowNode` tree (kind, id, config, children) alongside the existing text renderer, so external tooling (Studio UI, Mermaid renderers, diff tools) has a first-class machine-readable contract instead of scraping text. It detects cycles: loose mode renders a back-reference placeholder, strict mode throws a new typed `describe_cycle_error`. The existing text form `describe(flow)` remains byte-for-byte unchanged.

`model_call` closes over an `Engine` plus model configuration and returns a `Step<ModelCallInput, GenerateResult>` whose `run` auto-threads `ctx.abort`, `ctx.trajectory`, and (only when `run.stream` is driving) an `on_chunk` forwarder into `ctx.emit`. It normalizes string input, surfaces a legible `{ model, system?, has_tools, has_schema, effort? }` config for `describe` (never the raw engine object), hashes a stable default id when none is supplied, and re-raises the engine's typed errors unchanged. It is the first and only file in the umbrella (`packages/fascicle/src/`) that imports value symbols from both `@repo/core` and `@repo/engine` simultaneously — that invariant is locked mechanically by a new ast-grep rule landed in the same phase.

At the end of this phase the workspace still does not publish anything, but `pnpm check` is green and the umbrella's public surface is final. The bundled artifact built in Phase 2 inherits its v1 shape from the first build.

## Context

This is the foundation phase. The repository is a pnpm workspace with five `@repo/*` internal packages (`core`, `engine`, `observability`, `stores`, `agent-kit` umbrella) plus a root manifest that will eventually publish as `@robmclarty/agent-kit`. Every package is currently `"private": true`. The composition layer (`@repo/core`) exposes 16 primitives, `run`, `run.stream`, `describe`, `flow_schema`, typed errors, and shared types. The engine layer (`@repo/engine`) exposes `create_engine`, `generate`, provider routing, and alias/pricing tables. 493 tests pass today under a green `pnpm check`.

Today, calling `engine.generate` inside a composition-layer step requires a bespoke closure (`step(async (msgs, ctx) => engine.generate({ ...msgs, abort: ctx.abort, trajectory: ctx.trajectory, on_chunk: ... }))`). That plumbing is easy to get wrong (cost events missed, abort forgotten, chunks not forwarded). `model_call` absorbs it into one correct implementation. Today `describe` returns a text tree; tools that need structure re-implement the walk. `describe.json` gives them a stable contract.

Architectural boundaries to respect (from `constraints.md` §3): `@repo/core` never imports value symbols from `@repo/engine`. `@repo/engine` only `import type`s from `@repo/core` (the one value-level carve-out is the shared `aborted_error` re-export, which already exists). The umbrella is permitted to import from both, but the new ast-grep rule restricts that dual value-level import to `model_call.ts` alone.

Spec §4.5 resolves the step-kind question: `model_call` returns a named `step('model_call', fn)` — the outer `kind` stays `'step'` and the composer surfaces its identity via `step.id` and `step.config` rather than by extending `@repo/core`'s step-kind dispatch table.

## Acceptance Criteria

1. `describe.json(flow)` is exposed as a namespace member on the existing `describe` function and shares a single tree walk with the text renderer.
2. `describe.json(flow)` returns a value structurally matching the `FlowNode` TypeScript type for every composer in the 16-primitive set (`step`, `sequence`, `parallel`, `branch`, `map`, `pipe`, `retry`, `fallback`, `timeout`, `adversarial`, `ensemble`, `tournament`, `consensus`, `checkpoint`, `suspend`, `scope`/`stash`/`use`): every node carries `kind` and `id`; composers expose `config` and `children`; leaf steps omit `children`.
3. Function values in step config serialize as `{ kind: '<fn>' }`; zod schemas serialize as `{ kind: '<schema>' }`. No raw function or schema object appears anywhere in the output.
4. A cyclic flow renders its back-reference as `{ kind: '<cycle>', id: '<original-id>' }` under the default (loose) mode. The same input under `describe.json(flow, { strict: true })` and `describe(flow, { strict: true })` throws `describe_cycle_error`.
5. `FlowNode` and `FlowValue` type aliases are exported such that the return value of `describe.json` is assignable to `FlowNode` under `tsc --strict`; a type-level test enforces this and `pnpm check` exits 0.
6. `describe(flow)` (text form) produces byte-identical output to the current implementation for the full existing sample-composer test corpus.
7. `describe_cycle_error` is defined as a typed error consistent with the existing pattern in `packages/core/src/errors.ts` and is re-exported through the umbrella.
8. `model_call<T>(cfg)` exists at the umbrella layer and returns a `Step<ModelCallInput, GenerateResult<T>>` matching the signature in spec §4.2 (readonly config including `engine`, `model`, optional `id`, `system`, `tools`, `schema`, `effort`, `max_steps`, `provider_options`, `retry_policy`, `tool_error_policy`, `schema_repair_attempts`, `on_tool_approval`).
9. The composer returns a named `step('model_call', fn)` whose outer `kind` is `'step'`. Its step id defaults to a stable hash of `{ model, system, has_tools, has_schema }` when `cfg.id` is omitted; an explicit `cfg.id` wins.
10. `run(model_call({ engine, model: 'x' }), 'hi')` against a mock engine whose `generate` returns a canned result: the call succeeds, the mock received `abort: ctx.abort` and `trajectory: ctx.trajectory`, and the returned `GenerateResult` matches the canned payload.
11. With `ctx.abort` pre-aborted at step start, `model_call` raises `aborted_error({ reason: { signal: 'abort' }, step_index: 0 })` before `engine.generate` is invoked; the mock `generate` is never called.
12. An abort that fires mid-call propagates as `aborted_error` from the step, and the engine observes the signal through the forwarded `ctx.abort`.
13. `opts.on_chunk` is wired to forward chunks via `ctx.emit({ kind: 'model_chunk', step_id, chunk })` only when `run.stream` is driving; under plain `run`, `on_chunk` is omitted entirely. Running the same mocked engine response under `run(...)` and `run.stream(...)` yields identical `GenerateResult`.
14. String input is normalized to `[{ role: 'user', content: [{ type: 'text', text }] }]`; a `ReadonlyArray<Message>` input passes through unchanged.
15. `step.config` surfaces `{ model, system?, has_tools, has_schema, effort? }` and never includes the raw `engine` object. `describe(model_call({ engine, model: 'cli-sonnet', system: 'be careful' }))` output contains `model: "cli-sonnet"` and `system: "be careful"` and does not contain the engine instance. `describe.json` of the same composer includes the same config keys plus `has_tools` and `has_schema` as booleans.
16. `model_call` never mutates its `cfg` argument (verified by freezing `cfg` and running the composer), never reads `process.env`, never installs signal handlers, and registers no `ctx.on_cleanup` handler.
17. `model_call` throws only engine-layer typed errors (the full set enumerated in spec §4.7); no new error class is introduced for the composer itself.
18. The umbrella's `packages/fascicle/src/index.ts` re-exports `model_call`, `ModelCallInput`, `ModelCallConfig`, `FlowNode`, `FlowValue`, and `describe_cycle_error` alongside every pre-existing export; the existing `describe` re-export now carries the `describe.json` namespace member. A unit test asserts the full export surface including the 16 composition primitives and `create_engine`.
19. A new ast-grep rule at `rules/model-call-is-sole-bridge.yml` is wired into `pnpm check` and fails when any file under `packages/fascicle/src/**` other than `model_call.ts` imports value symbols from both `@repo/core` and `@repo/engine`.
20. No file in `packages/core/src/` gains a value import of `@repo/engine`; the existing `aborted_error` cross-layer carve-out is the only such reference.
21. Tests 1–9 from spec §10 are implemented as vitest files colocated with sources and pass under `pnpm check`.
22. `pnpm check` exits 0 at phase end. The root `package.json` still reads `"private": true`. No `dist/` directory is produced. No `tsdown.config.ts` exists yet.

## Spec Reference

- §1 (gaps 3 `model_call` bridge, 4 `describe` text-only)
- §2 Solution Overview — core invariant; `model_call` and `describe.json` subsections
- §4 `model_call` Composer — §4.1 file and module, §4.2 signature, §4.3 behavior, §4.4 cost-forwarding and cleanup, §4.5 registering a new step kind (Option 1 decision), §4.6 abort semantics, §4.7 typed errors, §4.8 scope fence
- §5 `describe.json(step)` — §5.1 shape, §5.2 API, §5.3 stability (type-level v1, no ajv), §5.4 circular references
- §7 Architectural invariant — `model_call` is the only file in `packages/fascicle/src/` that imports value symbols from both `@repo/core` and `@repo/engine`
- §10 Success Criteria — automated tests 1–9
- §11 File Structure — `packages/fascicle/src/model_call.ts` (NEW), `packages/fascicle/src/index.ts` edit, `packages/core/src/describe.ts` edit, `packages/core/describe.test.ts` edit, `rules/model-call-is-sole-bridge.yml` (NEW)
- §13 Open questions 3 (stability of `<fn>` / `<schema>` placeholders) and 6 (`describe_cycle_error` scope — stays in `@repo/core` for v1)
- Bootstrap build order — items 1–3

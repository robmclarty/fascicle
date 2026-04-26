# Composition Layer — Taste

**Companion documents:** `constraints.md` (hard non-negotiables), `spec.md` (interface and behavior)
**Source spec:** `docs/agent-kit-composition-layer-spec.md`

Taste is the opinionated shape that lives inside the constraints. Constraints are the walls; spec is the surface area; taste is what the rooms look like. It is why the API is shaped the way it is, what it refuses to become, and what "good code" looks like at a call site. Taste without reasons is dogma; taste with reasons is a guide future-you can apply to novel decisions.

---

## Design Principles

### 1. A step is a plain value. Composers take steps and return steps.

**Rule:** every composable unit is a `step<i, o>` — a plain object with an id, a kind, and an async `run`. Every composer is a function that accepts one or more `step<i, o>` values and returns a single `step<i, o>` value. There is no separate "workflow" type, no graph builder, no DAG class.

**Why:** the uniform composer signature is the load-bearing invariant of the entire layer. It gives substitutability: anywhere a step fits, any composition of steps fits, including arbitrarily deep trees. It gives introspectability: the whole flow is walkable as a tree of plain values. And it gives composability without registration: steps are values, so composing them never requires touching global state.

Break this invariant anywhere and every downstream property breaks with it. A composer that returns a `Flow` or a `Graph` instead of a `step` immediately forces callers to learn two vocabularies; the substitution property is gone and the tree shape fragments. When in doubt, ask: "does this return a `step`?" If no, reshape it.

### 2. Output chaining is the default; named state is opt-in

**Rule:** by default, `sequence` chains outputs directly — step N's output is step N+1's input. When more than one upstream value is needed downstream, wrap in `scope` and use `stash` / `use` to bind names.

**Why:** most real flows are linear, and wiring them linearly is what reads well at a glance. Framework tools that front-load a graph builder (DAG editors, block diagrams with explicit edges) impose ceremony on the common case to accommodate the uncommon case. The opposite trade — plain chaining by default, a named-state escape hatch when you actually need references to non-adjacent values — matches the frequency distribution of real flows.

The subtle consequence: `scope` + `stash` + `use` is a feature to reach for when chaining becomes awkward, not a default to adopt. If your flow works as a `sequence` of steps, write it as one. Open a `scope` only when a later step needs a value that is not the immediate predecessor's output.

### 3. Readable top-down; LLM-writable

**Rule:** a flow should read top-to-bottom like the English description of what happens. Composer names are the vocabulary: `sequence`, `parallel`, `adversarial`, `checkpoint`. Config fields use words (`max_attempts`, `max_rounds`, `when`, `then`, `otherwise`) not acronyms or shorthand.

**Why:** two constituencies read these flows: the human builder skimming for what the system does, and an LLM writing or modifying a flow from a natural-language spec. Both constituencies benefit from the same choices. An LLM generating a flow needs composer names and field names that are self-documenting; the LLM does not have access to hovered-type-tooltip context. A human reader skimming a 12-step flow needs to understand structure without reading function bodies.

The YAML representation in §5.17 of `spec.md` exists primarily for this: it is the shape an LLM writes into when asked to produce a flow from a spec, and the shape a human reads to understand a flow at a glance. It is not a runtime format in v1; it is a documentation and prompt shape.

### 4. Streaming is observational, not a separate code path

**Rule:** `run(flow, input)` and `run.stream(flow, input)` execute identical step graphs and produce identical final results for the same input. Streaming is enabled by iterating `events`; omitting the iteration simply buffers (to a bounded high-water mark) and then discards.

**Why:** if streaming were a separate code path — a `stream_flow` primitive, a `StreamingStep` class, separate composers for "stream-aware" flows — callers would branch on whether they need events, write two code paths, and maintain the invariant themselves. The bug surface explodes: now you have to test that the streaming and non-streaming paths produce the same result, because someone will naturally write them differently.

The solution is to make there be only one path. Composers do not know streaming exists. The runner threads events through the trajectory logger automatically. Consumers filter by `span_id` or `kind`. The invariant stays in the engine's hands, not every caller's.

### 5. Cancellation is mandatory, not optional

**Rule:** every I/O operation over roughly 50ms must accept or close over `ctx.abort`. Passing `ctx.abort` to `fetch`, `spawn`, file streams, and LLM requests is the baseline; ignoring it is a bug.

**Why:** agentic workflows make expensive network calls. A running flow that does not honor `SIGINT` consumes tokens after `Ctrl+C`, holds file descriptors, and stalls shutdown. The cost of a single unhandled abort is real dollars and real latency. The composition layer is designed around traceable, cancellable execution; violating that at the step level silently undoes half the architectural work.

`ctx.on_cleanup` is the partner rule: anything that would survive a crash (a spawned subprocess, an open connection, a pending write) registers a cleanup handler. The runner guarantees LIFO execution on abort, on uncaught error, and on successful completion. One handler that throws does not block the rest. The net effect: a correct step always releases its resources, no matter how its parent flow terminates.

### 6. No ambient state. No registries. No classes.

**Rule:** no module-level mutable state. No `Mastra`-style central registry. No singleton trajectory logger. No `Workflow.register()`. Composers are functions; steps are values; context is injected per-call.

**Why:** ambient state couples unrelated flows. Two concurrent tests that share a registry can interfere. An app that imports a library with a global logger can have its logs polluted by the library's internals. A class that must be `new`'d before use leaks instantiation ceremony into every call site. Each of these has a corresponding "no" in the spec, and each "no" defends the same property: two flows that do not share a composer value should not share any state.

The no-class rule has one exception: typed errors in `packages/core/src/errors.ts` (`timeout_error`, `suspended_error`, `resume_validation_error`, `aborted_error`) extend `Error`, because `Error` is a built-in and `instanceof` branching is how `retry` and `fallback` distinguish failure modes. Every other structure is a plain object. A tool of that shape composes trivially — spread, filter, map, build with a factory if you want one. A class does not.

### 7. Composers do not know about each other

**Rule:** each composer file in `packages/core/src/` depends only on `./types` and `./runner` (plus its own siblings within co-located facilities like `scope`). `sequence.ts` does not import `parallel.ts`. `adversarial.ts` does not import `retry.ts`. Sharing happens through the `step<i, o>` value contract, not through cross-composer calls.

**Why:** the flat dependency graph makes each composer independently testable and independently replaceable. If `ensemble` turns out to be redundant with a user-land pattern, it can be deleted without ripples. If a new composer is added, existing composers are not a risk surface. The runner is the only code that knows the full cast of composer kinds, and it only knows them through a dispatch — never through behavior.

This is why `retry(adversarial(...))` is easy and clean: `retry` treats `adversarial` as any other step; it has no special case for the build-and-critique loop. Nested patterns that would otherwise require framework awareness compose for free.

### 8. Small public surface, deep internal surface

**Rule:** the public API of `@robmclarty/core` is the 16 primitives, `run`, `describe`, shared types, typed errors, and `flow_schema`. Adapters (filesystem checkpoint store, filesystem trajectory logger, langfuse, MCP) live in sibling packages (`@robmclarty/stores`, `@robmclarty/observability`, future `@robmclarty/mcp`). Internal helpers — span bookkeeping, event buffering, cleanup registry, alias resolution — are not exported.

**Why:** a small public surface is a small seam. If `resolve_alias` or `build_event_buffer` were exported, callers would use them, and every usage becomes a coupling point that cannot be changed without a major bump. The goal is that an application step imports `run` and a handful of composers, and nothing else. That is what makes rewrites cheap: if the backing implementation changes (a different event buffer strategy, a different cleanup queue), nothing user-visible changes.

The corollary: adapters go in sibling packages, not the root of `@robmclarty/core`. A user who only needs in-memory trajectory depends on nothing from `@robmclarty/observability`. A user who wants langfuse adds `@robmclarty/observability` + the `langfuse` peer. The cost of optional capabilities is strictly opt-in — and modeled as deep modules, not subpath exports.

---

## What This Rules Out

**Graph builders.** No `new Workflow()`, no `wf.addNode(...)`, no `wf.addEdge(...)`. Flows are trees of composer values. A DAG builder is a different primitive — and users who truly need DAGs can build a composer that returns a step whose `run` executes a DAG. The composition layer does not ship one.

**Registries.** No `agent_registry.register(...)`, no `Workflow.get('name')`. Flows are values that live in the modules that define them. Sharing is via `import`, not via a global table.

**`Workflow` class, `Agent` class, `Step` class.** No `extends`, no `this`, no inheritance chains. Factories return plain objects. The only class in the codebase is `Error` subclasses in `errors.ts`.

**Ambient configuration.** No `agent_kit.configure({ default_checkpoint: 'filesystem' })`. Configuration is per-`run` via the injected context, or per-adapter at construction. Two concurrent tests configure their own contexts and do not interfere.

**Hidden retry inside composers.** `retry` is the one retry primitive. Composers that quietly retry on internal failure (provider rate limits, network errors) create two retry systems that interact unpredictably. Typed errors surface; callers wrap in `retry(...)` when they want it.

**Hidden response caching.** Caching belongs in a `checkpoint` wrapping the step that makes the call. Putting caching inside a composer or the runner creates invisible behavior. Checkpoint keys are data; caching decisions are the caller's.

**Streaming as a second vocabulary.** No `stream_sequence`, no `StreamingStep`, no `generator_step`. `run.stream` is an observation mode; every step still returns exactly once.

**Composer-specific abort strategies.** `ensemble`, `tournament`, `consensus` cancel all in-flight children on abort. Letting one fast-returning child "win" and cancelling siblings is deferred (see `spec.md` §13.3) — not rejected, but not decided without a use case. The default is simple and consistent across agent-pattern composers.

---

## What Good Code Looks Like

A flow that exercises most of the surface, reading top-to-bottom:

```typescript
import { step, scope, stash, use, checkpoint, adversarial, ensemble, pipe } from '@robmclarty/agent-kit'
import { run } from '@robmclarty/agent-kit'

const multi_judge = ensemble({
  members: {
    opus:   step('judge_opus',   judge_opus_fn),
    sonnet: step('judge_sonnet', judge_sonnet_fn),
    gemini: step('judge_gemini', judge_gemini_fn),
  },
  score: (r) => r.confidence,
})

const build_and_ship = scope([
  stash('plan', step('plan', plan_fn)),
  stash('build', checkpoint(
    adversarial({
      build: step('build', build_fn),
      critique: pipe(multi_judge, (r) => r.winner),
      accept: (r) => r.verdict === 'pass',
      max_rounds: 3,
    }),
    { key: (i) => `build:${i.spec_hash}` },
  )),
  use(['build'], ({ build }) => deploy_fn(build.candidate)),
])

await run(build_and_ship, { spec_hash: 'abc123', brief: '...' })
```

Observations:
- every line is a composer or a step. No glue, no event wiring, no handles.
- `scope` + `stash` + `use` appears because `deploy_fn` needs the build result from two steps back, not the immediate predecessor. That is the job these primitives exist for.
- `checkpoint` wraps the expensive `adversarial` loop with a content-addressed key. Resuming the flow with the same input hits the cache; a different spec regenerates.
- `ensemble` is used as the `critique` step of `adversarial` without either composer knowing about the other. The `step<i, o>` value contract is the entire interface between them.

A minimal flow when the full surface is overkill:

```typescript
const draft = sequence([
  step('outline', outline_fn),
  step('expand',  expand_fn),
  step('polish',  polish_fn),
])
```

Three steps chained directly. No `scope`, no named state. This is the common case, and it reads like the task description.

A streaming step that surfaces tokens to the outer run:

```typescript
step('draft', async (input, ctx) => {
  const { content } = await generate({
    model: 'claude-sonnet',
    prompt: input.brief,
    abort: ctx.abort,
    trajectory: ctx.trajectory,
    on_chunk: (chunk) => ctx.emit({ kind: 'token', text: chunk.text }),
  })
  return content
})
```

The step does not know whether the outer runner was called as `run` or `run.stream`. It wires `ctx.abort` to the engine's abort, `ctx.trajectory` to tracing, and `ctx.emit` to streaming. The streaming invariant propagates for free.

---

## Carry-Over to the Engine Layer

These decisions are propagated downward to the AI engine layer (sibling spec) and must not be violated there:

- **Substitutability.** A step that calls `generate` must be substitutable with any other step of compatible I/O type. The engine layer must not require a step to register itself, acquire a handle, or initialize framework state. `generate` is a plain async function call.
- **No globals.** The engine's alias table is data, not a registry. Trajectory loggers are not ambient. `create_engine(overrides)` returns a `generate` function bound to a configuration — no ambient singletons.
- **Readable top-down.** The engine's `generate_options` object is self-documenting: `model`, `prompt`, `system`, `schema`, `tools`, `abort`, `trajectory`. A reviewer skimming a step should understand the call without reading engine internals.
- **LLM-writable.** Step authors need `generate_options` and `generate_result`, both small and stable. Everything about provider resolution and HTTP plumbing is below the LLM's horizon.
- **Cancellation is mandatory.** Every step that calls `generate` must pass `ctx.abort`. Enforced by review and by this document. A model call is always I/O.

# Composition Layer — Specification

**Status:** implementation-ready
**Package:** `@robmclarty/agent-kit` (working name; final name TBD)
**Sibling documents:** `constraints.md` (hard non-negotiables), `taste.md` (design philosophy)
**Source spec:** `docs/agent-kit-composition-layer-spec.md`
**Scope:** the composition layer only. The AI engine layer (model calls, tool invocation, provider routing) is specified separately and sits underneath this layer.

---

## §1 — Problem Statement

Builders of agentic systems in TypeScript face a false choice between two failure modes:

1. **Framework lock-in.** Adopting a batteries-included framework (Mastra, LangGraph, etc.) means inheriting its class hierarchies, its registry pattern, its graph abstractions, and its opinionated runtime. Switching agent patterns or orchestration backends later means a rewrite.

2. **Wiring fatigue.** Building from scratch with only the AI SDK means rewriting retry, checkpoint, ensemble, and adversarial-review patterns in every project. These patterns are small individually, but the glue code accumulates and drifts between projects.

The builder needs a thin, owned composition layer that provides the common agent-orchestration patterns as values that compose freely, without imposing a framework. The composition must be:

- **Readable top-down** at a glance, even for flows with a dozen steps.
- **Uniformly substitutable:** anywhere a step fits, any composition of steps fits.
- **Introspectable** as a tree of plain values (for tracing, spec generation, UI rendering).
- **Easy for LLMs to write and modify** with minimal framework-specific knowledge.

Strategic motivation: this layer is the foundation for multiple downstream projects (a personal long-horizon coding harness, edtech workflows under compliance constraints, a personal external-memory system). Owning it means the same primitives power all of them, and reconfiguring a workflow never requires rewiring an application.

---

## §2 — Solution Overview

### Core insight

Every composable unit is a `step`. A step is a plain object with an id, a kind, and an async `run` function. **Composers take steps and return steps.** There is no separate notion of "workflow"; a workflow is simply a step whose `run` dispatches to child steps. The recursion is uniform.

This single invariant produces every desirable property:

- **Substitutability:** any step can be replaced with any other step of compatible input/output type.
- **Introspectability:** the full flow is a tree that can be walked.
- **Composability without registration:** steps are values, not registered entities. No global state, no coupling between unrelated flows.

### Layer position

```
┌─────────────────────────────────────────────────────────────┐
│  Application code (your harnesses, workflows, agents)      │
├─────────────────────────────────────────────────────────────┤
│  Composition layer (this spec)                              │
│    primitives: step, sequence, parallel, branch, map, pipe, │
│                retry, fallback, timeout, adversarial,       │
│                ensemble, tournament, consensus,             │
│                checkpoint, suspend, scope/stash/use         │
│    runner:     run(flow, input) → output                    │
│    streaming:  run.stream(flow, input) → { events, result } │
├─────────────────────────────────────────────────────────────┤
│  AI engine layer (separate spec)                            │
│    generate, create_engine, alias resolution,               │
│    provider routing, tool-call loop                         │
├─────────────────────────────────────────────────────────────┤
│  Vendor SDKs (Vercel AI SDK v5+, provider adapters, zod)    │
└─────────────────────────────────────────────────────────────┘
```

The composition layer does not know that AI exists. It orchestrates async functions. The AI engine layer sits underneath and provides the `generate(...)` function that application steps call. This separation is the core architectural commitment.

### Primitive inventory

Sixteen primitives, organized by role:

- **Atomic (1):** `step`.
- **Control flow (5):** `sequence`, `parallel`, `branch`, `map`, `pipe`.
- **Resilience (3):** `retry`, `fallback`, `timeout`.
- **Agent patterns (4):** `adversarial`, `ensemble`, `tournament`, `consensus`.
- **State (2):** `checkpoint`, `suspend`.
- **Named scopes (3 exports, one facility):** `scope`, `stash`, `use`.

No others are part of the spec. Additions are deferred (§13).

### Data flow model

**Default:** sequential steps chain outputs directly. The output of step N is the input to step N+1. No explicit wiring.

**When you need named references:** wrap in a `scope`. Inside a scope, `stash("key", step)` runs the step and binds its output to `key` in a scope-local state map. `use(["key"], fn)` reads named values out of the state map. Scopes nest; inner scopes see outer state but not vice versa.

**Across composer boundaries:** each composer defines what its children receive. `adversarial` passes `{ input, prior?, critique? }` to its builder. Details in §5.

### Step context (`run_context`)

Every step's `run` receives `(input, ctx)`. The context is ambient and rarely used directly:

```typescript
type run_context = {
  run_id: string
  trajectory: trajectory_logger
  state: ReadonlyMap<string, unknown>     // scope state; read via `use`, not directly
  parent_span_id?: string
  abort: AbortSignal                      // fires on SIGINT, SIGTERM, timeout, or explicit abort
  emit: (event: Record<string, unknown>) => void  // streaming progress shortcut
  on_cleanup: (fn: () => Promise<void> | void) => void  // register resource release
}
```

Steps treat `ctx` as opaque unless they need:
- `ctx.abort` to cancel long-running I/O (mandatory for any operation over ~50ms; see `constraints.md` §5.1).
- `ctx.emit` to surface streaming progress to observers.
- `ctx.on_cleanup` to register resource release (subprocess kills, file handle closes, connection teardown).
- `ctx.state` if implementing a custom scope-aware composer (normally `use` handles this).

---

## §5 — Interface Definitions

Each primitive is defined below in both TypeScript signature form and in YAML shorthand. The YAML form is specified formally in §5.17.

### §5.1 `step` — atomic unit

```typescript
step<i, o>(
  id: string,
  fn: (input: i, ctx: run_context) => Promise<o> | o,
): step<i, o>
```

```yaml
step:
  id: <id>       # optional; anonymous form auto-generates
  fn: <function_ref>
```

**Semantics:** wraps a function as a step. `id` is local to the enclosing composer tree, used for trajectory spans and describe output. Step ids need not be globally unique. An anonymous form (`step(fn)`) auto-generates an id of the form `anon_<counter>`; anonymous steps cannot be checkpointed (enforced at flow construction — see §9 F6).

---

### §5.2 `sequence` — chain outputs

```typescript
sequence<steps extends step<any, any>[]>(
  steps: steps,
): step<first_input<steps>, last_output<steps>>
```

```yaml
sequence:
  - <node_1>
  - <node_2>
  - <node_n>
```

**Semantics:** runs steps in declared order. Input to `sequence` is passed to the first step. Each subsequent step receives the previous step's output. Return value is the last step's output. Type system enforces chain compatibility.

---

### §5.3 `parallel` — concurrent execution

```typescript
parallel<steps extends Record<string, step<any, any>>>(
  steps: steps,
): step<common_input<steps>, { [k in keyof steps]: output_of<steps[k]> }>
```

```yaml
parallel:
  <key_1>: <node_1>
  <key_2>: <node_2>
```

**Semantics:** runs all children concurrently with the same input. Output is an object keyed by the child names. All children must accept the same input type.

---

### §5.4 `branch` — conditional

```typescript
branch<i, o>(config: {
  when: (input: i) => boolean | Promise<boolean>
  then: step<i, o>
  otherwise: step<i, o>
}): step<i, o>
```

```yaml
branch:
  when: <lambda>
  then: <node>
  otherwise: <node>
```

**Semantics:** evaluates `when(input)`. If true, runs `then`; else `otherwise`. Both branches must return the same output type.

---

### §5.5 `map` — per-item

```typescript
map<item, result>(config: {
  items: (input: any) => item[] | Promise<item[]>
  do: step<item, result>
  concurrency?: number  // default: unbounded
}): step<any, result[]>
```

```yaml
map:
  items: <lambda>
  do: <node>
  concurrency: <n>   # optional
```

**Semantics:** extracts an array via `items(input)`, runs `do` once per element. `concurrency` caps parallel execution; omitted means full parallelism. Output is an array in the same order as inputs.

---

### §5.6 `pipe` — transform output

```typescript
pipe<i, a, b>(
  inner: step<i, a>,
  fn: (a: a) => b | Promise<b>,
): step<i, b>
```

```yaml
pipe:
  of: <node>
  fn: <lambda>
```

**Semantics:** runs `inner`, passes its output to `fn`, returns `fn`'s result. Use for shape adaptation when composing heterogeneous steps.

---

### §5.7 `retry` — retry on failure

```typescript
retry<i, o>(
  inner: step<i, o>,
  config: {
    max_attempts: number
    backoff_ms?: number          // default: 1000
    on_error?: (err: unknown, attempt: number) => void
  },
): step<i, o>
```

```yaml
retry:
  do: <node>
  max_attempts: <n>
  backoff_ms: <ms>   # optional
```

**Semantics:** runs `inner`. If it throws, retries up to `max_attempts - 1` more times with exponential backoff (`backoff_ms * 2^(attempt-1)`). `on_error` is called on every failure. Re-throws the last error if all attempts fail.

---

### §5.8 `fallback` — primary-or-backup

```typescript
fallback<i, o>(primary: step<i, o>, backup: step<i, o>): step<i, o>
```

```yaml
fallback:
  primary: <node>
  backup: <node>
```

**Semantics:** runs `primary`. If it throws, runs `backup` with the same input. If `backup` also throws, the `backup` error propagates.

---

### §5.9 `timeout` — bound execution

```typescript
timeout<i, o>(inner: step<i, o>, ms: number): step<i, o>
```

```yaml
timeout:
  do: <node>
  ms: <ms>
```

**Semantics:** runs `inner` with its `ctx.abort` replaced by `AbortSignal.any([parent_ctx.abort, AbortSignal.timeout(ms)])`. When the timeout fires, the composed signal's `reason` is a `timeout_error` instance — inner steps that inspect `ctx.abort.reason` can distinguish timeout from parent abort by `instanceof timeout_error`. If the step does not complete in time, the composer throws `timeout_error`. The inner step is responsible for honoring `ctx.abort` — a step that ignores the signal continues running in the background (known hazard; see §9 F4). Nested timeouts are independent: each fires on its own schedule.

---

### §5.10 `adversarial` — build and critique loop

```typescript
adversarial<input, candidate>(config: {
  build: step<{ input: input; prior?: candidate; critique?: string }, candidate>
  critique: step<candidate, { notes: string } & Record<string, unknown>>
  accept: (critique_result: any) => boolean
  max_rounds: number
}): step<input, { candidate: candidate; converged: boolean; rounds: number }>
```

```yaml
adversarial:
  max_rounds: <n>
  accept: <lambda>
  build: <node>
  critique: <node>
```

**Semantics:** runs up to `max_rounds` iterations of:
1. `build` receives `{ input, prior, critique }` (where `prior` and `critique` are from the previous round, or undefined on round 1).
2. `critique` evaluates the built candidate.
3. `accept(critique_result)` is called. If true, return `{ candidate, converged: true, rounds }`.
4. Otherwise loop. `prior` becomes current candidate; `critique` becomes `critique_result.notes`.

If `max_rounds` reached without acceptance, returns `{ candidate: last_candidate, converged: false, rounds: max_rounds }`. The builder, not the framework, is responsible for using `prior` and `critique` when revising. Does not throw on non-convergence (see §9 F3).

---

### §5.11 `ensemble` — N-of-M pick best

```typescript
ensemble<i, o>(config: {
  members: Record<string, step<i, o>>
  score: (result: o, member_id: string) => number | Promise<number>
  select?: 'max' | 'min'  // default: 'max'
}): step<i, { winner: o; scores: Record<string, number> }>
```

```yaml
ensemble:
  score: <lambda>
  select: max   # optional, default max
  members:
    <member_1>: <node>
    <member_2>: <node>
```

**Semantics:** runs all members concurrently with the same input, scores each result, returns the winner (highest or lowest score depending on `select`) plus the full score map. Tie-breaking is undefined; implementations may pick any tied result.

---

### §5.12 `tournament` — pairwise bracket

```typescript
tournament<i, o>(config: {
  members: Record<string, step<i, o>>
  compare: (a: o, b: o) => Promise<'a' | 'b'>
}): step<i, { winner: o; bracket: bracket_record[] }>
```

```yaml
tournament:
  compare: <lambda>
  members:
    <member_1>: <node>
    <member_2>: <node>
```

**Semantics:** runs all members, then pairs them off in a single-elimination bracket. `compare(a, b)` returns which one advances. An odd member count gives one bye per round. `bracket` is a list of `{ round, a_id, b_id, winner_id }` records for introspection.

---

### §5.13 `consensus` — run until agreement

```typescript
consensus<i, o>(config: {
  members: Record<string, step<i, o>>
  agree: (results: Record<string, o>) => boolean
  max_rounds: number
}): step<i, { result: Record<string, o>; converged: boolean }>
```

```yaml
consensus:
  agree: <lambda>
  max_rounds: <n>
  members:
    <member_1>: <node>
    <member_2>: <node>
```

**Semantics:** runs all members concurrently. Calls `agree(results)`. If true, returns `{ result, converged: true }`. Else re-runs all members (with the same input) up to `max_rounds` times. Returns the last result with `converged: false` if no agreement. Members should be non-deterministic (temperature > 0 on LLM calls) for this to make progress.

---

### §5.14 `checkpoint` — persist and resume

```typescript
checkpoint<i, o>(
  inner: step<i, o>,
  config: { key: string | ((input: i) => string) },
): step<i, o>
```

```yaml
checkpoint:
  do: <node>
  key: <string or lambda>
```

**Semantics:** before running `inner`, checks persistent storage for a completed result at `key`. If found, returns it without running `inner`. Otherwise runs `inner`, persists the result at `key`, and returns it. The storage backend is injected via `run_context` (see §6). If `key` is a function, it is called with the step's input to derive the key.

`inner` must be a named step (not anonymous). Wrapping `step(fn)` (no id) with `checkpoint` is a flow-construction-time error — see §9 F6.

---

### §5.15 `suspend` — human-in-the-loop

```typescript
suspend<i, o, resume>(config: {
  id: string
  on: (input: i, ctx: run_context) => Promise<void>  // side effect, e.g. send notification
  resume_schema: z.ZodSchema<resume>
  combine: (input: i, resume: resume, ctx: run_context) => step<any, o> | Promise<o>
}): step<i, o>
```

```yaml
suspend:
  id: <id>
  resume_schema: <schema_identifier>
  on: <side_effect_fn_identifier>
  combine: <fn_identifier or node>
```

**Semantics:** on first encounter, calls `on(input, ctx)` (which typically sends a notification or writes to a pending-approvals queue), then throws `suspended_error` carrying the run state. The runner catches this and persists. When the run is resumed with external resume data, `combine(input, resume, ctx)` is called and its result returned. `combine` may return a value directly or a step to execute (the step's output becomes the suspend's output).

---

### §5.16 `scope` + `stash` + `use` — named state

```typescript
scope<o>(steps: step_in_scope<any>[]): step<any, o>

stash<i, v>(
  key: string,
  source: step<i, v>,
): step_in_scope<i>  // writes source's output to scope state[key]

use<keys extends string[], i, o>(
  keys: keys,
  fn: (state: Record<keys[number], unknown>, input: i, ctx: run_context) => Promise<o>,
): step_in_scope<i>
```

```yaml
scope:
  - stash: <key_1>
    do: <node>
  - stash: <key_2>
    do: <node>
  - use: [<key_1>, <key_2>]
    do: <node>
```

**Semantics:**
- `scope` introduces a scope-local `Map<string, unknown>` and runs its children in order.
- `stash(key, source)` runs `source`, stores the output at `state[key]`, and also passes it through as output (so subsequent steps can chain normally if they want).
- `use(keys, fn)` is called with a projection of `state` containing only the requested keys. This is the read side.
- The final output of a `scope` is the output of its last child.
- Inner scopes can read (via `use`) outer scope state. Inner scopes cannot write to outer state.
- `stash` and `use` are only valid inside a `scope`. Using them outside is a runtime error with a clear message (see §9 F1).

---

### §5.17 YAML representation

A composition tree can be written as plain YAML. This is not a DSL — it is ordinary YAML, structured to map one-to-one onto the TypeScript API in §5.1 through §5.16, and validated by a JSON Schema (`flow_schema`, exported from `@robmclarty/core`). It exists for specs, documentation, and LLM-targeted prompts; YAML is chosen because parsers are universal, schema validation is free, and LLMs interpret it without ambiguity.

The YAML form is documentation-only in v1 (not parsed at runtime). Using it in a spec lets you express compositions without pseudocode drift.

#### Tree shape

Every node in the tree is a YAML map with exactly one composer key identifying its kind. The value under that key is the composer's configuration.

```yaml
<composer_key>:
  <config_fields>
```

A document is a YAML sequence of top-level `compose:` entries, each defining a named flow:

```yaml
- compose: <flow_name>
  <composer_key>:
    <config>
```

#### Composer keys and field contracts

| Composer key | Shape |
|---|---|
| `step` | `{ fn: <identifier>, id?: <string> }` |
| `sequence` | array of nodes |
| `parallel` | map of `<name>: <node>` |
| `branch` | `{ when: <lambda>, then: <node>, otherwise: <node> }` |
| `map` | `{ items: <lambda>, do: <node>, concurrency?: <int> }` |
| `pipe` | `{ of: <node>, fn: <lambda> }` |
| `retry` | `{ do: <node>, max_attempts: <int>, backoff_ms?: <int> }` |
| `fallback` | `{ primary: <node>, backup: <node> }` |
| `timeout` | `{ do: <node>, ms: <int> }` |
| `adversarial` | `{ build: <node>, critique: <node>, accept: <lambda>, max_rounds: <int> }` |
| `ensemble` | `{ members: { <name>: <node> }, score: <lambda>, select?: max\|min }` |
| `tournament` | `{ members: { <name>: <node> }, compare: <lambda> }` |
| `consensus` | `{ members: { <name>: <node> }, agree: <lambda>, max_rounds: <int> }` |
| `checkpoint` | `{ do: <node>, key: <string or lambda> }` |
| `suspend` | `{ id: <string>, on: <identifier>, resume_schema: <identifier>, combine: <identifier or node> }` |
| `scope` | array of `stash` or `use` entries (see below) |
| `ref` | name of a named compose block (cross-flow reference) |

#### Scope entries

`scope` is the only composer with dedicated child node types. Its array contains `stash` entries (binding a step's output to a name) and `use` entries (reading named values and running a step with them):

```yaml
scope:
  - stash: <name>
    do: <node>
  - use: [<name>, <name>, ...]
    do: <node>
```

A `stash` entry runs its `do` step, stores the output at the given name in scope-local state, and passes the value through as output. A `use` entry reads the listed state keys and passes them alongside the flowing input to its `do` step.

#### Lambdas

Lambdas are YAML strings containing a single arrow function expression. The string is pasted verbatim into the generated TypeScript. Always quote lambdas to avoid YAML parsing edge cases.

```yaml
accept: "(r) => r.verdict === 'pass'"
key: "(i) => `build:${i.spec_hash}`"
score: "(r) => r.confidence"
```

#### Function and schema references

Function references (`fn:`, `on:`, `combine:`) and zod schema references (`resume_schema:`) are bare YAML strings that resolve to identifiers in the surrounding TypeScript module.

```yaml
step:
  fn: plan_fn
```

#### Cross-flow references

`{ ref: <flow_name> }` substitutes a named `compose:` block at that position. The referenced block must appear at the top level of the same document.

#### Example: adversarial build with checkpoint, ensemble judge, final deploy

```yaml
- compose: multi_judge
  ensemble:
    score: "(r) => r.confidence"
    members:
      opus:   { step: { id: judge_opus,   fn: judge_opus_fn } }
      sonnet: { step: { id: judge_sonnet, fn: judge_sonnet_fn } }
      gemini: { step: { id: judge_gemini, fn: judge_gemini_fn } }

- compose: build_and_ship
  scope:
    - stash: plan
      do: { step: { id: plan, fn: plan_fn } }
    - stash: build
      do:
        checkpoint:
          key: "(i) => `build:${i.spec_hash}`"
          do:
            adversarial:
              max_rounds: 3
              accept: "(r) => r.verdict === 'pass'"
              build: { step: { id: build, fn: build_fn } }
              critique:
                pipe:
                  of: { ref: multi_judge }
                  fn: "(r) => r.winner"
    - use: [build]
      do: { step: { id: ship, fn: deploy_fn } }
```

Equivalent TypeScript (reference):

```typescript
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
```

#### Validation

The JSON Schema is published from `@robmclarty/core` as the exported constant `flow_schema` (source at `packages/core/src/flow-schema.json`). Any YAML-aware linter or LSP can validate documents against it. The schema and the TypeScript API are the contract; there is no separate "DSL semantics" document.

#### Authoring guidance

1. Prefer `scope` + `stash` + `use` when more than one upstream value is needed downstream.
2. Prefer `sequence` when each step needs only its immediate predecessor's output.
3. Name every top-level flow. Factor shared subtrees into separate `compose:` blocks referenced via `{ ref: ... }`.
4. Quote all lambdas. Keep lambdas short; factor complex logic into named TypeScript functions and reference them via `fn:`.

---

## §6 — Semantics and Runtime Contract

The composition layer ships with a runner (`run(flow, input) → Promise<output>`) that executes a step tree. Implementors must honor these semantics.

### 6.1 Execution model

- **Recursive dispatch.** The runner inspects `step.kind` and executes accordingly. Each composer orchestrates its children; the runner only starts the root.
- **No framework state.** All execution state lives in `run_context`, constructed fresh per top-level `run(...)` call. Two concurrent `run(...)` calls share nothing.
- **No implicit globals.** Trajectory loggers, checkpoint stores, abort signals are injected via `ctx`. Constructors for context are application concerns.

### 6.2 Trajectory logging

Every composer wraps child execution in a trajectory span with its kind and id. Spans are hierarchical and reflect the composition tree. The trajectory logger interface is:

```typescript
type trajectory_logger = {
  record: (event: Record<string, unknown>) => void
  start_span: (name: string, meta?: Record<string, unknown>) => string
  end_span: (id: string, meta?: Record<string, unknown>) => void
}
```

The runner and composers must call `start_span` / `end_span` around child execution. Errors during a span must call `end_span` with `{ error: string }`.

### 6.3 Checkpoint storage

`checkpoint` requires a `checkpoint_store` on `ctx`:

```typescript
type checkpoint_store = {
  get: <t>(key: string) => Promise<t | null>
  set: <t>(key: string, value: t) => Promise<void>
  delete: (key: string) => Promise<void>
}
```

The default implementation is filesystem-backed JSON. Alternative implementations (SQLite, S3) must satisfy the same interface. Corrupted reads (JSON parse failure) must be treated as cache miss, not error.

### 6.4 Suspend and resume

When a `suspend` step throws `suspended_error`, the runner catches it, persists the full `ctx.state` plus the path-to-suspend-point (a list of composer ids), and returns a sentinel indicating suspension. A `resume(run_id, resume_data)` API restores state and re-enters execution at the suspend point.

**Out of scope for the composition layer:** the storage backend for suspended-run state. The runner exposes hooks; the application supplies storage.

### 6.5 Error propagation

- Unhandled errors in a step bubble up through composers.
- `retry` catches and re-runs; `fallback` catches and delegates; `timeout` throws `timeout_error`.
- All other composers let errors propagate.
- Errors carry a `path` property: an array of composer ids from root to failure point, useful for debugging.

### 6.6 Introspection

A `describe(step)` function returns a text tree representation of the composition. Every composer must expose enough metadata (its config, excluding functions) for `describe` to render a complete tree. Function bodies render as `<fn>`.

### 6.7 Streaming observation channel

The composition layer accommodates streaming without implementing any specific streaming protocol. All streaming is expressed through the trajectory event channel:

1. Every step may call `ctx.emit(event)` to surface incremental progress. This is a convenience shortcut for `ctx.trajectory.record({ ...event, span_id: <current> })`.
2. `run.stream(flow, input)` is a secondary entry point that returns `{ events, result }`:
   ```typescript
   type streaming_run_handle<o> = {
     events: AsyncIterable<trajectory_event>
     result: Promise<o>
   }
   ```
   The `events` async iterable yields events as they are emitted. The `result` promise resolves with the final value when the flow completes. Consumers can await one, iterate the other, or both.
3. Composers do not need to know streaming exists. The runner threads events from descendants through the trajectory logger automatically; consumers filter by `span_id` or `kind` to isolate a specific step's stream.
4. Individual steps (typically LLM-backed steps in the AI engine layer) are responsible for emitting chunks. A token-streaming LLM step calls `ctx.emit({ kind: 'token', text })` per chunk.

**Invariant:** `run(flow, input)` and `run.stream(flow, input)` execute identical step graphs. Streaming is purely observational. Both modes produce the same final result for the same input. This invariant is tested (see §10 criterion 21).

**Buffer policy:** when a streaming consumer never iterates `events`, the engine buffers events up to a high-water mark (default **10,000**). Past that, emissions drop the oldest events and record a single `{ kind: 'events_dropped', count }` marker. The `result` still resolves correctly. See §9 F10.

**Out of scope:** streaming step return values (where each yielded chunk is a partial output of the step itself). In the composition layer, every step returns exactly once.

### 6.8 Cancellation and cleanup

All long-running operations must be cancellable and must release resources on cancellation. This is a hard requirement; see `constraints.md` §5.1 / §5.2.

**Runtime contract:**

1. `run_context.abort: AbortSignal` is the root cancellation signal. Every step that performs I/O longer than roughly 50ms must pass `ctx.abort` to that I/O (fetch calls, subprocess spawn, file streams, LLM requests).
2. `ctx.abort.reason` carries a typed Error describing the cause: `aborted_error` on SIGINT/SIGTERM/explicit abort, `timeout_error` on `timeout` composer expiry. Inner steps and composers may branch on `ctx.abort.reason instanceof <TypedError>` to distinguish causes; the runner and `timeout` composer set this before firing.
3. The runner installs `SIGINT` and `SIGTERM` handlers by default using `process.once` (handlers are idempotent against double-install). On signal, the runner aborts the root signal with an `aborted_error` as the reason and triggers registered cleanup handlers. Opt-out is `run(flow, input, { install_signal_handlers: false })`.
4. `ctx.on_cleanup(fn: () => Promise<void> | void)` registers a cleanup handler. Handlers run on abort, on uncaught error in the root, and on successful completion. Handlers execute in reverse registration order (LIFO). Each handler has a 5-second timeout; timeouts are recorded in the trajectory but do not block other handlers.
5. Cleanup handlers must: release file handles, kill child processes, close network connections, flush pending writes, cancel in-flight HTTP requests.
6. Cancellation propagates down the tree: aborting the root signal causes all child steps' `ctx.abort` to fire simultaneously.

**Composer obligations:**

- `timeout(inner, ms)` fires the abort signal for `inner`'s subtree when the timeout elapses. The inner step is responsible for honoring the signal.
- `retry` does not reset cleanup between attempts; cleanup handlers accumulate across retries. Each attempt may register its own handlers.
- `parallel`, `ensemble`, `tournament`, `consensus`: on abort, all in-flight children receive the abort signal (implemented via `AbortSignal.any([ctx.abort, child_local])` per child, with child-local reason propagation). The runner awaits all children (successful, failed, or aborted) before returning. The composer rethrows `ctx.abort.reason` (typically `aborted_error` or `timeout_error`).
- `suspend`: cleanup does NOT delete the suspended run's persisted state. Resume remains possible.
- `checkpoint`: in-flight writes must be all-or-nothing. Partial results never land in the store. If a write is interrupted mid-flush, the next read treats it as a miss.
- `map` with `concurrency`: on abort, no new items start. In-flight items receive the abort signal.

**Failure mode:** a cleanup handler that itself errors. The error is logged via trajectory but does not propagate; other cleanup handlers still execute (see §9 F9).

---

## §7 — Constraints

See `constraints.md` for hard non-negotiables. Composition-specific clarifications:

- Every composer's config accepts plain values or other `step<i, o>` values. No handles, no ids from a registry.
- `checkpoint` requires a named `inner` step; anonymous steps throw at flow-construction time (§9 F6).
- `trajectory_logger` and `checkpoint_store` are imported via `import type` from `packages/core/src/types.ts`. Adapter packages (`@robmclarty/observability`, `@robmclarty/stores`) and `@robmclarty/engine` `import type` from `@robmclarty/core`. No runtime import from the engine layer.

---

## §8 — Dependencies

### Runtime (in `dependencies`)

| Package | Version | Purpose |
|---|---|---|
| `zod` | ^4.0.0 | schema validation for `suspend` resume_schema and optional input/output schemas. Imported as `import { z } from "zod"`; the `zod/v4` subpath is internal and should not be used. |

### Peer dependencies

`@robmclarty/core` has no peer dependencies. Peers belong on the adapter packages that use them:

| Package | Peer | Version | Purpose |
|---|---|---|---|
| `@robmclarty/observability` | `langfuse` | ^3.0.0 | optional langfuse trajectory logger (`peerDependenciesMeta.langfuse.optional: true`) |
| (future) `@robmclarty/mcp` | `@modelcontextprotocol/sdk` | ^1.0.0 | MCP server adapter when built |

### Development

| Package | Version | Purpose |
|---|---|---|
| `typescript` | ^6.0.0 | compiler |
| `vitest` | ^4.1.0 | test runner |
| `@types/node` | ^24.0.0 | Node.js types |
| `tsdown` | ^0.15.0 | ESM bundling with `.d.ts` emission |

No AI SDK dependency at this layer. That belongs to the AI engine layer.

---

## §9 — Failure Modes

### F1: `stash` / `use` outside a `scope`

**Scenario:** User calls `stash("x", step(...))` at the top level, not inside a `scope([...])` array.
**Behavior:** runtime error with message: `stash() may only appear inside scope(); got: top-level`. Thrown when the runner encounters the step, not at construction time.
**Test:** construct a flow with a bare `stash`, call `run(flow, {})`, assert the error message matches.

### F2: Checkpoint key collision across unrelated flows

**Scenario:** Two unrelated flows both use `checkpoint(step, { key: 'x' })` with the same checkpoint store.
**Behavior:** the second run returns the first run's result. This is intentional; checkpoint keys are a global namespace by design. Users are expected to namespace keys by flow or input hash.
**Test:** verify that key-based deduplication works. Separately, document the namespacing recommendation in the README.

### F3: `adversarial` max rounds exceeded

**Scenario:** The critique never calls `accept` as true within `max_rounds`.
**Behavior:** returns `{ candidate: <last_built>, converged: false, rounds: max_rounds }`. Does not throw. Downstream steps are expected to inspect `converged`.
**Test:** construct an adversarial where `accept` always returns false, run with `max_rounds: 2`, assert output shape.

### F4: `timeout` on a step that ignores `ctx.abort`

**Scenario:** Inner step does not honor `AbortSignal`, timeout elapses.
**Behavior:** the runner throws `timeout_error` on schedule. The inner step continues running in the background (fire-and-forget). Known hazard; documentation must warn users to honor `ctx.abort` in long-running I/O.
**Test:** wrap a step that ignores abort with `timeout(step, 100)`, assert `timeout_error` thrown at ~100ms even if the inner step runs for 500ms.

### F5: `suspend` resume with schema-invalid data

**Scenario:** Resume data does not match `resume_schema`.
**Behavior:** throw `resume_validation_error` carrying the zod error's flattened structure: `new resume_validation_error(zod_error.flatten())` where `.flatten()` returns `{ formErrors, fieldErrors }` per zod 4. Do not call `combine`. The run remains in suspended state; it can be resumed again with corrected data.
**Test:** suspend a run, attempt resume with invalid data, assert error, attempt resume with valid data, assert success.

### F6: Anonymous step checkpointed

**Scenario:** User wraps `step(fn)` (no id) with `checkpoint`.
**Behavior:** runtime error at flow construction: `checkpoint requires a named step; got anonymous`. This is a fail-fast check.
**Test:** construct the bad flow, assert it throws before `run` is ever called.

### F7: Circular composition

**Scenario:** A composer accidentally references itself.
**Behavior:** this is a user error that causes infinite recursion during `describe` or execution. No framework-level protection. Document that composers are trees, not graphs.
**Test:** none; documented as "don't do that."

### F8: SIGINT during long-running flow

**Scenario:** User presses Ctrl+C while a flow with pending LLM calls and open subprocesses is executing.
**Behavior:** the runner catches SIGINT, fires `ctx.abort`, runs all registered cleanup handlers in reverse order, then exits with a non-zero status. In-flight `fetch` and `child_process.spawn` calls that received `ctx.abort` are cancelled by the platform natively. No additional tokens are consumed after the signal.
**Test:** start a flow with a step that `fetch`es a slow endpoint with `ctx.abort` wired, register a cleanup handler via `ctx.on_cleanup` that writes to a marker file, send SIGINT mid-flight, assert the marker file exists and the fetch was cancelled.

### F9: Cleanup handler throws

**Scenario:** A registered cleanup handler throws or rejects.
**Behavior:** the error is recorded in the trajectory with `{ kind: 'cleanup_error', error }`, but the runner continues executing remaining cleanup handlers in order. Shutdown does not hang.
**Test:** register two cleanup handlers where the first throws; assert both handlers' side effects occur and the trajectory contains the error record.

### F10: Streaming consumer drops the iterator

**Scenario:** Consumer calls `run.stream(flow, input)`, awaits `result`, but never iterates `events`.
**Behavior:** events are buffered internally bounded by a high-water mark (default 10,000); past that, emissions drop the oldest events and record a single `{ kind: 'events_dropped', count }` marker. The result still resolves correctly.
**Test:** run a flow that emits 15,000 events; do not iterate; assert `result` resolves and buffer eviction is recorded.

### F11: Cleanup handler registered inside a retried step

**Scenario:** A step wrapped in `retry(...)` calls `ctx.on_cleanup(fn)` on every attempt. Over N attempts, N handlers are registered.
**Behavior:** this is the documented contract (§6.8 "retry does not reset cleanup between attempts"). All N handlers fire on abort / error / success. Implementations that close resources the step opens on each attempt (e.g., an HTTP connection) should either release at the end of the attempt, or pool resources across attempts rather than registering per-attempt cleanup.
**Test:** retry a step that registers a handler each attempt, with `max_attempts: 3`, and force all three to run (first two throw). Assert three cleanup calls fire in LIFO order.

---

## §10 — Success Criteria

### Automated tests

Each must pass in CI against a clean install.

1. **Atomic step:** `run(step('id', (x) => x + 1), 1)` returns `2`.
2. **Sequence chain:** three steps adding 1, 2, 3 run in order, output is input + 6.
3. **Parallel fan-out:** two steps run concurrently, output is `{a, b}` with expected values; total elapsed time < sum of individual delays.
4. **Branch:** `when: (x) => x > 0` routes correctly for both inputs.
5. **Retry:** step that throws twice then succeeds with `max_attempts: 3` returns success on third attempt.
6. **Fallback:** primary throws, backup succeeds, output is backup's.
7. **Timeout:** long-running step wrapped in `timeout(step, 50)` throws within 100ms.
8. **Adversarial convergence:** critique accepts on round 2; output has `converged: true, rounds: 2`.
9. **Adversarial non-convergence:** critique always rejects; output has `converged: false, rounds: max_rounds`.
10. **Ensemble:** three members, `score: (r) => r.n`, winner is the one with highest `n`.
11. **Tournament:** four members, single-elimination, bracket has 3 matches.
12. **Consensus:** two members, agree on round 2, `converged: true`.
13. **Checkpoint hit:** same key run twice, second run does not invoke inner step's function (verify via spy).
14. **Checkpoint miss:** no prior result, inner runs, result persisted.
15. **Suspend and resume:** `suspend` throws `suspended_error` on first run; resume with valid data returns expected output.
16. **Scope stash/use:** scope with two stashes and a terminal `use` reads both values.
17. **Pipe:** output shape adaptation works; type system catches mismatches.
18. **Map concurrency:** items = `[1,2,3,4,5]` with `concurrency: 2` never has more than 2 in-flight simultaneously (verify via counter).
19. **Describe tree:** `describe(sample_flow)` produces a multi-line string with correct nesting and all composer kinds.
20. **Error path:** error in deep step carries a `path` array from root to failure.
21. **Streaming observation:** `run.stream(flow, input)` emits events in the order steps call `ctx.emit`; `result` resolves with the same value as `run(flow, input)` would.
22. **Streaming drop:** 15,000 emitted events with no consumer iteration produces at most 10,000 buffered events plus a single `events_dropped` marker; `result` still resolves.
23. **SIGINT cleanup:** a running flow with a `ctx.on_cleanup` handler receives SIGINT; the handler fires; in-flight `fetch` calls are aborted (verify via `AbortSignal.reason`); process exits non-zero.
24. **Cleanup order:** three handlers registered in order A, B, C fire in order C, B, A on abort.
25. **Cleanup handler error:** first of two handlers throws; second still executes; trajectory contains `cleanup_error` record.
26. **Parallel abort:** `parallel({ a, b })` where `a` is in-flight when abort fires; both `a` and `b` receive abort; runner returns `aborted_error`.
27. **Abort reason typing:** `timeout(step, 50)` applied to a step that inspects `ctx.abort.reason` must see an `instanceof timeout_error` after expiry, distinct from a parent-aborted case which sees `instanceof aborted_error`.
28. **Retry cleanup accumulation:** retry with `max_attempts: 3` and a step that registers one cleanup handler per attempt fires three handlers on completion (F11).

### Architectural validation

- No file in `packages/core/src/` imports from any adapter package (`@robmclarty/observability`, `@robmclarty/stores`, `@robmclarty/engine`, or future adapter packages). See `constraints.md` §7.
- No composer imports from another composer. All composers depend only on `types.ts` and the runner.
- `zod` is the only runtime dependency in `package.json`. All others are `peerDependencies` or `devDependencies`.
- No `class`, no `extends`, no `this` keyword in source outside `errors.ts`. Verified by AST grep or lint rule.
- All async functions that perform I/O accept or close over an `AbortSignal`. Verified by review.

### Learning outcomes

After shipping v1, the builder should be able to answer:

- Which of the 16 primitives get used daily, weekly, never?
- Does `scope` + `stash` + `use` earn its complexity, or does output-chaining cover the real cases?
- Is `tournament` redundant with `ensemble`?
- Which deferred composers from `BACKLOG.md` does real usage actually demand?
- Is 10,000 a reasonable streaming buffer high-water mark, or does real usage need tuning?

---

## §11 — File Structure

pnpm workspace; each layer from §2 is its own publishable package under `packages/`. Layer packages are deep modules — narrow public surface, substantial internals.

```
packages/
├── core/                             # @robmclarty/core — composition layer
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsdown.config.ts
│   ├── README.md
│   ├── BACKLOG.md                    # deferred composers with rationale
│   ├── src/
│   │   ├── index.ts                  # public surface
│   │   ├── types.ts                  # step<i,o>, run_context, trajectory_logger, trajectory_event, checkpoint_store
│   │   ├── errors.ts                 # timeout_error, suspended_error, resume_validation_error, aborted_error (only file with `class`)
│   │   ├── step.ts                   # step() factory + anon id generator
│   │   ├── runner.ts                 # run(flow, input, ctx?) dispatch
│   │   ├── streaming.ts              # run.stream() + event buffer + emit helper
│   │   ├── cleanup.ts                # signal handlers, cleanup registry, abort propagation
│   │   ├── describe.ts               # describe(step) tree renderer
│   │   ├── sequence.ts
│   │   ├── parallel.ts
│   │   ├── branch.ts
│   │   ├── map.ts
│   │   ├── pipe.ts
│   │   ├── retry.ts
│   │   ├── fallback.ts
│   │   ├── timeout.ts
│   │   ├── adversarial.ts
│   │   ├── ensemble.ts
│   │   ├── tournament.ts
│   │   ├── consensus.ts
│   │   ├── checkpoint.ts
│   │   ├── suspend.ts
│   │   ├── scope.ts                  # scope, stash, use (co-located)
│   │   └── flow-schema.json          # re-exported as `flow_schema` constant
│   ├── test/
│   │   ├── core/                     # one test file per composer
│   │   ├── streaming/
│   │   ├── cleanup/                  # SIGINT, abort propagation, cleanup order
│   │   └── integration/              # cross-composer scenarios
│   └── examples/
│       ├── adversarial_build.ts
│       ├── ensemble_judge.ts
│       ├── streaming_chat.ts
│       └── suspend_resume.ts
├── engine/                           # @robmclarty/engine — AI engine layer (separate spec)
├── observability/                    # @robmclarty/observability
│   ├── package.json
│   └── src/
│       ├── index.ts
│       ├── noop.ts                   # default no-op trajectory_logger
│       └── filesystem.ts             # jsonl trajectory_logger
├── stores/                           # @robmclarty/stores
│   ├── package.json
│   └── src/
│       ├── index.ts
│       └── filesystem.ts             # filesystem-backed checkpoint_store
└── agent-kit/                        # @robmclarty/agent-kit — umbrella
    ├── package.json
    └── src/
        └── index.ts                  # export * from '@robmclarty/core'
```

Public surface of `@robmclarty/core` (from `packages/core/src/index.ts`): every composer, `run`, `describe`, shared types, typed errors, `flow_schema`. `@robmclarty/agent-kit` re-exports this surface unchanged. Adapters are consumed by importing `@robmclarty/observability` or `@robmclarty/stores` directly — adapter instances are injected into the composition layer via `run_context`, never imported by composers.

---

## §12 — Environment Variables

The composition layer has no environment variables of its own. Adapter packages (`@robmclarty/stores`, `@robmclarty/observability`) may read paths from environment if the user passes `process.env.X` explicitly at construction. No package in this workspace reads `process.env` implicitly. See `constraints.md` §3 and §7.

---

## §13 — Open Questions

1. **YAML runtime parser.** The YAML representation is documentation-only in v1. If later usage demands runtime parsing (to generate TypeScript from `.flow.yaml` files), a parser can be added. Deferred until a real use case appears.
2. **Deferred composers.** A curated backlog of additional composers lives in `packages/core/BACKLOG.md`. The bar for promotion into v1+ is "this pattern appeared in two unrelated flows and was awkward to express." None are scoped into v1.
3. **Cancellation granularity in agent-pattern composers.** `ensemble`, `tournament`, `consensus` currently cancel all in-flight children on abort. An alternative is to let one fast-returning child win and cancel siblings. Deferred; needs a real use case to decide.
4. **Visual introspection.** `describe` produces text. A tree-to-Mermaid or tree-to-React-flow renderer is out of scope for v1 but the tree shape is stable enough to build one later.
5. **Streaming step return values.** v1 streaming is observational only (events alongside a single final value). A future version may need steps that yield a stream of partial outputs. Would be specified in the AI engine layer when the use case arises.
6. **Checkpoint store consistency across distributed instances.** If two processes share a filesystem checkpoint store, concurrent writes to the same key are last-write-wins. Formalizing concurrency semantics (locks, versioning) is deferred.

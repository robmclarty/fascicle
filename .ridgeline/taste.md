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

### 9. `ProviderAdapter` is a discriminated union, not a bag of optional methods

**Rule:** `ProviderAdapter = AiSdkProviderAdapter | SubprocessProviderAdapter`. The `ai_sdk` branch exposes `{ kind, name, build_model, translate_effort, normalize_usage, supports }`. The `subprocess` branch exposes `{ kind, name, generate, dispose, supports }`. Engine-layer callers narrow on `kind` before using branch-specific methods.

**Why:** "every adapter has every method, unused ones return no-ops" is how small-surface objects become big-surface objects over time. The union makes each branch honest about what it can do. The type system prevents `generate.ts` from accidentally calling `normalize_usage` on a subprocess adapter (it would not compile). Discriminants beat optional members — especially when the two transports diverge on fundamentals like who owns the tool-call loop and where cost comes from.

### 10. Subprocess lifecycle is first-class, not plumbing

**Rule:** when a provider adapter spawns subprocesses, those subprocesses are spawned detached, registered in a per-adapter live set, SIGTERM'd before SIGKILL with a bounded escalation window, and reaped on engine dispose (async) and on Node exit (synchronously, via `process.on('exit')`). The patterns — process-group signal delivery, live registry, synchronous exit reap, startup-and-stall timers — are elevated to engine invariants, not left to each adapter to re-derive.

**Why:** subprocess leaks are the worst kind of bug. Invisible during development, they accumulate silently in production, and they correlate with the events most likely to be unit-tested (aborts, crashes, timeouts). Treating lifecycle as plumbing means accepting that production leaks will happen and will not be diagnosed until they cost real resources. A harness wires `dispose` into its shutdown handler and gets correct behavior; a test `await engine.dispose()`-ing in `afterEach` gets hermetic isolation. There is no "forget to clean up": either you call `dispose` and the engine reaps, or you crash Node and the synchronous exit handler reaps. Both lead to zero live children.

### 11. `Engine.dispose()` is universal, not provider-gated

**Rule:** `Engine.dispose(): Promise<void>` is on every engine, regardless of configured providers. HTTPS-only adapters have no `dispose` member; the aggregator skips them. Subprocess adapters implement `dispose`; the aggregator awaits them all. Post-dispose `engine.generate(...)` throws `engine_disposed_error` synchronously.

**Why:** asking the caller to branch — "if you configured a subprocess provider, you need to call `dispose`; otherwise you don't" — is exactly the wrong cognitive tax. The correct shutdown pattern is "always call `dispose`, always await it, always in a `finally`." Making the API support that unconditionally means the pattern is always correct. Same ergonomic logic as `abort: AbortSignal` being optional-but-universal on `generate_options`: the caller wires it through always; whether the provider honors it at every level is the provider's problem.

### 12. When a provider owns its tool loop, asymmetry is loud, not silent

**Rule:** the engine's in-process tool-call loop does not run for subprocess providers that run the loop themselves. Caller-supplied options the provider cannot honor (`max_steps`, `tool_error_policy`, `on_tool_approval`) are recorded once per call as `{ kind: 'option_ignored', option, provider }` via trajectory. User-defined `Tool` objects with `execute` closures that cannot cross the transport surface per a `provider_options.<provider>.tool_bridge` setting, whose default is provider-specific (typically forward names and drop `execute`) and whose forbid mode fails loudly with `provider_capability_error`.

**Why:** the tool model is the largest semantic asymmetry between HTTPS providers and transports that own their own loop. An `execute` callback cannot run inside a subprocess. Pretending otherwise — silently treating `execute` as if it would run — would mislead callers into writing code that looks like it works and fails subtly at runtime. The honesty tax is the trajectory record: callers see exactly which closures were dropped, and can opt into loud failure (`tool_bridge: 'forbid'`) when portability across providers matters. A future MCP bridge (deferred) restores symmetry by launching `execute` callbacks as ephemeral MCP servers the external tool connects to; shipping it prematurely would cement a bad implementation.

### 13. Cost source is explicit

**Rule:** every trajectory `cost` event carries a mandatory `source: 'engine_derived' | 'provider_reported'` discriminant. `engine_derived` means the engine computed cost from `usage × pricing_table`; `provider_reported` means the provider returned a cost number in its own output (e.g. Claude CLI's `total_cost_usd`). For `provider_reported` providers, `pricing_missing` is never emitted and `FREE_PROVIDERS` does not apply.

**Why:** provider-reported cost is more accurate for total-dollar numbers but less transparent for component decomposition; engine-derived cost is the opposite. Consumers aggregating across mixed providers need to distinguish the two cleanly. Hiding the source behind a single `cost` shape would silently conflate two different accuracy guarantees. The discriminant is the principled way to let budget code opt into or out of either source. The engine's job is to report honestly and tag the provenance; harnesses decide what to do with it.

### 14. Forward-compat via unknown-event tolerance

**Rule:** stream parsers tolerate unknown event types. An unknown event is recorded to trajectory and parsing continues; it does not throw, does not reject `generate`, and does not synthesize a pretend event.

**Why:** upstream transports (Anthropic's CLI, Vercel AI SDK, new provider SDKs) evolve. A new feature ships as a new event type. If the parser is strict, every upstream release becomes a breaking change with us. Tolerance degrades gracefully: the new event is unobserved by the engine and callers who don't know about it, but the rest of the call still works. The trajectory record lets harnesses monitor for drift and prompts adapter updates when the new event matters. Strict where it matters (auth patterns, failure modes); lenient at the edges (event stream).

### 15. Umbrella-is-the-seam

**Rule:** the workspace publishes exactly one npm package. The composition, engine, observability, and stores layers stay as separate workspace packages under the `@repo/*` prefix, but they do not reach npm. `packages/fascicle/src/index.ts` is the umbrella; `tsdown` bundles it into a single `dist/` that publishes as `fascicle`. Workspace-internal deps are inlined into the bundle; `ai`, `zod`, and every `@ai-sdk/*` stay external as peer dependencies.

**Why:** multi-package publication is a path we could take later; taking it now doubles the coordination tax (version alignment, dep-graph alignment, peer-dep alignment across N tarballs) before a single user has asked for slim installs. An umbrella with a bundled `dist/` is the simpler shape. Each layer stays a separate workspace package under `@repo/*` so `constraints.md` §3's boundary rules keep their teeth internally — `@repo/core` cannot import `@repo/engine`, and ast-grep rules mechanically enforce that even inside a pnpm workspace where everything is symlinked together. The `@repo/*` prefix is the internal-vs-public signal; it makes the answer to "will this reach a user?" trivially visible at any import site. Revisit multi-package publish when a user concretely asks for slim installs and the coordination cost is worth paying for at least one named consumer.

### 16. Lockstep first; semver-per-package on demand

**Rule:** every workspace package ships at the same version. One `/version` skill bumps the root, every `packages/*/package.json`, and the literal `version` constants in `packages/core/src/version.ts` and `packages/engine/src/version.ts` in a single atomic commit. One number, one release note, one tag. `scripts/check-deps.mjs`, `scripts/check-publish.mjs`, and `scripts/bump-version.mjs` share the lockstep enumeration via `scripts/lib/lockstep.mjs` so there is exactly one list of version-bearing files in the repo.

**Why:** independent semver per package is a full-time job masquerading as a tooling setup. Even with a good tool (changesets, Lerna) somebody has to decide, for every PR, what each affected package's next version should be; the answer is almost always "bump them together" until the shape of the code makes that actively wrong. Lockstep makes versioning a non-decision and trades a bit of version-space efficiency (a layer that didn't change still gets a bump) for the equivalent of zero decisions per PR. Adopt independent semver if and when one layer churns meaningfully faster than another — for example, the engine cuts a breaking release every week while core is stable — and the cost of bumping the quiet layer becomes real. Default is lockstep.

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

**`engine.<provider>.generate(...)` as a second entry point.** The public API gains no new entry points. Callers route to a subprocess transport by writing `engine.generate({ model: 'cli-sonnet', ... })`; the alias table dispatches. `generate_cli`, `generate_with_tools`, `generate_object`, `generate_stream` — none of them. One function, every feature optional.

**`engine.login()` / token management inside the engine.** Subprocess providers that wrap an external tool (e.g. Claude CLI) delegate auth entirely to that tool. The engine never reads or writes OAuth tokens, never parses `~/.claude/`, never invokes `claude login`. An adapter's `auth_mode` setting expresses a preference about which of the external tool's own auth sources to use, by scrubbing env vars before `spawn`; it is not the engine "doing auth."

**Automatic `cli-*` routing based on environment.** Aliases for subprocess transports are explicit (`cli-sonnet`, `cli-opus`). Making `'claude-sonnet'` silently route to `claude_cli` when a CLI is detected would be convenient and wrong: convenience that changes behavior based on environment is the kind of magic that makes tests flaky and incidents hard to diagnose.

**PTY-based subprocess interaction.** Piped stdio only. `node-pty` is forbidden.

**Shell-interpreted argv.** `spawn` only, `shell: false`, no string interpolation into argv. Argv injection is not a surface we accept.

**Module-level process registries.** Every live-process set is per-adapter, closed over by the adapter factory. Two engines have two registries.

---

## What Good Code Looks Like

A flow that exercises most of the surface, reading top-to-bottom:

```typescript
import { step, scope, stash, use, checkpoint, adversarial, ensemble, pipe } from 'fascicle'
import { run } from 'fascicle'

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
- **Cancellation is mandatory.** Every step that calls `generate` must pass `ctx.abort`. Enforced by review and by this document. A model call is always I/O — whether the transport is HTTPS or a subprocess.
- **`dispose` is universal.** `engine.dispose()` exists on every engine regardless of configured providers. Harnesses wire it into SIGINT/SIGTERM handlers once; no branching on provider identity.
- **Subprocess transports are lifecycle-correct.** Detached process groups, live-child registries, SIGTERM→SIGKILL escalation, synchronous reap on Node exit. Callers never see a leaked child.
- **Extra transport features pass through as data, not code.** Provider-specific settings (`allowed_tools`, `agents`, `plugin_dirs`, `session_id`, `extra_args` for Claude CLI; equivalents for future adapters) flow through `provider_options.<provider>.*` to the adapter. The engine does not parse, validate, or transform them beyond what the transport's interface demands.

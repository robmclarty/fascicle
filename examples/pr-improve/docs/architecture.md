# Architecture: composition-first design

This app is structured so that a developer can read `src/flow.ts` and see the agent topology directly — no imperative goo, no buried control flow. Everything that isn't fascicle composition lives in adjacent modules and is invoked from named chain bindings.

This doc captures **why** the codebase is shaped this way, so the next person tempted to inline a `for` loop or an `if` inside a `step('...')` body will have a reason to pause. The generalized, app-agnostic version of this architecture is [docs/blueprint.md](../../../docs/blueprint.md) at the repo root — this app is its canonical worked example.

## The principle: think at the fascicle level

When you open `flow.ts`, you should see only fascicle vocabulary: `chain`, `branch`, `loop`, `step`, `model_step`, `ctx.call`. The shape of the agent system should be visible as the shape of the file. Anything that isn't part of that shape — string formatting, markdown rendering, state transitions, reading scope state — belongs in a sibling module.

## What this means in code

`flow.ts` reduces to one expression that mirrors the agent diagram:

```text
chain 'pr'
 ├ suggestions ← reviewer (model_step via ctx.call)
 └ branch (any suggestions?)
     then ─ chain 'review'
       ├ spec ← pragmatist (model_step via ctx.call)
       └ branch (any accepted?)
           then ─ chain 'accepted'
             ├ final_state ← loop({ body: build+review, guard: pass? })
             └ assemble FinalResult
           otherwise ─ no_changes_proposed
     otherwise ─ no_changes_proposed
```

Every node in that diagram is a fascicle primitive in `flow.ts`. Each binding that invokes a composed arm declares it as `arm` metadata, so `describe` renders this same tree statically.

## Module split

Each module has one reason to exist; together they keep `flow.ts` at the fascicle level.

- `flow.ts` — pure fascicle composition. The agent topology.
- `stages/*.ts` — each stage loads its markdown prompt and returns a `make_*_step(engine, model, ...)` factory producing a `model_step`. No formatting, no extraction: the factory returns the schema-validated output type directly. `make_builder_step` additionally takes `worktree_root` and `provider` and dispatches: `claude_cli` uses the CLI's built-in tools, API providers get explicit worktree-scoped tools. The `Step<string, Handoff>` contract stays stable so `flow.ts` doesn't notice.
- `prompts/*.md` — one markdown file per model role, with frontmatter, loaded by `prompts/load.ts`. The file holds the role and its judgment criteria; per-call content is assembled in `messages.ts`, and field-level output rules live in `.describe()` on the schemas. A prompt change is a prompt diff, reviewable on its own.
- `messages.ts` — `format_*` user-message builders. Pure string assembly.
- `render.ts` — `render_*` markdown builders for run artifacts (`IMPROVEMENT_SPEC.md`, `HANDOFF.md`, `PR_COMMENT.md`) and `assemble_final_result` for the discriminated-union output.
- `types.ts` — the zod schema per model boundary, with the field-level output contract in `.describe()`, plus `FlowModels`, the role-to-model record threaded into the flow as data.
- `state.ts` — `LoopState` and its pure transitions (`next_loop_state`, `loop_converged`) for the build-review loop. Everything else threads through typed chain bindings, so no scope keys or `read_*` casts remain.
- `engine.ts` — the one `create_engine` call site: provider selection by env, and the single per-provider model-defaults table. Stub engine for tests and fixture runs.
- `observability.ts` — `stdout_logger` for CloudWatch (paired with `filesystem_logger` via `tee_logger`).

## Why this beats imperative control flow

### 1. The agent topology is readable

You don't have to parse a 60-line async function to find the agents. `flow.ts` reads top-to-bottom as a tree of named primitives. Adding a new stage is "add a binding." Adding a conditional is "wrap a branch." Adding a retry is "wrap a `retry`." None of these require imperative refactoring.

### 2. Trajectory observability is free

Every primitive emits a span via the runner's `dispatch_step`, and `ctx.call` routes through the same dispatcher, so arms invoked from binding bodies nest correctly. The composition-first version produces ~35 spans per run with structural nesting that mirrors the topology — `branch` spans wrap `chain` spans wrap binding spans wrap individual `model_step` spans. The hand-rolled `for` loop produced 2 spans (the outer step, and the runner). The viewer and CloudWatch Logs Insights get rich structure with no extra code.

### 3. Stages are swappable in isolation

Phase A's builder is a one-shot `model_step({ schema: HandoffSchema })`. Phase B's builder is a `tool_loop` with worktree-scoped file tools. Both satisfy `Step<string, Handoff>`. Swapping them means rewriting `stages/builder.ts`'s body — `flow.ts`, `state.ts`, `messages.ts`, every other stage, all stay untouched. The composition shape *is* the integration contract.

### 4. State is typed bindings, not ambient keys

When the build-reviewer needs PR + spec + handoff + loop state, that's:

```ts
.step('verdict', ({ carry, handoff }, ctx) =>
  ctx.call(build_reviewer, format_build_review_message(carry.pr, carry.spec, handoff, carry.state)),
  { arm: build_reviewer })
```

Binding names and view types are inferred, so there is no key registry, no `read_*` casts, and a typo in a binding name is a compile error. Adding a new piece of state needed by a stage is "destructure another binding." This composes naturally as the pipeline grows.

### 5. Provider portability lives in one place

`flow.ts` doesn't import `anthropic` or `openrouter` or `claude_cli`. It takes an `Engine` and routes every call through `model_step`. The engine is the only place the provider matters. Swapping `FASCICLE_PROVIDER=anthropic` to `FASCICLE_PROVIDER=openrouter` is one env var with zero code changes — the explicit acceptance criterion of this app.

### 6. Branching is data, not control flow

`branch({ when, then, otherwise })` is a value. You can describe it, log it, visualize it (Weft will draw it). An `if (suggestions.length === 0) return ...` inside a step body is invisible to the runner and the trajectory. Branches at the composition level are introspectable.

## Anti-patterns to avoid

### Don't bury model calls inside `step()` bodies

If a step's body calls `await someStep.run(input, ctx)` directly, you bypass `dispatch_step` and lose the trajectory span for that inner call. The model step's own cost/usage events still flow because it writes to `ctx.trajectory` directly, but you lose the structural nesting that makes the trajectory readable in the viewer.

The sanctioned form is `ctx.call(the_step, input)` from a named chain binding, with the step also passed as `{ arm }` so `describe` still shows it. Bare `.run` is never right.

### Don't put control flow inside `step()` bodies

A `for` loop, an `if`/`else`, a try/catch with a fallback — all of these have a fascicle primitive: `loop`, `branch`, `fallback`. Using the primitive gets you trajectory spans, retry composability, and (with Weft) a visual representation. Hiding the same logic inside a step body gets none of those things.

The exception: a step body might do small bookkeeping arithmetic (`round + 1`, picking a field off an object). That's fine. The line is "would another agent pipeline want to compose around this decision?" If yes, lift it to a primitive.

### Don't reintroduce ambient scope state

`chain` bindings are typed and inferred; raw `scope`/`stash`/`use` reintroduces string keys and `as` casts. If a value genuinely cannot thread through bindings (writes from deep inside a subtree, state shared across sibling compositions), quarantine the keys and casts in a dedicated `state.ts` per the blueprint — do not scatter them through the flow.

## When to revisit this design

The composition-first style has a cost: a small amount of indirection (a named binding and a `ctx.call`) where a less-disciplined codebase would just close over a variable. That cost is worth it as long as the pipeline benefits from being introspectable, swappable, and observable.

If a future stage genuinely needs imperative control flow that doesn't map to any primitive — three nested loops with shared mutable state, say — that's the signal to either (a) propose a new fascicle primitive in `src/core`, or (b) document why this stage is the exception. Hiding it inside a `step()` body without comment is not the answer.

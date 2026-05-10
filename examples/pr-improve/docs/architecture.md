# Architecture: composition-first design

This app is structured so that a developer can read `src/flow.ts` and see the agent topology directly — no imperative goo, no buried control flow. Everything that isn't fascicle composition lives in adjacent modules and is plugged in via `use(...)` projections.

This doc captures **why** the codebase is shaped this way, so the next person tempted to inline a `for` loop or an `if` inside a `step('...')` body will have a reason to pause.

## The principle: think at the fascicle level

When you open `flow.ts`, you should see only fascicle vocabulary: `scope`, `stash`, `use`, `sequence`, `branch`, `loop`, `step`, `model_call`. The shape of the agent system should be visible as the shape of the file. Anything that isn't part of that shape — string formatting, markdown rendering, state transitions, reading scope state — belongs in a sibling module.

## What this means in code

`flow.ts` reduces to one expression that mirrors the agent diagram:

```text
scope
 ├ stash PR
 ├ stash SUGGESTIONS  ← reviewer (model_call)
 └ branch (any suggestions?)
     then ─ scope
       ├ stash SPEC  ← pragmatist (model_call)
       └ branch (any accepted?)
           then ─ scope
             ├ stash LOOP_RESULT ← loop({ body: build+review, guard: pass? })
             └ assemble FinalResult
           otherwise ─ no_changes_proposed
     otherwise ─ no_changes_proposed
```

Every node in that diagram is a fascicle primitive in `flow.ts`. None of them is hidden inside a `step(async (input, ctx) => { ... })` block.

## Module split

Each module has one reason to exist; together they keep `flow.ts` at the fascicle level.

- `flow.ts` — pure fascicle composition. The agent topology.
- `stages/*.ts` — each stage is a system prompt plus a `make_*_call(engine, model, ...)` factory that returns a `model_call` step. No formatting, no extraction. `make_builder_call` additionally takes `worktree_root` and `provider` (Phase C, PR B) and dispatches: `claude_cli` uses the CLI's built-in tools, API providers get explicit worktree-scoped tools. The `Step<string, GenerateResult<Handoff>>` contract stays stable so `flow.ts` doesn't notice.
- `messages.ts` — `format_*` user-message builders. Pure string assembly.
- `render.ts` — `render_*` markdown builders for run artifacts (`IMPROVEMENT_SPEC.md`, `HANDOFF.md`, `PR_COMMENT.md`) and `assemble_final_result` for the discriminated-union output.
- `state.ts` — state key constants (`K`), `LoopState`, `next_loop_state`, `loop_converged`, and `read_*` helpers. The only place unsafe `as` casts on scope state are allowed.
- `engine.ts` — provider selection by env. Stub engine for tests/Phase A.
- `observability.ts` — `stdout_logger` for CloudWatch (paired with `filesystem_logger` via `tee_logger`).

## Why this beats imperative control flow

### 1. The agent topology is readable

You don't have to parse a 60-line async function to find the agents. `flow.ts` reads top-to-bottom as a tree of named primitives. Adding a new stage is "insert a stash." Adding a conditional is "wrap a branch." Adding a retry is "wrap a `retry`." None of these require imperative refactoring.

### 2. Trajectory observability is free

Every primitive emits a span via the runner's `dispatch_step`. The composition-first version produces ~35 spans per run with structural nesting that mirrors the topology — `branch` spans wrap `scope` spans wrap `stash` spans wrap individual `model_call` spans. The hand-rolled `for` loop produced 2 spans (the outer step, and the runner). The viewer and CloudWatch Logs Insights get rich structure with no extra code.

### 3. Stages are swappable in isolation

Phase A's builder is a one-shot `model_call({ schema: HandoffSchema })`. Phase B's builder is a `tool_loop` with worktree-scoped file tools. Both satisfy `Step<string, GenerateResult<Handoff>>`. Swapping them means rewriting `stages/builder.ts`'s body — `flow.ts`, `state.ts`, `messages.ts`, every other stage, all stay untouched. The composition shape *is* the integration contract.

### 4. State is named, not threaded

When the build-reviewer needs PR + spec + handoff + loop_input, that's:

```ts
use([K.PR, K.SPEC, K.LOOP_INPUT, K.HANDOFF], (s) =>
  format_build_review_message(read_pr(s), read_spec(s), read_handoff(s), read_loop_input(s)),
)
```

No threading four parameters through three layers of helper functions. Adding a new piece of state needed by a stage is "add a key to the `use` array." This composes naturally as the pipeline grows.

### 5. Provider portability lives in one place

`flow.ts` doesn't import `anthropic` or `openrouter` or `claude_cli`. It takes an `Engine` and routes every call through `model_call`. The engine is the only place the provider matters. Swapping `FASCICLE_PROVIDER=anthropic` to `FASCICLE_PROVIDER=openrouter` is one env var with zero code changes — the explicit acceptance criterion of this app.

### 6. Branching is data, not control flow

`branch({ when, then, otherwise })` is a value. You can describe it, log it, visualize it (Weft will draw it). An `if (suggestions.length === 0) return ...` inside a step body is invisible to the runner and the trajectory. Branches at the composition level are introspectable.

## Anti-patterns to avoid

### Don't bury model calls inside `step()` bodies

If a step's body calls `await someStep.run(input, ctx)` directly, you bypass `dispatch_step` and lose the trajectory span for that inner call. The `model_call`'s own cost/usage events still flow because `model_call` writes to `ctx.trajectory` directly, but you lose the structural nesting that makes the trajectory readable in the viewer.

If you find yourself doing this, the right fix is almost always to express the work as a `sequence([use(...), the_step, step('extract', ...)])`.

### Don't put control flow inside `step()` bodies

A `for` loop, an `if`/`else`, a try/catch with a fallback — all of these have a fascicle primitive: `loop`, `branch`, `fallback`. Using the primitive gets you trajectory spans, retry composability, and (with Weft) a visual representation. Hiding the same logic inside a step body gets none of those things.

The exception: a step body might do small bookkeeping arithmetic (`round + 1`, picking a field off an object). That's fine. The line is "would another agent pipeline want to compose around this decision?" If yes, lift it to a primitive.

### Don't let scope state types be `any`

`state.ts` is the choke point for the (necessarily) untyped scope state map. The `read_*` helpers are the *only* place `as` casts on scope state should appear. Stages and flow code import the readers, never the keys-with-cast pattern.

## When to revisit this design

The composition-first style has a cost: a small amount of indirection (`use([K.PR, K.SPEC], ...)`) where a less-disciplined codebase would just close over a variable. That cost is worth it as long as the pipeline benefits from being introspectable, swappable, and observable.

If a future stage genuinely needs imperative control flow that doesn't map to any primitive — three nested loops with shared mutable state, say — that's the signal to either (a) propose a new fascicle primitive in `@repo/core`, or (b) document why this stage is the exception. Hiding it inside a `step()` body without comment is not the answer.

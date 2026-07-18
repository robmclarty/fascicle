# The agent blueprint

A standard architecture for apps built on fascicle. [writing-a-harness.md](./writing-a-harness.md) covers the mechanics of wrapping a flow in a runnable program; this doc covers the *shape* of the codebase around it: where composition lives, where prompts live, and how to slice the modules so an agent stays legible and easy to change.

The blueprint is distilled from the reference apps in [`examples/`](../examples/) and from several production consumers of the published package. Every rule here earned its place by the presence of the pattern in codebases that stayed easy to work on, or by the pain of its absence in ones that did not.

## Why shape matters

Fascicle's power is that steps are plain values: anything with the same `Step<i, o>` type swaps for anything else, including whole compositions. That plug-and-play property is only worth something if your app has a place where the blocks are *visible*. When `model_call`, `sequence`, and `branch` are sprinkled through business logic, the topology of the agent exists only in the reader's head, and swapping a block means archaeology. When they are gathered into one composition layer, the topology is the file, and swapping a block is editing one line of it.

So the whole blueprint reduces to one rule and a set of module shapes that support it.

## The one rule

> **Give the agent exactly one composition layer.** One file the reader opens to see the entire topology, written in fascicle vocabulary only: `sequence`, `parallel`, `branch`, `loop`, `scope`, `stash`, `use`, `step`, `model_call`. Everything that is not shape (string formatting, IO, state transitions, extraction) lives in sibling modules and is plugged in as plain functions.

Call it `flow.ts`. A reader should be able to say "first the reviewer runs, then if there are suggestions the pragmatist runs, then a build-review loop bounded at three rounds" by reading top to bottom, without opening any other file. The canonical worked example is [`examples/pr-improve/src/flow.ts`](../examples/pr-improve/src/flow.ts) and its design rationale in [`examples/pr-improve/docs/architecture.md`](../examples/pr-improve/docs/architecture.md).

## Pick the right tier first

Not every app should be a full composition. Fascicle has three useful adoption tiers; pick the smallest one that keeps your topology legible, and pick it *per subsystem*, not per project (a deterministic CLI can be tier 0 while its eval harness is tier 1).

| Tier | Fascicle owns | You write | Reach for it when |
| --- | --- | --- | --- |
| **1. Engine only** | provider portability, schema enforcement, retries, cost | a plain async pipeline; model calls are leaf functions behind a small port | the pipeline is deterministic code and the model is a subroutine |
| **2. Orchestrated loop** | the control-flow skeleton: one `loop` / `sequence` at the top | phase modules the steps delegate to | an iterative build / check / critique loop that wants trajectory, resume, abort, and cost caps |
| **3. Composition-first** | the whole topology | leaf functions only | a multi-stage model pipeline with branches, fan-out, or convergence, where stages should be swappable |

**Tier 1** looks like a port: a single app-owned function type that the rest of the codebase depends on, with fascicle behind it.

```ts
export type CompleteRequest<T> = {
  label: string
  system?: string
  prompt: string
  schema: z.ZodType<T>
}
export type Complete = <T>(req: CompleteRequest<T>) => Promise<T>

export const fascicle_complete = (engine: Engine): Complete =>
  async <T>(req: CompleteRequest<T>): Promise<T> => {
    const call = model_call<T>({ engine, id: req.label, schema: req.schema,
      ...(req.system ? { system: req.system } : {}) })
    const result = await run(call, req.prompt)
    return result.content
  }
```

Business logic takes `Complete` as a dependency and never imports fascicle. You keep provider swap as a one-env-var change, structured output, retry, and cost accounting, without adopting the composition algebra. This tier is underrated: if your flow is a straight line of two calls, a port plus ordinary code reads better than `sequence([step, pipe(model_call, extract)])`.

**Tier 2** puts fascicle's `loop` at the top and nothing else:

```ts
const flow = loop<RunInput, LoopState, LoopState>({
  name: 'volley',
  init: (input) => input.resume_from ?? initial_state(),
  body: sequence([build, check, critique, record]),
  guard: step('gate', (s: LoopState) => gate(config, s)),
  finish: (s) => s,
  max_rounds: config.max_iterations,
})
```

Each of `build`, `check`, `critique`, `record` is a thin `step` that delegates to a phase module (`run_builder(deps, state, ctx)`); the loop's carry-state is one immutable record, spread-updated per step. Resume falls out of `init` for free. The guard is a pure, separately testable function.

**Tier 3** is the full pattern this doc describes. The rest of the blueprint assumes it; at lower tiers, drop the files you do not need.

Two signals you have over-composed:

- A "flow" that is a single `step` wrapping an imperative function, existing only to produce a named span. That is composition theater; a plain function with a `compose` label, or nothing, is honest.
- A linear two-node chain dressed in `sequence` / `pipe` / `branch` where a short-circuit forces you to thread a `{ result } | { next_input }` union or a mutable closure through the graph. Collapse it to one step. One consumer shipped both dialects side by side and the collapsed version won on every axis.

Two signals you have under-composed: an `if`/`for` inside a step body that another pipeline might want to compose around (lift it to `branch` / `loop` and get spans, retry composability, and describability for free), and a hand-rolled fan-out with `Promise.all` that wants `map`'s concurrency cap.

## The standard layout

```text
src/
  main.ts            the shell: input in, run() call, artifacts out, exit codes
  flow.ts            THE composition layer
  engine.ts          the only create_engine call site
  types.ts           zod schemas = the contracts between stages
  state.ts           scope keys and readers (only when using scope/stash/use)
  messages.ts        format_* user-message builders, pure string assembly
  render.ts          render_* builders for output artifacts
  prompts/           *.md system prompts, one file per role
  stages/            make_*_call factories, one file per model role
  tools/             make_* Tool factories, limits.ts, index.ts
  services/          plain IO modules (git, db, http) that steps wrap
```

Each module has one reason to exist and a strict import contract:

| Module | Owns | Must not contain |
| --- | --- | --- |
| `flow.ts` | topology, in fascicle vocabulary | string building, IO, business logic, `as` casts |
| `engine.ts` | env to `create_engine`, provider selection | anything about the flow |
| `stages/` | one `model_call` factory per role, prompt loading | message formatting, result extraction |
| `prompts/` | static role instruction as markdown | code, dynamic content |
| `messages.ts` | user-message assembly from typed inputs | fascicle imports |
| `types.ts` | zod schemas plus inferred types | logic |
| `state.ts` | stash key constants, typed readers | anything except keys and readers |
| `tools/` | `Tool` factories, shared safety, limits | prompt text, flow knowledge |
| `render.ts` | output artifacts (markdown, JSON reports) | model calls |
| `services/` | side-effecting domain IO | fascicle imports |
| `main.ts` | argv/HTTP in, `run(...)`, adapters, disposal | composition |

The names matter less than the contracts. What kills legibility is not calling the file `pipeline.ts` instead of `flow.ts`; it is a `format_reviewer_message` implemented inline in the flow, or a `model_call` hidden in a service.

## flow.ts

Rules, in order of importance:

1. **Only fascicle vocabulary and plugged-in names.** Every import is a stage factory, a `format_*` / `render_*` / `read_*` function, or a type. If you find yourself writing a template literal or an `await fetch` here, it belongs in a sibling.
2. **Export one builder**: `build_flow(engine, models, env): Step<In, Out>`. The engine and model choices arrive as arguments so the flow never touches `process.env` and tests can hand it a stub engine.
3. **Put the topology diagram in the file header.** An ASCII tree that mirrors the code below it is the cheapest architecture doc you will ever write, and drift is caught in review because they sit in the same diff.
4. **Recurring stage idiom**: a stage is a three-step sequence, and readers learn to see it as one unit.

```ts
const reviewer_subflow: Step<unknown, ReadonlyArray<Suggestion>> = sequence([
  use([K.PR], (s) => format_reviewer_message(read_pr(s))),
  reviewer_call,
  step('extract_suggestions', (r: GenerateResult<ReviewerOutput>) => r.content.suggestions),
])
```

Format from named state, call the model, extract the typed payload. Nothing else.

5. **Annotate the outer type of every named subflow** (`Step<In, Out>`). Heterogeneous `sequence` chains do not always infer end to end; explicit annotations catch mismatches at the boundary where they are introduced. If you are tempted to write `sequence([...]) as Step<In, Out>`, a step in the chain has the wrong type; fix that instead.
6. **The escape hatch, used honestly.** Occasionally wiring is data-dependent: a `map`'s inner step needs a value that only exists at runtime (a sandbox handle, a per-file root). Then a named `step` body may build and `await inner.run(input, ctx)` a sub-composition. This costs you structural spans for the inner nesting, so: give the step a name, keep the sub-composition small, and leave a comment saying why it could not be expressed statically. Unexplained buried control flow is the anti-pattern; the documented exception is fine.

## engine.ts

- **`create_engine` appears in exactly one file.** Everything else takes a ready-made `Engine`. This is the seam that makes provider swap a one-env-var change and tests trivial.
- Provider comes from one env var (`FASCICLE_PROVIDER` or your own name), validated through a zod enum. Models are threaded as data (a `FlowModels` record of role to model id), not read from env at call sites.
- **One source of truth for model defaults.** A recurring bug across consumers: defaults defined in `engine.ts`, redefined in `main.ts`, and env overrides that are parsed but never reach the flow. Define the role-to-model table once, resolve env overrides once, and pass the resolved record down.
- Dispose in `finally`, always: `try { await run(flow, input, opts) } finally { await engine.dispose() }`.

```ts
const ProviderSchema = z.enum(['anthropic', 'openrouter', 'claude_cli'])
export type Provider = z.infer<typeof ProviderSchema>

export function create_app_engine(cfg: AppEngineConfig): Engine {
  if (cfg.provider === 'claude_cli') {
    return create_engine({ providers: { claude_cli: { auth_mode: 'oauth' } } })
  }
  return create_engine({ providers: { [cfg.provider]: { api_key: cfg.api_key } } })
}
```

## prompts/: markdown, not string literals

System prompts are contract artifacts, not incidental strings. Keep them as markdown files, one per role, with frontmatter:

```markdown
---
name: reviewer
description: Reviews a PR diff and emits structured suggestions
model: sonnet
---

You are a senior code reviewer. Review the diff for clarity, correctness,
and complexity. Do not propose stylistic preferences or speculative refactors.
Cap your output at 10 suggestions.
```

Why files instead of `const REVIEWER_SYSTEM = \`...\``:

- A prompt diff in review is a prompt diff, not a code diff with noise. Changing a prompt *is* changing the agent's spec; it deserves the same review weight, and a `.md` diff renders cleanly.
- Non-engineers (and future you) can read and edit the role definition without parsing template-literal escapes.
- The frontmatter gives each role a home for per-role model and sampling defaults, next to the words they modify.

Two loading mechanisms, by weight:

**Simple agents: `define_agent`.** When an agent is a prompt plus an output schema, fascicle already does the whole job. The markdown body becomes the prompt (with `{{key}}` substitution against string fields of the input), or the system prompt when you supply `build_prompt`; frontmatter `model` / `temperature` become call defaults:

```ts
import { define_agent } from 'fascicle/agents'

const reviewer = define_agent({
  md_path: new URL('../prompts/reviewer.md', import.meta.url),
  schema: reviewer_output_schema,
  engine,
  build_prompt: (input: ReviewerInput) => format_reviewer_message(input),
})
```

**Stage factories: load the body as `system`.** When you need the full `GenerateResult` envelope (usage, cost, tool calls) or `model_call` options like `schema_repair_attempts` and `tools`, keep the stage factory and load the markdown at factory time. A minimal loader is about a dozen lines (split on the closing `---`, parse `key: value` pairs); write it once in `prompts/load.ts`.

```ts
export function make_reviewer_call(
  engine: Engine,
  model: string,
): Step<string, GenerateResult<ReviewerOutput>> {
  const prompt = load_prompt(new URL('../prompts/reviewer.md', import.meta.url))
  return model_call({
    engine,
    model: prompt.model ?? model,
    system: prompt.body,
    schema: reviewer_output_schema,
    schema_repair_attempts: 2,
    id: 'reviewer_call',
  })
}
```

Rules that keep this honest:

- **Static instruction in markdown; dynamic assembly in code.** The `.md` file holds the role, constraints, and output-format contract. Everything computed per call (the diff, prior feedback, iteration numbers) is assembled by a `format_*` function in `messages.ts` and sent as the user message. Do not interpolate runtime data into the system prompt.
- **Resolve paths with `new URL('...', import.meta.url)`**, never by walking parent directories. It works identically from `src/` under tsx and from `dist/` after build, provided your build copies `prompts/` alongside the output (add it to the package `files` list).
- **Give the first line of each prompt a stable role id** (`myapp/reviewer` or the frontmatter `name`). Stub engines route canned responses on it (see Testing), and trajectory readers orient by it.

## stages/: one factory per model role

A stage file is exactly two things: the prompt wiring and a factory.

```ts
export function make_builder_call(
  engine: Engine,
  model: string,
  worktree_root: string,
  provider: Provider,
): Step<string, GenerateResult<Handoff>> { ... }
```

The returned type, `Step<string, GenerateResult<Handoff>>`, is the integration contract, and it is the whole point of the layer. Behind that signature you can swap, without touching `flow.ts` or any other stage:

- a one-shot `model_call({ schema })` for a tool loop with `tools: make_builder_tools(root)` and `max_steps`
- provider dispatch: under `claude_cli` pass no tools and set `provider_options.claude_cli.allowed_tools` (the CLI brings its own); under API providers pass explicit worktree-scoped `Tool`s
- a different model, a retry wrapper, a `fallback` to a second provider

No formatting, no extraction, no flow knowledge. If a stage file imports `messages.ts`, the layering has broken.

## types.ts: schemas are the contracts

- **One zod schema per model boundary**, with `export type X = z.infer<typeof x_schema>` beside it. Pass the schema to `model_call({ schema })` and let the engine validate and repair; downstream code reads `r.content` fully typed and never parses model output itself.
- **Discriminated unions for verdicts and results** (`z.discriminatedUnion('kind', [...])` for model output, hand-written unions for app results that never cross a model boundary). Degraded outcomes are data (`{ kind: 'did_not_converge' }`), not exceptions; the shell maps them to messages and exit codes.
- **Keep prompt and schema from drifting apart.** The failure mode observed everywhere: output rules stated in the system prompt, restated in `.describe()` on schema fields, restated again in an auditor prompt, and now three copies to keep in sync. Pick one home per rule. Field-level constraints (length caps, enums, "empty when approved") belong in `.describe()` on the schema, which travels with the JSON schema the model sees. The prompt states the role and the one-line output contract ("respond with only the JSON object") and does not enumerate fields.
- Zod is for boundaries the model or the outside world crosses: model output, tool inputs, env/config, stdin. Internal row and record types do not need runtime validation.

## state.ts: quarantine the casts

Scope state (`scope` / `stash` / `use`) is a string-keyed map of `unknown`; something has to cast. Concentrate all of it here:

```ts
export const K = { PR: 'pr', SUGGESTIONS: 'suggestions', SPEC: 'spec' } as const

export function read_pr(s: ReadonlyMap<string, unknown>): PRContext {
  const v = s.get(K.PR)
  if (v === undefined) throw new Error(`scope state missing key "${K.PR}"`)
  return v as PRContext
}
```

The `read_*` helpers are the only place `as` appears on scope state. `flow.ts` writes `use([K.PR, K.SPEC], (s) => format_builder_message(read_pr(s), read_spec(s)))` and stays clean. Nothing enforces that `stash(K.PR, ...)` stored what `read_pr` claims, so keep keys and readers adjacent in this one file where a mismatch is visible in one screenful.

## tools/: capability factories

- One file per tool, exporting `make_<name>(root: string): Tool` (or a context object) so every tool closes over its confinement root rather than trusting the model's paths.
- Declare a zod `input_schema` and **re-parse inside `execute`**: `const input = read_file_input.parse(raw)`. Fascicle's `Tool` is invariant on input, so the parse keeps the wiring cast-free while the declared schema still drives what the model sees.
- Centralize limits (`MAX_FILE_BYTES`, timeouts, output caps) in `limits.ts` and interpolate them into tool descriptions, so the prompt text cannot drift from the enforcement.
- Shared safety in one place: a `resolve_within(root, path)` confinement check that every path-taking tool calls, symlink refusal, argv-array-only shell with an allowlist.
- **Error doctrine**: mistakes the model can correct (a failed edit match, a nonzero exit, a blocked URL) are *returned* as results for the model to read, pairing with `tool_error_policy: 'feed_back'`. Tools `throw` only on harness faults (containment violation, cap breach). Tools that must terminate a loop deterministically use `ends_turn: true`.
- An aggregator, `make_builder_tools(root): ReadonlyArray<Tool>`, is what stages import; role-scoped surfaces (builder gets write tools, reviewer read-only) live here, not in the flow.

## main.ts: the shell

- Parses input, resolves config, builds the engine, calls `run(flow, input, options)` once, and turns the result into artifacts, side effects, and an exit code. All external side effects (posting comments, pushing branches) happen *after* `run` returns, keyed off the typed result, so the flow stays replayable.
- Adapters are injected here and only here: `trajectory: filesystem_logger(...)`, `checkpoint_store: filesystem_store(...)`. Steps never construct their own logging.
- Pass `install_signal_handlers: false` everywhere except the one top-level run that should own Ctrl-C.
- Map fascicle's typed errors to exit codes in one small module, discriminating on error kind, and default the unknown case explicitly.

## Testing: stub the engine, not the flow

The `Engine` type is a small interface; a scripted stub is about 40 lines and lets you run the *real* flow through the *real* `run()` with zero network:

```ts
export function make_stub_engine(responses: ReadonlyArray<StubResponse>): Engine {
  return {
    generate: async <T>(opts: GenerateOptions<T>): Promise<GenerateResult<T>> => {
      const match = responses.find((r) => (opts.system ?? '').startsWith(r.match_system_prefix))
      if (!match) throw new Error('no canned response for this call')
      const parsed = opts.schema ? opts.schema.parse(match.content) : match.content
      return { content: parsed as T, tool_calls: [], steps: [], usage: { input_tokens: 0, output_tokens: 0 }, finish_reason: 'stop', model_resolved: { provider: 'stub', model_id: 'stub' } }
    },
    // remaining Engine members are no-ops
  }
}
```

Three details that make this pattern pay:

1. **Route canned responses by the prompt's stable first line** (or the `model_call` id). No mocking framework, and the routing key is the same one humans use to orient in trajectories.
2. **Validate canned content through the caller's own schema** (`opts.schema.parse(match.content)`). Fixtures then cannot drift from the contracts; a schema change breaks the test that ships stale data.
3. Because stages keep the `Step<In, GenerateResult<Out>>` contract, integration tests of `flow.ts` cover the topology (branching, looping, convergence) end to end, while stage internals (provider dispatch, tool surfaces) get their own focused tests with a capture engine.

Gate live tests on key presence (`describe.skipIf(!process.env.ANTHROPIC_API_KEY)`) and keep them few: one smoke per provider path.

## Naming conventions

Match fascicle's own surface: `snake_case` for values and functions, `PascalCase` for types only. The uniform seam matters; half camelCase apps end up writing translation shims at every fascicle boundary.

| Prefix / shape | Meaning |
| --- | --- |
| `make_<x>` | factory returning a leaf value: a `model_call` step, a `Tool`, a stub engine |
| `build_<x>` | factory returning a composition: `build_flow`, `build_review_loop` |
| `format_<x>` | pure user-message builder in `messages.ts` |
| `render_<x>` | pure output-artifact builder in `render.ts` |
| `read_<x>` | scope-state reader in `state.ts` |
| `<x>_schema` | zod schema; inferred type `X` beside it |
| `K` | the stash-key const object |
| step ids | `snake_case` verbs (`extract_suggestions`), or `<flow>.<leaf>` in larger apps; ids are trajectory labels, name them for the reader of the span tree |

## Anti-patterns

Each of these was observed in the wild; the fix is in parentheses.

1. **Fascicle calls scattered through business logic.** The topology becomes unreadable and unswappable (gather into one composition layer, or drop to tier 1 and hide fascicle behind a port).
2. **Control flow buried in step bodies.** An `if` / `for` / try-fallback inside a `step` is invisible to trajectories and to `describe` (lift to `branch` / `loop` / `fallback`; the test: would another pipeline want to compose around this decision?).
3. **Composition theater.** Single-step "flows" whose only contribution is a span name, or combinator chains around a linear two-call sequence that force unions and mutable closures through the data channel (collapse to a step, or to plain code behind a port).
4. **Two sources of truth for model defaults**, and env overrides that are parsed but never reach the flow (one role-to-model table, resolved once, passed as data).
5. **Output rules stated in three places**: system prompt, `.describe()`, auditor prompt (one home per rule; schema for field constraints, prompt for the role).
6. **Mutable closures smuggled through the graph** (`let stopped = false` captured by three steps). Loop carry-state and accretion result types (`ViewsResult = ClusterResult & {...}`) express the same thing inside the type system.
7. **Stringly-typed cross-module contracts**: matching on `err.message === 'Retries exhausted'`, duck-typing a provider-reported blob (typed error kinds and typed accessors; if fascicle does not export the shape you need, request the export rather than mirroring internals that will drift).
8. **Capability built ahead of adoption**: exported atoms, adapters, and retry policies that no production path calls. Dead abstraction reads as load-bearing and taxes every refactor (build the layer when the second caller arrives).
9. **Anonymous steps in checkpointed or observed flows.** `checkpoint` rejects them at construction, and unnamed spans make trajectories unreadable (name every step you might resume or watch).
10. **Version-coupled workarounds without an exit condition.** When you must work around a substrate bug, write the workaround where it lives, cite the version, and state what change lets you delete it.

## Enforce it with rules

Conventions decay; machine-checked conventions do not. The consumers that stayed clean all enforce the blueprint with [ast-grep](https://ast-grep.github.io/) rules in CI. Working, tested copies of the three rules below live in [`examples/pr-improve/rules/`](../examples/pr-improve/rules/), wired through [`examples/pr-improve/sgconfig.yml`](../examples/pr-improve/sgconfig.yml) and runnable with `pnpm --filter ./examples/pr-improve check:rules`. Copy that directory into your own app as a starting point.

Rule 1 — [`create-engine-only-in-engine.yml`](../examples/pr-improve/rules/create-engine-only-in-engine.yml): the one-engine-factory seam.

```yaml
id: create-engine-only-in-engine
message: "create_engine may be called in exactly one file: src/engine.ts."
severity: error
language: typescript
files:
  - src/**/*.ts
ignores:
  - src/**/__tests__/**
  - src/engine.ts
rule:
  pattern: create_engine($$$)
```

Rule 2 — [`flow-no-imperative-loops.yml`](../examples/pr-improve/rules/flow-no-imperative-loops.yml): iteration in the composition layer goes through `loop()`/`map()`.

```yaml
id: flow-no-imperative-loops
message: "The composition layer expresses iteration with loop()/map(), not for/while/do."
severity: error
language: typescript
files:
  - src/flow.ts
rule:
  any:
    - kind: for_statement
    - kind: for_in_statement
    - kind: while_statement
    - kind: do_statement
```

Rule 3 — [`fascicle-value-imports-confined.yml`](../examples/pr-improve/rules/fascicle-value-imports-confined.yml): value imports from `fascicle` are allowed only in `engine.ts` (`create_engine`), `flow.ts` (composition), `main.ts` (`run`), and `stages/**` (`model_call`); everywhere else, `import type` stays free. The brace/default/namespace patterns match value imports without matching `import type { ... }`, so business logic files that need only fascicle types are untouched. If your app uses subpath imports (`fascicle/adapters`, `fascicle/mcp`), widen the `$PATH` regex to `^fascicle(/|$)` and add `main.ts` / `tools/**` to the ignore list as appropriate.

```yaml
id: fascicle-value-imports-confined
severity: error
language: typescript
files:
  - src/**/*.ts
ignores:
  - src/**/__tests__/**
  - src/engine.ts
  - src/flow.ts
  - src/main.ts
  - src/stages/**/*.ts
rule:
  any:
    - pattern: import { $$$ } from '$PATH'
    - pattern: import { $$$ } from "$PATH"
    - pattern: import $NAME from '$PATH'
    - pattern: import $NAME from "$PATH"
    - pattern: import * as $NAME from '$PATH'
    - pattern: import * as $NAME from "$PATH"
constraints:
  PATH:
    regex: '^fascicle$'
```

Add a rule per boundary you care about; each is a few lines and turns an architecture review comment into a build failure.

## Checklist

Before calling an agent app done:

- [ ] One composition layer exists and contains only fascicle vocabulary; the header diagram matches the code.
- [ ] `create_engine` appears in exactly one file; provider swap is one env var; disposal is in `finally`.
- [ ] Every model boundary has a zod schema in `types.ts`; stages return `Step<In, GenerateResult<Out>>`.
- [ ] System prompts are markdown files with frontmatter; dynamic content is assembled in `messages.ts`.
- [ ] Scope-state casts live only in `state.ts` readers.
- [ ] Tools re-parse inputs, share one confinement helper, and centralize limits.
- [ ] The flow runs end to end against a stub engine that validates fixtures through the real schemas.
- [ ] Adapters are injected only at `run(...)`; side effects happen after `run` returns.
- [ ] The boundaries are enforced by lint rules, not memory.

## Further reading

- [writing-a-harness.md](./writing-a-harness.md) for the runnable-program mechanics around the flow
- [composition.md](./composition.md) for the full primitive surface
- [cookbook.md](./cookbook.md) for worked composition patterns
- [`examples/pr-improve/`](../examples/pr-improve/) for the canonical tier-3 reference, and [`examples/pr-improve/docs/architecture.md`](../examples/pr-improve/docs/architecture.md) for its rationale

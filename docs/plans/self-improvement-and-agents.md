# Self-improvement loops + agents

Implementation plan for two ideas from [ideas.md](./ideas.md):

1. **Self-improvement** as a first-class composer (`learn`, optionally `distill`).
2. **Agents** (`reviewer`, `researcher`, `documenter`) as a proof-of-abstraction package.

Order is intentional: `learn` deepens the library; agents consume it. Build `learn` first.

---

## Part 1 — `learn`: self-improvement composer

### What it is

A composer that takes a flow and a corpus of trajectories from prior runs of that flow, asks an analyzer step to propose improvements, and returns those proposals (and optionally applies them).

The `amplify` example (`examples/amplify/src/loop.ts`) is the canonical *online* version of this pattern: propose → score → accept/reject, accumulating lessons. `learn` is the *offline* counterpart: read what already happened, distill what to change next.

This split matters. Online improvement is a tight loop bounded by an evaluator; offline improvement is reflection across many runs without an evaluator in the loop. Most agent libraries do neither. Doing the offline one is the novel direction.

### Where it lives

**`@repo/composites/src/learn.ts`** (sibling of `ensemble`, `tournament`, `consensus`, `adversarial`).

Reasoning:

- It composes existing primitives (`step` + user-supplied analyzer); it is not a new control-flow mechanism.
- It does not need to register a new `kind` in `STEP_KINDS` if implemented as a `step` factory. (Decision below.)
- It is a *pattern*, not an *axiom* — exactly what `composites` is for.

If the dispatcher needs custom span semantics (e.g. nested spans for `read → analyze → propose`), promote it to a registered kind. Default to `step`-based until that need is concrete.

### API

```ts
import type { Step, TrajectoryEvent } from '@repo/core';

export type TrajectorySource =
  | { readonly kind: 'paths'; readonly paths: ReadonlyArray<string> }
  | { readonly kind: 'events'; readonly events: ReadonlyArray<TrajectoryEvent> }
  | { readonly kind: 'dir'; readonly dir: string }; // reads *.jsonl recursively

export type LearnInput = {
  readonly flow_description: string;   // typically describe(flow)
  readonly events: ReadonlyArray<TrajectoryEvent>;
  readonly prior?: unknown;             // last round's improvements, for iteration
};

export type Improvement = {
  readonly target: string;              // step id, span name, or free-form locator
  readonly kind: 'prompt' | 'config' | 'structure' | 'note';
  readonly rationale: string;
  readonly suggestion: string;
};

export type LearnConfig<I extends LearnInput, O> = {
  readonly name?: string;
  readonly flow: Step<unknown, unknown>; // the flow being studied (for describe + identity)
  readonly source: TrajectorySource;
  readonly analyzer: Step<I, O>;         // user-supplied; produces Improvements (or richer)
  readonly filter?: (e: TrajectoryEvent) => boolean; // optional pre-filter
  readonly max_events?: number;          // safety cap; default 10_000
};

export type LearnResult<O> = {
  readonly proposals: O;
  readonly events_considered: number;
  readonly run_ids: ReadonlyArray<string>;
};

export function learn<I extends LearnInput, O>(
  config: LearnConfig<I, O>,
): Step<unknown, LearnResult<O>>;
```

Why generic over `analyzer`'s output: the proposal shape is domain-specific. Some users want `Improvement[]`; some want a structured patch; some want a textual report. Forcing one shape is wrong. We provide `Improvement` as a recommended convention but never require it.

### Implementation outline

`packages/composites/src/learn.ts`:

1. Construct as a `step('learn', async (_, ctx) => { ... })`.
2. Resolve `source`:
   - `paths` / `dir` → read JSONL files, parse each line via `trajectory_event_schema` from `@repo/core`. Skip malformed lines and emit `learn.parse_error` trajectory events with line offsets.
   - `events` → use directly.
3. Apply `filter` and `max_events` cap. Track unique `run_id` values across events.
4. Build `LearnInput`:
   - `flow_description` = `describe(config.flow)` (text form).
   - `events` = filtered list.
   - `prior` = `undefined` on first call (caller threads via `loop` if iterating).
5. Dispatch the analyzer via the runner's `dispatch_step` so its spans nest under the `learn` span.
6. Emit a `learn.summary` trajectory event with `events_considered`, `run_ids`, and any high-level analyzer signal.
7. Return `LearnResult<O>`.

Key invariants:

- No engine dependency. `learn` does not call any LLM directly — the analyzer step does.
- No filesystem assumption beyond reading the trajectory source. No writes.
- Honors `ctx.abort` — long file reads must check abort between files.

### Tests (`packages/composites/src/learn.test.ts`)

Mirror the conventions in `loop.test.ts` and `ensemble.test.ts`:

- `'reads JSONL paths and forwards events to analyzer'` — synthesize three small JSONL files in `os.tmpdir()`, assert the analyzer receives every event.
- `'filter prunes events before analyzer sees them'`.
- `'max_events caps oversized inputs and records a truncation event'`.
- `'malformed lines record parse errors and continue'`.
- `'propagates abort while reading'` — pass an aborted signal via `RunContext`, assert no analyzer call.
- `'spans nest correctly'` — `recording_logger`, assert `span_start(learn) → span_start(analyzer) → span_end(analyzer) → span_end(learn)`.
- `'flow_description matches describe(flow)'` — run `describe()` and compare.

### Integration touch points

- **Exports** — add to `packages/composites/src/index.ts`:
  ```ts
  export { learn } from './learn.js';
  export type { LearnConfig, LearnInput, LearnResult, Improvement, TrajectorySource } from './learn.js';
  ```
- **No changes to `@repo/core`** if implemented via `step()`. Confirm by running `pnpm check` after the first cut.
- **`packages/fascicle`** — that umbrella re-exports `@repo/core` only today. Decide whether to fold composites into the umbrella (separate question; track in a follow-up). For this work, importers should `import { learn } from '@repo/composites'`.

### Optional follow-up: `distill`

`distill(flow, examples)` extracts a smaller / cheaper / more direct flow from a corpus of (input, output) pairs harvested from trajectories. This is meaningfully more ambitious — it produces *flows*, not *proposals*. Treat it as a separate plan once `learn` lands and we have real usage to inform the API. **Out of scope here.**

---

## Part 2 — `@repo/agents` package

### Stance

ideas.md says explicitly: *"Useful as proof of the abstraction, but adds maintenance surface and doesn't deepen the library itself."* Keep that bar.

Most "agent" code in the wild is one prompt and one output schema with a thin wrapper around them. We lean into that: simple agents are **markdown + schema**, loaded by a tiny `define_agent` helper. Agents that genuinely need flow logic stay as bespoke TypeScript.

Each agent must:

- Be a pure factory returning `Step<input, output>` — no global state, no config files outside its own directory.
- Use only the public surface of `@repo/core`, `@repo/composites`, `@repo/engine`. No private imports.
- Be exercised by `examples/` so we have lived proof the abstraction holds.

If an agent strains those constraints, that is a finding about the library, not a reason to stretch the agent.

### Package layout

```
packages/agents/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts                   # re-exports each agent + define_agent
    ├── define_agent.ts            # the markdown-driven loader
    ├── define_agent.test.ts
    ├── reviewer/
    │   ├── index.ts               # public factory: reviewer({ engine })
    │   ├── prompt.md              # frontmatter + system prompt
    │   ├── schema.ts              # Zod output schema + input/output types
    │   └── reviewer.test.ts
    ├── documenter/
    │   ├── index.ts
    │   ├── prompt.md
    │   ├── schema.ts
    │   └── documenter.test.ts
    └── researcher/
        ├── index.ts               # bespoke TS — has real flow logic
        └── researcher.test.ts
```

`package.json` mirrors `packages/composites/package.json`:

- name: `@repo/agents` (private workspace; public name decided later)
- dependencies: `@repo/core`, `@repo/composites`, `@repo/engine` (workspace)
- peerDependencies: `zod`
- scripts: `build`, `check`, `test` matching project conventions
- build must copy `**/*.md` into `dist/` so prompts ship alongside compiled JS

### `define_agent` — the markdown loader

Most of an "agent" is its system prompt and its output shape. A loader lets us keep the prompt as content and the schema as code, with a one-line factory glueing them.

#### Markdown contract

`prompt.md` uses YAML frontmatter:

```md
---
name: reviewer            # required; used as the step's display_name
description: One-liner.        # optional; surfaced in describe()
model?: string                 # optional; engine alias or full id
temperature?: number           # optional
---

You are a code reviewer. ...
(body is the system prompt; supports {{placeholders}} resolved from input)
```

The body supports a minimal `{{key}}` template syntax — only top-level string fields of the input are substituted. No conditionals, no loops, no partials. If the input shape is non-trivial, the agent's `index.ts` builds the prompt itself and passes it to `define_agent` via `build_prompt`.

#### API

```ts
import type { Engine } from '@repo/engine';
import type { Step } from '@repo/core';
import type { z } from 'zod';

export type DefineAgentConfig<I, O> = {
  readonly md_path: string | URL;       // resolved relative to caller (import.meta.url)
  readonly schema: z.ZodType<O>;
  readonly engine: Engine;
  readonly name?: string;                // override frontmatter name
  readonly build_prompt?: (input: I) => string | { user: string; system?: string };
};

export function define_agent<I, O>(config: DefineAgentConfig<I, O>): Step<I, O>;
```

Behavior:

- Reads `md_path` once at factory time (cached). Parses frontmatter via a tiny parser (keep it ~50 LOC; do not pull in `gray-matter` for one feature).
- Returns a `step(name, async (input, ctx) => { ... })` that:
  1. Resolves the user prompt: `build_prompt(input)` if provided, else `{{key}}` substitution on the body.
  2. Calls `engine.generate({ system, prompt, schema, model, temperature })`.
  3. Records a `agent.call` trajectory event with `name`, `model`, and token usage if the engine surfaces it.
  4. Returns the parsed output. Schema errors surface with the step id prepended (runner does this for free).
- No retry, no fallback baked in. Callers wrap with `retry()` from core if they want it.

#### Tests (`define_agent.test.ts`)

- `'parses frontmatter and substitutes {{name}} placeholders'`.
- `'build_prompt overrides body substitution when provided'`.
- `'engine receives schema and returns parsed output'` — mock `engine.generate`.
- `'malformed frontmatter throws at factory time, not call time'`.
- `'records agent.call trajectory event'`.

### Agent designs

#### `reviewer` (markdown-defined)

`packages/agents/src/reviewer/schema.ts`:

```ts
import { z } from 'zod';

export const review_finding_schema = z.object({
  severity: z.enum(['info', 'minor', 'major', 'blocker']),
  file: z.string().optional(),
  line: z.number().int().optional(),
  category: z.string(),
  message: z.string(),
  suggestion: z.string().optional(),
});

export const reviewer_output_schema = z.object({
  findings: z.array(review_finding_schema),
  summary: z.string(),
});

export type ReviewerInput = {
  readonly diff: string;
  readonly focus?: ReadonlyArray<'correctness' | 'security' | 'style' | 'tests'>;
};
export type ReviewerOutput = z.infer<typeof reviewer_output_schema>;
```

`packages/agents/src/reviewer/index.ts`:

```ts
import { define_agent } from '../define_agent.js';
import { reviewer_output_schema, type ReviewerInput, type ReviewerOutput } from './schema.js';
import type { Engine } from '@repo/engine';
import type { Step } from '@repo/core';

export function reviewer(config: { engine: Engine; name?: string }): Step<ReviewerInput, ReviewerOutput> {
  return define_agent<ReviewerInput, ReviewerOutput>({
    md_path: new URL('./prompt.md', import.meta.url),
    schema: reviewer_output_schema,
    engine: config.engine,
    name: config.name,
    build_prompt: (input) => {
      const focus = input.focus?.length ? `Focus areas: ${input.focus.join(', ')}.\n\n` : '';
      return `${focus}Diff:\n\n${input.diff}`;
    },
  });
}
```

`packages/agents/src/reviewer/prompt.md`: frontmatter + a hand-tuned system prompt. Lives in source control so it can be reviewed and improved without touching code.

#### `documenter` (markdown-defined)

Same shape as `reviewer`. Schema enforces `{ doc: string; inferred_purpose: string }`. `build_prompt` formats the target (`file` vs `symbol` discriminated union) into the user message and threads the requested style (`tsdoc | jsdoc | markdown`) through.

#### `researcher` (bespoke TS)

Stays as TypeScript because it iterates over injected tools — that is real flow logic, not a single prompt.

```ts
export type ResearcherInput = {
  readonly query: string;
  readonly depth?: 'shallow' | 'standard' | 'deep';
};
export type ResearcherOutput = {
  readonly brief: string;
  readonly sources: ReadonlyArray<{ url: string; title?: string; quote?: string }>;
  readonly notes: string;
};
export function researcher(config: {
  engine: Engine;
  search: (q: string, ctx: RunContext) => Promise<Array<{ url: string; title?: string; snippet?: string }>>;
  fetch: (url: string, ctx: RunContext) => Promise<string>;
  name?: string;
}): Step<ResearcherInput, ResearcherOutput>;
```

Internally: `loop` over (search → pick top-k → fetch → summarize → decide-stop), with per-depth round caps. Reuses `loop` from `@repo/core`. The summarizer is itself a small `define_agent` instance — so even the bespoke agent eats its own dogfood.

### Tests

For each agent:

- **Pure tests** (no LLM): construct with a mock `Engine` whose `generate` returns deterministic structured output. Assert input normalization, output shape, and trajectory span structure.
- **Schema tests**: feed malformed mock output and verify the error surfaces with a useful path.
- **Abort propagation test** (research only, since it iterates).

No live-LLM tests in CI. Live exercises live in `examples/`.

### Examples (proof of abstraction)

Add three small files under `examples/`:

- `examples/reviewer.ts` — wires `reviewer` against the engine, runs it on a hand-crafted diff, prints findings.
- `examples/researcher.ts` — wires `researcher` with a tiny mock search/fetch, asserts brief is non-empty.
- `examples/documenter.ts` — generates docs for a single function literal.

Each is a single file (matching `examples/hello.ts`, `examples/ensemble_judge.ts` style). Not workspace entries unless they grow harnesses.

---

## Build sequence

Numbered for clarity; each numbered step ends with green `pnpm check`.

1. **`learn` skeleton** — write `packages/composites/src/learn.ts` with the `events` source path only (no file IO). Tests cover analyzer dispatch, span nesting, and abort.
2. **`learn` IO** — add `paths` and `dir` sources. Tests cover JSONL parsing, malformed lines, `max_events`, `filter`.
3. **`learn` exports** — add to `packages/composites/src/index.ts`. Run `pnpm check:all` for the umbrella state.
4. **`learn` example** — add `examples/learn.ts` that reads a small synthetic trajectory file and runs a trivial analyzer step. Sanity check the API ergonomically.
5. **`@repo/agents` package skeleton** — `package.json`, `tsconfig.json`, empty `index.ts`, wired into `pnpm-workspace.yaml`. Build script copies `**/*.md` into `dist/`. `pnpm check`.
6. **`define_agent` loader** — frontmatter parser, `{{key}}` substitution, schema dispatch, trajectory event. Tests cover frontmatter parsing, substitution, override via `build_prompt`, and parse-time vs call-time error timing.
7. **`reviewer`** — `prompt.md` + `schema.ts` + `index.ts`, test with mock engine, add `examples/reviewer.ts`.
8. **`documenter`** — same shape as reviewer, add `examples/documenter.ts`.
9. **`researcher`** — bespoke TS (uses `loop` + a `define_agent`-built summarizer), test with mock engine + injected search/fetch, add `examples/researcher.ts`.
10. **End-to-end demo** — one example that combines `reviewer` with `learn`: run the reviewer on N diffs, then run `learn` over the trajectory to propose prompt improvements. This is the proof point.
11. **`pnpm check:all`** including mutation, then update `docs/plans/ideas.md` to strike or annotate the two implemented bullets.

Each step is independently mergeable. Steps 1–4 deliver `learn` standalone; steps 5–9 deliver agents standalone; step 10 ties them.

---

## Decisions deferred

- **`learn` as a registered kind?** Default no; revisit if span semantics require it.
- **Folding `@repo/composites` and `@repo/agents` into the `fascicle` umbrella export.** Separate plan; not blocking.
- **Public name for `@repo/agents`.** Private until we know whether they ship as one package or as `@fascicle/reviewer` etc.
- **Markdown templating depth.** v1 only does `{{key}}` for top-level string fields. Anything richer goes through `build_prompt`. Revisit only if a real agent needs more.
- **`distill`.** Out of scope; revisit after `learn` has a real user.

---

## What this plan deliberately does not do

- No trajectory viewer / replay UI (tracked separately as "Trajectory tooling" in ideas.md).
- No eval harness / `bench` primitive (tracked as "Eval / regression harness").
- No new core primitives. Everything proposed is a composite or an agent.
- No changes to existing composites or core. If implementation reveals a missing core hook, that becomes its own discussion.

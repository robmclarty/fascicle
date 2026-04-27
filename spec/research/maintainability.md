# Research: Maintainability / Simplicity

Raw output from the maintainability research agent. Preserved verbatim. Consulted by `spec/studio.md` §3, §4, §6, §8, §9, §10. The PDR adopts most of this report's recommendations; the few divergences are noted in `spec/studio.md` §14.

---

## 1. Architecture: where it lives

**Pick: Option C — `apps/studio/` outside the `@repo/*` namespace.** Plus a tiny `@repo/studio-protocol` package for shared types only.

Why not A (`@repo/studio` re-exported as `fascicle/studio`):
- The umbrella is published as `fascicle` (`packages/fascicle/src/index.ts` re-exports `@repo/core` + `@repo/engine`). Adding a React/Vite UI through the umbrella means `pnpm add fascicle` in a backend pulls a frontend toolchain into `node_modules`, even with an `exports` subpath. The library is one bundle today (`tsdown.config.ts`), and that simplicity is load-bearing.
- The existing rules (`rules/no-adapter-import-from-core.yml`, `rules/no-composer-cross-import.yml`, `rules/no-process-env-in-core.yml`, the snake-case rule) all glob `packages/*/src/**`. A React workspace under `packages/` would either trip rules or force every rule to add an exclusion — a smell that fights the codebase.
- Fallow's boundary checker and the `core`/`engine` production-deps audit (`scripts/check-deps.mjs`) treat `packages/*` as the library surface. The studio is not the library.

Why not B (separate sibling repo): you lose `pnpm check:all` as the single gate, you lose ast-grep rules sharing, and the core surfaces the studio needs (§5) become harder to evolve in lockstep.

**Layout:**

```
apps/studio/                # React app, Vite, NOT in @repo/*
apps/studio-server/         # tiny Node HTTP+SSE host
packages/studio-protocol/   # @repo/studio-protocol — type-only event union, route names
```

`packages/studio-protocol/` *does* live under `packages/*` and follows all conventions. It exports types, route constants, and a Zod schema for the event union. The library and the app both depend on it. It is the only studio code subject to fascicle's existing rules.

The umbrella never re-exports studio. `fascicle` stays the same shape it is today. To attach the studio to a running flow, users run `npx fascicle-studio` (CLI in `apps/studio-server`) or call `attach_studio(...)` from a *separate* package `@repo/studio-attach` (server only, no React). That helper takes a `TrajectoryLogger`-shaped sink and an HTTP port.

Bundle-size impact on `fascicle` library: zero. That is the point.

## 2. Server contract: smallest possible

**Pick: HTTP + SSE, no WebSocket, no file-watch in v1.**

Rationale: the existing `TrajectoryLogger` (see `packages/core/src/types.ts:14-24`) is push-only and append-only. SSE matches that shape exactly: one TCP connection, server pushes lines, client reconnects with `Last-Event-ID`. It is half the code of WebSocket, browsers handle reconnection natively, and it survives proxies. File-watching `.trajectory.jsonl` is tempting but couples the studio to the filesystem logger and breaks for users using `noop_logger` or a custom sink.

**Routes:**

```
GET  /api/graph                 -> FlowNode (the existing describe.json output)
GET  /api/events                -> text/event-stream of TrajectoryEvent
POST /api/runs                  -> { run_id }     (v2)
GET  /api/runs/:id/events       -> SSE filtered by run_id
```

**Event shape** (already 90% of what `TrajectoryEvent` is — keep the loose `Record` for v1, tighten in §5):

```
event: message
id: 42
data: {"kind":"span_start","span_id":"sequence:abc12345","name":"sequence","run_id":"r1"}
```

**Embedding:** ship `attach_studio({ port, trajectory_path })` as a tiny harness helper. It opens an HTTP server that tails an in-memory ring buffer of the last N events (so a late-connecting browser sees recent history), reads the static graph from `describe.json(flow)`, and serves `apps/studio/dist` from disk. Users who already have an HTTP server use the SSE handler directly. Total server LOC target: under 300.

## 3. Frontend stack

**Pick: React + React Flow + Tailwind + Vite.**

This is the boring answer and it is correct.

- React Flow is the only library on the list with first-class graph primitives, viewport controls, mini-map, and edge routing already done. Building this on Solid + custom canvas or Pixi is a 6-month detour for v1.
- React is what every LLM in production has the most training data on. Claude edits React with substantially fewer mistakes than Solid or Svelte. That is a maintainability argument, not a fashion one.
- Vite + Tailwind is two config files and zero ceremony. SvelteKit and Vue 3 + Vue Flow both work but bring smaller communities and less LLM signal; svelte-flow is younger than React Flow.
- "Hundreds of animated nodes" is well within React Flow's documented envelope. If profiling later shows render pressure, swap node renderers for `<canvas>` or memoize harder — don't pre-optimize by picking Pixi.

Reject Solid+canvas and Pixi: both are "smart" choices that cost a maintainer who values reading the code in an afternoon.

## 4. Code-style rules: which to extend

| Rule | Studio? | Position |
|---|---|---|
| TypeScript strict | **Yes, identical.** | Non-negotiable. |
| No classes | **Yes, with one carve-out.** | No app-level classes. State stores: use Zustand or a plain `create_store(initial)` factory returning getters/setters. Allow class only if a third-party API forces it (none of the recommended stack does). |
| Named exports only | **Yes, identical.** | React components are functions; named exports work fine. Vite/React Flow examples use defaults by convention, not requirement. The `rules/no-default-export.yml` rule should glob `apps/studio/**` too. |
| snake_case identifiers | **Partial.** Local variables, helpers, hooks, and event field names stay snake_case. **Components stay PascalCase** because JSX requires capitalization to distinguish components from intrinsics (`<node_panel/>` is invalid JSX, `<NodePanel/>` is a component). Hook names follow React convention `use_node_state` (snake) — this is consistent with snake_case for functions. Codify in a new ast-grep rule scoped to `apps/studio/**`. |
| File extensions `.js` on imports | **Yes for `packages/studio-protocol`. No for `apps/studio`** — Vite resolves without extensions and forcing `.js` on `.tsx` confuses tooling. |
| Tests colocated | **Yes.** `node_panel.tsx` + `node_panel.test.tsx`. |
| Coverage floor 70% | **Yes for protocol, lower for UI (50%).** Visual code is harder to unit-test profitably; spend that budget on Playwright (§7). |

## 5. Core surfaces fascicle needs to add (ranked)

1. **Stable `step.kind` registry as a const string union.** Today `kind` is `string` on `Step<i,o>`. Studio palette needs to know the closed set. Risk: low — already de facto closed (16 primitives). Just export `STEP_KINDS` from `@repo/core`.
2. **Structured `TrajectoryEvent` discriminated union.** Replace the loose `Record<string, unknown>` (`packages/core/src/types.ts:14`) with a union: `span_start | span_end | model_chunk | tool_call | error | custom`. Risk: medium — adapters (filesystem logger, `engine/src/trajectory.ts`) emit ad-hoc fields. Solve by keeping a `custom` variant with `data: Record<string, unknown>` so external emitters aren't broken.
3. **Deterministic step ids.** `describe.json` already returns ids; verify they're stable across runs of the same flow. If they're random, studio cannot correlate events to graph nodes. Risk: low — likely already deterministic from `step.ts`, just needs a contract test.
4. **`step({ display_name, description, port_labels })` metadata at construction.** Optional fields stored on the step. `describe.json` echoes them. Risk: low; purely additive. Critical for v2 codegen and for human-readable studio UX.
5. **`from_json(FlowNode) -> Step<i,o>`.** Round-trip for v2 codegen. Risk: high — re-creating closures from JSON requires a function registry. Defer; specify only the JSON schema for v1 and treat codegen as text emission.
6. **`run_id` propagation into every event.** Studio multiplexes runs. Today `RunContext` has `run_id` but events don't always carry it. Risk: low; thread it through `filesystem.ts` and `engine/src/trajectory.ts`.

## 6. LLM-friendliness patterns for the studio (six)

1. **Graph-as-data.** Persist as `{ nodes: NodeData[]; edges: EdgeData[] }` plain JSON. Never store a class instance, never store React Flow's internal node objects directly.
2. **Pure functions for graph transforms.** `add_node(graph, node) -> graph`, `connect(graph, from, to) -> graph`, `to_fascicle_code(graph) -> string`. Each importable, each testable without a DOM.
3. **One constants module per layer.** `apps/studio/src/constants.ts` for UI strings, route names, event kinds. No magic strings inline. (Mirrors fascicle's existing discipline.)
4. **Flat components, no prop drilling.** Top level reads from the store; leaves call hooks. No more than two levels of prop passing before hoisting to context or store.
5. **One file per component, colocated test, colocated stories (if Storybook).** Same shape as fascicle's `foo.ts` + `foo.test.ts`.
6. **No effects for derived state.** If it can be computed from props/store, compute it. `useEffect` only for subscriptions (SSE) and imperative integrations (React Flow refs).

## 7. CI integration

Add to `pnpm check`:

- **types** — `tsc --noEmit` already globs everything; just include `apps/studio/**`.
- **lint** — extend oxlint config; same rules.
- **ast-grep** — add `rules/studio-pascalcase-components.yml` (component names only) scoped to `apps/studio/**`. Keep all other rules globbed across both.
- **fallow** — point at `apps/studio` and `apps/studio-server` as additional roots.
- **vitest** — already globs; tests will be picked up.
- **markdownlint, cspell** — already glob.

Skip in v1: **Stryker mutation testing for studio code** (UI mutation testing is low-ROI), **visual regression** (defer), **bundle-size budget** (defer).

Add as **opt-in** (like `mutation`):
- `pnpm check --include e2e` runs Playwright headless smoke (load app, see a graph, see an SSE event).
- `pnpm check --include studio-build` runs `vite build`. Required before publish, opt-in during inner loops.

Required in v1 default `pnpm check`: types, lint, ast-grep, fallow, vitest, markdownlint, cspell — everything currently required.

## 8. Claude-editing sensors (five most valuable)

1. **Playwright MCP server** (already wired in this environment). Not for full e2e in CI necessarily, but so Claude can verify "I changed the node panel; does the page still render?" without asking the human.
2. **Storybook + a `storybook test` runner.** Component snapshots give Claude a fast "did this break the visual contract?" loop. Skip Chromatic/visual regression for v1; just `play()` interaction tests inside stories.
3. **An ast-grep rule for "smart" patterns to flag.** Example: ban `useEffect` with empty-deps that does work other than subscribe; ban `any` in `*.tsx`; ban inline styles outside `tailwind.config`. Structural lint catches drift Claude introduces.
4. **A `studio-design.md` taste file** alongside the existing `.ridgeline/taste.md`. Five rules max ("nodes are rectangles with 4px corner radius", "edges use the `stroke-current` token"). Cited by Claude before edits.
5. **A protocol contract test in `packages/studio-protocol`.** Round-trip every `TrajectoryEvent` through Zod parse/stringify. If Claude breaks the wire format on either side, this fails before Playwright does — much faster signal.

Skip: a "design lint for flat-rounded-blob components". Subjective; the taste file does this job cheaper.

## 9. v1 cuts (do NOT do)

1. **No graph-to-code generation.** Read-only viewer first. Codegen is v2.
2. **No persistence layer.** No "save my graph to a workspace". The graph is whatever `describe.json(flow)` returns from the running process. No DB, no auth.
3. **No multi-run timeline / scrubber.** Live tail only. Replay UI is v2.
4. **No collaborative editing / multiplayer.** Single user, single tab.
5. **No plugin system for custom node renderers.** The 16 primitives get fixed renderers. Custom step kinds fall back to a generic node.

---

**Key files referenced:**
- `/Users/robmclarty/Projects/fascicle/code/fascicle/packages/core/src/types.ts` — `TrajectoryLogger`, `TrajectoryEvent`, `RunContext`
- `/Users/robmclarty/Projects/fascicle/code/fascicle/packages/core/src/describe.ts` — `FlowNode`, `describe.json`
- `/Users/robmclarty/Projects/fascicle/code/fascicle/packages/observability/src/filesystem.ts` — JSONL logger reference shape
- `/Users/robmclarty/Projects/fascicle/code/fascicle/packages/fascicle/src/index.ts` — umbrella; do not touch
- `/Users/robmclarty/Projects/fascicle/code/fascicle/rules/` — twelve ast-grep rules globbing `packages/*/src/**`
- `/Users/robmclarty/Projects/fascicle/code/fascicle/AGENTS.md` — the contract; `pnpm check:all` is truth

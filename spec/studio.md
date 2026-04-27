# Fascicle Studio — PDR

A drag-and-drop visual editor and live monitor for fascicle pipelines, in the style of Factorio / Mindustry / Shapez, with a worn-and-warm Final Fantasy Tactics colour story. Ships in a sibling repo so the `fascicle` library bundle stays untouched. Designed to be human-readable, LLM-editable, and visibly fun.

> Status: design accepted. Phase 0 (library prep) lives **in this repo, on the `ui` branch**. Phase 1+ (the studio app, server, and CLI) lives in a **separate repo**, name TBD (working name: `fascicle-studio`). This document is the north star for both.

---

## 1. North star

A web app where you can:

- **Watch a running fascicle harness** as a living factory. Each step is a stamped plate with input/output ports. Edges are conveyor belts that carry tokens (intermediate values), pulse when a step fires, sag with weight, turn copper when something errors. You can pan, zoom, click any plate to inspect its history, and scrub the recent past.
- **(later) Build a fascicle harness by dragging factories.** Wire the ports together, configure each plate in an inspector, and emit the `.ts` file underneath. The graph is the source of truth; the code is generated and committed.

Three decisions, resolved up front:

1. **"Fun and stylized" vs "boring and maintainable."** Resolve by keeping the *data and viewport* layer boring (React Flow) and the *renderers* stylized. The personality is in the brushes, not the framework.
2. **"Ship as `fascicle/studio`" vs "ship as a separate package."** Resolve by putting the studio in a **completely separate repo**. The `fascicle` library bundle is unaffected; this repo never imports React, Vite, or a UI toolchain.
3. **"Build studio first" vs "tighten core first."** Resolve by tightening core first. Phase 0 lands in this repo before any studio code is written, so the studio starts on a stable foundation.

---

## 2. Scope: what each version is

### v1 — Monitor mode only

- Read-only visualization of a running harness or a saved trajectory.
- Live tail of trajectory events via SSE.
- Token particles on edges, sparklines on nodes, error scars, hand-stamped run badges.
- Inspector panel: per-node history, model-call streaming preview, last error, cost.
- Tail timeline (last N events) with `J/K/L` scrubbing.
- Zero-install: `npx fascicle-studio tail .trajectory.jsonl`.
- One-line attach: `import { studio } from 'fascicle-studio'; await run(flow, input, { trajectory: studio({ port: 4242 }) })`.

### v2 — Build mode + one-way codegen

- Drag fascicle primitives from a palette, wire ports, configure inspector.
- Graph persists as `flow.fascicle.json` plus a generated `.ts` file with stable `// @fascicle:id` comments.
- Diff panel and drift detection vs on-disk source.
- Sample flows (Hello model, Retry+fallback, Ensemble of 3) for empty state.
- Round-trip: graph → code only. Code → graph is explicitly out of scope.

### v3+ — Polish

- Multi-run timeline / scrubber with full historical replay.
- Code-to-graph parser (research project, not committed).
- Storybook visual regression, Playwright e2e.
- Plugin system for custom node renderers (only if there is real demand).

Anything not on this list is not a v1, v2, or v3 feature. See §10 for the explicit "do not build" list.

---

## 3. Repo layout

Two repos. This one (`fascicle`) only does Phase 0.

### This repo (`fascicle`)

```
fascicle/
├─ packages/
│  ├─ core/                # MODIFIED — structured TrajectoryEvent union + Zod schema,
│  │                       # STEP_KINDS const, optional step() metadata, run_id
│  │                       # threaded through every event, deterministic-id contract test
│  ├─ engine/              # MODIFIED — emit run_id on trajectory writes
│  ├─ observability/       # MODIFIED — filesystem logger threads run_id
│  ├─ stores/              # unchanged
│  ├─ config/              # unchanged
│  └─ fascicle/            # umbrella; re-exports the new types and schema, nothing else
├─ rules/                  # unchanged in scope (still globs packages/*/src/**)
└─ ...
```

**Key invariants:**

- `fascicle` (the library) gains zero new runtime dependencies. Bundle size impact: smaller than the rounding error on `dist/index.js`. zod is already a runtime dep of `@repo/core`.
- All Phase 0 changes are additive on the public surface. Existing harnesses keep working unchanged.
- No `apps/*` directory in this repo. No React, no Vite, no Tailwind. The library stays pure TypeScript.

### Sibling repo (`fascicle-studio`, name TBD)

```
fascicle-studio/
├─ apps/
│  ├─ studio/              # Vite + React + React Flow + Tailwind app
│  └─ studio-server/       # tiny Node HTTP+SSE host + npx CLI
├─ rules/                  # studio-scoped ast-grep rules (PascalCase components, etc)
├─ AGENTS.md               # mirrors fascicle's contract: pnpm check:all is truth
└─ package.json            # depends on `fascicle` for the protocol types
```

The studio repo depends on `fascicle` like any external consumer: `pnpm add fascicle`. It imports the structured `TrajectoryEvent` types and `trajectory_event_schema` from there. No private workspace coupling.

Published packages:

- `fascicle` — unchanged shape; this repo.
- `fascicle-studio` — NEW; sibling repo. Bundles the CLI binary (from `apps/studio-server`) and the static UI assets (from `apps/studio`). Users install as a `devDependency` in their harness, or run `npx fascicle-studio` zero-install.

Studio code follows fascicle's conventions in spirit (snake_case identifiers, named exports, no classes), with one carve-out: **React component names are PascalCase**, because JSX requires it.

---

## 4. Core surfaces fascicle must add (Phase 0)

Small, safe, additive changes. None break existing users. Do these *first* — they unblock the studio cleanly and pay off again in v2 codegen. This is the entirety of this repo's Phase 0 scope.

| # | Change | Risk | Where |
|---|---|---|---|
| 1 | Export `STEP_KINDS` const string union (`'step' \| 'sequence' \| 'parallel' \| ...`) | low | `packages/core/src/types.ts`, re-exported from umbrella |
| 2 | Tighten `TrajectoryEvent` to a discriminated union (`span_start`, `span_end`, `model_chunk`, `error`, `tool_call`, `custom`) plus a Zod schema `trajectory_event_schema`. Keep `custom` with `data: Record<string, unknown>` for forward compatibility. zod is already a runtime dep of `@repo/core`. | medium | `packages/core/src/trajectory.ts` (new), `packages/core/src/types.ts`, `packages/observability/src/filesystem.ts`, `packages/engine/src/trajectory.ts` |
| 3 | Add a contract test that `step.id` and `describe.json(step)` ids are deterministic across construction of the same flow. Fix root cause if not. | low-medium | `packages/core/src/step.test.ts`, `packages/core/src/describe.test.ts` |
| 4 | Optional metadata on `step({ display_name?, description?, port_labels? })`, echoed on `Step` and by `describe.json`. Existing call sites pass nothing and behave identically. | low | `packages/core/src/step.ts`, `packages/core/src/describe.ts`, `packages/core/src/types.ts` |
| 5 | Ensure every emitted trajectory event carries `run_id` (already on `RunContext` — thread it through writes). Backfill in adapters. | low | `packages/observability/src/filesystem.ts`, `packages/engine/src/trajectory.ts`, all `record/start_span/end_span` callsites |
| 6 | Re-export the new types and `trajectory_event_schema` from the umbrella so `import { trajectory_event_schema } from 'fascicle'` works in the studio repo | low | `packages/fascicle/src/index.ts` |

Out of scope for Phase 0:

- `from_json(FlowNode) -> Step` (recreating closures from JSON requires a function registry; v2 codegen problem, not v1 monitor problem).
- Any change to the 16 primitives' signatures.
- Any new public surface beyond items 1–6 above.
- Any UI code, server code, React, or Vite. Those live in the sibling repo.

---

## 5. Server contract

### Transport: HTTP + SSE

Not WebSocket, not file watch. SSE is half the code, native browser reconnection (`Last-Event-ID`), survives proxies, matches `TrajectoryLogger`'s push-only shape exactly.

### Routes

```
GET  /api/graph                      → FlowNode (existing describe.json output)
GET  /api/events                     → text/event-stream of TrajectoryEvent
GET  /api/runs                       → [{ run_id, started_at, ended_at?, status }]
GET  /api/runs/:run_id/events        → SSE filtered by run_id
GET  /                               → static studio bundle (apps/studio/dist)
```

### Event format

```
event: trajectory
id: 42
data: {"kind":"span_start","span_id":"sequence:abc12345","name":"sequence","run_id":"r1","ts":1714123456789}
```

Server-side ring buffer of the last 1000 events so a late-connecting browser sees recent history. Total studio-server LOC target: <300.

### Embedding shapes

```ts
// 1. Library helper from fascicle-studio (devDependency in the harness)
import { studio } from 'fascicle-studio';
await run(flow, input, { trajectory: studio({ port: 4242 }) });

// 2. Zero-install tail of an existing JSONL file
//    npx fascicle-studio tail .trajectory.jsonl

// 3. BYO transport: user already has an HTTP server; use the SSE handler directly
import { sse_handler } from 'fascicle-studio/server';
app.get('/api/events', sse_handler({ source: my_logger }));
```

---

## 6. Frontend stack and rendering

### Stack: React + Vite + React Flow + Tailwind + Zustand

Rationale: React Flow gives us the graph data model, viewport, hit-testing, mini-map, and edge routing for free. React is what every LLM has the most training data on; Claude edits React with measurably fewer mistakes than Solid or Svelte. Vite + Tailwind is two config files. Zustand is the smallest store that keeps state out of React's render path. The combined stack is boring on purpose.

We are NOT picking React Flow's *defaults*. We use it as the substrate; the renderers are custom.

### Rendering strategy: custom renderers, not custom framework

React Flow lets you fully replace `nodeTypes`, `edgeTypes`, and the background. We exploit that hard:

- **Custom nodes** are SVG (clean strokes, crisp at any zoom) wrapped in a small HTML shell for the inspector hit-area. Each primitive (`step`, `sequence`, `parallel`, ...) gets its own renderer.
- **Custom edges** are catenary curves with 8-14% sag, computed once per layout, redrawn during drag. Token particles are absolutely-positioned `<circle>` elements animated by Framer Motion / motion.dev, not CSS.
- **Custom background** is a paper-grain SVG pattern that parallaxes 5% slower than nodes on pan.
- **Performance escape hatch:** if profiling shows >200 active edges drag a frame budget, swap edge rendering to a single `<canvas>` overlay. Not before. The typical fascicle harness has 5-50 steps.

### Visual style: Worn Foundry (FFT-warm, not blueprint-cool)

The mood is **Final Fantasy Tactics**: a stained map on a wooden table, ochre and tan and rust, edges soft from handling, gold leaf rubbed off the corners. Lived-in, never sterile. **Simple, not over-detailed.** The personality comes from the warmth of the colours and a few well-placed worn-edge touches, not from cluttered ornamentation.

The aesthetic descriptor is "lived-in workshop", not "industrial blueprint". Same blueprint *bones* (stamped plates, brass ports, schematic edges, hand-stamped run badges) — but in a warmer, browner palette that feels handled, not freshly printed.

| Role | Hex | Notes |
|---|---|---|
| Parchment (canvas bg) | `#E8D9B8` | warm aged tan, not cream — yellow-leaning |
| Sepia ink (primary line/text) | `#3D2817` | dark warm brown, not navy |
| Faded olive (secondary) | `#7A6B4F` | dusty olive for secondary strokes and labels |
| Ochre (active/running) | `#C9882B` | the only saturated hue; the only thing that says "alive" |
| Rust red (error) | `#8B3A1E` | deeper than the ochre, immediately reads as "broken" |
| Aged bronze (ports/accents) | `#9C6F3A` | port grommets, rivet heads, frame trim |
| Wax-seal red (badges only) | `#7A1F1F` | run badges, completion stamps. Used sparingly. |

Type:
- **UI:** Inter Tight — geometric, condensed enough for dense node headers, free, ships well. Avoid medieval pastiche; the *colour* carries the warmth, the typography stays clean.
- **Labels / monospace:** JetBrains Mono — distinguishes `Il1`/`O0`, matters for serial numbers and code emission.

Resist the temptation to add fantasy-game ornament: no scrollwork frames, no calligraphic flourishes, no parchment torn-edges around panels. The point is a *colour story*, not a costume. Read EXAPUNKS for tone — terminal precision in a warm, used-up palette.

Motion personality (six rules; nothing else animates):

1. **Edge data pulse.** Discrete dashes travel from output → input port at speed proportional to event arrival rate. One dash per `emit`. Not continuous.
2. **Port click-clack on connect.** 80ms scale-bounce + 40ms ink-splat on the receiving port.
3. **Node breathing while running.** 0.5% scale oscillation at ~6s period. Idle nodes are still.
4. **LLM-call exhaust.** A 200ms puff of soft particles rises off a `model_call` header when it fires. Once. Not a loop.
5. **Error judder + scar.** 4px horizontal shake for 120ms, then the node turns rust-red, then keeps a thin red underline ("scar") until acknowledged.
6. **Pan/zoom with weight.** Slight overshoot and damped settle. Never instant snap.

Three "breaks the rules but earns it" moments:

- Subtle paper grain + a faint coffee ring baked into the background, parallaxing 5% slower than nodes on pan. Read once at low opacity; never compete with the graph.
- Hand-stamped run badges (`RUN 0413 — OK`) in wax-seal red thud onto the canvas margin and stay in a history strip.
- Edges have catenary slack and wobble briefly when a node is dragged. Cheap, signals "this is physical."

Anti-patterns explicitly banned: glassmorphism, neon-cyan-on-black, rounded-rectangle nodes with a lucide icon and a truncated title, marketing-site "AI sparkle" iconography, bezier-spaghetti edges with no flow direction, and — given the FFT direction — fantasy-game ornament (scrollwork, calligraphy, parchment-edge frames). The colour does the work; the chrome stays clean.

---

## 7. UX: interaction model

### Mode toggle

Single canvas, hard mode toggle on `Tab`. v1 ships only Monitor mode; v2 enables Build mode behind the same toggle.

What survives the toggle: camera, selection, node positions, collapsed/expanded states, pinned inspectors. What does not: monitor-mode token particles (fade out in build mode), build-mode ghost nodes (n/a in monitor).

While editing a flow whose run is still in progress: the live run keeps streaming into a frozen "shadow graph" overlay (dimmed, behind the editable one). On save, diff and offer "apply on next run" — never hot-patch.

### v1 interactions (ranked by user-effort and frequency)

1. **Pan/zoom.** Trackpad two-finger drag, mouse wheel, `Cmd+scroll` zoom. Standard.
2. **Click a node → inspector.** Right rail, two tabs (`Config`, `History`). Default to `History` in monitor mode.
3. **Pin an inspector.** `P` with node selected. Pinned panels stack and survive selection changes. (Houdini.)
4. **Scrub timeline.** `J/K/L` for back/pause/forward (DaVinci). `[` and `]` jump to prev/next error. Hover an event marker for a tooltip.
5. **Heatmap zoom-out.** At zoom < 0.4, individual nodes degrade to colored rectangles where hue = node type and brightness = recent activity. (Mindustry.)
6. **Box-select / multi-select.** `B` or click-drag empty canvas. Useful for "hide all this" or "expand all selected."

### v2 build-mode interactions

7. **Wire from a port.** Drag from output port. On release in empty space, open a filtered palette ("nodes that accept `string`"). Houdini-style TAB-menu, not Blender's separate add-then-connect. `C` to start a wire from the selected node's primary output.
8. **Add a node.** `Space` opens the palette. Type-to-filter, arrow keys, Enter places at cursor. Drag-from-sidebar also works but keyboard is primary.
9. **Pipette.** `Q` copies a node's type+config into the cursor (Factorio).
10. **Copy/paste subgraph.** `Cmd+C`/`Cmd+V` preserves port mappings; paste creates a node group with unconnected ports exposed (Factorio blueprints).

### Build → code round-trip rule

**Graph is the source of truth. Code is generated, formatted, committed.**

Bidirectional sync is a tarpit. Each node carries a stable ULID that survives in the generated source as `// @fascicle:id 01H...` so codegen produces diff-friendly output. If the on-disk file has been hand-edited since last codegen, the title bar shows a lock icon and writes require explicit "Overwrite hand edits."

Code-to-graph parsing is a v3+ research project. Not committed.

### Live-monitor "alive, not noisy" patterns

The monitoring experience must be visibly alive without becoming a strobe. Five and only five patterns carry weight; everything else is noise.

1. **Token particles on edges** (one per `emit`, fade to none when idle).
2. **Per-node sparklines** in the node header (60-sample rolling window; latency or token-cost; no axis).
3. **Streaming model output in the node body** when a `model_call` is mid-stream (last ~3 lines monospace + blinking caret).
4. **Heatmap zoom-out** (above).
5. **Error flash + scar** (above).

### Onboarding

- Empty canvas: centered ghost text "Press `Space` to add a node" plus three sample-flow chips (*Hello model*, *Retry + fallback*, *Ensemble of 3*). Click loads a real working graph.
- "Explain this node" inline: every node has a `?` icon. Hover → one-sentence plain English. Click → side panel with primitive name, signature, 6-line code example. Doubles as primitive documentation.
- No interactive tutorial. Devs hate them. Sample flows + tooltips cover 90%.

---

## 8. Code-style and conventions inside the studio

Inherit fascicle's discipline. One carve-out for JSX. New ast-grep rules scoped to `apps/studio/**`.

| Rule | Studio? | Notes |
|---|---|---|
| TypeScript strict | yes | non-negotiable |
| No classes | yes | including state stores; use `create_store(initial)` factories or Zustand's functional API |
| Named exports only | yes | including React components |
| snake_case identifiers | partial | locals, helpers, hooks, event field names: snake_case. **Components: PascalCase** (JSX requirement). Hooks: `use_node_state` (snake_case is consistent with fascicle's function-naming). |
| File extensions `.js` on imports | partial | `.js` in `packages/studio-protocol/`. NOT in `apps/studio/` (Vite resolves without extensions; forcing `.js` on `.tsx` confuses tooling). |
| Tests colocated | yes | `node_panel.tsx` + `node_panel.test.tsx` |
| Coverage floor | partial | 70% for `packages/studio-protocol/`. 50% for `apps/studio/` (visual code is harder to unit-test profitably; spend that budget on Playwright). |

New ast-grep rules under `rules/` scoped to `apps/studio/**`:

- `rules/studio-pascalcase-components.yml` — component names must be PascalCase.
- `rules/studio-no-any-tsx.yml` — ban `any` in `*.tsx`.
- `rules/studio-no-default-export.yml` — already covered by the existing rule, but verify glob includes `apps/studio/**`.
- `rules/studio-no-inline-styles.yml` — ban `style={{...}}` outside `tailwind.config`.
- `rules/studio-no-effect-busywork.yml` — flag `useEffect` whose body computes derived state (use `useMemo` or selectors instead).

---

## 9. CI / `pnpm check` integration

Required in default `pnpm check` (no behavior change for existing users, just additional globs):

- **types** — `tsc --noEmit` includes `apps/studio/**`, `apps/studio-server/**`, `packages/studio-protocol/**`.
- **lint** — oxlint same rules.
- **ast-grep** — globs above + new studio-scoped rules.
- **fallow** — add `apps/studio` and `apps/studio-server` as extra roots.
- **vitest** — already globs.
- **markdownlint, cspell** — already glob.
- **deps audit** (`scripts/check-deps.mjs`) — assert `apps/studio` does NOT appear in `fascicle`'s dependency tree (catches accidental imports through the umbrella).

Opt-in (like `mutation` today):

- `pnpm check --include studio-build` — `vite build` and a bundle-size budget. Required before publishing `fascicle-studio`.
- `pnpm check --include e2e` — Playwright headless smoke (boot studio, see a graph, see one SSE event).
- `pnpm check --include storybook` — Storybook `play()` interaction tests on every node renderer.

Skipped in v1:

- Stryker mutation testing for studio code (UI mutation testing is low-ROI).
- Visual regression / Chromatic.
- Bundle-size budget enforcement (track but do not fail).

---

## 10. Sensors and tools to give Claude effective backpressure

The studio is a frontend; Claude's failure modes there differ from the library. Wire these in:

1. **Playwright MCP server** (already available in this environment via `mcp__plugin_playwright_playwright__*`). Used during dev so Claude can verify "I changed the node panel; does the page still render?" without round-tripping through the human.
2. **Storybook + interaction tests.** One story per node renderer. `play()` interaction tests function as cheap component snapshots and are included in the opt-in `--include storybook` check.
3. **Protocol contract test in `@repo/studio-protocol`.** Round-trip every `TrajectoryEvent` variant through `Zod.parse → JSON.stringify → Zod.parse`. If Claude breaks the wire format on either side, this fails before Playwright does — much faster signal.
4. **`spec/studio-design.md` taste file.** Five rules max (e.g. "nodes are stamped rectangles with rivets, not pill shapes"; "edges sag, not bezier"; "no glassmorphism"; "max one accent color per scene"; "monospace only for serial numbers and code"). Cited by Claude before edits, modeled on `.ridgeline/taste.md`.
5. **fallow audit on changed files.** Already wired via `.mcp.json`; explicitly run it during studio iteration. Catches dead components fast.

Skipped: a bespoke "design lint for flat-rounded-blob components" (subjective; the taste file does this job cheaper); any LLM-as-judge layer (premature).

---

## 11. Phase plan

### Phase 0 — Library prep (1-2 weeks, **this repo, `ui` branch**)

Ship before any studio code is written. Each item lands as its own commit (or PR) with `pnpm check:all` green.

1. Deterministic-ids contract test (additive; locks current behavior or surfaces a bug to fix).
2. `STEP_KINDS` const string union exported from `@repo/core` and re-exported from the umbrella.
3. Structured `TrajectoryEvent` discriminated union in `packages/core/src/trajectory.ts` plus `trajectory_event_schema` (Zod). Adapters (`@repo/observability`, `@repo/engine`) updated to emit through it. Backwards compatible via the `custom` variant.
4. Optional `display_name` / `description` / `port_labels` metadata on `step()`, echoed by `describe.json`.
5. `run_id` threaded through every trajectory write; round-trip test asserts every event carries it.
6. Umbrella re-exports the new types and schema.

Exit criteria: `pnpm check:all` passes; `fascicle` consumer surface is fully backwards compatible; the studio repo can `pnpm add fascicle` and `import { trajectory_event_schema, STEP_KINDS } from 'fascicle'` and start building.

**No `apps/*` or studio code in this repo.** Phase 1 is a separate repo.

### Phase 1 — Monitor mode v1 (3-4 weeks, **sibling repo**)

1. `apps/studio-server` — HTTP+SSE on a local port, ring buffer, serves static UI. <300 LOC.
2. `apps/studio` — Vite + React + React Flow + Tailwind. Worn-Foundry parchment canvas. Six custom node renderers (one per primitive family: leaf, branching, looping, model-bearing, scope, suspend). Catenary edges with token particles. Inspector right rail with tabs.
3. Live tail of a single run; tail timeline (last 1000 events).
4. Sample `.trajectory.jsonl` fixtures for development.
5. `npx fascicle-studio tail <path>` — zero-install path.
6. `import { studio } from 'fascicle-studio'` — one-line attach helper.
7. Storybook with one story per node renderer, basic `play()` interaction tests.
8. Playwright smoke test in CI (opt-in).
9. README + getting-started docs.

Exit criteria: a user can `npx fascicle-studio tail` an existing JSONL and see a graph that updates. The studio repo's `pnpm check:all` passes. The `fascicle` library bundle is unchanged.

### Phase 2 — Build mode + codegen (4-6 weeks after Phase 1)

1. Palette UI. Drag/drop, `Space` to open, type-filter.
2. Wire-pull-to-empty-space → filtered palette (Houdini TAB-menu).
3. Inspector `Config` tab with per-primitive forms (driven by `step.config` shape).
4. Graph persistence as `flow.fascicle.json`.
5. One-way codegen → `.ts` with `// @fascicle:id` markers.
6. Drift detection vs on-disk file; lock icon; "overwrite hand edits" confirmation.
7. Sample flows for empty state.
8. Pipette (`Q`), copy/paste with port mapping (`Cmd+C`/`Cmd+V`).
9. Updated taste file.

Exit criteria: a user can build a working `Hello model` flow visually, hit save, see a `.ts` file appear, run `pnpm exec tsx flow.ts` and have it work. Round-trip is graph → code only.

### Phase 3+ — Polish and stretch

- Multi-run timeline / scrubber with full historical replay.
- Code-to-graph parser (research; not committed).
- Visual regression / Chromatic.
- Plugin system for custom node renderers (only if real demand).
- Collaborative editing — explicitly NOT a goal.

---

## 12. Explicitly NOT in scope

These are tempting, popular, and wrong for this product. Resist.

1. **Bidirectional graph ↔ code sync.** Tarpit. v2 is graph → code one way. Code → graph is research, not product.
2. **Custom node authoring inside the UI.** Users write fascicle steps in TypeScript, not in a visual node-builder. Don't build a meta-editor.
3. **Cloud sync, accounts, sharing.** Local-first. Export is a screenshot or `flow.fascicle.json`. No backend, no auth.
4. **Mobile / touch support.** Desktop dev tool. Don't waste a week on pinch-zoom edge cases.
5. **Collaborative multi-cursor editing.** Figma envy; massive infra cost; near-zero value for a solo-dev tool.
6. **Re-importing arbitrary user TypeScript into a graph.** As above. v3 stretch.
7. **Plugin / extension system before there's clear demand.** Pre-extension architecture is an extension trap.
8. **Themes / dark mode / "make it look like Linear."** Blueprint Foundry is the look. One look. If it doesn't work for users, change it for everyone.
9. **In-app authentication for AI providers.** Engine config stays in user code where it belongs.
10. **An LLM "explain this trace" assistant.** Cute; out of scope; punted to v4 if ever.

---

## 13. Open questions

These need answers before Phase 1 starts. Each is a one-line discussion item, not blocking the plan structure.

1. Do we publish `fascicle-studio` from this monorepo or a sibling repo? (Plan says monorepo; revisit if release cadence diverges.)
2. Server: is a single shared port across runs OK, or do we need a per-run port? (Plan: single port, multiplex by `run_id`.)
3. How does the studio handle `suspend(...)` flows that pause across processes? (Plan: graph dims, inspector shows "paused for resume_data"; revisit when implementing.)
4. Token particle rate cap when `emit` floods (e.g. one per ms). (Plan: rate-limit visually to ~10/s per edge, batch the rest into a "rush" pulse.)
5. How does the user choose between `History` and `Config` defaults when both are meaningful? (Plan: mode-aware default; user can pin.)

---

## 14. Reference research

The synthesis above draws on three parallel research passes. The raw outputs are preserved verbatim in `spec/research/` and should be consulted when a specific design choice in this PDR is contested:

- `spec/research/style.md` — fun / design / style angle (Blueprint Foundry vs alternatives, motion personality, palette, tooling).
- `spec/research/ux-dx.md` — UX / DX angle (mode toggle, interactions, alive-not-noisy patterns, install path, onboarding).
- `spec/research/maintainability.md` — maintainability / simplicity angle (repo layout, server contract, stack choice, code-style rules, core surfaces, CI, sensors, cuts).

Where this PDR disagrees with one of those documents, the disagreement is intentional. The most consequential reconciliations:

| Topic | Style says | Maintainability says | This PDR says |
|---|---|---|---|
| Canvas tech | Pixi.js + WebGL | React Flow + React | React Flow as substrate; custom renderers carry the personality. Defer Pixi until profiled need. |
| Install surface | (n/a) | Separate `apps/*` in same monorepo, separate npm package | **Separate repo entirely.** `fascicle-studio` is its own monorepo. This repo never grows an `apps/*` tree. Library bundle stays unchanged. |
| Timeline scrubber | (n/a) | Cut from v1 | v1 ships a "tail of recent" timeline (1000 events). Full multi-run replay is v3. |
| Codegen in v1 | (n/a) | Cut from v1 | v1 is monitor only. Codegen lands in v2 with `// @fascicle:id` markers. |
| Visual style | Blueprint Foundry: cream paper + navy ink + safety-orange + brass | (n/a) | **Worn Foundry**: parchment + sepia ink + ochre + aged bronze + rust + wax-seal red. FFT-warm, not blueprint-cool. Same bones, warmer palette. |

---

## 15. Done definition

The studio is done for a given phase when:

1. `pnpm check:all` exits 0.
2. The opt-in `--include studio-build`, `--include e2e`, and `--include storybook` checks all exit 0.
3. The phase's exit criteria above are met.
4. The library bundle size is unchanged from main.
5. A first-time user can follow the README's quickstart and have the UI rendering a real flow inside 60 seconds.

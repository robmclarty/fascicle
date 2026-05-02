# Still on the menu

A running list of work that has been considered, scoped, or partially built but not yet shipped. Pulled from `docs/plans/ideas.md`, `spec/`, and the research explorations. Not a roadmap — a menu.

When something here ships, strike it through (don't delete) so the reasoning trail stays intact.

## Visualization (the headline)

The pitch: nobody understands what fascicle is from the README. A live picture of a flow firing — per-primitive node shapes, active spans pulsing, costs rolling up the tree, errors leaving scars — is the demo that sells step-as-value.

### `weft` Phase 1 — make the canvas come alive

Weft (`../weft/`) already has the structural skeleton: `@repo/core` does FlowNode validation, tree-to-graph transform, ELK layout, and React Flow with one custom renderer per primitive (`StepNode`, `SequenceNode`, `ParallelNode`, `PipeNode`, `RetryNode`, `ScopeNode`, `StashNode`, `UseNode`, `CycleNode`, `GenericNode`). `@repo/studio` is a Vite SPA with canvas shell, inspector, banner, shortcuts, watch-socket. `@repo/watch` is a Node CLI. All five v0 phases are done — but only against an older fascicle that emitted `describe.json` and nothing else.

Two gaps before weft is the README hero:

1. **Resync the contract.** Fascicle's `describe.json` now carries `meta?: StepMetadata` (`display_name`, `description`, `port_labels`). New primitives `loop` and `compose` need renderers. The `parallel` config-keys invariant in `@repo/core/src/schemas.ts` should match the current fascicle output exactly. Replace the local `FlowNode` type with `import type { FlowNode } from '@robmclarty/fascicle'` once that's published; keep weft's Zod schemas as the boundary.
2. **Wire trajectory events onto the canvas.** Today weft sees structure only. The `@repo/viewer` package in fascicle already proves the live data path: ingest `trajectory_event_schema` events over file-tail or HTTP, build a span tree, attribute cost. Move that ingest into weft (or have weft consume the existing viewer server) and overlay events on the structural canvas via `step_id`:
    - active span = ochre pulse on the matching node
    - `cost` events = cost badge on the node, summed up containers
    - `error` events = rust scar, persists until acknowledged
    - `emit` events = token particle along the outgoing edge

Once that's in, the README gets a 10-second gif of a `sequence` of `parallel`s firing, with cost rolling up to the root. That's the sell.

### Where the in-fascicle viewer fits

`@repo/viewer` (already shipped, see `spec/viewer.md`) is the boring grey log: span tree, event log, cost rollup. Useful for grep-style debugging. Keep it. Weft is the structural canvas; viewer is the timeline. Same wire format, two surfaces.

Decision deferred: do we publish weft as `@robmclarty/weft` immediately, or hold one cycle until the live overlay lands? Recommendation: hold. A static structural viewer is not the demo we want to lead with.

---

## From `docs/plans/ideas.md`

### MCP server as a library helper

Today: `examples/mcp-server/` exists (last commit). What's missing: promote it from example to library surface so any `Step<i, o>` with a Zod schema becomes an MCP tool with one call. Probable shape: `serve_mcp(steps, options)` in a new `@repo/mcp` package, re-exported from the umbrella. Cheap, opens fascicle to every MCP-aware client.

### Deployment shells

Thin runtime wrappers around `run` and `run.stream`:

- **HTTP / SSE server** — `run.stream` already maps to SSE. One adapter, one example.
- **Queue-worker shell** — pull jobs, run the flow, write results. The `CheckpointStore` interface already covers durability.
- **Cloudflare Worker adapter** — proves the "no infrastructure assumption" claim.

Each is a separate package. Composition stays portable; only the runtime ships.

### `distill` — flow extraction from examples

`distill(flow, examples)` extracts a smaller / cheaper / more direct flow from a corpus of (input, output) pairs. Out of scope until `learn` has a real user. Tracked in `docs/plans/self-improvement-and-agents.md`.

### Studio v2 — build mode + codegen

After weft Phase 1 ships the monitor, Phase 2 in `spec/studio.md` adds drag-to-build and one-way codegen (graph → `.ts` with `// @fascicle:id` markers). Real scope; 4-6 weeks. Don't start until Phase 1 has lived in someone's hands.

---

## Papercuts surfaced during execution

Captured in `spec/eval.md` §11. Half-day cleanup wedges, low stakes:

1. **Run-id dropdown shows raw UUIDs.** Truncate to 8 chars + tooltip with full id, or render a timestamp.
2. **Viewer log pane capped at 200 rows.** Header counts all events, but the log only shows the tail. Add pagination or a "show all" toggle.
3. **Bench baseline `run_id` churn.** Each baseline regen produces a new `run_id`, which makes `bench/<flow>/baseline.json` git diffs noisy. Make it deterministic (hash of cases + flow_name) or drop `run_id` from the persisted baseline.
4. **`judge_llm` engine wiring.** Currently takes a `Step<string, string>` to keep composites layering clean; user must construct their own `model_call`. Probably right, but worth a second look once a real third-party uses it.
5. **Bench cases parallelism.** Uses a small worker-pool helper rather than `ensemble`. Intent ("don't roll a new concurrency primitive") is preserved; consider promoting that helper into `@repo/core` if anything else needs it.

---

## Observability adapters (community territory)

Not on the build list, but explicitly designed for: Langfuse, LangSmith, Phoenix (Arize), Helicone, Braintrust, OpenLLMetry. Each is a `TrajectoryLogger` adapter. Every one written by us is a maintenance bill we don't want; every one written by a community contributor is leverage. Document the contract, link to a reference implementation (`http_logger`, `filesystem_logger`), and otherwise leave it.

---

## What this menu deliberately does not include

- **Hosted SaaS / dashboard / accounts.** Standing commitment in `research/explorations/2026-04-competition.md`. Not negotiable.
- **Registry of any kind.** Same source.
- **Python port.** Same source.
- **Bidirectional graph ↔ code sync in studio.** Tarpit. v3+ research at the earliest.
- **Plugin system before there's clear demand.** Pre-extension architecture is an extension trap.
- **In-app provider auth.** Engine config stays in user code.

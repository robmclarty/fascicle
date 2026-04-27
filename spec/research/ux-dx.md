# Research: UX / DX

Raw output from the UX/DX research agent. Preserved verbatim. Consulted by `spec/studio.md` §5, §7. Where the PDR diverges (e.g. install surface, v1 codegen scope, timeline depth), the divergence is intentional and called out in `spec/studio.md` §14.

---

## 1. Information Architecture: One Canvas, Two Modes

**Verdict: Same canvas, hard mode toggle bound to `Tab`. Not split-pane, not separate apps.**

The graph topology is the spine of both modes — duplicating it across two apps means two hit-testing layers, two camera systems, two selection models, two sets of bugs. Comfy UI conflates run+build and it works; n8n splits "editor" from "executions" and it feels like two products stapled together. We pick Comfy.

What survives the toggle: camera position, selection, node positions, collapsed/expanded states, pinned inspectors. What doesn't: build-mode ghost nodes (unplaced palette drags), monitor-mode token particles, the timeline scrubber.

**Mid-run topology change**: monitor mode is read-only on structure. If the user wants to edit a running flow they hit `Tab` → build mode → the run keeps streaming into a frozen "shadow graph" overlay (dimmed, behind the editable one). On save, we diff and offer "apply on next run" — never hot-patch a live run. Factorio's blueprint-while-running model.

**Inspect history vs configure**: the right panel is one component, `<NodeInspector>`, with two tabs: **Config** (build-mode default) and **History** (monitor-mode default). `Tab` switches modes globally; `1`/`2` switches the inspector tab locally. Pinning is orthogonal — pin survives mode toggle.

## 2. Six Interactions, Ranked

1. **Pull a wire from a port.** Click+drag from output port; on release over a compatible input, snap+connect; on release in empty space, open a filtered palette ("nodes that accept `string`"). Houdini's TAB-menu, not Blender's separate-add-then-connect. Hotkey: `C` to start a wire from the selected node's primary output. Feedback: live-typed dotted line in port color, incompatible ports gray out instantly.

2. **Drag a node from the palette.** Palette is `Shift+A` (Blender) or just `Space` (Comfy) — pick `Space` because it's one key. Type-to-filter, arrow keys, Enter places at cursor. Drag-from-sidebar also works but the keyboard path is primary. Feedback: ghost node follows cursor with valid-drop highlighting on existing wires (drop on a wire = splice).

3. **Multi-select + copy subgraph.** Box-select with `B` (Houdini) or click-drag on empty canvas. `Cmd+C`/`Cmd+V` copies *with port mappings preserved* — paste creates a node group with the unconnected ports exposed. This is Factorio blueprints. Without this, large flows are unmaintainable.

4. **Pipette / "use this node's config".** `Q` to pipette a node's type+config into the cursor (Factorio). Critical for "I want 5 more `model_call` nodes with the same model and temperature."

5. **Scrub trajectory timeline.** Bottom-of-screen timeline like a video editor. Drag the playhead, graph state rewinds. `J`/`K`/`L` for back/pause/forward (DaVinci). `[` and `]` jump to previous/next error. Hover an event marker → tooltip with span name + duration. The timeline is the killer feature; spend disproportionate time here.

6. **Pin an inspector to a node.** Click the pin icon or `P` with node selected. Pinned inspectors stack on the right rail as collapsible cards. Selection no longer kicks out the inspector. Houdini-style. Without pinning, users lose context every time they click elsewhere.

## 3. Five "Alive, Not Noisy" Patterns

1. **Token particles on edges.** Small dots travel from output to input port at a speed proportional to event arrival. One particle per `emit`, color-coded by type (string/object/error). Conveys throughput at a glance; Factorio's belts. Fades to none when idle so static graphs don't strobe.

2. **Per-node sparklines in the node header.** A 60-sample rolling sparkline of latency or token-cost. No axis, no label, just shape. Honeycomb-style. Anomalies pop without reading numbers.

3. **Streaming model output in the node body.** When a `model_call` is mid-stream, the node expands to show the last ~3 lines of generated text, monospace, with a blinking caret. Feels like the model is *thinking inside the box*. This is the single most "magic" moment.

4. **Heatmap zoom-out.** At zoom <0.4, individual nodes become colored rectangles where hue = node type and brightness = recent activity. Mindustry's density rendering. Lets you see a 200-node graph as a city.

5. **Error flash + scar.** On exception, the node flashes red for 400ms then keeps a thin red underline ("scar") until acknowledged or until next successful run. Sentry-style persistence; not a popup, not a toast, just a mark you can find by eye.

## 4. Build → Code Round-Trip

**Graph is source of truth. Code is generated, formatted, and committed.**

Bidirectional sync is a tarpit (Retool learned this). Code-first means the visual editor is a viewer with extra steps. Graph-first with codegen is honest.

Tactics:
- **Live code pane** on `` ` ``: right-side panel showing the generated `.ts` file, prettier-formatted, syntax-highlighted, scrolled to the currently-selected node.
- **Diff panel** on `Cmd+D`: shows generated code vs the file on disk. One-click "Write to disk."
- **Drift detection**: if the on-disk file has been hand-edited since last codegen, show a lock icon in the title bar and require explicit "Overwrite hand edits" before write. Never silently clobber.
- **No re-import from code in v1.** Parsing arbitrary user TS back to a graph is a research project; ship the one-way arrow first. Power users edit the graph; if they need raw TS, they delete the `.fascicle.json` and write it by hand.

Each node carries a stable `id` (ULID) that survives in a comment `// @fascicle:id 01H...` so codegen is diff-friendly across saves.

## 5. DX: Installing the Monitor

**Adapter via `RunOptions.trajectory`. No new import surface, no separate package in v1.**

```ts
import { run } from 'fascicle'
import { studio } from 'fascicle/studio'

await run(pipeline, input, { trajectory: studio({ port: 4242 }) })
```

`studio()` returns a `TrajectoryWriter` that also boots a local server and opens the browser on first event. One line added, zero imports moved. `fascicle/studio` is a subpath export so it tree-shakes out of production builds.

Zero-install: `npx fascicle-studio tail trajectory.jsonl` reads an existing JSONL file and serves the UI without touching the harness. This is the "I just want to look at last night's run" path and it should exist day one.

## 6. Discoverability and Onboarding

- **Empty build canvas**: centered ghost text "Press `Space` to add a node" plus three sample-flow chips: *Hello model*, *Retry + fallback*, *Ensemble of 3*. Click loads a real working graph.
- **"Explain this node" inline**: every node has a `?` icon in its header. Hover for one-sentence plain English ("Runs N steps in parallel, returns all results"); click for a side panel with the primitive name, signature, and a 6-line code example. This doubles as primitive documentation; ship it once, use it everywhere.
- **No interactive tutorial in v1.** Devs hate them. The sample flows + the explain-this-node tooltip cover 90% of onboarding. Revisit if telemetry shows people bounce from the empty state.

## 7. Cut From v1

1. **Collaborative multi-cursor editing.** Figma-envy. Massive infra cost, near-zero value for a solo-dev tool.
2. **Custom node authoring inside the UI.** Users write fascicle steps in TS, not in a visual node-builder. Don't build a meta-editor.
3. **Cloud sync / accounts / sharing.** Local-first; export is `.fascicle.json` + screenshot. No backend.
4. **Mobile / touch support.** This is a desktop dev tool. Don't waste a week on pinch-zoom edge cases.
5. **Code-to-graph reverse parser.** As above — one-way codegen only. The temptation will be enormous; resist.

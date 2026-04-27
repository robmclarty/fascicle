# Research: Fun / Design / Style

Raw output from the design-direction research agent. Preserved verbatim. Consulted by `spec/studio.md` §6, §10. Where the PDR diverges (e.g. canvas technology), the divergence is intentional and called out in `spec/studio.md` §14.

---

## 1. Visual style direction (ranked)

**1. Blueprint Foundry (RECOMMENDED).** Drafting-table aesthetic crossed with industrial schematic. Warm cream/oat paper background (not white, not dark), navy-ink line work at 1.5px primary / 0.75px secondary, nodes are stamped rectangular plates with riveted corners and a serial number in the header strip. Ports are brass grommets. Edges are technical-drawing strokes with arrowheads and tick-mark flow indicators. One safety-orange accent for "active/running", one oxidized-copper for "error". Typography: a geometric sans for UI, a stencil/mono for labels. **Feeling:** you are an engineer at a desk in 1962 wiring a real machine. Serious but tactile. **Why this one:** it signals "this is engineering, not magic" — exactly the counter-positioning fascicle needs against the GPT-glow dashboard genre. Ages well, prints well, screenshots well.

**2. Isometric Pixel Foundry.** Mindustry/Shapez DNA. 2:1 iso grid, 16px or 24px tile nodes with chunky pixel shading, conveyor-belt edges that visibly tick. Palette: dusk teals, rust, sodium-lamp yellow. Feeling: toy factory you want to poke. **Risk:** charming but fights you when graphs get dense and ports need labels. Better as a "monitor mode" easter egg than the primary canvas.

**3. CRT Patchbay.** Modular-synth/Buchla aesthetic. Dark charcoal panel, screen-printed white labels, glowing phosphor-green and amber port LEDs, rope-style cables that sag with gravity. Feeling: tactile studio gear. **Risk:** every AI tool is going dark-mode-with-glow right now; this lands you adjacent to the bland pile unless executed perfectly.

## 2. Animation & motion personality

- **Edge data pulse.** Discrete dashes travel along the edge at a speed proportional to throughput — like Factorio belts, not like a CSS marching-ants gradient. When a step fires, one fat dash departs the output port. Reference: Factorio belts, Houdini cook flashes.
- **Port "click-clack" on connect.** 80ms scale-bounce + a 40ms ink-splat on the receiving port. Tactile confirmation. Reference: Blender node snap.
- **Node breathing while idle.** 0.5% scale oscillation at ~6s period on running nodes only. Dead nodes are dead still. Reference: Opus Magnum's idle hexes.
- **LLM-call exhaust.** When a `model_call` step fires, a brief 200ms puff of soft particles rises off the node header — think a steam whistle. Once. Not a loop.
- **Error judder.** 4px horizontal shake, 120ms, then the node turns oxidized-copper and a small rivet pops off into the canvas margin. Reference: EXAPUNKS crash glyphs.
- **Pan/zoom inertia with weight.** Slight overshoot and damped settle, like Frame.io's scrubber. Never instant snap.

Avoid: continuous rotating spinners, glow-pulse-on-everything, edge animations that run when nothing is flowing.

## 3. "Breaks the rules but earns it"

- **Real paper grain + subtle coffee ring** baked into the canvas background, parallaxing 5% slower than nodes on pan. Sounds gimmicky; sells the foundry fiction in one frame.
- **Hand-stamped run badges.** When a pipeline completes, a rotated rubber-stamp ("RUN 0413 — OK") thuds onto the canvas margin and stays in a history strip. Real product utility (audit log) disguised as delight.
- **Cables have slack.** Edges are catenary curves with 8–14% sag, not Bezier handles. They wobble briefly when a node is dragged. Costs you nothing, signals "this is physical."

## 4. Anti-patterns to avoid

- **Glassmorphism + neon gradient hero.** The Vercel/Linear-clone dashboard. Looks like every YC AI tool from 2024.
- **Pure dark mode with cyan accent.** Langflow, Flowise, n8n's dark theme — interchangeable.
- **Rounded-rectangle nodes with a lucide icon and one truncated title.** ReactFlow defaults. Instantly forgettable.
- **Bezier spaghetti edges with no flow indication.** If you can't tell direction at a glance, you've failed the monitoring use case. n8n suffers from this.
- **Marketing-site "AI sparkle" iconography** anywhere in the canvas. Stars, gradients, halos. Burn them.

## 5. Starter palette + type

| Role | Hex |
|---|---|
| Paper (canvas bg) | `#F2EBDA` |
| Ink (primary line/text) | `#1B2A3A` |
| Graphite (secondary) | `#5B6573` |
| Safety orange (active) | `#E5621F` |
| Oxidized copper (error) | `#8C3B1F` |
| Brass (port/accent) | `#B89253` |
| Stamp red (badges only) | `#A4262C` |

Justifications: cream paper kills the LCD-glare feel; navy ink is darker than black on cream and far more legible; orange is the only saturated hue, so "running" is unmistakable; brass gives ports physical weight.

**UI font:** **Inter Tight** — geometric, condensed enough for dense node headers, free, ships well.
**Terminal/label font:** **JetBrains Mono** — strong glyphs at 11px, distinguishes `Il1` and `O0` (matters for serial numbers and code emission).

## 6. Build stack (ranked)

1. **PixiJS v8 + react-pixi** for the canvas. WebGL-backed, handles 1000+ animated nodes/edges at 60fps, and the per-edge dash animation is trivial as a shader. SVG dies past ~300 animated edges; you will hit that.
2. **React + Zustand** for graph state and side panels; canvas is Pixi, chrome (inspector, palette, run log) is DOM/React. Don't try to render the inspector inside Pixi.
3. **Motion (motion.dev)** for DOM/chrome animations only — node inspector slides, badge stamps, toolbar transitions.
4. **rough.js** sparingly — for the stamp badges and maybe error glyphs, not for primary node strokes (would fight the precision feel).
5. **dagre** or **elkjs** for auto-layout when importing existing fascicle code. ELK gives better orthogonal routing for the schematic look.
6. **Skip:** ReactFlow (you'll fight its renderer within a week), Konva (SVG-ish ceiling), raw three.js (overkill, no 2D ergonomics).

Canvas vs SVG vs WebGL: **WebGL via Pixi**, full stop. SVG is tempting for "blueprint" feel but the per-frame cost of animating dashes on hundreds of edges will kill it. Pixi can render crisp 1.5px strokes via MSAA and a simple line shader, and you get the dash animation for free in a fragment shader.

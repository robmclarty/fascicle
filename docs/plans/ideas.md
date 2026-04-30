# Ideas

Possible directions to build on top of Fascicle. Not a roadmap — a menu.

Fascicle's core bet is "step-as-value across providers." The highest-leverage directions are ones that *consume* that surface rather than re-implement it. The main tradeoff is depth vs. breadth: build one canonical agent product on top to prove the abstraction, or build adjacent infrastructure that makes every flow more observable and reproducible.

## Directions

Roughly ordered by how much they exploit what's already built.

### Trajectory tooling

A replay and debug viewer for the JSONL trajectories: diff two runs of the same flow, scrub through events, surface latency and cost per step. The data is already emitted; nothing else reads it well today.

### Eval / regression harness

Turn flows into goldens. `run(flow, input)` is pure-ish, so a `bench(flow, cases, judges)` primitive on top of `ensemble` and `tournament` is a natural extension. This would position Fascicle as the substrate for *evaluating* agents, not just running them.

### MCP server that exposes flows as tools

Any `Step<i, o>` with a Zod schema is already an MCP tool in disguise. One adapter and Fascicle becomes a way to *author* MCP servers compositionally.

### Deployment shells

Thin runtime wrappers around `run` and `run.stream`:

- HTTP / SSE server (`run.stream` maps directly to SSE)
- Queue-worker shell
- Cloudflare Worker adapter

The composition stays portable; only the runtime ships.

### Flow IR and visual editor

`describe(flow)` already exists. A JSON IR plus a round-trippable visual builder turns Fascicle into something non-engineers can poke at.

### Self-improvement loops as a first-class composer

The `amplify` example hints at this. A `learn` or `distill` primitive that takes a flow plus trajectories and proposes improvements is novel territory most agent libraries don't touch.

### Domain agents on top

Code reviewer, research agent, doc generator. Useful as proof of the abstraction, but adds maintenance surface and doesn't deepen the library itself.

## Recommendation

If picking one: **eval harness + trajectory viewer**, together.

They reinforce each other, they're pure leverage on data already produced, and "the agent framework with serious eval baked in" is a positioning most competitors don't have.

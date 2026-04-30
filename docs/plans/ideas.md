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

> Status: `learn` shipped in `@repo/composites`. `distill` deferred — see [self-improvement-and-agents.md](./self-improvement-and-agents.md). Examples: [`examples/learn.ts`](../../examples/learn.ts) (analyzer-only) and [`examples/learn_reviewer.ts`](../../examples/learn_reviewer.ts) (analyzes trajectories from the reviewer agent).

### `improve` composite — generic bounded improvement loop

The kernel inside `amplify`, with the opinions stripped out: a bounded round loop with parallel proposers, a winner-pick, a lessons accumulator, and plateau detection. Inject `propose` (a step that produces candidates) and `score` (a step that ranks them). Strip the filesystem mutation, the test-suite gate, the subprocess research — those stay in `amplify`-the-example.

The online counterpart to `learn`.

> Status: shipped in `@repo/composites`. `apply` was omitted as an amplify-domain leak — callers wrap the result if they need side effects. Example: [`examples/improve.ts`](../../examples/improve.ts) (toy "walk toward TARGET" demo).

### Domain agents on top

Code reviewer, research agent, doc generator. Useful as proof of the abstraction, but adds maintenance surface and doesn't deepen the library itself.

> Status: shipped in `@repo/agents` — `reviewer` and `documenter` are markdown-defined via the `define_agent` loader; `researcher` is bespoke TS using `loop`. See [self-improvement-and-agents.md](./self-improvement-and-agents.md). Examples: [`examples/reviewer.ts`](../../examples/reviewer.ts), [`examples/documenter.ts`](../../examples/documenter.ts), [`examples/researcher.ts`](../../examples/researcher.ts).

## Recommendation

If picking one: **eval harness + trajectory viewer**, together.

They reinforce each other, they're pure leverage on data already produced, and "the agent framework with serious eval baked in" is a positioning most competitors don't have.

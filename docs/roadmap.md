# Roadmap

A sequenced plan derived from the June 2026 strategic review. The architecture
is sound; the work is wiring, surface, and distribution. Three goals drive the
sequence, and they are compatible when ordered: building blocks for multi-agent
systems, real adoption (internal automations and a local-first memory system), and
credibility as the author.

The guiding principle: stop building to product standards while distributing to
personal-tool standards. Phase 1 made the shipped surface match the pitch.
Phase 2 points it at the two real deployments. Phase 3 makes the work known.

**Status (v0.8.8).** Phase 1 is fully shipped (v0.6.0–v0.6.3). Several changes
landed after this plan was written and are not sequenced below: verbatim model
resolution (v0.7.0, breaking), the collapse of the internal `@repo/*` workspace
into a single `src/` tree (v0.8.0), and the MCP bridge (v0.8.8). The live edge is
mid-Phase 2: the MCP adapter has shipped, and the first deployment that realizes
the two remaining Phase 2 items at once has begun (see Phase 2 below).

## Phase 1: make it true (✅ shipped, v0.6.0–v0.6.3)

The published surface contradicted the trust-positioned pitch at nearly every
consumer touchpoint, and the safety-critical control-flow bugs lived exactly on
the paths the goals depend on. That gap is now closed; the items below shipped
across v0.6.0–v0.6.3 and are kept as a record.

1. Stop `fallback` and `retry` from swallowing control-flow signals
   (`suspended_error`, `aborted_error`); add abort checks between children in
   `sequence` and `scope`; make `parallel` surface a suspend over a sibling
   failure.
2. Repair the engine differentiators: thread user `provider_options` through to
   the SDK, fix effort translation for anthropic and google, and add opt-in
   live-provider smoke tests so a wrong wire format cannot pass silently again.
3. Make observability true: timestamp every trajectory event, populate
   `parent_span_id` so span trees are correct under `parallel` and `map`, and
   record tool results.
4. Fix the front door: publish the `./adapters` subpath, make the README
   example compile (`model_call` default generic), export the documented error
   types.
5. Reconcile docs with the shipped API: replace the nonexistent consensus
   `quorum` with the real `agree` predicate, fix the cookbook recipes, correct
   the viewer invocation, state ESM-only and the Node floor.
6. Make every security claim true: re-resolve the lockfile so the manifest
   overrides apply, pass network isolation when the allowlist is empty.
7. Stand up CI: GitHub Actions running the check suite, a doc-snippet
   compilation check against the built types, and npm provenance on release.

## Phase 2: make it useful to the goals

Two deployment shapes, both script-shaped, unattended, observability-first.

- MCP adapter (**shipped, v0.8.8**): a published MCP bridge (`fascicle/mcp`) that
  works both ways. `mcp_client()` connects to an MCP server over stdio or
  streamable HTTP and returns its tools as plain fascicle `Tool[]`; `serve_flow()`
  exposes composed flows as MCP tools to external hosts (Claude Desktop, Cursor,
  upstream agents). Pure adapter glue: no new tool kind, no new step kind, no
  change to core or engine. `mcp_client` output satisfies the engine's existing
  `Tool<i, o>` contract, and `serve_flow` drives the existing `run`.
  `@modelcontextprotocol/sdk` rides as an optional peer dependency, so consumers
  that never touch MCP do not install it. It was promoted out of
  `examples/mcp-server/` into the published surface. Still deferred to a later
  pass: auth on the HTTP transport, MCP `sampling`, per-tool approval gating, and
  `resources` subscriptions.
- First internal automation in production **and** the local-first memory system
  (**started**): these two items collapse into one deployment rather than two. The
  conflict-aware ingestion/adjudication pipeline of the memory system *is* the
  first internal automation: unattended and cron-shaped rather than chat, pinned to
  a published fascicle version, routing every model call through the engine API,
  and observable because the trajectory is the audit trail. Local models so data
  never leaves the house; the library hands over the spine and the audit trail, and
  the memory is built on top as a separate application repo (not vendored here). The
  suspend-gate fix from Phase 1 is a precondition. Live edge: the write-side
  adjudicator (the version/conflict reconciliation that off-the-shelf RAG lacks) is
  the first slice, scaffolded and proven end-to-end against the published surface.
- Done (v0.8.0): top-level examples import the published `fascicle` surface so
  they are consumer-runnable; the built-in agents stay workspace-private
  (`fascicle/agents` is a dev-only alias, not a published export), so the five
  agent examples are repo-only.

## Phase 3: make it known

- A docs site.
- Three essays already latent in the codebase: deliberation as a composition
  primitive; regression-testing model behavior with mutation-tested judges
  (`bench`/`judges`/`regression`); and the memory-system case study once it
  exists.
- Then a launch, as a demonstration artifact backed by production proof rather
  than a falsification test. The `claude_cli` rebase onto the Agent SDK slots in
  wherever provider metering forces it.

## Backlog / candidates (not yet sequenced)

Considered or partially scoped, folded in from the old `docs/plans/` menu. Not phase
commitments — leverage bets to draw from once Phase 2 lands. The standing "won't build"
commitments behind several of these live in
[`research/explorations/2026-04-competition.md`](../research/explorations/2026-04-competition.md).

- **Visualization (the headline).** A live picture of a flow firing is the demo that sells
  step-as-value. The structural canvas lives in the separate `weft` repo; the long-term
  north star is [`research/papers/0001-studio-pdr.md`](../research/papers/0001-studio-pdr.md).
  Phase 1 overlays trajectory events on the canvas (active spans, cost rollup, error scars);
  Studio v2 adds drag-to-build plus one-way codegen. Hold publishing until the live overlay lands.
- **Deployment shells.** Thin runtime wrappers around `run` / `run.stream` — HTTP/SSE,
  queue-worker, Cloudflare Worker. Composition stays portable; only the runtime ships. (A broader
  deployment story is otherwise deferred — see below.)
- **`distill`.** Flow extraction from an (input, output) corpus. Out of scope until `learn` has a
  real user; rationale in
  [`research/explorations/2026-04-self-improvement-and-agents.md`](../research/explorations/2026-04-self-improvement-and-agents.md).
- **Papercuts.** Low-stakes viewer/bench cleanups captured in
  [`research/explorations/2026-04-eval-surface.md`](../research/explorations/2026-04-eval-surface.md) §11
  (run-id truncation, log pagination, deterministic bench baselines, `judge_llm` wiring).
- **Observability adapters (community territory).** Langfuse, LangSmith, Phoenix, Helicone,
  Braintrust, OpenLLMetry — each a `TrajectoryLogger`. Document the contract, point at
  `http_logger` / `filesystem_logger` as references, and let contributors own them.
- **Deferred composition primitives.** Candidate composers (`race`, `debounce`/`throttle`,
  `cache`, `circuit_breaker`, `batch`/`unbatch`, `poll_until`) are parked with their user-land
  workarounds and a promotion bar in [`src/core/BACKLOG.md`](../src/core/BACKLOG.md). Promote one
  only when its pattern recurs across two unrelated flows and is awkward to express today.
- **Open design questions (composition layer).** Two calls are deferred pending a real use case,
  not rejected: (1) *cancellation granularity* — `ensemble` / `tournament` / `consensus` cancel
  all in-flight children on abort; letting the first resolver win and preemptively cancelling
  siblings is the `race` semantics, still undecided. (2) *Suspend and checkpoint state lifecycle*
  — persisted suspend and checkpoint state has no GC or TTL, and filesystem checkpoint stores are
  last-write-wins across processes; whether a first-party helper owns this or it stays
  application-level is open. Runtime `.flow.yaml` parsing stays documentation-only until
  downstream demand appears.

## Explicitly not before release

These were considered and deliberately deferred. Doing any of them now trades
surface correctness for interior work users cannot see, or adds scope the goals
do not need:

- ~~An eighth provider.~~ Superseded: AWS Bedrock shipped as the eighth provider in v0.7.0.
- Feature parity with Mastra or Strands (memory modules, an Agent class,
  multi-agent handoffs).
- A `Step`-type variance redesign. Document the inference limits honestly
  instead: only first-input and last-output are inferred, adjacent
  compatibility is not checked, and `parallel` infers a wide input for
  mismatched members.
- A rename or camelCase conversion.
- New composers (including a `quorum` convenience; the `agree` predicate is
  strictly more expressive).
- An OpenTelemetry bridge. The synchronous, flush-less logger contract blocks a
  correct exporter; revisit post-launch.
- A deployment story or a Python port.

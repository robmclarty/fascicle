# Roadmap

A sequenced plan derived from the June 2026 strategic review. The architecture
is sound; the work is wiring, surface, and distribution. Three goals drive the
sequence, and they are compatible when ordered: building blocks for multi-agent
systems, real adoption (internal automations and a local-first memory system), and
credibility as the author.

The guiding principle: stop building to product standards while distributing to
personal-tool standards. Phase 1 made the shipped surface match the pitch.
Phase 2 points it at the two real deployments. Phase 3 makes the work known.

**Status (v0.8.0).** Phase 1 is fully shipped (v0.6.0–v0.6.3). Two changes
landed after this plan was written and are not sequenced below: verbatim model
resolution (v0.7.0, breaking) and the collapse of the internal `@repo/*`
workspace into a single `src/` tree (v0.8.0). The live edge is now mid-Phase 2.

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

- MCP tools adapter (**next, still pending**): an `mcp_tools()` helper mapping
  an MCP server's tools into fascicle `Tool` values. Tools are already injected
  plain values, so this is a contained adapter, not framework creep. It is the
  first real capability gap for work agents that touch Slack, databases, and
  internal APIs. Today it exists only as `examples/mcp-server/`; the work is to
  promote it into the published surface.
- First internal automation in production, pinned to a published version.
- Start the local-first memory system as the flagship personal deployment:
  local models so data never leaves the house, cron-shaped rather than chat,
  and observable because the trajectory is the safety record. The library hands
  over the spine and the audit trail; the memory itself is built on top as an
  application. The suspend-gate fix from Phase 1 is a precondition for this one.
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
- **MCP server as a library helper.** Promote `examples/mcp-server/` into the published surface
  so any `Step<i, o>` with a Zod schema becomes an MCP tool with one call (`serve_mcp`). This is
  the *outbound* direction; the *inbound* `mcp_tools()` adapter is already in Phase 2.
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

# Roadmap

A sequenced plan derived from the June 2026 strategic review. The architecture
is sound; the work is wiring, surface, and distribution. Three goals drive the
sequence, and they are compatible when ordered: building blocks for multi-agent
systems, real adoption (internal automations and a local-first memory system), and
credibility as the author.

The guiding principle: stop building to product standards while distributing to
personal-tool standards. Phase 1 makes the shipped surface match the pitch.
Phase 2 points it at the two real deployments. Phase 3 makes the work known.

## Phase 1: make it true

The published surface contradicts the trust-positioned pitch at nearly every
consumer touchpoint, and the safety-critical control-flow bugs live exactly on
the paths the goals depend on. Close that gap first.

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

- MCP tools adapter: an `mcp_tools()` helper mapping an MCP server's tools into
  fascicle `Tool` values. Tools are already injected plain values, so this is a
  contained adapter, not framework creep. It is the first real capability gap
  for work agents that touch Slack, databases, and internal APIs.
- First internal automation in production, pinned to a published version.
- Start the local-first memory system as the flagship personal deployment:
  local models so data never leaves the house, cron-shaped rather than chat,
  and observable because the trajectory is the safety record. The library hands
  over the spine and the audit trail; the memory itself is built on top as an
  application. The suspend-gate fix from Phase 1 is a precondition for this one.
- Rewrite examples to import `fascicle` (not `@repo/fascicle`) so they are
  consumer-runnable; ship or cut `@repo/agents`.

## Phase 3: make it known

- A docs site.
- Three essays already latent in the codebase: deliberation as a composition
  primitive; regression-testing model behavior with mutation-tested judges
  (`bench`/`judges`/`regression`); and the memory-system case study once it
  exists.
- Then a launch, as a demonstration artifact backed by production proof rather
  than a falsification test. The `claude_cli` rebase onto the Agent SDK slots in
  wherever provider metering forces it.

## Explicitly not before release

These were considered and deliberately deferred. Doing any of them now trades
surface correctness for interior work users cannot see, or adds scope the goals
do not need:

- An eighth provider.
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

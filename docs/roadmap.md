# Roadmap

What has shipped, what is being considered, and what fascicle deliberately will
not do. This is a direction, not a commitment: fascicle is pre-1.0 and the
sequence changes as real usage lands. Pin an exact version and upgrade
deliberately.

## Shipped

The published surface as of v0.9.6:

- **Composition.** 21 primitives over a single `Step<i, o>` value type, plus
  `run` / `run.stream` and opt-in durability via `checkpoint`, `suspend`, and
  `resume`.
- **A provider-sovereign engine.** One `generate` seam fronts eight providers.
  Most wrap the Vercel AI SDK; five can instead run `transport: 'native'` (raw
  HTTP, no SDK in the path): `anthropic` on the Messages API, `openai` /
  `openrouter` / `lmstudio` on a shared OpenAI-compatible core, and `ollama` on
  `/api/chat`. `claude_cli` delegates to an external agent process, and
  `custom_providers` registers your own adapter without touching fascicle.
  Model ids are opaque and sent verbatim.
- **Loop control.** Multi-step tool loops with tool-call salvage for models that
  emit calls as prose, approval gating, deterministic turn-ending, per-turn
  timeout budgets, a `prepare_step` hook, and cost accounting.
- **MCP, both directions** (`fascicle/mcp`). `mcp_client()` turns an MCP
  server's tools into plain fascicle `Tool[]` over stdio or streamable HTTP;
  `serve_flow()` exposes composed flows as MCP tools to external hosts.
  `@modelcontextprotocol/sdk` rides as an optional peer.
- **Observability.** A trajectory event stream with correct span trees under
  `parallel` and `map`, `TrajectoryLogger` / `CheckpointStore` contracts small
  enough to implement yourself, a bundled viewer, and a transport-neutral
  `fascicle/otel` bridge (see
  [configuration.md](./configuration.md#opentelemetry)).
- **An app architecture.** [`docs/blueprint.md`](./blueprint.md) standardizes the
  consumer-app shape, with reference agents in
  [`examples/agents/`](../examples/agents/) and the worked example in
  [`examples/pr-improve/`](../examples/pr-improve/).
- **Supply-chain posture.** Releases publish from CI with npm Trusted Publishing
  (OIDC) and a signed provenance attestation; verify one with
  `npm audit signatures`. See [SECURITY.md](../SECURITY.md).

## Near-term

- **MCP hardening.** Auth on the HTTP transport, MCP `sampling`, per-tool
  approval gating, and `resources` subscriptions were all deferred out of the
  first bridge.
- **Live trajectory visualization.** A picture of a flow firing is the
  demonstration that sells step-as-value: active spans, cost rollup, and error
  scars overlaid on the structural canvas.
- **`claude_cli` on the Agent SDK.** Rebasing the subprocess adapter onto
  Anthropic's Agent SDK, slotted in wherever provider metering forces it.

## Under consideration

Scoped but not sequenced. Each is a leverage bet, not a promise.

- **Deployment shells.** Thin runtime wrappers around `run` / `run.stream`:
  HTTP/SSE, queue-worker, Cloudflare Worker. Composition stays portable; only the
  runtime ships.
- **Observability adapters (community territory).** Langfuse, LangSmith, Phoenix,
  Helicone, Braintrust, OpenLLMetry, each of which is a `TrajectoryLogger`. The intent is
  to document the contract, point at `http_logger` / `filesystem_logger` as
  reference implementations, and let contributors own the rest.
- **Deferred composition primitives.** Candidates (`race`, `debounce` /
  `throttle`, `cache`, `circuit_breaker`, `batch` / `unbatch`, `poll_until`) are
  parked with their user-land workarounds in
  [`src/core/BACKLOG.md`](../src/core/BACKLOG.md). A composer earns promotion only
  when its pattern recurs across two unrelated flows and is awkward to express
  today.
- **Viewer and bench papercuts.** Run-id truncation, log pagination,
  deterministic bench baselines, `judge_llm` wiring.

## Open design questions

Two calls are deferred pending a real use case, not rejected:

1. **Cancellation granularity.** `ensemble`, `tournament`, and `consensus` cancel
   all in-flight children on abort. Letting the first resolver win and
   preemptively cancelling its siblings is `race` semantics, and whether that
   belongs as a mode or a separate composer is undecided.
2. **Suspend and checkpoint state lifecycle.** Persisted suspend and checkpoint
   state has no GC or TTL, and filesystem checkpoint stores are last-write-wins
   across processes. Whether a first-party helper owns this or it stays
   application-level is open.

Runtime `.flow.yaml` parsing stays documentation-only until downstream demand
appears.

## Not planned

Deliberate exclusions. Each trades surface correctness for interior work users
cannot see, or adds scope fascicle does not need:

- **Feature parity with the broad frameworks**: memory modules, an `Agent`
  class, multi-agent handoffs. [comparison.md](./comparison.md) names the tools
  that do these well.
- **A `Step`-type variance redesign.** The inference limits are documented
  honestly instead: only first-input and last-output are inferred, adjacent
  compatibility is not checked, and `parallel` infers a wide input for mismatched
  members.
- **A rename or camelCase conversion.**
- **New convenience composers** that an existing primitive already expresses (a
  `quorum` helper, for instance; the `agree` predicate is strictly more
  expressive).
- **A Python port.** fascicle is TypeScript-only by design.

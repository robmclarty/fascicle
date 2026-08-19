# Roadmap

What has shipped, what I'm considering, and what fascicle won't do. Read this as
a direction and not a commitment. fascicle is pre-1.0, and the sequence changes as
real usage lands, so pin an exact version and upgrade on purpose.

## Shipped

The published surface as of v0.12.0:

- **Composition.** 22 primitives over a single `Step<i, o>` value type. You get
  the `chain` spine (`.step` / `.stage` / `.output`), `model_step` as the default
  model boundary, `ctx.call` for direct-style sub-steps, a `project` option on
  the envelope composites, and compile-time joint checking for literal
  `sequence` tuples (runtime-built arrays still degrade to unknown
  boundaries). The `Step` type is sound, because `run` is a function property with
  contravariant input and `AnyStep` is the erased supertype. Runners are
  `run` / `run.stream` / `run.until_suspended`, with opt-in durability via
  `checkpoint`, `suspend`, and `resume`.
- **A provider-sovereign engine.** One `generate` seam fronts eight providers.
  Most wrap the Vercel AI SDK, and five can instead run `transport: 'native'`
  (raw HTTP, no SDK in the path). Those five are `anthropic` on the Messages API,
  `openai` / `openrouter` / `lmstudio` on a shared OpenAI-compatible core, and
  `ollama` on `/api/chat`. `claude_cli` delegates to an external agent process, and
  `custom_providers` registers your own adapter without touching fascicle.
  Model ids are opaque and sent verbatim.
- **Loop control.** Multi-step tool loops with tool-call salvage for models that
  emit calls as prose, approval gating, deterministic turn-ending, per-turn
  timeout budgets, a `prepare_step` hook, and cost accounting.
- **MCP, both directions** (`fascicle/mcp`). `mcp_client()` turns an MCP
  server's tools into plain fascicle `Tool[]` over stdio or streamable HTTP, and
  `serve_flow()` exposes your composed flows as MCP tools to external hosts.
  `@modelcontextprotocol/sdk` rides as an optional peer.
- **Observability.** A trajectory event stream with correct span trees under
  `parallel` and `map`, `TrajectoryLogger` / `CheckpointStore` contracts small
  enough to implement yourself, a bundled viewer, and a transport-neutral
  `fascicle/otel` bridge (see
  [configuration.md](./configuration.md#opentelemetry)).
- **An app architecture.** [`docs/blueprint.md`](./blueprint.md) standardizes the
  consumer-app shape, [`docs/leaf-arm-spine.md`](./leaf-arm-spine.md) names the
  layering (with [`docs/advanced-composition.md`](./advanced-composition.md)
  covering the demoted tier), and the worked examples are the vocabulary tour
  in [`examples/newsroom.ts`](../examples/newsroom.ts), reference agents in
  [`examples/agents/`](../examples/agents/), and the app-scale
  [`examples/pr-improve/`](../examples/pr-improve/).
- **Testing doubles** (`fascicle/testing`). `make_stub_engine` routes canned
  responses by system-prompt prefix and validates them through the call's schema,
  and `make_capture_engine` records every call's `GenerateOptions` so you can
  assert on them.
- **Supply-chain posture.** Releases publish from CI with npm Trusted Publishing
  (OIDC) and a signed provenance attestation, and you can verify one with
  `npm audit signatures`. See [SECURITY.md](../SECURITY.md).

## Near-Term

- **MCP hardening.** Auth on the HTTP transport, MCP `sampling`, per-tool
  approval gating, and `resources` subscriptions were all deferred out of the
  first bridge.
- **Live trajectory visualization.** A picture of a flow firing is the
  demonstration that sells step-as-value, with active spans, cost rollup, and
  error scars overlaid on the structural canvas.
- **`claude_cli` on the Agent SDK.** Rebasing the subprocess adapter onto
  Anthropic's Agent SDK, slotted in wherever provider metering forces it.

## Under Consideration

Scoped but not sequenced. Each one is a bet on leverage, not a promise to you.

- **Deployment shells.** Thin runtime wrappers around `run` / `run.stream`, so
  HTTP/SSE, a queue worker, or a Cloudflare Worker. Your composition stays
  portable, and only the runtime ships.
- **Observability adapters (community territory).** Langfuse, LangSmith, Phoenix,
  Helicone, Braintrust, OpenLLMetry, each of which is a `TrajectoryLogger`. I want
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

## Open Design Questions

I've deferred two calls pending a real use case, and neither is rejected:

1. **Cancellation granularity.** `ensemble`, `ensemble_step`, `tournament`, and
   `consensus` cancel all in-flight children on abort. Letting the first
   resolver win and preemptively cancelling its siblings is `race` semantics,
   and whether that belongs as a mode or a separate composer is undecided.
2. **Suspend and checkpoint state lifecycle.** Persisted suspend and checkpoint
   state has no GC or TTL, and filesystem checkpoint stores are last-write-wins
   across processes. Whether a first-party helper owns this or it stays
   application-level is open.

Runtime `.flow.yaml` parsing stays documentation-only until downstream demand
appears.

## Not Planned

These are the exclusions I've chosen. Each one trades surface correctness for
interior work you can't see, or adds scope fascicle doesn't need:

- **Feature parity with the broad frameworks**, so no memory modules, no `Agent`
  class, no multi-agent handoffs. [comparison.md](./comparison.md) names the tools
  that do these well.
- **A rename or camelCase conversion.**
- **New convenience composers** that an existing primitive already expresses. A
  `quorum` helper is the example I keep being asked for, and the `agree` predicate
  is strictly more expressive than one.
- **A Python port.** fascicle is TypeScript-only by design.

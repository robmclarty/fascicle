# Roadmap

What has shipped, what I know is broken, what I'm considering, and what Fascicle
won't do. Read this as a direction and not a commitment. Fascicle is pre-1.0,
and the sequence changes as real usage lands, so pin an exact version and
upgrade on purpose.

## Shipped

The published surface as of v0.15.0:

- **Composition.** 23 primitives over a single `Step<i, o>` value type. You get
  the `chain` spine (`.step` / `.stage` / `.output`), `model_step` as the default
  model boundary, `ctx.call` for direct-style sub-steps, a `project` option on
  the envelope composites, a `settle` mode that lets `map` keep every item's
  outcome past a failure, and compile-time joint checking for literal
  `sequence` tuples (runtime-built arrays still degrade to unknown
  boundaries). The `Step` type is sound, because `run` is a function property with
  contravariant input and `AnyStep` is the erased supertype. Runners are
  `run` / `run.stream` / `run.until_suspended`, with opt-in durability via
  `checkpoint`, `suspend`, and `resume`.
- **Durable runs.** `durable({ store })` keeps a run that suspends in a store
  between events, so you can resume it from a webhook, a finished job, or a
  deadline timer, each in a fresh process. A lease keeps two invocations from
  driving one run at once, an event that lands while the run is busy waits in
  its inbox, and a run whose flow changed shape under it fails loudly instead of
  replaying the wrong steps. A `suspend` gate can carry a deadline, `gate`
  checkpoints paid work before an approval pause, and a step marked
  `side_effect` records a `step_replayed` event whenever a resume runs it again,
  so you can see what a resume paid for twice. `describe.replays` finds those
  steps from the flow's shape before anything runs, so you can hold a flow to
  having none in a test. Stores can scope and claim, and
  [`examples/object-store/`](../examples/object-store/) shows you how to write
  one over an S3-style client.
- **A provider-sovereign engine.** One `generate` seam fronts eight providers.
  Most wrap the Vercel AI SDK, and five can instead run `transport: 'native'`
  (raw HTTP, no SDK in the path). Those five are `anthropic` on the Messages API,
  `openai` / `openrouter` / `lmstudio` on a shared OpenAI-compatible core, and
  `ollama` on `/api/chat`. `claude_cli` delegates to an external agent process, and
  `custom_providers` registers your own adapter without touching Fascicle.
  Model ids are opaque and sent verbatim.
- **Reasoning that lasts a whole tool loop.** A tool loop hands each model its
  own reasoning back on the next step, on the `ai_sdk` transport and on
  `anthropic` and `openrouter` native, so a Claude loop keeps its thinking and a
  Gemini 3 loop isn't refused. Each part of a turn carries the data that its
  provider wants back (a thinking block's signature, an OpenRouter reasoning
  entry, Gemini's thought signature on a tool call) under that provider's name,
  so a `fallback` never hands one vendor's signature to another. On the native
  transport, OpenRouter's reasoning also streams to `on_chunk`, so you can watch
  what the model reasoned in Zed's thought block or a `useChat` UI. See
  [providers.md](./providers.md#reasoning-in-a-tool-loop).
- **Loop control.** Multi-step tool loops with tool-call salvage for models that
  emit calls as prose, approval gating, deterministic turn-ending, per-turn
  timeout budgets, a `prepare_step` hook, and cost accounting. On OpenRouter's
  native transport, the charge that OpenRouter reports for each response is the
  step's cost, a BYOK request's upstream charge included, so `cost` events and
  the budgets you build on them work there with no pricing row.
- **Markdown-defined agents** (`fascicle/agents`). When an agent is just a
  prompt and an output schema, `define_agent` folds a markdown file and a schema
  into a `Step<i, o>`. The frontmatter names the agent and sets its model,
  provider, effort, and sampling, the body is the prompt, and you can set every
  one of those knobs on the config too, where code wins over frontmatter.
- **MCP, both directions** (`fascicle/mcp`). `mcp_client()` turns an MCP
  server's tools into plain Fascicle `Tool[]` over stdio or streamable HTTP, and
  `serve_flow()` exposes your composed flows as MCP tools to external hosts.
  `@modelcontextprotocol/sdk` rides as an optional peer.
- **Editor agents over ACP** (`fascicle/acp`). `serve_acp` serves a flow as an
  [Agent Client Protocol](https://agentclientprotocol.com) agent over stdio, so
  you can talk to it in Zed's agent panel beside Claude Code, Codex, and Gemini
  CLI while its text, reasoning, and tool calls stream back into the thread.
  `workspace_tools(session)` hands a coding agent the six tools it needs, which
  read, list, search, write, and edit files on disk and run commands in a shell
  of their own. A file tool reaches only paths inside the session's workspace,
  the session asks before an edit or a command as often as its mode (Manual,
  Accept edits, or Auto) says, and each tool card looks the way Claude Agent's
  does. `@agentclientprotocol/sdk` rides as an optional peer,
  [`examples/acp-coder/`](../examples/acp-coder/) is a working coding agent on
  OpenRouter, and [acp.md](./acp.md) covers the rest.
- **Chat UIs** (`fascicle/ui`). `to_ui_message_response` turns a `run.stream`
  handle into the AI SDK's UI message stream, so you can back a `useChat`
  endpoint with a flow, and `pipe_ui_message_stream_to_response` does the same
  for a `node:http` server. It needs `ai` as a peer, and
  [human-in-the-loop.md](./human-in-the-loop.md) pairs it with suspend and
  resume over HTTP.
- **Flows as child processes** (`fascicle/stdio`). `run_stdio(flow, options)`
  runs a flow as a single-shot child that reads JSON on stdin, can check the
  input and the result against a schema, writes one JSON result on stdout, and
  keeps its trajectory on stderr. The exit code is the verdict (0 when the
  result is authoritative, 1 for a flow failure, 2 for a broken contract), so a
  parent that only speaks JSON over stdio can drive it. See
  [embedding-under-a-harness.md](./embedding-under-a-harness.md).
- **Observability.** A trajectory event stream with correct span trees under
  `parallel` and `map`, `TrajectoryLogger` / `CheckpointStore` contracts small
  enough to implement yourself, the run canvas viewer that draws a live run and
  replays a finished one over one pure fold, and a transport-neutral
  `fascicle/otel` bridge (see [configuration.md](./configuration.md#opentelemetry)).
  `describe.diagram` draws a flow as an annotated tree, and the
  `fascicle-diagram` bin prints the same diagram from a terminal.
- **An app architecture.** [`docs/blueprint.md`](./blueprint.md) standardizes the
  consumer-app shape, [`docs/leaf-arm-spine.md`](./leaf-arm-spine.md) names the
  layering (with [`docs/advanced-composition.md`](./advanced-composition.md)
  covering the demoted tier), and the worked examples are the vocabulary tour
  in [`examples/newsroom/main.ts`](../examples/newsroom/main.ts), reference agents in
  [`examples/agents/`](../examples/agents/), and the app-scale
  [`examples/pr-improve/`](../examples/pr-improve/).
- **Testing doubles** (`fascicle/testing`). `make_stub_engine` routes canned
  responses by system-prompt prefix and validates them through the call's schema,
  `make_script_engine` plays responses back in a strict call order, and
  `make_capture_engine` records every call's `GenerateOptions` so you can
  assert on them. `checkpoint_store_conformance` checks that a store you wrote
  keeps the `CheckpointStore` contract, scopes and claims included.
- **Supply-chain posture.** Releases publish from CI with npm Trusted Publishing
  (OIDC) and a signed provenance attestation, and you can verify one with
  `npm audit signatures`. See [SECURITY.md](../SECURITY.md).

## Near-Term

- **MCP hardening.** Auth on the HTTP transport, MCP `sampling`, per-tool
  approval gating, and `resources` subscriptions were all deferred out of the
  first bridge.
- **`claude_cli` on the Agent SDK.** Rebasing the subprocess adapter onto
  Anthropic's Agent SDK, slotted in wherever provider metering forces it.
- **ACP sessions that last, and the rest of Zed's thread.** A thread that you
  can reopen after the agent restarts, from sessions that a `CheckpointStore`
  keeps. Around it, usage and cost for Zed's context ring, a model picker,
  thread titles, a stop reason for a turn that runs out of steps, the MCP
  servers that the editor sends, and the auth method that the ACP registry asks
  for. [acp.md](./acp.md#whats-missing-in-zed) lists what you'll notice is
  missing today.

## Known Issues

These are the bugs that I know about and haven't fixed yet, with the ones most
likely to bite you first.

- **Pick-best composites misread `undefined` and NaN.** `ensemble`,
  `ensemble_step`, and `tournament` treat a member that returns `undefined` as
  one that returned nothing at all, and `ensemble` and `ensemble_step` let a NaN
  score win when it comes first.
- **`suspend` and `gate` don't check their ids.** An empty id, or one that isn't
  an identifier, gets through, though `step` and `chain` refuse both.
- **`claude_cli` turns a structured `null` into the string `"null"`.** When you
  pass a `schema` and the reply parses to `null`, `content` holds the raw text.
- **OpenRouter's cache writes go uncounted.** On `transport: 'native'`, usage
  reads the `cached_tokens` that OpenRouter reports but not its
  `cache_write_tokens`, so a model with explicit caching shows no cache writes.
  The cost that OpenRouter reports, which is what the step records, is right.
- **`checkpoint` fails the run when its write fails.** A failed read counts as a
  miss and the run goes on, but a failed write fails the run after the step that
  it wraps has finished, and after you've paid for that step.
- **`bench`'s `CaseResult` has an `_input` field that's never set.** It exists
  only to give the input type parameter a use.
- **The viewer slows down on long runs and clips large flows.** Holding or
  playing the scrubber refolds the run from its first event at every position,
  so a long run lags. A flow that's still bigger than the window at the
  smallest zoom loses its right and bottom edges, with no way to pan to them.
- **An open tab misses events after the viewer restarts.** Event ids start over
  with the server, so a tab that reconnects asks for the events after its old
  id and gets nothing until the new ids pass it, then folds the run from the
  middle. Reload the tab after you restart the viewer.
- **`run_stdio` leaves the console on stdout.** A stray `console.log` in your
  flow lands ahead of the result, and the run still exits 0, so log to stderr
  under `run_stdio`. `serve_acp` moves the console off stdout for you.
- **An `acp_agent` app serves one connection.** A transport of your own builds
  an app for each connection, and an agent that runs for a long time holds the
  history of every session that it has opened. [acp.md](./acp.md#serve_acp) has
  the details.
- **Some provider errors don't say what to do.** Many name what went wrong but
  not the fix, such as the config key to set or the `base_url` to check.
- **Housekeeping.** Engine code that only tests call (`normalize_chunk` and
  `record_request_sent`), a schema-issue formatter that `fascicle/testing`
  repeats, a viewer test that runs before the build that it checks, tsdown
  options that are dead or deprecated, four devDependencies on caret ranges, and
  a mutation-ratchet comment with stale numbers.

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
- **Bench papercuts.** Deterministic bench baselines and `judge_llm` wiring.

## Open Design Questions

I've deferred one call pending a real use case, and it isn't rejected:

1. **Cancellation granularity.** `ensemble`, `ensemble_step`, `tournament`, and
   `consensus` cancel all in-flight children on abort. Letting the first
   resolver win and preemptively cancelling its siblings is `race` semantics,
   and whether that belongs as a mode or a separate composer is undecided.

The other question I'd parked here, the lifecycle of suspend and checkpoint
state, got its real use case and an answer. `durable` claims a run before it
drives it and checks the record's revision on every write, so two processes
don't drive one run at once, and a drive that stalls past its claim can't
write over the one that took over. Deleting the run's scope is how its state
goes away. Retention past that belongs to the store,
which knows its own expiry far better than a timestamp on every write would.

Runtime `.flow.yaml` parsing stays documentation-only until downstream demand
appears.

## Not Planned

These are the exclusions I've chosen. Each one trades surface correctness for
interior work you can't see, or adds scope that Fascicle doesn't need:

- **Feature parity with the broad frameworks**, so no memory modules, no `Agent`
  class, no multi-agent handoffs. [comparison.md](./comparison.md) names the tools
  that do these well.
- **A rename or camelCase conversion.**
- **New convenience composers** that an existing primitive already expresses. A
  `quorum` helper is the usual example, and the `agree` predicate is strictly more
  expressive than one.
- **A Python port.** Fascicle is TypeScript-only by design.

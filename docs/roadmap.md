# Roadmap

What has shipped, what I know is broken, what I'm considering, and what Fascicle
won't do. Read this as a direction and not a commitment. Fascicle is pre-1.0,
and the sequence changes as real usage lands, so pin an exact version and
upgrade on purpose.

## Shipped

The published surface as of v0.19.0:

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
  replaying the wrong steps. A `suspend` gate can carry a deadline, and `gate`
  checkpoints paid work before an approval pause. A resumed gate serves the
  result that the approver saw or fails the run, and a flow that uses one
  suspend id twice, or reaches one again on another input, fails rather than
  pass on an approval that was given for something else. A step marked
  `side_effect` records a `step_replayed` event whenever a resume runs it again,
  so you can see what a resume paid for twice. `describe.replays` finds those
  steps from the flow's shape before anything runs, so you can hold a flow to
  having none in a test. Stores can scope, claim, and write on a condition, so every write that
  `durable` makes lands only on the record it read. `object_store` in
  `fascicle/adapters` keeps a run in a bucket for more than one host to drive,
  over a small client that you write for your bucket, `sqlite_store` keeps one
  in a single file on `node:sqlite`, and
  [`examples/object-store/`](../examples/object-store/) runs the first of them.
  A drive can stream with `record_chunks`.
- **A provider-sovereign engine.** One `generate` seam fronts eight providers.
  Most wrap the Vercel AI SDK, and five can instead run `transport: 'native'`
  (raw HTTP, no SDK in the path). Those five are `anthropic` on the Messages API,
  `openai` / `openrouter` / `lmstudio` on a shared OpenAI-compatible core, and
  `ollama` on `/api/chat`. `claude_cli` delegates to an external agent process, and
  `custom_providers` registers your own adapter without touching Fascicle.
  Model ids are opaque and sent verbatim. A rate limit, a 5xx, or a dropped
  connection retries for 7 to 10 s by default, and a failure that outlasts the
  retries throws an error that carries the status, the response body, the
  attempt count, and the provider's own error as its `cause`. The run's end
  events carry the status and the attempt count as fields too, so a dashboard
  can count them without parsing a message. A 4xx throws the same typed error
  on either transport, and its message says what to check, so a 401 names the
  key and a refused connection names the URL. `claude_cli` can run under
  Claude Code's own sandbox (`sandbox: { kind: 'claude_code' }`), which the
  CLI enforces at the OS level, so its commands reach only the hosts in
  `network_allowlist` and write only where you allow. `omit_env` keeps the
  variables that you name out of the CLI's env.
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
  timeout budgets, a `prepare_step` hook, and cost accounting. When
  `max_tool_calls_per_step` drops a call, the loop tells the model which calls
  didn't run, and a tool that sets `read_only` doesn't count toward the cap, so
  a turn can make several reads and still make only one write.
  `truncated_turn_policy: 'continue'` keeps a loop going past a turn that hit
  its output limit before it made a call. Prompt caching
  is one option, `cache`, that every adapter answers the way it declares, and
  an Anthropic tool loop caches by default, so each turn after the first reads
  the conversation back instead of paying for it again. `define_tool`
  hands a tool's `execute` the type that its input schema validates to, so a
  tool no longer parses its input a second time. On OpenRouter's native
  transport, the charge that OpenRouter reports for each response is the step's
  cost, a BYOK request's upstream charge included, so `cost` events and the
  budgets you build on them work there with no pricing row.
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
  does. A `session_store` keeps sessions, so a thread survives a restart, and
  config turns on the rest of what Zed draws around a thread: the context ring
  and the cost, a model picker, and the MCP servers that you've set up in the
  editor. A thread takes its title from its first prompt, and a turn says why
  it stopped. `@agentclientprotocol/sdk` (1.8 or 2.x) rides as an optional peer,
  [`examples/acp-coder/`](../examples/acp-coder/) is a working coding agent on
  OpenRouter, and [acp.md](./acp.md) covers the rest.
- **Network agents over A2A** (`fascicle/a2a`). `serve_a2a` serves a flow as an
  Agent2Agent agent over JSON-RPC, so an agent built on another framework can
  hand it work over HTTP, and `a2a_step` calls a remote agent from inside a
  flow. Every task is a durable run, so a task that asks a question waits in
  the store until the answer comes. `@a2a-js/sdk` rides as an optional peer,
  [`examples/a2a-agent/`](../examples/a2a-agent/) is a working pair, and
  [a2a.md](./a2a.md) covers the rest.
- **Reading the web** (`fascicle/web`). `web_tools()` hands an agent
  `web_fetch`, which takes a URL and returns the page as text that a model can
  read, and `web_search` once you pass it a search backend. Both run in your own
  process, so an agent on Ollama reads the web as well as one on Claude does.
  `web_fetch` refuses the addresses that a server shouldn't be asked to reach
  (loopback, the private ranges, and the cloud metadata address), on the first
  request and on every redirect, and it caps what it reads and how long it
  waits. `searxng_search` searches through a SearXNG server that you run with
  no key, `brave_search` takes a key for a hosted index, and any function of the
  same shape fits in their place. The subpath adds no dependency,
  [`examples/web-research/`](../examples/web-research/) answers a question from
  the web and cites what it read, and [web.md](./web.md) covers the rest, the
  risks of handing a model the web among them.
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
  Pass `follow_links: false` and the viewer reads a run's trajectory without
  following a link, so a link that's swapped in after you checked the path
  can't make it serve another file. A call's `capture` option records what
  each turn sent the model and what came back (see
  [concepts.md](./concepts.md#what-gets-recorded)).
  `describe.diagram` draws a flow as an annotated tree, and the
  `fascicle-diagram` bin prints the same diagram from a terminal, or with
  `--outline` the plain outline that `describe` prints.
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
  assert on them. `make_loop_engine` scripts only the model, so the engine's own
  tool loop runs the tools and keeps every request that the model was sent,
  and `assert_prefix_stable` checks that each of those requests only appended
  to the one before it, so a provider's prompt cache can hold across the loop.
  `checkpoint_store_conformance` checks that a store you wrote
  keeps the `CheckpointStore` contract, with scopes, claims, and the
  compare-and-set included.
- **Supply-chain posture.** Releases publish from CI with npm Trusted Publishing
  (OIDC) and a signed provenance attestation, and you can verify one with
  `npm audit signatures`. See [SECURITY.md](../SECURITY.md).

## Near-Term

- **ACP hosts beyond Zed.** An ACP agent now offers the login that the ACP
  registry asks for, a thread that you open again comes back with its tool
  cards, and an unknown session answers the way the protocol says. What's left
  is to run it by hand in Zed and in kandev, to run the suite on the 1.x SDK,
  and to list an agent in the registry.
- **A live run of `object_store` against a real bucket.** The store passes the
  conformance suite over in-memory clients only, and the S3 client in
  [human-in-the-loop.md](./human-in-the-loop.md#the-store-a-run-lives-in) has
  never been compiled against the SDK. I'll run both against a real bucket
  before I call the store proven.
- **A live check of prompt caching.** Since 0.17.0 an Anthropic tool loop
  caches by default, and the mocked suite proves that `cache_control` goes out
  on the wire, but not that a provider caches or what a loop saves. The live
  test that measures it has never run. I'll run it through OpenRouter, record
  the hit ratio and the cost beside the same loop with `cache: 'off'`, find out
  what OpenRouter does with `cache` on another vendor's model, and fix
  [providers.md](./providers.md#prompt-caching) wherever the run settles
  something that it hedges on.
- **Triage from checkride's digest.** Since 0.19, checkride prints an excerpt
  of what failed when it's run with `--digest`, but the triage steps in
  [AGENTS.md](../AGENTS.md) still send an agent to the summary and then to each
  raw report. They'll read the digest instead.
- **MCP hardening.** Auth on the HTTP transport, MCP `sampling`, per-tool
  approval gating, and `resources` subscriptions were all deferred out of the
  first bridge.
- **`claude_cli` on the Agent SDK.** Rebasing the subprocess adapter onto
  Anthropic's Agent SDK, slotted in wherever provider metering forces it.

## Known Issues

These are the bugs that I know about and haven't fixed yet, with the ones most
likely to bite you first.

- **An A2A agent that closes fails the tasks it was running.** `close` on a
  `serve_a2a` agent ends every task in flight as `FAILED` and deletes its run,
  even over a store that would have kept it. A task that waits at a gate
  survives. Drain the agent before a redeploy until a close can leave a
  running task for the next process.
- **An A2A cancel can't stop a drive that another process holds.** The task
  goes `CANCELED` at once and the drive's result is dropped, but the work runs
  on to its end, and you pay for it.
- **The viewer slows down on long runs and clips large flows.** Holding or
  playing the scrubber refolds the run from its first event at every position,
  so a long run lags. A flow that's still bigger than the window at the
  smallest zoom loses its right and bottom edges, with no way to pan to them.
- **An open tab misses events after the viewer restarts.** Event ids start over
  with the server, so a tab that reconnects asks for the events after its old
  id and gets nothing until the new ids pass it, then folds the run from the
  middle. Reload the tab after you restart the viewer.
- **The `bwrap` sandbox can't run a `claude` installed in your home directory.**
  The sandbox binds only `/usr`, `/bin`, `/lib`, `/lib64`, and
  `additional_write_paths`, so a binary under `~/.local/bin`, or a Node from a
  version manager, isn't there when `bwrap` goes to run it, and the call fails
  with `binary_not_found`. Your home directory isn't bound either, so an
  `auth_mode: 'oauth'` run couldn't reach its login even with the binary there.
  The wrapper is deprecated now and won't get a fix. `kind: 'claude_code'`
  runs the binary unwrapped, and `bwrap` and `greywall` both go in a later
  minor release.
- **Claude Code's coming bare default will cut `claude_cli` off from the
  login.** Claude Code plans to run `-p` in bare mode by default in a future
  release, and bare mode never reads the CLI's login, so an
  `auth_mode: 'oauth'` call, or an `auto` call without a key, would stop
  authenticating. No release has made the switch yet, and none documents a
  flag that opts a run back out. When one ships, I'll have `claude_cli` pass
  that flag under `auto` and `oauth`, and let `api_key` calls go bare.
- **Housekeeping.** Engine code that only tests call (`normalize_chunk`), a
  schema-issue formatter that `fascicle/testing`
  repeats, a viewer test that runs before the build that it checks, tsdown
  options that are dead or deprecated, four devDependencies on caret ranges, and
  a mutation-ratchet comment with stale numbers.

## Under Consideration

Scoped but not sequenced. Each one is a bet on leverage, not a promise to you.

- **Deployment shells.** Thin runtime wrappers around `run` / `run.stream`.
  `fascicle/a2a` is the first, and what remains is a plain HTTP/SSE shell, a
  queue worker, and a Cloudflare Worker. Your composition stays
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

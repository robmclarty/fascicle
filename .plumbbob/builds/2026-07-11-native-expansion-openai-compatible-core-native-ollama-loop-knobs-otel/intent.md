# Native expansion: OpenAI-compatible core, native Ollama, loop knobs, otel

*Source: `research/native-expansion-intent.md` (rob, 2026-07-11). Absorbed in
full; this document stands on its own.*

**Phase:** frame
**Size:** medium (top end; the natural split line, if it must become two
builds, is after Step 6, where the native-provider track ends and the
loop/observability track begins)

The sequel to the plumbbob build "Demote the AI SDK behind a native provider
seam" (shipped 2026-07-11, 17/17 steps; see
`.plumbbob/builds/2026-07-09-demote-the-ai-sdk-behind-a-native-provider-seam/report.md`).
That build left five open questions (Q1-Q5) and a handful of deferred items;
this intent resolves all of them in one final upgrade run. Sources: the
predecessor's open questions (answers settled 2026-07-11, recorded in the
Decisions below), an external design handoff on the OpenAI-compatible adapter
(absorbed in full: its contract, invariants, and dialect notes appear in the
Appendix), and the V-spec Phase 5 triage
(`research/ai-sdk-v7-upgrade-spec.md` §4.4), which this build closes by
verdict.

Provenance publishing is NOT here because it already shipped:
`.github/workflows/publish.yaml` publishes with npm trusted publishing (OIDC)
plus `--provenance` per `research/provenance-publish-spec.md`. Background only.

## Frame

- **Problem:** Native (raw-HTTP, zero AI SDK) exists for exactly one provider.
  The other seven still require Vercel peers, and the highest-leverage gap is
  that four of them (`openai`, `openrouter`, `lmstudio`, plus Ollama's compat
  endpoint) speak one wire format: OpenAI Chat Completions. Separately, the
  engine loop is missing three knobs users of a sovereign loop expect: per-turn
  timeout budgets, a per-step message hook (the `prepareStep`/`pruneMessages`
  shape), and OpenTelemetry visibility. And the V-Phase 5 spikes are still
  formally open.
- **Smallest thing that solves it:** One `openai_compatible_native` core
  parameterized by dialect (base_url + auth/header/usage quirks), consumed by
  the `openai`, `openrouter`, and `lmstudio` factories' `transport: 'native'`
  branches; a separate small native Ollama adapter on `/api/chat` (NDJSON);
  engine-owned turn timeouts; one `prepare_step` hook in the loop fascicle
  already owns; an otel bridge over the trajectory events fascicle already
  emits; and written verdicts closing V-Phase 5.
- **Done looks like:** `openai`, `openrouter`, `lmstudio`, and `ollama` each
  run text, tools, streaming, and schema-via-repair with `transport: 'native'`
  and zero `ai`/`@ai-sdk/*` in the native module graph (rule-enforced);
  a golden parity test proves ai_sdk and native transports produce equal
  `TurnResult` + `UsageTotals` for the same fixture; `turn_timeout_ms` and
  `prepare_step` work identically on every depth-1 transport; `fascicle/otel`
  emits spans for any transport; the V-Phase 5 verdicts are appended to the
  triage note; `pnpm check:all` exits 0.
- **Explicitly NOT doing:**
  - Native Bedrock (SigV4/AWS auth is not worth reimplementing) and native
    Google (low leverage). Both stay ai_sdk-only.
  - Flipping any default `transport` to `'native'`. Default stays `'ai_sdk'`;
    the per-provider `transport` field is the configuration surface (D3).
  - Mutable runtime provider registration. Declined again (D8); the
    value-semantic alternative (`with_providers`) ships instead.
  - Removing the `@ai-sdk/*` peers. Half-native means keeping both maintenance
    surfaces; dropping peers requires all-native, which this is not.
  - Native constrained decoding (`response_format` / `structured_output`
    capability) on the OpenAI-compatible core. Schema rides the engine's
    prompt + parse + repair loop, parity with native Anthropic (predecessor
    D6). Revisit only with evidence the repair loop falls short.
  - Provenance publishing (already shipped, see above).
  - `Tool.output_schema` (V-Phase 4): still its own future intent.

## Architecture sketch

End state (additions to the predecessor's sketch marked with `+`):

```text
┌──────────────────────────────────────────────────────────────────┐
│  generate.ts: resolves opts, gates capabilities, owns retry +     │
│  trajectory + turn timeout(+); knows ONLY invoke_turn             │
├──────────────────────────────────────────────────────────────────┤
│  run_tool_loop (+ prepare_step hook before each turn)             │
├──────────────────────────────────────────────────────────────────┤
│  depth-1 turn seam: invoke_turn(TurnRequest) -> TurnResult        │
│    ├─ providers/ai_sdk/          kind:'ai_sdk' (+ otel telemetry) │
│    ├─ anthropic_native.ts        kind:'native' (Messages API SSE) │
│    ├─ openai_compatible_native + kind:'native' (chat/completions  │
│    │    dialects: openai, openrouter, lmstudio, any base_url)     │
│    └─ ollama_native.ts         + kind:'native' (/api/chat NDJSON) │
│  depth-2: kind:'external' adapter.generate() (claude_cli, ...)    │
└──────────────────────────────────────────────────────────────────┘
  registry: built-ins + custom_providers + engine.with_providers()(+)
  observability: trajectory events ──> fascicle/otel bridge(+) ──> spans
```

## Decisions

- D1: OpenAI first, as a shared OpenAI-compatible core (predecessor Q1 + Q3,
  answered). One `openai_compatible_native.ts` parameterized by a dialect
  config (base_url, auth strategy, extra headers, stream-usage behavior,
  token-limit field name), consumed by the `openai`, `openrouter`, and
  `lmstudio` factories — *because* one implementation serves four wire-compatible
  backends, and pointing the `openai` provider's `base_url` at any compat
  server (including Ollama's `/v1`) makes the whole local tail nearly free.
- D2: Ollama's `transport: 'native'` targets its own `/api/chat` endpoint,
  not the compat endpoint (predecessor Q2, answered) — *because* the compat
  tail is already served by D1 via `base_url`, and the native endpoint exposes
  what compat hides (`options`, `keep_alive`, `think`), which is the point of
  going native on a local runtime.
- D3: Default transport stays `'ai_sdk'` for every provider; the configuration
  surface is the existing per-provider `transport` init field, now extended to
  `openai`, `openrouter`, `lmstudio`, and `ollama`; no engine-wide
  `default_transport` (predecessor Q4, answered) — *because* a global flag
  invites silent-fallback ambiguity for providers with no native backend
  (bedrock, google), while the per-provider field is explicit, already the
  anthropic precedent, and exactly the user-configurability asked for.
- D4: V-Phase 5 closes by verdict, not by spike branches (predecessor Q5,
  answered). P5.1 reasoning control: DECLINE the SDK primitive; native
  adapters map `EffortLevel` to their own wire fields (`reasoning_effort` on
  OpenAI-compatible, `thinking.budget_tokens` on Anthropic), so an SDK
  abstraction would serve only the ai_sdk transport and add coupling above
  the seam. P5.2 structured-output repair: DECLINE; the engine's repair loop
  already covers every transport including native, which SDK repair cannot.
  P5.3 timeout budgets: ADOPT the spike's own default recommendation and
  implement sovereign (engine-owned `turn_timeout_ms`, Step 7) — *because*
  the spikes' gate was "keep only if it deletes fascicle-owned code without
  adding coupling," and after the inversion only P5.3 passes, in the
  own-implementation form the spec itself predicted.
- D5: The engine owns the turn timeout, not adapters. `turn_timeout_ms`
  (per-call, engine-defaultable) composes a timeout signal with the user's
  abort around `invoke_turn`; expiry throws a typed timeout error the shared
  classifier treats as retryable — *because* D5-prime from the predecessor
  (adapters never retry, the engine owns the failure ladder) extends
  naturally: adapters should not own deadlines either, and one implementation
  covers every transport including local runtimes that hang.
- D6: `prepareStep` and `pruneMessages` collapse into ONE engine-neutral hook:
  `prepare_step?: (ctx) => { messages? } | undefined` on `GenerateOptions`,
  called by `run_tool_loop` before each turn with the step index and the
  would-be request messages; returning replacement messages is pruning,
  returning undefined is a no-op. A trajectory event records every step the
  hook modified — *because* fascicle owns the loop, so this is native loop
  surface (not SDK adoption), one hook at the loop boundary expresses both
  SDK features, and the trajectory event keeps mid-loop mutation legible.
  Per-step model/effort switching is explicitly deferred (Open question N-Q1).
- D7: Otel lands in two layers with the seam between them (predecessor
  backlog, answered: yes, `@ai-sdk/otel` is acceptable to start). Layer 1:
  a transport-neutral trajectory-to-otel bridge in a new `fascicle/otel`
  subpath, taking `@opentelemetry/api` as a new optional peer, so native and
  external transports get spans from the events the engine already emits.
  Layer 2: AI SDK telemetry (`@ai-sdk/otel`) wired strictly inside
  `providers/ai_sdk/`, opt-in via init, for turn-internal detail on that
  transport only. The agent-layer boundary ADR is amended in the same change:
  `@ai-sdk/otel` moves from declined-wholesale to adopted-below-the-seam —
  *because* the D2 litmus (one turn below the loop) is satisfied when
  telemetry instruments a single turn inside the ai_sdk module, but the
  loop-level story must be fascicle's own or non-SDK transports go dark.
- D8: Mutable runtime provider registration stays declined; the answer to
  "register a provider after construction" is `engine.with_providers(extra)`,
  which returns a NEW engine (fresh adapters from merged config, same
  defaults, same shadow-throws rule, independent disposal) — *because*
  fascicle's identity is compose-agents-like-plain-values: a mutable registry
  makes engine behavior time-dependent and muddies the dispose lifecycle,
  while derivation keeps value semantics and still serves the
  plugin-that-loads-late case.
- D9: The native `provider_options` convention generalizes per provider name:
  on any native transport, `provider_options.<provider>` is raw wire-format
  keys for that provider's API, shallow-merged last over the engine-computed
  body (predecessor Step 17's convention, applied to `openai`, `openrouter`,
  `lmstudio`, `ollama`) — *because* deciding it once was the point of parking
  it; new native adapters inherit the convention instead of re-litigating it.
- D10: Local-runtime usage degrades gracefully: a dialect flag marks backends
  whose `usage` may be absent or approximate (lmstudio, ollama-compat), and
  the mapper returns zeroed totals instead of throwing — *because* cost
  accounting is a feature of hosted APIs; refusing to run against a local
  model over missing token counts would invert the local-first values that
  motivated native Ollama in the first place.

## Constraints

- C1: `pnpm check:all` (incl. mutation) exits 0 at every phase boundary
  (Steps 2, 6, 9, 12); `pnpm check` for inner iteration.
- C2: Zero new runtime dependencies. Engine npm deps remain `ai` + `zod` only
  (rule-enforced). `@opentelemetry/api` and `@ai-sdk/otel` enter as OPTIONAL
  peers; the otel bridge lives outside `src/engine/` (own subpath) so the
  engine dep rule holds unmodified.
- C3: Invariant 13 (inverted form) holds: only `providers/ai_sdk/` imports
  from `ai`/`@ai-sdk/*`. The existing ast-grep rule forbidding those imports
  in `*native*` provider files covers the new native modules by naming
  convention; new native files MUST match the pattern the rule targets.
- C4: Streamed result equals non-streamed result for the same input on every
  native path — the OpenAI-compatible SSE aggregator and the Ollama NDJSON
  aggregator must each rebuild the non-stream payload shape and feed ONE
  shared response parser, the construction that made this true for Anthropic.
- C5: No live network in the test suite; recorded fixtures only. Live smokes
  are manual gates: OpenRouter native at Step 6 and (if a local daemon is
  available) Ollama native at Step 12.
- C6: Provider names stay stable across transports (`openai`, `openrouter`,
  `lmstudio`, `ollama`) so `DEFAULT_PRICING` keys and `normalize_usage`
  fields keep working.
- C7: Coverage floor 70%; colocated `__tests__/`; wire mapping, SSE/NDJSON
  parsing, and usage math assert concrete values, not smoke (prime mutation
  targets).
- C8: Scope is `src/engine/**`, a new `src/otel/**` subpath, `rules/`,
  `fallow.toml`, `package.json` (peers/exports only), docs, and the ADR
  amendment. `core`, `composites`, `agents`, `adapters`, `mcp`, `viewer`,
  `ui`, and `stdio` are untouched.

## Steps

1. [x] OpenAI-compatible core: mapping, non-stream, auth — **done when:**
   `openai_compatible_native.ts` maps `Message[]`/`Tool[]` to a
   `chat/completions` body (system message, tool_calls/tool role round-trip,
   `finish_reason` map per Appendix A2, usage map per Appendix A3 including
   `reasoning_tokens` and `cached_tokens`), non-stream `invoke_turn` passes
   golden-fixture tests for text, tool-call, and mixed responses, Bearer-auth
   and no-auth dialect strategies work, and error paths assert classification
   (401 auth, 429 + retry-after, 5xx, network) exactly as the Anthropic
   adapter does
   - seam: `src/engine/providers/openai_compatible_native.ts`, `src/engine/providers/__tests__/`
   - model: fable — logic-dense greenfield wire mapping; the dialect
     parameterization is the named subtle part
2. [x] OpenAI-compatible core: streaming + e2e — **done when:** the SSE parse
   (`data:` lines, `[DONE]` terminator, index-keyed tool_call delta
   accumulation, `stream_options.include_usage`) dispatches `StreamChunk`s
   and aggregates through the same response parser as non-stream (C4:
   streamed equals non-streamed on shared fixtures), an e2e tool loop on
   recorded fixtures exercises salvage + approval + `ends_turn` + cost, the
   native-file import rule covers the new module, and `pnpm check:all` exits 0
   - seam: `src/engine/providers/openai_compatible_native.ts`, `rules/`
   - model: fable — hand-rolled SSE with tool-call index bookkeeping;
     streamed-equals-non-streamed parity is the named subtle part
3. [ ] Wire `openai` native — **done when:** `transport: 'native'` on the
   openai init routes through the core with the openai dialect
   (`Authorization: Bearer`, `organization` header, `reasoning_effort` from
   `EffortLevel` per Appendix A4, `max_completion_tokens`),
   `provider_options.openai` wire passthrough merges last with
   concrete-value tests (an overridden token limit and a passthrough-only
   key on both stream and non-stream paths, per D9), and `ProviderConfigMap`
   gains `transport?` on openai
   - seam: `src/engine/providers/openai.ts`, `src/engine/types.ts`, `src/engine/providers/__tests__/`
   - model: opus — small wiring diff against a proven core; precedence tests
     gate it
4. [ ] Wire `openrouter` + `lmstudio` native (+ compat recipe) — **done
   when:** both factories grow `transport: 'native'` branches with their
   dialects (openrouter: Bearer auth + `HTTP-Referer`/`X-Title` headers;
   lmstudio: no auth, tolerant usage per D10), `provider_options.openrouter`
   / `.lmstudio` passthrough tested per D9, and docs show the
   ollama-via-compat recipe (openai provider + `base_url:
   'http://localhost:11434/v1'`) as the supported compat path
   - seam: `src/engine/providers/openrouter.ts`, `src/engine/providers/lmstudio.ts`, `src/engine/types.ts`, `src/engine/providers/__tests__/`, `docs/providers.md`
   - model: opus — dialect wiring against the proven core; per-dialect
     concrete-value tests gate it
5. [ ] Native Ollama on `/api/chat` — **done when:** `ollama_native.ts` maps
   messages/tools to the native chat shape, streams NDJSON (line-delimited
   JSON, `done: true` terminator) through an aggregator feeding one shared
   parser (C4), maps `done_reason` and `prompt_eval_count`/`eval_count` to
   `FinishReason`/`UsageTotals` (zeroed when absent, D10), leaves effort
   ignored (thinking is opt-in via `provider_options.ollama.think`, D2/D9),
   and passes golden-fixture tests for text, tool-call, and streamed-parity
   cases
   - seam: `src/engine/providers/ollama_native.ts`, `src/engine/providers/ollama.ts`, `src/engine/providers/__tests__/`
   - model: fable — a second wire dialect (NDJSON, not SSE) with no in-tree
     prior art for the framing
6. [ ] Transport parity golden tests + OpenRouter live smoke — **done when:**
   a parity suite drives the same recorded request through `ai_sdk` and
   `native` transports for `openai` and `anthropic` and asserts equal
   `TurnResult` + `UsageTotals` (catching SDK normalization drift, the
   payoff of the seam), the manual OpenRouter-native live smoke runs a tool
   loop streamed and non-streamed with usage/cost recorded, and
   `pnpm check:all` exits 0
   - seam: `src/engine/providers/__tests__/`, `examples/`
   - model: opus — assertion-strong test authoring; judgment is in reading
     the smoke output
7. [ ] Turn timeout budgets + V-Phase 5 verdicts — **done when:**
   `turn_timeout_ms` (per-call option + engine default) wraps every depth-1
   `invoke_turn` in a timeout signal composed with the user abort, expiry
   throws a typed timeout error the shared classifier retries, tests assert
   the timeout fires on a hung fake adapter and does NOT fire on a fast one,
   a mid-stream timeout after chunks flowed refuses retry (stream-interruption
   parity), and the three P5 verdicts (D4) are appended to
   `explorations/2026-07-ai-sdk-v7-upgrade-and-capability-triage.md`
   - seam: `src/engine/generate.ts`, `src/engine/types.ts`, `src/engine/__tests__/`, `research/explorations/2026-07-ai-sdk-v7-upgrade-and-capability-triage.md`
   - model: opus — small, well-bounded signal composition; the retry
     interaction is covered by existing patterns
8. [ ] `prepare_step` loop hook — **done when:** the hook (D6 shape) is
   called before each turn on both depth-1 transports, returned messages
   replace the request messages for that turn only (the canonical transcript
   is untouched), a `step_prepared` trajectory event records modified steps,
   and tests prove pruning mid-loop preserves salvage, approval, `ends_turn`,
   and schema-repair behavior (the loop-inheritance suite is the model)
   - seam: `src/engine/tool_loop.ts`, `src/engine/generate.ts`, `src/engine/types.ts`, `src/engine/__tests__/`
   - model: fable — mutating the loop's message flow is invariant-sensitive;
     plausible-but-drifted interaction with salvage/repair is the failure mode
9. [ ] Otel: trajectory bridge + ai_sdk telemetry + ADR amendment — **done
   when:** `fascicle/otel` exports a `TrajectoryLogger` bridge emitting spans
   (generate root span, per-step child spans, per-tool-call events) via
   `@opentelemetry/api` (new optional peer, subpath-only per C2), the ai_sdk
   transport accepts opt-in telemetry wired to `@ai-sdk/otel` strictly inside
   `providers/ai_sdk/` (C3), the boundary ADR's decline table is amended per
   D7, and bridge tests assert span structure against an in-memory exporter
   with no otel packages required at engine runtime, and `pnpm check:all`
   exits 0
   - seam: `src/otel/`, `src/engine/providers/ai_sdk/`, `package.json`, `research/explorations/2026-07-ai-sdk-agent-layer-boundary.md`
   - model: opus — new but well-bounded surface; the boundary bookkeeping is
     settled by D7
10. [ ] `with_providers` derivation — **done when:** `engine.with_providers(
    providers, custom_providers?)` returns a new engine with merged config
    (same defaults, custom-first resolution, shadow-throws vs built-ins,
    adapters constructed fresh, disposal independent of the parent), the
    original engine is provably untouched, and docs frame it as the answer
    to runtime registration (D8)
    - seam: `src/engine/create_engine.ts`, `src/engine/types.ts`, `src/engine/__tests__/`, `docs/configuration.md`
    - model: opus — value-semantics refactor of existing construction code;
      the suite gates it
11. [ ] Barrel exports + docs sweep — **done when:** new public types (dialect
    config if exported, timeout/hook options, otel bridge API) are exported
    type-safely from the engine barrel / `fascicle` top level / `fascicle/otel`,
    `docs/providers.md` documents the four new native transports and the
    per-provider wire-format `provider_options` conventions (D9, including
    the camelCase-vs-wire-format warning per provider), `docs/configuration.md`
    covers `turn_timeout_ms`, `prepare_step`, `with_providers`, and otel
    setup, and the roadmap links this intent
    - seam: `src/engine/index.ts`, `src/index.ts`, `package.json` (exports), `docs/`, `README.md`
    - model: sonnet — mechanical export + docs prose from settled content
12. [ ] Final gate: local live smoke + full check — **done when:** the manual
    smoke matrix runs green where backends are available (OpenRouter native
    re-run; Ollama native `/api/chat` and lmstudio native against local
    daemons if present, each streamed and non-streamed with a tool loop),
    any unavailable backend is recorded as not-run in the build log, and
    `pnpm check:all` (incl. mutation) exits 0
    - seam: `examples/`, `.plumbbob/`
    - model: opus — manual gate; judgment is in reading the smoke output

## Open questions

- N-Q1: Should `prepare_step` grow per-step overrides beyond messages
  (effort, max_tokens, tool subset)? Deferred from D6; effort is baked into
  the ai_sdk invoke config at build time, so per-step effort needs seam work
  — *resolve by:* revisit after the hook has real consumers.
- N-Q2: `structured_output` via `response_format` on the OpenAI-compatible
  core: worth claiming once parity data shows where the repair loop pays a
  latency/token tax? — *resolve by:* collect repair-loop stats in production
  first; revisit with numbers.
- N-Q3: When do defaults flip to `native` (per provider)? Carried forward
  from the predecessor's Q4 unchanged: after production mileage + parity
  data, now partially supplied by Step 6's parity suite — *resolve by:*
  revisit per provider once the parity suite has run against live traffic.
- N-Q4: Does the otel bridge belong upstream in `core` trajectory types
  (span context propagation into tool executes)? — *resolve by:* decide when
  a consumer needs cross-process traces.

## Verdicts

*(Filled in as spikes and forks resolve — the audit trail of "these were my calls.")*

- 2026-07-11 — V-Phase 5 (predecessor Q5) → closed by verdict, not spikes
  (D4): P5.1 reasoning control DECLINED, P5.2 structured-output repair
  DECLINED, P5.3 timeout budgets ADOPTED as sovereign `turn_timeout_ms`
  (Step 7). Written verdicts land in the triage note at Step 7.

## Appendix: wire notes (detail source for Steps 1-5)

### A1. Dialect config (the shape Step 1 parameterizes)

Per-dialect knobs, from the absorbed design handoff:

| Knob | openai | openrouter | lmstudio | (compat via base_url) |
|------|--------|------------|----------|-----------------------|
| auth | `Authorization: Bearer` | Bearer | none | none |
| extra headers | `OpenAI-Organization` (opt) | `HTTP-Referer`, `X-Title` (opt) | none | none |
| stream usage | `stream_options: { include_usage: true }` | same | often absent → D10 | varies → D10 |
| token limit field | `max_completion_tokens` | `max_tokens` | `max_tokens` | `max_tokens` |
| usage tolerance | strict | strict | tolerant (D10) | tolerant (D10) |

### A2. `finish_reason` map (Chat Completions → fascicle)

`stop → stop`, `tool_calls → tool_calls`, `length → length`,
`content_filter → content_filter`, anything else `→ stop`.
Ollama native: `done_reason` `stop → stop`, `length → length`, presence of
`message.tool_calls → tool_calls`.

### A3. Usage map (Chat Completions → `UsageTotals`)

`prompt_tokens → input_tokens` (NOTE: inclusive of cached tokens, unlike
Anthropic's exclusive accounting — a straight copy is correct here;
`compute_cost` subtracts the cached portion back out),
`completion_tokens → output_tokens`,
`prompt_tokens_details.cached_tokens → cached_input_tokens`,
`completion_tokens_details.reasoning_tokens → reasoning_tokens`.
No cache-write concept on this API. Absent usage → zeroed totals under a
tolerant dialect (D10), never a throw.
Ollama native: `prompt_eval_count → input_tokens`, `eval_count →
output_tokens`, no cache/reasoning fields.

### A4. Effort map (OpenAI-compatible native)

`EffortLevel → reasoning_effort`: `none →` field omitted, `low → low`,
`medium → medium`, `high → high`, `xhigh → high`, `max → high` (same clamp
as the ai_sdk transport's `reasoningEffort`, keeping C6 behavior parity).
Non-reasoning models ignore the field server-side; the adapter does not
model-sniff. Ollama native ignores effort entirely (D2; `think` is
passthrough-only).

### A5. Streaming frames

OpenAI-compatible: SSE `data:` lines each holding a chunk JSON; tool calls
arrive as `choices[].delta.tool_calls[]` with an `index` field keying
accumulation of `function.arguments` string deltas; terminal frame is the
literal `data: [DONE]`. Usage arrives on the final pre-DONE chunk only when
`stream_options.include_usage` is set.
Ollama native: newline-delimited JSON objects (NOT SSE); each line carries
`message.content` (and possibly `message.tool_calls`); the final line has
`done: true` plus `done_reason` and the eval counts.

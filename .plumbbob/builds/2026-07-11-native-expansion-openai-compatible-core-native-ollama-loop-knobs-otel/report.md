# Report — Native expansion: OpenAI-compatible core, native Ollama, loop knobs, otel

**Status:** done — 12/12 steps checkpointed. `pnpm check:all` (incl. mutation)
green at every phase boundary (Steps 2, 6, 9, 12). The manual live smoke re-ran
at Step 12: openrouter native and ollama native `/api/chat` both green (streamed
+ non-streamed, tool loop); lmstudio native recorded not-run (no local server).

The sequel to "Demote the AI SDK behind a native provider seam" (17/17,
2026-07-11), which left five open questions and a native path proven for exactly
one provider. This build resolved all five and widened native from one provider
to five wire formats.

## What shipped

The build ran in the two arcs the intent's split line predicted — the native
provider track, then the loop/observability track.

- **Native provider expansion (Steps 1–6).** One `openai_compatible_native`
  core — Chat Completions mapping, non-stream + hand-rolled SSE, dialect-
  parameterized auth/headers/usage — feeds the `openai`, `openrouter`, and
  `lmstudio` factories' `transport: 'native'` branches (D1). A separate
  `ollama_native` adapter speaks the daemon's own `/api/chat` NDJSON wire (D2),
  not the compat tail. Both stream aggregators rebuild the non-stream payload
  and feed one shared response parser, so streamed equals non-streamed on every
  native path (C4). Closed with a transport-parity golden suite (same recorded
  request through `ai_sdk` and `native` for `openai` + `anthropic`, asserting
  equal `TurnResult` + `UsageTotals`) and the manual OpenRouter live smoke.

- **Loop knobs + observability (Steps 7–12).** Engine-owned `turn_timeout_ms`
  composes a per-turn deadline with the user abort around `invoke_turn`, expiry
  throwing a typed retryable error (D5); the three V-Phase 5 verdicts landed in
  the triage note by verdict, not spikes (D4). A single `prepare_step` loop hook
  expresses both `prepareStep` and `pruneMessages`, replacing request messages
  for one turn only and recording a `step_prepared` trajectory event (D6). Otel
  arrived in two layers with the seam between them (D7): a transport-neutral
  `fascicle/otel` trajectory-to-span bridge (`@opentelemetry/api` as an optional
  peer, subpath-only per C2) plus opt-in `@ai-sdk/otel` telemetry confined
  inside `providers/ai_sdk/`, with the boundary ADR amended in the same change.
  `engine.with_providers()` answers runtime registration by value-semantic
  derivation rather than a mutable registry (D8). Closed with barrel exports, a
  docs sweep, and this final gate.

End state matches the architecture sketch: `generate.ts` still knows only
`invoke_turn`; `openai`, `openrouter`, `lmstudio`, and `ollama` each run text,
tools, streaming, and schema-via-repair on `transport: 'native'` with zero
`ai`/`@ai-sdk/*` in their module graph (rule-enforced, C3); `turn_timeout_ms`
and `prepare_step` work identically on every depth-1 transport; and any
transport can emit spans through the otel bridge.

## Decisions and why

The load-bearing calls, distilled from intent's D1–D10:

- **D1/D2 — one compat core, native Ollama apart.** Four backends speak OpenAI
  Chat Completions, so one dialect-parameterized implementation serves them all,
  and pointing `openai`'s `base_url` at any compat server (including Ollama's
  `/v1`) makes the local tail nearly free. Ollama's own `transport: 'native'`
  targets `/api/chat` instead, because that endpoint exposes what compat hides
  (`options`, `keep_alive`, `think`) — the whole reason to go native locally.
- **D3 — default stays `ai_sdk`; per-provider `transport` is the surface.** No
  engine-wide `default_transport` flag: a global switch invites silent-fallback
  ambiguity for providers with no native backend, while the per-provider field
  is explicit and already the Anthropic precedent.
- **D4/D5 — the engine owns deadlines and the failure ladder.** V-Phase 5 closed
  by verdict: reasoning-control and structured-output-repair SDK primitives both
  DECLINED (native adapters map effort to their own wire fields; the repair loop
  already covers every transport), timeout budgets ADOPTED as sovereign
  `turn_timeout_ms`. Adapters own neither retry nor deadlines.
- **D6 — one hook at the loop boundary.** `prepare_step` collapses two SDK
  features into native loop surface fascicle already owns; the trajectory event
  keeps mid-loop message mutation legible. Per-step effort/model switching
  deferred (N-Q1).
- **D7 — otel below the seam, bridge above it.** `@ai-sdk/otel` moved from
  declined-wholesale to adopted-below-the-seam (one turn inside the ai_sdk
  module satisfies the D2 litmus), but loop-level tracing had to be fascicle's
  own bridge or non-SDK transports go dark.
- **D8 — derivation over a mutable registry.** `with_providers` returns a new
  engine (fresh adapters, independent disposal, same shadow-throws rule),
  keeping value semantics instead of making engine behavior time-dependent.
- **D9/D10 — inherited conventions, graceful local usage.** The native
  `provider_options.<provider>` wire-passthrough convention generalized to all
  four new adapters; a dialect flag marks local backends whose usage may be
  absent, and the mapper zeroes totals (free-provider zero-cost estimate)
  instead of throwing.

## Parked & harvested

Nothing was parked — the park list stayed empty from Step 1 to Step 12, and the
harvest was clean at every boundary. Six steps (2, 5, 7, 9, 10, 11) each recorded
a single mid-step plan refinement (drift → `/pb-refine`), folded in without
changing scope; no item was ever classified as a blocker or pivot. The plan held.

## Deferred tangents (future work)

Carried as the intent's open questions, none blocking:

- **N-Q1 — `prepare_step` per-step overrides** (effort, max_tokens, tool subset)
  beyond messages; effort is baked into the ai_sdk invoke config at build time,
  so this needs seam work. Revisit once the hook has real consumers.
- **N-Q2 — native `structured_output` via `response_format`** on the compat
  core; worth claiming only once parity data shows where the repair loop pays a
  latency/token tax.
- **N-Q3 — flipping `transport` defaults to `native`** per provider, after
  production mileage + parity data (Step 6's suite is the start).
- **N-Q4 — otel bridge in `core` trajectory types** (span-context propagation
  into tool executes), when a consumer needs cross-process traces.

Explicitly out of scope and still out: native Bedrock (SigV4) and native Google,
removing the `@ai-sdk/*` peers, native constrained decoding on the compat core,
flipping any default transport, `Tool.output_schema`, and provenance publishing
(already shipped).

## Checkpoints

- baseline aa5d74c31bd520c536540c0cc0f61de900ddadd8
- plan 5caa88efd57a9e221ef8cacaf32cdf31c2355c5e
- step 1 d8da9cd0cdac3aa2adefac3f8482904a9ccc25ef
- step 2 f36982fafd055279ae02d9e6f96d803df5373ba9
- step 3 c2be71483da9a5d3af78367a537ff4be5f1e7aef
- step 4 fb335302e741ed5faa0e772cb9038fd6d3e57683
- step 5 1179e12962e61ab1fe63300e781b6ca7b2ec7618
- step 6 0a1c100d90df001ff44aacf5072a6792fc59e45c
- step 7 24c68d301bb698ffc6ca7a0372ab3eabe2e9fdd0
- step 8 ef6d11e5ccc072895ab91d87d9d37f30909ea931
- step 9 526e8db73d05c88295c37d21a81ecd06db5841af
- step 10 a53872cf0fd823ddae05b189b5a59117bff45c18
- step 11 74a342a5a7a52302ec5ddb8f7bf7854d206e940d
- step 12 b1762bcefed93406fdbb6ef2e9e79c0d5d28d931

## Stats

| step | red checks | drift warnings | reverts | wall-clock |
|------|------------|----------------|---------|------------|
| 1 | 0 | 0 | 0 | 25m |
| 2 | 0 | 1 | 0 | 23m |
| 3 | 0 | 0 | 0 | 8m |
| 4 | 0 | 0 | 0 | 11m |
| 5 | 0 | 1 | 0 | 18m |
| 6 | 0 | 0 | 0 | 24m |
| 7 | 0 | 1 | 0 | 26m |
| 8 | 0 | 0 | 0 | 13m |
| 9 | 0 | 1 | 0 | 39m |
| 10 | 0 | 1 | 0 | 11m |
| 11 | 0 | 1 | 0 | 18m |
| 12 | 0 | 0 | 0 | 42m |
| **total** | 0 | 6 | 0 | 258m |

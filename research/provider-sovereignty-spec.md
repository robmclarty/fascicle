---
title: Provider Sovereignty — de-privileging the AI SDK behind a pluggable turn seam
status: draft
date: 2026-07-08
author: rob
tags: [engine, providers, ai-sdk, sovereignty, spec]
---

# Provider Sovereignty — Specification

**Status:** Draft, implementation pending
**Scope:** the `engine` module only (`src/engine/**`), plus the boundary rules
(`rules/`, `fallow.toml`) and docs that describe it. The `core`, `composites`,
`agents`, `adapters`, `mcp`, `viewer`, `ui`, and `stdio` modules are untouched.
**Background:** [`explorations/2026-07-ai-sdk-and-provider-sovereignty.md`](./explorations/2026-07-ai-sdk-and-provider-sovereignty.md)
(the argument and the integration-depth taxonomy this spec implements).
**Sibling contracts:** `AGENTS.md` (conventions), `.ridgeline/constraints.md`
(invariants), `docs/providers.md` and `docs/configuration.md` (living reference to
update on completion).
**Tracking:** structured for ingestion into plumbbob-plan. Every task carries a
stable ID (`P<phase>.<n>`), acceptance criteria, dependencies, and the files it
touches. Phases are ordered by dependency; within a phase, tasks may parallelize
except where `deps` says otherwise.

---

## §1 — Problem Statement

Fascicle is already built on the Vercel AI SDK: seven of eight built-in providers
are `kind: 'ai_sdk'`, and `generate.ts` hard-wires the single-turn model call to
`generateText` / `streamText`. Only `claude_cli` (`kind: 'subprocess'`) is
SDK-independent. Three consequences follow:

1. **The AI SDK is privileged, not pluggable.** There is no supported way to add a
   provider that talks to a vendor over raw HTTP and still inherits the fascicle loop
   (salvage, approval, `ends_turn`, cost, trajectory, retry). Non-SDK integration is
   only possible at the self-orchestrating (`subprocess`) depth, which gives up the
   loop entirely.
2. **The registry is closed.** `registry.ts` is a frozen Map of eight built-ins;
   `create_engine` resolves provider names only against it. Consumers cannot register
   a provider without forking fascicle. This blocks proprietary or workplace-private
   providers from living in the consuming repo, and forces every experiment through a
   library release.
3. **The SDK's churn can reach the core.** A breaking change in `generateText` (the
   majors have churned: `maxSteps` → `stopWhen`, `Agent` class → interface, and we
   already had to set `maxRetries: 0`) lands directly on our most important
   providers, because they have no non-SDK path.

The goal is not to remove the AI SDK. It is to **demote it to one implementation of a
neutral single-turn seam**, open the registry so providers can be added at any
integration depth, and move the two most important providers (Anthropic, OpenAI) onto
a raw-HTTP path so the SDK becomes a convenience for the long tail rather than the
substrate for the core.

Non-goals: rewriting the loop, adopting the AI SDK's agent layer (`ToolLoopAgent`,
`stopWhen`, `prepareStep`), or changing any public surface outside `create_engine`
config and the internal adapter union. `prepareStep` / `pruneMessages`-style loop
hooks are explicitly deferred (§9).

---

## §2 — Solution Overview

### Integration-depth taxonomy (the organizing idea)

Three ways to integrate a provider, by who owns the loop:

- **Depth 1 — single-turn driver.** Provider does one model call, returns a neutral
  turn result; fascicle owns the loop. Inherits everything. *Target: pluggable.*
- **Depth 2 — self-orchestrating runtime.** Provider owns its own loop; fascicle
  collects the result. For agent runtimes (`claude_cli`; future HTTP/A2A agents).
- **Depth 3** is not a depth — it is the observation that the AI SDK is *one*
  depth-1 driver, currently hard-wired, that must become one implementation among
  peers.

### Target adapter union

```
ProviderAdapter =
  | AiSdkProviderAdapter      // kind: 'ai_sdk'   — depth-1, backed by `ai`
  | NativeProviderAdapter     // kind: 'native'   — depth-1, backed by anything (raw fetch)   [NEW]
  | ExternalAgentAdapter      // kind: 'external' — depth-2, self-orchestrating (was 'subprocess')
```

### Target layering (after this spec)

```
┌───────────────────────────────────────────────────────────────┐
│  generate.ts                                                    │
│    resolves opts, gates capabilities, owns retry + trajectory   │
│    builds one InvokeOnce seam from the adapter, drives loop      │
├───────────────────────────────────────────────────────────────┤
│  run_tool_loop  (unchanged — already SDK-neutral)               │
├───────────────────────────────────────────────────────────────┤
│  depth-1 turn seam:  invoke_turn(TurnRequest) -> TurnResult      │
│    ├─ ai_sdk adapter    → generateText / streamText              │
│    └─ native adapter    → raw fetch (Anthropic, OpenAI, ...)     │
│  depth-2:  external adapter.generate(...) (self-orchestrating)   │
└───────────────────────────────────────────────────────────────┘
```

### Selection mechanism: `transport`

A provider name may have more than one backend. Selection is a `transport` field on
the provider init, defaulting to `ai_sdk` so nothing breaks:

```typescript
create_engine({
  providers: {
    anthropic: { api_key: process.env.ANTHROPIC_API_KEY!, transport: 'native' }, // raw HTTP
    openai:    { api_key: process.env.OPENAI_API_KEY! },                          // defaults to ai_sdk
  },
  custom_providers: {
    my_llm: create_my_llm_adapter,   // proprietary/private factory, lives in the consuming repo
  },
})
```

`transport` keeps pricing keys stable (same provider name → same `DEFAULT_PRICING`
entry) and makes "the AI SDK is one backend among several" literal. Providers with a
single backend ignore `transport`.

---

## §3 — Current State (verified, with anchors)

- `src/engine/providers/types.ts:82` — `ProviderAdapter = AiSdkProviderAdapter | SubprocessProviderAdapter`.
- `AiSdkProviderAdapter` = `{ kind:'ai_sdk', name, build_model, translate_effort, normalize_usage, supports }`.
- `SubprocessProviderAdapter` = `{ kind:'subprocess', name, generate, dispose, supports }`.
- `src/engine/providers/registry.ts` — frozen Map of 8 built-ins; "runtime registration deferred".
- `src/engine/create_engine.ts:37` — `build_provider_adapters` resolves via `get_provider_factory` (built-ins only).
- `src/engine/create_engine.ts:126` — `dispose` calls `adapter.dispose()` only when `kind === 'subprocess'`.
- `src/engine/generate.ts:528` — `if (adapter.kind === 'subprocess') return adapter.generate(...)` (depth-2 early return).
- `src/engine/generate.ts:539-547` — capability gating (`schema`/`tools`/`streaming`) applies **after** the subprocess return, i.e. to the ai_sdk path only.
- `src/engine/generate.ts:651-742` — `invoke_once` builds the AI SDK call (`get_model` → `build_model` → `collect_stream`/`collect_non_stream`), wrapped in `retry_with_policy`.
- `src/engine/generate.ts:675` — `maxRetries: 0` (engine owns retry).
- `src/engine/generate.ts:434-487` — `classify_ai_sdk_error` (429 / 5xx / network classification) — generalizable.
- `src/engine/tool_loop.ts:97-104` — `InvokeOnceResult = { text, tool_calls, finish_reason, usage }`, the already-neutral turn shape; `InvokeOnce` is the seam the loop consumes.
- Invariant 13 (`.ridgeline/constraints.md`, echoed in `generate.ts` header): only `generate.ts`, `tool_loop.ts`, `index.ts` may call `generateText` / `streamText`.
- Dependency invariants: `rules/no-engine-npm-dep-except-ai-zod.yml` (engine may only depend on `ai` + `zod`); provider SDKs are optional peers loaded via `load_optional_peer`.

---

## §4 — Design

### §4.1 Neutral turn types (shared)

Unify on one turn contract in `src/engine/types.ts`, replacing the loop-local
`InvokeOnceResult` and giving native adapters something to implement:

```typescript
export type TurnResult = {
  readonly text: string
  readonly tool_calls: ReadonlyArray<{ id: string; name: string; input: unknown }>
  readonly finish_reason: FinishReason
  readonly usage: UsageTotals
}

export type TurnRequest = {
  readonly step_index: number
  readonly messages: ReadonlyArray<Message>
  readonly tools: ReadonlyArray<Tool>
  readonly abort: AbortSignal
  readonly stream: boolean
  readonly model_id: string
  readonly system?: string
  readonly schema?: z.ZodType            // present when the caller requested structured output
  readonly effort: EffortLevel
  readonly provider_options?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly temperature?: number
  readonly max_tokens?: number
  readonly top_p?: number
  readonly dispatch_chunk?: (chunk: StreamChunk) => Promise<void> // stream === true ⇒ defined
}
```

`tool_loop.ts` keeps `InvokeOnce = (InvokeOnceArgs) => Promise<TurnResult>`;
`InvokeOnceResult` becomes a type alias of `TurnResult` (or is removed and callers
use `TurnResult`). This is a pure rename with no behavior change.

### §4.2 `NativeProviderAdapter`

```typescript
export type NativeProviderAdapter = {
  readonly kind: 'native'
  readonly name: string
  readonly invoke_turn: (req: TurnRequest) => Promise<TurnResult>
  readonly supports: (capability: ProviderCapability) => boolean
  readonly dispose?: () => Promise<void>          // optional: keep-alive agents, pools
  readonly classify_error?: (err: unknown) => unknown  // defaults to shared classifier
}
```

Contract obligations for a native adapter:

- **Streaming.** When `req.stream === true`, `invoke_turn` MUST emit `StreamChunk`s
  via `req.dispatch_chunk` (text deltas, reasoning deltas, `tool_call_start` /
  `tool_call_input_delta` / `tool_call_end`) as it parses the provider stream, and
  still return the fully aggregated `TurnResult`. Mirrors `claude_cli` and
  `collect_stream`.
- **Structured output.** If the adapter reports `supports('structured_output')` and
  `req.schema` is present, `invoke_turn` MUST constrain decoding to the schema in its
  own request (e.g. OpenAI `response_format: json_schema`). Otherwise it ignores
  `req.schema`; fascicle's prompt-prefix + parse + repair loop still validates. The
  AI SDK `Output.object` path (`generate.ts:644`) is **ai_sdk-only** and MUST NOT run
  for native adapters.
- **Errors.** `invoke_turn` throws raw provider errors. `generate.ts` wraps the call
  in `retry_with_policy` and runs them through `classify_error` (adapter-provided) or
  the shared classifier, so `429` / `5xx` / network map to retryable kinds and
  `retry-after` is honored. Native adapters MUST NOT implement their own retry.
- **No `ai` import.** A native adapter MUST NOT import from `ai` or `@ai-sdk/*`. It
  uses global `fetch` and manual SSE parsing (no new npm dependency; see §6.4).

### §4.3 `ExternalAgentAdapter` (renamed from `subprocess`)

Rename `kind: 'subprocess'` → `kind: 'external'`, and `SubprocessProviderAdapter` →
`ExternalAgentAdapter`. The shape is unchanged (`generate`, `dispose`, `supports`).
Rationale: depth-2 is not subprocess-specific; an HTTP/A2A self-orchestrating agent
is the same shape. `claude_cli` remains the only depth-2 provider for now. This is an
internal-union rename; per the pre-1.0 published-surface policy it is acceptable even
where it leaks to the public type surface.

### §4.4 `generate.ts` dispatch (refactor)

Replace the two-way branch with a three-way one and factor the loop driver out of the
AI-SDK specifics:

```
adapter.kind === 'external'  → return adapter.generate(opts, target)   // depth-2, unchanged
adapter.kind === 'ai_sdk'    → invoke_once = build_ai_sdk_invoke(...)   // existing body, extracted
adapter.kind === 'native'    → invoke_once = build_native_invoke(adapter, ...)
                               // wraps retry_with_policy + classify around invoke_turn
then: run the shared loop driver with invoke_once (existing run_tool_loop + schema-repair wrapper)
```

Required moves:

- **Hoist capability gating** (`schema`/`tools`/`streaming`, `generate.ts:539-547`)
  so it runs for both `ai_sdk` and `native` (both expose `supports`). Depth-2 keeps
  its own capability handling.
- **Generalize `classify_ai_sdk_error`** → `classify_provider_error` in a shared spot
  (it already keys off `statusCode`/`status`/`code`, which raw `fetch` errors and
  provider JSON errors can carry). `ai_sdk` and `native` both use it; a native
  adapter may override via `classify_error`.
- **`build_native_invoke`** maps `InvokeOnceArgs` → `TurnRequest` (threading resolved
  `system`, `effort`, merged `provider_options`, sampling params, and the
  `dispatch_chunk`), calls `adapter.invoke_turn`, and reuses the exact
  `retry_with_policy` + abort + `provider_error('stream interrupted')` wrapping the
  ai_sdk path already has.
- **`dispose`** (`create_engine.ts:126`): call `dispose` on any adapter that defines
  it (`external` always, `native` optionally), not just `kind === 'subprocess'`.

Two implementation stages (tracked separately so the risky one can follow validation):

- **§4.4a Additive.** Keep the AI SDK call *in* `generate.ts` (invariant 13
  unchanged). Add the `native` branch alongside. Lowest blast radius.
- **§4.4b Inversion (optional, after Phase 3 validation).** Move the AI SDK call into
  a `providers/ai_sdk/` adapter implementing `invoke_turn`, so `generate.ts` becomes
  fully SDK-agnostic and only knows `invoke_turn`. This **inverts invariant 13**: the
  rule changes from "only generate.ts/tool_loop.ts/index.ts touch `ai`" to "only the
  `ai_sdk` provider file touches `generateText`/`streamText`". Bigger, cleaner end
  state; sequenced last.

### §4.5 Open registry (`custom_providers`)

Add `custom_providers?: Record<string, ProviderFactory>` to `EngineConfig`.
`build_provider_adapters` resolves each provider-map key against `custom_providers`
first, then the built-ins. Rules:

- A `custom_providers` key that shadows a built-in name **throws**
  `engine_config_error` in v1 (no silent override; revisit later).
- Custom factories are validated synchronously at construction, exactly like
  built-ins (they throw on bad init; SDK/resource loading deferred to first call).
- Registration is **construction-time only**, via config. Runtime
  `engine.register_provider` stays deferred (post-construction mutation is against the
  no-ambient-state taste).
- A custom factory may return an adapter of any `kind`. Proprietary or
  workplace-private providers therefore live entirely in the consuming repo and never
  enter the fascicle tree — the registry is the clean IP boundary.

---

## §5 — Phased Implementation Plan

### Phase 1 — Open the registry

Smallest change, unblocks out-of-tree provider development immediately. Ships alone.

| ID | Task | Files | Acceptance | Deps |
|----|------|-------|------------|------|
| P1.1 | Add `custom_providers?: Record<string, ProviderFactory>` to `EngineConfig` | `src/engine/types.ts` | Type compiles; documented inline | — |
| P1.2 | Resolve custom-first, built-in-second in `build_provider_adapters`; throw on built-in shadow | `src/engine/create_engine.ts`, `src/engine/providers/registry.ts` | Custom name routes to custom factory; shadowing a built-in throws `engine_config_error` | P1.1 |
| P1.3 | Tests: custom `ai_sdk`-kind fake and custom `external`-kind fake both route through `generate`; shadow-throws; unknown-name still throws `provider_not_configured_error` | `src/engine/__tests__/*` | New tests pass; mutation survives | P1.2 |
| P1.4 | Docs: `custom_providers` in `docs/configuration.md`; export `ProviderFactory` + adapter types from the engine barrel if not already public | `docs/configuration.md`, `src/engine/index.ts` | Docs build; example type-checks | P1.2 |

### Phase 2 — Generalize the single-turn seam (`native`)

The structural core. De-privileges the AI SDK without yet writing a native provider.

| ID | Task | Files | Acceptance | Deps |
|----|------|-------|------------|------|
| P2.1 | Introduce `TurnResult` / `TurnRequest` in `types.ts`; alias/replace `InvokeOnceResult`; keep `InvokeOnce` returning `TurnResult` | `src/engine/types.ts`, `src/engine/tool_loop.ts`, `src/engine/generate.ts` | No behavior change; full suite green | — |
| P2.2 | Add `NativeProviderAdapter` and extend the `ProviderAdapter` union | `src/engine/providers/types.ts` | Type compiles; exhaustive `switch (kind)` sites updated | P2.1 |
| P2.3 | Generalize `classify_ai_sdk_error` → shared `classify_provider_error`; both paths use it | `src/engine/generate.ts` (or new `src/engine/classify_error.ts`) | Existing classification tests pass against new location | — |
| P2.4 | Extract the AI SDK invoke body into `build_ai_sdk_invoke`; add `build_native_invoke` (maps args→`TurnRequest`, wraps `retry_with_policy` + classify + abort/stream-interrupt) | `src/engine/generate.ts` | ai_sdk path behavior identical; native branch drives `run_tool_loop` | P2.1, P2.2, P2.3 |
| P2.5 | Three-way dispatch (`external` / `ai_sdk` / `native`); hoist capability gating to cover `native`; gate `Output.object` to `ai_sdk` only | `src/engine/generate.ts` | Native adapters get capability errors + salvage/approval/`ends_turn`/cost/trajectory via the loop | P2.4 |
| P2.6 | `dispose` covers any adapter with a `dispose` method | `src/engine/create_engine.ts` | Disposing an engine with a native adapter that holds resources calls its `dispose` | P2.2 |
| P2.7 | Tests: a **fake native adapter** (in-memory, no HTTP) proves it inherits salvage, tool approval (fail-closed), `Tool.ends_turn`, per-step clamping, cost, trajectory events, and retry-on-classified-error | `src/engine/__tests__/*` | New tests pass; mutation survives | P2.5 |

### Phase 3 — Native Anthropic (raw HTTP), the proof

Selected via `transport: 'native'` on the existing `anthropic` provider.

| ID | Task | Files | Acceptance | Deps |
|----|------|-------|------------|------|
| P3.1 | `transport?: 'ai_sdk' \| 'native'` on provider init (default `ai_sdk`); `anthropic` factory returns the native adapter when `transport === 'native'` | `src/engine/providers/types.ts`, `src/engine/providers/anthropic.ts` | Default unchanged; `transport:'native'` yields `kind:'native'` | P2.2 |
| P3.2 | Native request mapping: `Message[]` → Anthropic messages (leading system hoisted to top-level `system`; assistant `tool_use`; `tool_result` blocks); `Tool[]` → `tools` via `z.toJSONSchema` | `src/engine/providers/anthropic_native.ts` | Round-trip unit tests for each message shape | P3.1 |
| P3.3 | Non-stream `invoke_turn`: POST `/v1/messages`; parse `content` (text + `tool_use`) → `TurnResult`; map `stop_reason` → `FinishReason`; map `usage` (incl. cache create/read) via `normalize_usage` | `src/engine/providers/anthropic_native.ts` | Golden-fixture tests for text, tool-call, and mixed responses | P3.2 |
| P3.4 | Streaming `invoke_turn`: SSE parse (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`); emit `StreamChunk`s via `dispatch_chunk`; aggregate `TurnResult` identical to non-stream | `src/engine/providers/anthropic_native.ts` | Streamed and non-streamed results match for the same fixture | P3.3 |
| P3.5 | Auth + errors: `x-api-key` + `anthropic-version` headers; map HTTP 429 (+`retry-after`) / 5xx / network to classified errors; `provider_auth_error` on 401 | `src/engine/providers/anthropic_native.ts` | Error-path tests assert retry classification and auth error | P3.3 |
| P3.6 | Capabilities: `text, tools, schema, streaming, reasoning`; **not** `structured_output` (rely on prompt+parse+repair); register factory dispatch in `anthropic.ts` | `src/engine/providers/anthropic.ts` | Capability gating behaves; schema path uses repair loop | P3.4, P3.5 |
| P3.7 | End-to-end: a tool loop against the native Anthropic adapter (recorded fixtures / nock-style) exercises salvage + approval + `ends_turn` + cost with **zero `ai` import** in the module graph of the provider | `src/engine/providers/__tests__/*` | E2E green; import-graph assertion / ast-grep rule confirms no `ai` import | P3.6 |

### Phase 4 — Native OpenAI + depth-2 rename

| ID | Task | Files | Acceptance | Deps |
|----|------|-------|------------|------|
| P4.1 | Rename `kind:'subprocess'`→`'external'` and `SubprocessProviderAdapter`→`ExternalAgentAdapter` across the union, `generate.ts` dispatch, `create_engine` dispose, and `claude_cli` | `src/engine/**` | Full suite green; no `'subprocess'` kind remains | P2.2 |
| P4.2 | Native OpenAI adapter via `transport:'native'` on the `openai` factory: request/response/stream mapping for Chat Completions (or Responses) | `src/engine/providers/openai.ts`, `src/engine/providers/openai_native.ts` | Parity tests vs. the ai_sdk backend on shared fixtures | P2.5, P3.4 |
| P4.3 | Native OpenAI `structured_output`: set `response_format: json_schema` inside `invoke_turn` when `req.schema` present; report `supports('structured_output')` true | `src/engine/providers/openai_native.ts` | Schema honored natively; repair loop still validates | P4.2 |
| P4.4 | (Optional) `§4.4b` inversion: move the AI SDK call into a `providers/ai_sdk/` adapter; `generate.ts` becomes SDK-agnostic; invert invariant 13 and its rule | `src/engine/**`, `rules/`, `.ridgeline/constraints.md` | Only the `ai_sdk` provider file imports `generateText`/`streamText`; suite green | P3.7, P4.2 |

---

## §6 — Cross-Cutting Concerns

### §6.1 Boundary rules
- New ast-grep rule: files matching `src/engine/providers/*native*` MUST NOT import
  from `ai` or `@ai-sdk/*`. Add to `rules/`.
- Update invariant 13 wording once §4.4b lands (the AI SDK call site moves).
- Add the new provider files to `fallow.toml` boundary expectations if needed;
  `providers/` already sits under `engine`.

### §6.2 Pricing
- `transport` keeps the provider name stable, so native Anthropic/OpenAI reuse the
  existing `DEFAULT_PRICING` keys. No new pricing entries required. Verify
  `normalize_usage` produces the same token fields the pricing math expects
  (`cached_input_tokens`, `cache_write_tokens`, `reasoning_tokens`).

### §6.3 Tests, coverage, mutation
- Every new module carries colocated `__tests__/`. Coverage floor (70%) applies.
- `pnpm check:all` (incl. Stryker `mutation`) is the gate. Native providers are
  logic-dense (parsing/mapping) and prime mutation targets; write assertion-strong
  tests, not smoke tests.
- Prefer recorded fixtures over live network. No live-network calls in the suite.

### §6.4 Dependencies
- `rules/no-engine-npm-dep-except-ai-zod.yml` forbids engine deps beyond `ai` + `zod`.
  Native providers therefore use global `fetch` and **hand-rolled SSE parsing** — no
  `eventsource`/`undici`/SDK dependency. Budget for a small shared SSE line-reader
  util under `src/engine/` (there is precedent in `claude_cli/stream_parse.ts`).

### §6.5 Docs (update on completion, per `docs/` freshness rule)
- `docs/providers.md`: the three integration depths; `transport` selector; how to
  write a custom provider (all three kinds).
- `docs/configuration.md`: `custom_providers`, `transport`.
- `README.md`: keywords already list `ollama`/`lmstudio`; add nothing until native
  ships, then note SDK-independent providers.
- `docs/roadmap.md`: link this spec.

---

## §7 — Risks & Tradeoffs

- **Native providers re-implement what the SDK gave free** (message mapping, SSE,
  usage, errors). Cost is real: native Anthropic is a few hundred well-tested lines.
  Mitigated by sharing the SSE reader and the error classifier across native
  providers.
- **§4.4b inverts invariant 13** — a rule-touching refactor. De-risked by making it
  optional and sequencing it after Phase 3 proves the seam.
- **Streaming parity is the subtle part.** The invariant "streamed result ≡
  non-streamed result" (already true for ai_sdk) must hold for each native provider;
  it is an explicit acceptance criterion (P3.4, P4.2).
- **`transport` default stays `ai_sdk`** to avoid breakage; the native path must earn
  a default flip with production mileage (deferred, §9).

---

## §8 — Definition of Done

1. `create_engine` accepts `custom_providers`; a provider registered there routes
   through `generate` at any depth; shadowing a built-in throws. (Phase 1)
2. A `kind:'native'` adapter drives `run_tool_loop` and inherits salvage, fail-closed
   approval, `Tool.ends_turn`, per-step clamping, cost, trajectory, and
   retry-on-classified-error, proven by a fake adapter with no network. (Phase 2)
3. `anthropic` with `transport:'native'` runs text, tools, streaming, and
   schema-via-repair against the Messages API with **zero `ai` in the provider's
   module graph**, proven by an import-graph assertion. (Phase 3)
4. `openai` with `transport:'native'` reaches parity with its ai_sdk backend on
   shared fixtures, including native `structured_output`; the depth-2 kind is renamed
   `external`. (Phase 4)
5. `pnpm check:all` exits 0 at the end of every phase. Boundary rule forbids `ai`
   imports in native provider files. Docs updated.

---

## §9 — Out of Scope / Deferred

- AI SDK agent-layer adoption (`ToolLoopAgent`, `stopWhen`, `prepareStep`). Rejected
  by design; see background note.
- **`prepareStep` / `pruneMessages`-style native loop hooks** — genuinely useful,
  additive, but their own spec. Not blocked by this work.
- Flipping the default `transport` to `native` for anthropic/openai.
- A named `mlx` provider (trivial once wanted; `lmstudio.ts` pattern + default
  `base_url`).
- Depth-2 HTTP/A2A self-orchestrating agents (the `external` rename opens the door;
  no implementation here).
- Runtime (post-construction) provider registration.

---

## §10 — Open Questions

- **Chat Completions vs. Responses for native OpenAI.** Responses is the forward
  path; Chat Completions is simpler and more portable to OpenAI-compatible servers.
  Lean Chat Completions first for reuse with LM Studio / MLX-compatible endpoints;
  revisit.
- **Should `structured_output` for native Anthropic use forced-tool JSON?** Deferred;
  the repair loop is sufficient and simpler for v1.
- **Do we expose the shared SSE reader / error classifier as engine-internal utils
  or keep them provider-private?** Recommend engine-internal (reused by every native
  provider), colocated under `src/engine/`.

# Report — Demote the AI SDK behind a native provider seam

**Status:** done — 17/17 steps checkpointed. `pnpm check:all` green at every
phase boundary (Steps 1, 5, 10, 13, 14); the manual live smoke ran at Step 6 and
re-ran at Step 14.

## What shipped

The AI SDK went from privileged to just-another-kind. The build ran in two arcs,
tactical then structural (D1):

- **v7 catch-up (Steps 1–6).** Dev-dependency sweep, the held-back oxlint pair,
  the agent-layer boundary ADR, then the `ai@^7` core bump via codemod with the
  usage/stream-shape review that the nested `inputTokenDetails` shape forced
  (concrete-value cost assertions, per C7). Closed with a live smoke on
  OpenRouter + an OpenAI-compatible backend and a release.
- **Provider sovereignty (Steps 7–17).** Opened the registry to
  construction-time `custom_providers`; introduced neutral `TurnRequest`/
  `TurnResult` turn types and a shared `classify_provider_error`; split the
  single-turn seam into three-way dispatch (`ai_sdk` / `native` / `external`);
  proved a fake native adapter inherits the whole loop (salvage, fail-closed
  approval, `ends_turn`, clamping, cost, trajectory, retry); renamed
  `subprocess` → `external`; built the native Anthropic adapter (raw `fetch` +
  hand-rolled SSE, zero `ai` imports, rule-enforced) across mapping, non-stream,
  auth, streaming, and capabilities; **inverted the seam** so `generate.ts`
  imports nothing from `ai` and the SDK call lives in `providers/ai_sdk/`; swept
  the docs; exported the native contract from the barrel; and settled the native
  `provider_options` passthrough convention.

End state matches the intent's architecture sketch: `generate.ts` knows only
`invoke_turn`, the AI SDK is one `kind` among peers behind the depth-1 seam, and
`anthropic` with `transport: 'native'` runs text, tools, streaming, and
schema-via-repair against the Messages API with zero Vercel in its module graph.

## Decisions and why

The load-bearing calls, distilled from intent's D1–D11:

- **D2/D8 — the seam is the whole point.** The single-turn boundary is the
  sovereignty litmus (depend on a framework only if it lets you call one turn
  below its own loop; `generateText` passes, `ToolLoopAgent` does not). The
  S-§4.4b inversion was committed, not optional — stopping at the additive stage
  would have left the SDK privileged in the one file that matters. Sequenced last
  so the native proof (Steps 10, 13) de-risked it first.
- **D3/D6 — stable names, repair loop over native structured output.**
  `transport` is a field on provider init defaulting to `'ai_sdk'`, so provider
  names and pricing keys never move (C6). Native Anthropic v1 deliberately does
  not claim `structured_output`; schema rides the existing prompt + parse +
  repair loop.
- **D4/D5 — the engine owns retry; adapters owe Vercel nothing.** Native
  adapters use global `fetch` + hand-rolled SSE with zero `ai`/`@ai-sdk/*`
  imports (new ast-grep rule). Adapters may override error *classification*,
  never retry — hidden retries are exactly the illegibility fascicle refuses.
- **D7 — the registry opens at construction time only.** `custom_providers`
  config; shadowing a built-in name throws. The config boundary is the clean IP
  boundary for private providers. No runtime registration.
- **D9/D10 — hard `ai@^7` floor, agent layer declined in writing.** No v6/v7
  compat window (pre-1.0 latitude); the v7 agent layer declines were written as
  an ADR *before* the bump landed, since an upgrade is when the boundary is
  easiest to blur by accident.

## Parked & harvested

Two items were parked mid-build (both after Step 15), both proposed as tangents
to defer into the native-OpenAI intent, both **overridden by the human to
implement now** and folded into the plan:

- **Native `provider_options` passthrough** → Step 17. The convention was
  undefined in S-P3 and native OpenAI would hit the same question, so it was
  worth settling once: `provider_options.anthropic` is raw wire-format
  (snake_case Messages-API keys), shallow-merged last so an explicit user key
  beats every engine-derived field.
- **Barrel exports for native custom providers** → Step 16. Type-only exports of
  `NativeProviderAdapter`, `ProviderTransport`, `TurnRequest`, `TurnResult` so a
  consumer writing a `kind: 'native'` provider names the contract directly
  instead of leaning on contextual typing through `ProviderFactory`.

Nothing was classified as a blocker or pivot; the plan held from Step 1 to Step
17.

## Deferred tangents (future work)

Carried out as the intent's open questions, none blocking this build:

- **Native OpenAI (Q1/Q3)** — Chat Completions vs Responses API; leaning Chat
  Completions written so the request/stream core is reusable against any
  OpenAI-compatible `base_url`, which makes one implementation serve the local
  tail. Decide when drafting the next intent.
- **Native Ollama (Q2)** — native `/api/chat` vs the OpenAI-compatible endpoint
  (a thin variant of Q1's core).
- **`transport: 'native'` default flip (Q4)** — stays `'ai_sdk'` until the
  native path earns it with production mileage + parity data.
- **V-Phase 5 spikes (Q5)** — reasoning control, structured-output repair,
  timeout budgets: reassess whether they still carry weight after the inversion.

Explicitly out of scope and still out: provenance publishing (its own intent),
`Tool.output_schema`, and adopting any v7 agent layer (declined by the ADR).

## Checkpoints

- baseline 633bcd069e23a4b6acd8229f2b4c6e7a1541bb8b
- plan 6f6a2c935fd6eb96717beec8b9a624a7ec96ffbc
- step 1 8ab8848b43fa7f572f2f5c8b0d92386563a15b15
- step 2 74302d9948bbc543d1196b833f003244da09ca4d
- step 3 9c7a86f359e43e36fd3113b4204cb7431a94225b
- step 4 36ad674c860ff8a1bb990d9f094a273b33d88386
- step 5 3208ac72cecc679a720788e3f966985958bfa685
- step 6 9ec197bb007c9927d56668875c145828b6e9d4ed
- step 7 f9a2dc817f4994e5a13c99ba5d1353b146b0d826
- step 8 20db92fc9c598f410fff136697ae0bc36d4be3e8
- step 9 aee2ed45e3c2eee1d0a0cc80c4bef20afd95a750
- step 10 8d6f17fade43d5b9ff2b826aec35a3df996d3ae2
- step 11 02d8cb730f5fca3a7a2dae90dfb9f665fe2d3328
- step 12 da4e99ab140b5e436d933054f17087e75bcd165a
- step 13 c045b2cb3f4fa6434fdf461d614b283c0ec26242
- step 14 10468f26e1a09f641627fb06e719615ab2e9aea5
- step 15 ab68fe6d8d93ad77171611e1c560ec22077f609d
- step 16 8b3f37a8e7edd20a91dc8c7c98a207b0aea48235
- step 17 9f6e6fda5e9e67d1f71feb73ed6840d1af26e4e4

## Checkpoints

- baseline 633bcd069e23a4b6acd8229f2b4c6e7a1541bb8b
- plan 6f6a2c935fd6eb96717beec8b9a624a7ec96ffbc
- step 1 8ab8848b43fa7f572f2f5c8b0d92386563a15b15
- step 2 74302d9948bbc543d1196b833f003244da09ca4d
- step 3 9c7a86f359e43e36fd3113b4204cb7431a94225b
- step 4 36ad674c860ff8a1bb990d9f094a273b33d88386
- step 5 3208ac72cecc679a720788e3f966985958bfa685
- step 6 9ec197bb007c9927d56668875c145828b6e9d4ed
- step 7 f9a2dc817f4994e5a13c99ba5d1353b146b0d826
- step 8 20db92fc9c598f410fff136697ae0bc36d4be3e8
- step 9 aee2ed45e3c2eee1d0a0cc80c4bef20afd95a750
- step 10 8d6f17fade43d5b9ff2b826aec35a3df996d3ae2
- step 11 02d8cb730f5fca3a7a2dae90dfb9f665fe2d3328
- step 12 da4e99ab140b5e436d933054f17087e75bcd165a
- step 13 c045b2cb3f4fa6434fdf461d614b283c0ec26242
- step 14 10468f26e1a09f641627fb06e719615ab2e9aea5
- step 15 ab68fe6d8d93ad77171611e1c560ec22077f609d
- step 16 8b3f37a8e7edd20a91dc8c7c98a207b0aea48235
- step 17 9f6e6fda5e9e67d1f71feb73ed6840d1af26e4e4

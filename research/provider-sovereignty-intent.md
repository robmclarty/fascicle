---
title: Provider sovereignty build intent - v7 baseline, open registry, native Anthropic, AI SDK demotion
status: draft
date: 2026-07-09
author: rob
tags: [engine, providers, ai-sdk, sovereignty, intent, plumbbob]
---

# Demote the AI SDK: v7 baseline, then a native provider seam

Reconciles [`ai-sdk-v7-upgrade-spec.md`](./ai-sdk-v7-upgrade-spec.md) (tactical)
and [`provider-sovereignty-spec.md`](./provider-sovereignty-spec.md) (structural)
into one pb-plan intent. Task IDs below reference the spec tables: `V-P<n>.<m>`
for the v7 spec, `S-P<n>.<m>` for the sovereignty spec. The specs remain the
detail source; this document is the head.

Accounting for the rest of the July research: the third pending spec,
[`provenance-publish-spec.md`](./provenance-publish-spec.md), is deliberately
excluded (see NOT doing); the third July exploration,
[`explorations/2026-07-stdio-agent-contract.md`](./explorations/2026-07-stdio-agent-contract.md),
already shipped (`fascicle/stdio`, `stderr_logger`,
`docs/embedding-under-a-harness.md`) and is background only. It shares the
depth-2 shape with the `external` rename (Step 8) but no tasks: that work is
fascicle as the child, this build is fascicle as the parent.

**Phase:** frame
**Size:** medium (top end; the natural split line, if it feels too big as one
build, is after Step 4, where the v7 track ends and the sovereignty track begins)

## Frame

- **Problem:** The AI SDK is privileged, not pluggable. Seven of eight built-in
  providers route through a hard-wired `generateText`/`streamText` call in
  `generate.ts`, the registry is a frozen map, and we are a full major behind
  (`ai ^6` vs `7.0.18`) on a dependency whose churn we have already had to fight
  (`maxRetries: 0`, `maxSteps` renames). There is no way to add a raw-HTTP
  provider that still inherits the fascicle loop (salvage, approval,
  `ends_turn`, cost, trajectory, retry).
- **Smallest thing that solves it:** Get current on v7 (clean baseline, three
  files, mostly codemod), open the registry, generalize the single-turn seam to
  a `native` adapter kind, prove it with a raw-HTTP Anthropic provider, then
  move the AI SDK call itself behind the same seam so `generate.ts` knows only
  `invoke_turn`.
- **Done looks like:** `anthropic` with `transport: 'native'` runs text, tools,
  streaming, and schema-via-repair against the Messages API with zero `ai` in
  the provider's module graph (rule-enforced); the AI SDK call lives in a
  `providers/ai_sdk/` adapter as one `kind` among peers; `custom_providers`
  lets a consuming repo register a provider at any depth; `ai@^7` across the
  board; `pnpm check:all` exits 0.
- **Explicitly NOT doing:**
  - Provenance publishing (`provenance-publish-spec.md`): its own tiny intent.
    Different subsystem (release CI + npm registry config, zero `src/`
    changes), different risk profile, no shared tasks. Only touchpoint: if it
    lands before Step 4, the v7 release becomes the first provenance-attested
    publish. Nice ordering, not a dependency.
  - Native OpenAI and native Ollama (the next entries in the series; backlog,
    see Open questions Q1-Q3).
  - `Tool.output_schema` (V-Phase 4) and the capability spikes (V-Phase 5,
    reasoning control / structured-output repair / timeout budgets): own
    intents, independent of this work.
  - Adopting any of the v7 agent layer (`ToolLoopAgent`, `WorkflowAgent`,
    `HarnessAgent`, `toolApproval`, `@ai-sdk/otel`): declined by the boundary
    ADR (Step 2).
  - Flipping the default `transport` to `native` (must earn it with mileage).
  - Runtime (post-construction) provider registration.
  - `prepareStep`/`pruneMessages`-style loop hooks (future spec).

## Architecture sketch

End state (after Step 10, the inversion):

```
┌────────────────────────────────────────────────────────────────┐
│  generate.ts: resolves opts, gates capabilities, owns retry +   │
│  trajectory; knows ONLY invoke_turn - zero `ai` imports         │
├────────────────────────────────────────────────────────────────┤
│  run_tool_loop (unchanged, already SDK-neutral)                 │
├────────────────────────────────────────────────────────────────┤
│  depth-1 turn seam: invoke_turn(TurnRequest) -> TurnResult      │
│    ├─ providers/ai_sdk/    kind:'ai_sdk'  (generateText, moved) │
│    ├─ anthropic_native.ts  kind:'native'  (raw fetch + SSE)     │
│    └─ [next: openai_native, ollama_native, ...]                 │
│  depth-2: kind:'external' adapter.generate() (claude_cli, ...)  │
└────────────────────────────────────────────────────────────────┘
  registry: built-ins + custom_providers (consumer repo, any kind)
```

## Decisions

- D1: Tactical before structural: v7 upgrade lands first so the native work
  targets a clean, current baseline. *Because* both specs agree, and the more we
  already own, the cheaper the major (v7 is a three-file diff).
- D2: The single-turn seam is the sovereignty boundary. Litmus test: depend on a
  framework only if it lets you call one turn below its own loop. *Because*
  `generateText` passes the test; `ToolLoopAgent` does not.
- D3: Backend selection is a `transport` field on provider init, defaulting to
  `'ai_sdk'`. *Because* it keeps provider names (and pricing keys) stable and
  makes "one backend among several" literal without breaking anyone.
- D4: Native adapters use global `fetch` and hand-rolled SSE; zero `ai` or
  `@ai-sdk/*` imports, enforced by a new ast-grep rule. *Because* the engine
  dependency rule stays `ai` + `zod` only, and the point is a provider that owes
  Vercel nothing.
- D5: The engine owns retry and error classification (`retry_with_policy` +
  shared `classify_provider_error`); adapters may override classification only,
  never retry. *Because* hidden retries are exactly the illegibility fascicle
  refuses.
- D6: Native Anthropic v1 does not claim `structured_output`; schema flows
  through the existing prompt + parse + repair loop. *Because* the repair loop
  is sufficient, simpler, and already provider-neutral.
- D7: The registry opens via construction-time `custom_providers` config;
  shadowing a built-in name throws. *Because* explicit wiring over ambient
  registration, and the config boundary is the clean IP boundary for private
  providers.
- D8: The S-§4.4b inversion is COMMITTED, not optional: `generate.ts` becomes
  SDK-agnostic and invariant 13 is rewritten to "only the `ai_sdk` provider
  module calls `generateText`/`streamText`". *Because* the goal of this build
  is demotion to just-another-kind, and stopping at the additive stage leaves
  the SDK privileged in the file that matters. Sequenced last, after the native
  proof de-risks it. [FLAGGED: spec had this optional]
- D9: Hard `ai@^7` peer floor, no v6/v7 compat window. *Because* pre-1.0
  published-surface latitude; a dual-major burden buys nothing.
- D10: The v7 agent layer is declined wholesale and the declines are written
  down as an ADR before the bump lands. *Because* an upgrade is the moment the
  boundary is easiest to blur by accident.
- D11: `kind: 'subprocess'` renames to `kind: 'external'`
  (`SubprocessProviderAdapter` to `ExternalAgentAdapter`). *Because* depth-2 is
  runtime-neutral; an HTTP/A2A agent is the same shape.

## Constraints

- C1: `pnpm check:all` (incl. mutation) exits 0 at every phase boundary (Steps
  1, 4, 7, 9, 10); `pnpm check` for inner iteration.
- C2: Zero new runtime dependencies. Engine npm deps remain `ai` + `zod` only
  (`rules/no-engine-npm-dep-except-ai-zod.yml`).
- C3: Invariant 13 holds unchanged through Step 9; Step 10 inverts it and must
  update the rule, `.ridgeline/constraints.md`, and the `generate.ts` header in
  the same change.
- C4: Streamed result must equal non-streamed result for the same input on
  every provider path; explicit acceptance for all native streaming work.
- C5: No live network in the test suite; recorded fixtures only. The live smoke
  (V-P3.8) is a manual gate, run at Step 4 and re-run at Step 10.
- C6: Provider names stay stable across transports so `DEFAULT_PRICING` keys
  and `normalize_usage` fields (`cached_input_tokens`, `cache_write_tokens`,
  `reasoning_tokens`) keep working.
- C7: Coverage floor 70%; colocated `__tests__/`; native parsing/mapping code is
  a prime mutation target, so assert on concrete values, not smoke.
- C8: Scope is `src/engine/**` plus `rules/`, `fallow.toml`, and docs. `core`,
  `composites`, `agents`, `adapters`, `mcp`, `viewer`, `ui` (beyond the v7
  `map_chunk` review), and `stdio` are untouched.

## Steps

1. [ ] Dev-dependency sweep (V-P1.1..P1.4: vitest, oxlint, tsdown, zod,
   `@types/node` 26, fallow 3, et al.) - **done when:** `pnpm check:all` exits 0
   on the swept set, no source change
   - seam: `package.json`, `pnpm-lock.yaml`, `fallow.toml`
2. [ ] Agent-layer boundary ADR (V-P2.1..P2.2) - **done when:** decision record
   exists with the D2 litmus test and the full declined-v7 table, linked from
   `docs/providers.md`
   - seam: `research/explorations/2026-07-ai-sdk-agent-layer-boundary.md`, `docs/providers.md`
3. [ ] AI SDK v7 core migration (V-P3.1..P3.7: bump `ai@^7` + all `@ai-sdk/*`
   peers, run codemods, reconcile the four `generate.ts` renames, verify
   `normalize_usage` against the nested usage shape, review `map_chunk` incl.
   `reasoning-file`) - **done when:** `pnpm check:all` exits 0 on v7
   - seam: `package.json`, `src/engine/generate.ts`, `src/engine/providers/*.ts`, `src/ui/to_ui_message_stream.ts`, `src/engine/tool_loop.ts`
4. [ ] v7 live smoke + release (V-P3.8..P3.9) - **done when:** a tool-loop flow
   runs correctly streamed and non-streamed on Anthropic and one
   OpenAI-compatible backend with usage/cost recorded; changelog + version bumped
   - seam: `examples/`, `CHANGELOG.md`, `package.json`
5. [ ] Open the registry (S-P1.1..P1.4: `custom_providers` on `EngineConfig`,
   custom-first resolution, shadow-throws) - **done when:** a custom factory of
   any kind routes through `generate`; shadowing throws `engine_config_error`;
   docs updated
   - seam: `src/engine/types.ts`, `src/engine/create_engine.ts`, `src/engine/providers/registry.ts`, `docs/configuration.md`, `src/engine/index.ts`
6. [ ] Neutral turn seam (S-P2.1..P2.6: `TurnRequest`/`TurnResult`,
   `NativeProviderAdapter`, shared `classify_provider_error`, three-way
   dispatch, hoisted capability gating, generalized `dispose`) - **done when:**
   ai_sdk path behavior is byte-identical, suite green
   - seam: `src/engine/types.ts`, `src/engine/providers/types.ts`, `src/engine/generate.ts`, `src/engine/tool_loop.ts`, `src/engine/create_engine.ts`
7. [ ] Loop-inheritance proof (S-P2.7) - **done when:** an in-memory fake
   native adapter provably inherits salvage, fail-closed approval,
   `Tool.ends_turn`, per-step clamping, cost, trajectory, and
   retry-on-classified-error; mutation survives
   - seam: `src/engine/__tests__/`
8. [ ] Rename `subprocess` to `external` (S-P4.1) - **done when:** no
   `'subprocess'` kind remains anywhere; suite green
   - seam: `src/engine/**`
9. [ ] Native Anthropic (S-P3.1..P3.7: `transport` selector, message/tool
   mapping, non-stream + SSE stream `invoke_turn`, auth + error classification,
   capabilities, e2e fixtures) - **done when:** `transport: 'native'` passes
   text/tools/streaming/schema-via-repair on fixtures; streamed equals
   non-streamed; zero `ai` import proven by the new ast-grep rule
   - seam: `src/engine/providers/anthropic.ts`, `src/engine/providers/anthropic_native.ts`, `src/engine/providers/types.ts`, `rules/`
10. [ ] Invert the seam (S-P4.4, committed per D8) - **done when:** the AI SDK
    call lives in `src/engine/providers/ai_sdk/`; `generate.ts` imports nothing
    from `ai`; invariant 13 + rules rewritten; `pnpm check:all` exits 0; Step 4
    smoke re-run green
    - seam: `src/engine/generate.ts`, `src/engine/providers/ai_sdk/`, `rules/`, `.ridgeline/constraints.md`
11. [ ] Docs sweep (S-§6.5) - **done when:** `docs/providers.md` documents the
    three integration depths, `transport`, and writing a custom provider of each
    kind; `docs/configuration.md` covers `custom_providers`; roadmap links both
    specs and this intent
    - seam: `docs/providers.md`, `docs/configuration.md`, `docs/roadmap.md`, `README.md`

## Open questions

- Q1: Native OpenAI (next in the series): Chat Completions vs Responses API.
  Lean Chat Completions, written so the request/stream mapping core is reusable
  against any OpenAI-compatible `base_url` (LM Studio, MLX, Ollama's compat
  endpoint), which makes one implementation serve the whole local tail.
  *Resolve by:* decide when drafting the next intent.
- Q2: Native Ollama: Ollama's native `/api/chat` vs its OpenAI-compatible
  endpoint (i.e., a thin variant of Q1's core). *Resolve by:* spike when
  scheduled.
- Q3: Which native provider follows Anthropic: OpenAI or Ollama first? Values
  lean local-first (Ollama); reuse leans OpenAI-compatible-core-first, which
  then makes Ollama nearly free. Known consumer: volley is intended to run as a
  plumbbob agent on a local LLM, which raises the local tail's priority either
  way. *Resolve by:* ask.
- Q4: When does the default `transport` flip to `native` for anthropic (and
  later openai)? *Resolve by:* decide after production mileage + parity data.
- Q5: Do the V-Phase 5 spikes (reasoning control, structured-output repair,
  timeout budgets) still carry weight after the inversion, or does the native
  path change their calculus? *Resolve by:* decide when scheduling follow-ups.

## Verdicts

*(Filled in as forks resolve.)*

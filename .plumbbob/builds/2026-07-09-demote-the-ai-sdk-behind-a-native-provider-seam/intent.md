# Demote the AI SDK behind a native provider seam

**Phase:** plan
**Size:** medium (top end; the natural split line, if it must become two builds,
is after Step 6, where the v7 track ends and the sovereignty track begins)

*Source: `research/provider-sovereignty-intent.md` (absorbed in full below), which
reconciles `research/ai-sdk-v7-upgrade-spec.md` (tactical, task IDs `V-P<n>.<m>`)
and `research/provider-sovereignty-spec.md` (structural, task IDs `S-P<n>.<m>`).
The specs remain the detail source per task; this intent stands on its own for
sequencing, acceptance, and scope.*

Excluded from this build, accounted for on purpose:
`research/provenance-publish-spec.md` (release-CI supply chain, its own tiny
intent; only touchpoint is that landing it before Step 6 makes the v7 release the
first provenance-attested publish) and
`research/explorations/2026-07-stdio-agent-contract.md` (already shipped as
`fascicle/stdio` + `stderr_logger` + `docs/embedding-under-a-harness.md`;
background only - that work is fascicle as the child, this build is fascicle as
the parent).

## Frame

- **Problem:** The AI SDK is privileged, not pluggable. Seven of eight built-in
  providers route through a hard-wired `generateText`/`streamText` call in
  `src/engine/generate.ts`, the provider registry is a frozen map of eight
  built-ins, and we are a full major behind (`ai ^6` vs `7.0.18`) on a dependency
  whose churn we have already had to fight (`maxRetries: 0`, `maxSteps` renames).
  There is no way to add a raw-HTTP provider that still inherits the fascicle
  loop (salvage, approval, `ends_turn`, cost, trajectory, retry).
- **Smallest thing that solves it:** Get current on v7 (clean baseline, three
  coupled files, mostly codemod), open the registry, generalize the single-turn
  seam to a `native` adapter kind, prove it with a raw-HTTP Anthropic provider,
  then move the AI SDK call itself behind the same seam so `generate.ts` knows
  only `invoke_turn`.
- **Done looks like:** `anthropic` with `transport: 'native'` runs text, tools,
  streaming, and schema-via-repair against the Messages API with zero `ai` in the
  provider's module graph (rule-enforced); the AI SDK call lives in a
  `providers/ai_sdk/` adapter as one `kind` among peers; `custom_providers` lets
  a consuming repo register a provider at any depth; `ai@^7` across the board;
  `pnpm check:all` exits 0.
- **Explicitly NOT doing:**
  - Provenance publishing (`research/provenance-publish-spec.md`): own intent.
  - Native OpenAI and native Ollama: the next entries in the series (Q1-Q3).
  - `Tool.output_schema` (V-Phase 4) and the capability spikes (V-Phase 5:
    reasoning control, structured-output repair, timeout budgets): own intents.
  - Adopting any v7 agent layer (`ToolLoopAgent`, `WorkflowAgent`,
    `HarnessAgent`, `toolApproval`, `@ai-sdk/otel`): declined by the ADR (Step 3).
  - Flipping the default `transport` to `native` (must earn it with mileage).
  - Runtime (post-construction) provider registration.
  - `prepareStep`/`pruneMessages`-style loop hooks (future spec).

## Architecture sketch

End state (after Step 14, the inversion):

```text
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
  targets a clean, current baseline — *because* both specs agree, and the more we
  already own, the cheaper the major (v7 is a three-file diff).
- D2: The single-turn seam is the sovereignty boundary; litmus test: depend on a
  framework only if it lets you call one turn below its own loop — *because*
  `generateText` passes the test and `ToolLoopAgent` does not.
- D3: Backend selection is a `transport` field on provider init, defaulting to
  `'ai_sdk'` — *because* it keeps provider names (and pricing keys) stable and
  makes "one backend among several" literal without breaking anyone.
- D4: Native adapters use global `fetch` and hand-rolled SSE, zero `ai` or
  `@ai-sdk/*` imports, enforced by a new ast-grep rule — *because* the engine
  dependency rule stays `ai` + `zod` only, and the point is a provider that owes
  Vercel nothing.
- D5: The engine owns retry and error classification (`retry_with_policy` +
  shared `classify_provider_error`); adapters may override classification only,
  never retry — *because* hidden retries are exactly the illegibility fascicle
  refuses.
- D6: Native Anthropic v1 does not claim `structured_output`; schema flows
  through the existing prompt + parse + repair loop — *because* the repair loop
  is sufficient, simpler, and already provider-neutral.
- D7: The registry opens via construction-time `custom_providers` config;
  shadowing a built-in name throws — *because* explicit wiring over ambient
  registration, and the config boundary is the clean IP boundary for private
  providers.
- D8: The S-§4.4b inversion is COMMITTED, not optional: `generate.ts` becomes
  SDK-agnostic and invariant 13 is rewritten to "only the `ai_sdk` provider
  module calls `generateText`/`streamText`" — *because* the goal of this build
  is demotion to just-another-kind, and stopping at the additive stage leaves
  the SDK privileged in the file that matters; sequenced last, after the native
  proof de-risks it.
- D9: Hard `ai@^7` peer floor, no v6/v7 compat window — *because* pre-1.0
  published-surface latitude; a dual-major burden buys nothing.
- D10: The v7 agent layer is declined wholesale and the declines are written
  down as an ADR before the bump lands — *because* an upgrade is the moment the
  boundary is easiest to blur by accident.
- D11: `kind: 'subprocess'` renames to `kind: 'external'`
  (`SubprocessProviderAdapter` to `ExternalAgentAdapter`) — *because* depth-2 is
  runtime-neutral; an HTTP/A2A agent is the same shape.

## Constraints

- C1: `pnpm check:all` (incl. mutation) exits 0 at every phase boundary (Steps
  1, 5, 10, 13, 14); `pnpm check` for inner iteration.
- C2: Zero new runtime dependencies; engine npm deps remain `ai` + `zod` only
  (`rules/no-engine-npm-dep-except-ai-zod.yml`).
- C3: Invariant 13 holds unchanged through Step 13; Step 14 inverts it and must
  update the rule, `.ridgeline/constraints.md`, and the `generate.ts` header in
  the same change.
- C4: Streamed result must equal non-streamed result for the same input on every
  provider path; explicit acceptance for all native streaming work.
- C5: No live network in the test suite; recorded fixtures only. The live smoke
  (V-P3.8) is a manual gate, run at Step 6 and re-run at Step 14.
- C6: Provider names stay stable across transports so `DEFAULT_PRICING` keys and
  `normalize_usage` fields (`cached_input_tokens`, `cache_write_tokens`,
  `reasoning_tokens`) keep working.
- C7: Coverage floor 70%; colocated `__tests__/`; native parsing/mapping code is
  a prime mutation target, so assert on concrete values, not smoke.
- C8: Scope is `src/engine/**` plus `rules/`, `fallow.toml`, and docs. `core`,
  `composites`, `agents`, `adapters`, `mcp`, `viewer`, `ui` (beyond the v7
  `map_chunk` review), and `stdio` are untouched.

## Steps

1. [x] Dev-dependency sweep (V-P1.1..P1.4: vitest, oxlint, tsdown, zod, cspell,
   markdownlint-cli2, ast-grep, arethetypeswrong, tsx, `@types/node` 26,
   fallow 3) — **done when:** `pnpm check:all` exits 0 on the swept set with no
   source change
   - seam: `package.json`, `pnpm-lock.yaml`, `fallow.toml`
   - model: sonnet — mechanical dependency churn; the check gate catches everything
2. [x] Lint-tool catch-up + sweep fallout (oxlint 1.60→1.73, oxlint-tsgolint
   0.21→0.24 — the pair held back from Step 1) — **done when:** `pnpm check:all`
   exits 0 with the oxlint pair bumped, every newly-surfaced finding resolved by
   no-behavior-change edits (redundant type-assertion removal, function hoisting,
   one unused import, one namespace access), and `.plumbbob/**` added to the
   markdownlint ignore list so the appended build-log line stops tripping MD032;
   no test assertion values changed
   - seam: `package.json`, `pnpm-lock.yaml`, `.markdownlint-cli2.jsonc`, `src/`,
     `examples/` — lint-only edits (a one-time, no-behavior exception to C8 for the
     ~47 findings, ~21 in C8's otherwise-untouched core/composites/agents)
   - model: sonnet — mechanical, no-behavior lint fixes gated by types + lint + test
3. [x] Agent-layer boundary ADR (V-P2.1..P2.2) — **done when:** the decision
   record exists (`status: accepted`) with the D2 litmus test and the full
   declined-v7 table, linked from `docs/providers.md`
   - seam: `research/explorations/2026-07-ai-sdk-agent-layer-boundary.md`, `docs/providers.md`
   - model: opus — prose distillation of already-settled decisions (the triage table exists)
4. [x] v7 core bump + codemod + rename reconciliation (V-P3.1..P3.3: `ai@^7` and
   all `@ai-sdk/*` peer targets from V-§3, `npx @ai-sdk/codemod v7` with the
   mechanical diff committed separately, then hand-verify `stepCountIs` to
   `isStepCount`, `experimental_output` to `output`, `fullStream` to `stream`,
   `system` to `instructions`) — **done when:** `pnpm exec tsc --noEmit` is clean
   and the suite is green on v7
   - seam: `package.json`, `pnpm-lock.yaml`, `src/engine/generate.ts`
   - model: sonnet — codemod-driven renames against verified anchors; types + suite gate it
5. [x] v7 usage + stream-shape review (V-P3.4..P3.7: per-provider
   `normalize_usage` against the nested `inputTokenDetails`/`outputTokenDetails`
   shape with cache-read/reasoning granularity into cost math; `map_chunk` vs v7
   `UIMessageChunk` incl. the new `reasoning-file` part; `tool_loop.ts`
   content-part check) — **done when:** `pnpm check:all` exits 0 with usage/cost
   tests asserting concrete token values from the nested shape
   - seam: `src/engine/providers/`, `src/engine/generate.ts`, `src/ui/to_ui_message_stream.ts`, `src/engine/tool_loop.ts`
   - model: fable — silent cost-skew risk; a wrong field read passes types and only concrete-value assertions catch it
6. [x] v7 live smoke + release (V-P3.8..P3.9) — **done when:** a tool-loop flow
   runs correctly streamed and non-streamed on OpenRouter and one
   OpenAI-compatible backend with usage/cost recorded, and changelog + version
   are bumped
   - seam: `examples/`, `CHANGELOG.md`, `package.json`
   - model: opus — manual smoke gate plus release chores; judgment is in reading the smoke output
7. [x] Open the registry (S-P1.1..P1.4: `custom_providers` on `EngineConfig`,
   custom-first resolution, shadow-throws, factory/adapter types exported from
   the engine barrel) — **done when:** a custom factory of any kind routes
   through `generate`, shadowing a built-in throws `engine_config_error`,
   unknown names still throw `provider_not_configured_error`, docs updated
   - seam: `src/engine/types.ts`, `src/engine/create_engine.ts`, `src/engine/providers/registry.ts`, `src/engine/index.ts`, `docs/configuration.md`
   - model: opus — small and fully specified by the S-P1 acceptance criteria
8. [x] Neutral turn types + shared error classifier (S-P2.1..P2.3:
   `TurnRequest`/`TurnResult` in `types.ts`, `InvokeOnceResult` aliased,
   `classify_ai_sdk_error` generalized to `classify_provider_error`) —
   **done when:** pure rename/move with zero behavior change; full suite green
   - seam: `src/engine/types.ts`, `src/engine/tool_loop.ts`, `src/engine/generate.ts`, `src/engine/providers/types.ts`
   - model: opus — pure rename/move; the suite catches any behavior drift
9. [x] Three-way dispatch (S-P2.4..P2.6: extract `build_ai_sdk_invoke`, add
   `build_native_invoke` wrapping `retry_with_policy` + classify + abort, hoist
   capability gating over `ai_sdk` + `native`, gate `Output.object` to `ai_sdk`
   only, generalize `dispose` to any adapter that defines it) — **done when:**
   ai_sdk path behavior is identical on the existing suite and a `kind:'native'`
   adapter drives `run_tool_loop`
   - seam: `src/engine/generate.ts`, `src/engine/providers/types.ts`, `src/engine/create_engine.ts`
   - model: fable — behavior-preservation refactor with subtle ordering (gating hoist, retry/abort wrapping); plausible-but-drifted code is the failure mode
10. [x] Loop-inheritance proof (S-P2.7) — **done when:** an in-memory fake native
    adapter provably inherits salvage, fail-closed approval, `Tool.ends_turn`,
    per-step clamping, cost, trajectory events, and retry-on-classified-error,
    and `pnpm check:all` (incl. mutation) exits 0
    - seam: `src/engine/__tests__/`
    - model: opus — assertion-strong test authoring against mutation; well-bounded by the S-P2.7 list
11. [x] Rename `subprocess` to `external` (S-P4.1) — **done when:** no
    `'subprocess'` kind remains anywhere in the tree; full suite green
    - seam: `src/engine/`
    - model: sonnet — mechanical rename sweep; types + suite gate it
12. [x] Native Anthropic: mapping, non-stream, auth (S-P3.1..P3.3, S-P3.5:
    `transport` selector on provider init, `Message[]`/`Tool[]` to Messages-API
    mapping, non-stream `invoke_turn` with `stop_reason`/usage mapping,
    `x-api-key` + `anthropic-version` headers, 401/429(+`retry-after`)/5xx/network
    classification) — **done when:** golden-fixture tests pass for text,
    tool-call, and mixed responses and error-path tests assert classification
    - seam: `src/engine/providers/anthropic.ts`, `src/engine/providers/anthropic_native.ts`, `src/engine/providers/types.ts`
    - model: fable — logic-dense greenfield mapping (message shapes, stop_reason, usage) with no prior art in-tree
13. [x] Native Anthropic: streaming, capabilities, e2e (S-P3.4, S-P3.6..P3.7:
    SSE parse emitting `StreamChunk`s via `dispatch_chunk`, capabilities `text,
    tools, schema, streaming, reasoning` without `structured_output`, e2e tool
    loop on recorded fixtures, new ast-grep rule forbidding `ai`/`@ai-sdk/*`
    imports in `*native*` provider files) — **done when:** streamed equals
    non-streamed on shared fixtures, the e2e loop exercises salvage + approval +
    `ends_turn` + cost, zero `ai` import is rule-enforced, and `pnpm check:all`
    exits 0
    - seam: `src/engine/providers/anthropic_native.ts`, `src/engine/providers/anthropic.ts`, `rules/`
    - model: fable — hand-rolled SSE parsing; streamed ≡ non-streamed parity is the named subtle part (C4)
14. [ ] Invert the seam (S-P4.4, committed per D8) — **done when:** the AI SDK
    call lives in `src/engine/providers/ai_sdk/`, `generate.ts` imports nothing
    from `ai`, invariant 13 and its rule are rewritten, `pnpm check:all` exits 0,
    and the Step 6 smoke re-runs green
    - seam: `src/engine/generate.ts`, `src/engine/providers/ai_sdk/`, `rules/`, `.ridgeline/constraints.md`
    - model: opus — moves code behind a seam already proven by Steps 10 and 13, gated by suite + smoke re-run; worth a fable review pass on the diff before checkpointing
15. [ ] Docs sweep (S-§6.5) — **done when:** `docs/providers.md` documents the
    three integration depths, `transport`, and writing a custom provider of each
    kind; `docs/configuration.md` covers `custom_providers`; the roadmap links
    both specs and this intent
    - seam: `docs/providers.md`, `docs/configuration.md`, `docs/roadmap.md`, `README.md`
    - model: sonnet — docs prose from settled content; the link/lint gates cover form

## Open questions

- Q1: Native OpenAI (next in the series): Chat Completions vs Responses API.
  Lean Chat Completions, written so the request/stream mapping core is reusable
  against any OpenAI-compatible `base_url` (LM Studio, MLX, Ollama's compat
  endpoint), which makes one implementation serve the whole local tail —
  *resolve by:* decide when drafting the next intent.
- Q2: Native Ollama: Ollama's native `/api/chat` vs its OpenAI-compatible
  endpoint (a thin variant of Q1's core) — *resolve by:* spike when scheduled.
- Q3: Which native provider follows Anthropic: OpenAI or Ollama first? Values
  lean local-first (Ollama); reuse leans OpenAI-compatible-core-first, which
  then makes Ollama nearly free. Known consumer: volley is intended to run as a
  plumbbob agent on a local LLM, which raises the local tail's priority either
  way — *resolve by:* ask.
- Q4: When does the default `transport` flip to `native` for anthropic (and
  later openai)? — *resolve by:* decide after production mileage + parity data.
- Q5: Do the V-Phase 5 spikes (reasoning control, structured-output repair,
  timeout budgets) still carry weight after the inversion? — *resolve by:*
  decide when scheduling follow-ups.

## Verdicts

<!-- Filled in as spikes and forks resolve — the audit trail of "these were my calls." -->

- 2026-07-10 (step 6): the smoke's hosted backend is OpenRouter, not direct
  Anthropic — no Anthropic API key is available in this environment, and the
  OpenRouter leg still exercises a peer this build bumped a major
  (`@openrouter/ai-sdk-provider` ^3). Direct-Anthropic smoke coverage arrives
  with the native adapter's fixtures and the step 14 re-run.

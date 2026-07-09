---
title: AI SDK v6 → v7 upgrade, dependency sweep, and capability triage
status: draft
date: 2026-07-08
author: rob
tags: [engine, ai-sdk, dependencies, upgrade, sovereignty, spec]
---

# AI SDK v7 Upgrade + Dependency Sweep — Specification

**Status:** Draft, implementation pending
**Scope:** dependency ranges in `package.json`; the three `ai`-coupled source files
(`src/engine/generate.ts`, per-provider `normalize_usage`, `src/ui/to_ui_message_stream.ts`);
one additive `Tool` field (`src/engine/types.ts`, `src/engine/tool_loop.ts`); and the
docs that describe the boundary. No change to the tool loop's control semantics, the
public flow surface, or the provider registry.
**Background:** [`explorations/2026-07-ai-sdk-v7-upgrade-and-capability-triage.md`](./explorations/2026-07-ai-sdk-v7-upgrade-and-capability-triage.md)
(the v7 breaking-change matrix, the ride/evaluate/decline capability triage, and the
version data behind this spec).
**Sibling work:** [`provider-sovereignty-spec.md`](./provider-sovereignty-spec.md) —
the *structural* de-privileging of the AI SDK (native/raw-HTTP providers). This spec
is the *tactical* companion: stay current on the SDK we do use, contain its churn, and
keep the agent-layer boundary explicit. Doing v7 first gives the native work a clean v7
baseline to target. The two are independent and can proceed in parallel.
**Sibling contracts:** `AGENTS.md` (conventions), `.ridgeline/constraints.md`
(invariants — esp. #13, the `generateText`/`streamText` call-site rule), `docs/providers.md`.
**Tracking:** structured for ingestion into plumbbob-plan. Every task carries a stable
ID (`P<phase>.<n>`), acceptance criteria, dependencies, and the files it touches. Phases
are ordered by dependency; within a phase, tasks may parallelize except where `deps`
says otherwise.

---

## §1 — Problem Statement

Three coupled problems, one release window:

1. **We are a major version behind.** Peer deps pin `ai ^6.0.0` (resolved `6.0.168`);
   npm `latest` is now `ai@7.0.18`. The `@ai-sdk/*` providers have each shipped their
   v7-compatible majors. The longer the gap, the more expensive the eventual jump.
2. **v7 is the AI SDK climbing *into* fascicle's layer.** Its headline features are
   `ToolLoopAgent` (GA), `WorkflowAgent` durability, `HarnessAgent`, `toolApproval`,
   scoped tool context, and agent runtime context — i.e. the multi-step loop, approval,
   orchestration, and durability that fascicle *already owns* in `tool_loop.ts` /
   composites. An upgrade is the moment that boundary is easiest to blur by accident
   (a contributor reaches for `ToolLoopAgent`, and the engine quietly hollows out).
   The decline decisions need to be written down, not implied.
3. **The dev toolchain has drifted.** A dozen dev deps are behind (one major:
   `fallow` 2→3; `@types/node` 24→26 is types-only), unrelated to the SDK and safe to
   sweep independently for a green baseline before the risky change.

The upside specific to fascicle: the two ugliest v7 breakers **do not apply**. The
package is already `"type": "module"`, ESM-only build (`tsdown format: ['esm']`,
NodeNext / ES2024), and pinned to Node `>=24` (CI on node 24). v7 requires Node 22+ and
ESM-only; both are already satisfied. The real migration surface is three files, most of
it codemod-automated (see §3), because fascicle already owns the loop, pins every SDK
call to a single step, reads usage via forward-compatible `Reflect.get` probes, and uses
the function-form UI-stream helpers. This upgrade is a validation of the sovereignty
thesis as much as a maintenance task.

Non-goals: adopting the AI SDK agent layer (§9); the raw-HTTP native providers (that is
`provider-sovereignty-spec.md`); flipping any default; changing the public flow surface.

---

## §2 — Solution Overview

Five phases across two independent tracks plus one small feature and a set of spikes.

- **Track A — dependency sweep (Phase 1).** Non-SDK dev deps. Ships alone, first, as a
  green baseline. No source change.
- **Boundary ADR (Phase 2).** A short `research/explorations/` decision record (and a
  pointer from `docs/providers.md`) stating: fascicle rides the AI SDK as a
  provider/primitive layer and declines its agent layer. Anchors every "decline" in §9.
- **Track B — AI SDK v7 core (Phase 3).** Bump `ai` + all `@ai-sdk/*` peers to their
  v7 majors, run the v7 codemods, hand-review the three coupled files, adopt the richer
  usage breakdown, gate on `pnpm check:all` + a real provider smoke test.
- **`Tool.output_schema` (Phase 4).** The provider-neutral answer to "how is tool output
  handled": add an optional output schema validated **in `tool_loop.ts`**, not in the
  SDK. Independent of v7; benefits all eight providers uniformly.
- **Capability spikes (Phase 5).** Time-boxed evaluation of the three below-the-line v7
  primitives worth considering (reasoning control, structured-output repair, timeout
  budgets), each gated by "does this delete fascicle-owned code without adding coupling?"

### The organizing rule (from the sovereignty doctrine)

> Adopt v7 capabilities that live strictly *below* our turn seam (provider primitives).
> Decline v7 capabilities *at or above* it (orchestration). The litmus test from the
> background note — *can I call one turn below its loop?* — is what keeps `generateText`
> a legitimate depth-1 backend while `ToolLoopAgent` is refused.

---

## §3 — Current State (verified, with anchors)

### Versions

| Package | Pinned (`package.json`) | Resolved | v7-line target |
|---|---|---|---|
| `ai` | `^6.0.0` | `6.0.168` | `^7.0.0` (`7.0.18`) |
| `@ai-sdk/anthropic` | `^3.0.0` | `3.0.71` | `^4.0.0` (`4.0.10`) |
| `@ai-sdk/openai` | `^3.0.0` | `3.0.53` | `^4.0.0` (`4.0.9`) |
| `@ai-sdk/google` | `^3.0.0` | `3.0.64` | `^4.0.0` (`4.0.10`) |
| `@ai-sdk/amazon-bedrock` | `^3.0.0` | `3.0.102` | `^5.0.0` (`5.0.14`) |
| `@ai-sdk/openai-compatible` | `^2.0.0` | `2.0.41` | `^3.0.0` (`3.0.6`) |
| `@openrouter/ai-sdk-provider` | `^2.0.0` | `2.8.0` | `^3.0.0` (`3.0.0`) |
| `ai-sdk-ollama` | `^3.0.0` | `3.8.3` | `^4.0.0` (`4.0.0`) |

Dev deps behind (from `pnpm outdated`): `vitest` / `@vitest/coverage-v8` 4.1.4→4.1.10,
`oxlint` 1.60→1.73, `oxlint-tsgolint` 0.21.1→0.24, `tsx` 4.21→4.23, `tsdown` 0.21.9→0.22.3,
`zod` 4.3.6→4.4.3, `cspell` 10.0.0→10.0.1, `markdownlint-cli2` 0.22→0.23,
`@ast-grep/cli` 0.42.1→0.44.1, `@arethetypeswrong/cli` 0.18.2→0.18.4, **`@types/node`
24.12.2→26.1.0 (major, types-only)**, **`fallow` 2.40.3→3.2.0 (major, dev tool)**.
`typescript` 6.0.3 and `@modelcontextprotocol/sdk` 1.29.0 are current.

### Runtime readiness (v7's big breakers already satisfied)

- `package.json` → `"type": "module"`, `"engines": { "node": ">=24.0.0" }`.
- `.github/workflows/ci.yaml` → node 24. `tsconfig` → `module: NodeNext`, `target: ES2024`.
- `tsdown.config.ts` → `format: ['esm']`. **⇒ Node 22+ and ESM-only reqs are non-issues.**

### The three `ai`-coupled source touchpoints (confirmed anchors)

- `src/engine/generate.ts:14` imports `stepCountIs`; `:671` `stopWhen: stepCountIs(1)`
  → v7 rename `isStepCount`. (codemod `rename-step-count-is`)
- `src/engine/generate.ts:648` `Output.object({ schema })`; `:685` assigns
  `base_params.experimental_output`; `:408` comment documents the eager-parse behavior
  → v7 `output` / `result.output`. (codemod `replace-experimental-output-with-output`)
- `src/engine/generate.ts:335` iterates `stream_result.fullStream`
  → v7 `result.stream`. (codemod `rename-full-stream-to-stream`)
- `src/engine/generate.ts:255,664` `split_leading_system` hoists a top-level `system`
  passed to the SDK params → v7 `instructions`. (codemod `rename-system-to-instructions`)
- **Usage — mostly forward-compatible already.** `generate.ts:134-144` already probes
  `inputTokenDetails` / `outputTokenDetails` / nested `reasoningTokens` via `Reflect.get`
  (the v7 nested shape). Per-provider `normalize_usage` in
  `src/engine/providers/{anthropic,openai,google,bedrock,openrouter,ollama,lmstudio}.ts`
  must be checked for any *removed* top-level v6 fields (`cachedInputTokens`,
  `reasoningTokens`, `cacheCreationInputTokens`). (codemods `replace-cached-input-tokens`,
  `replace-reasoning-tokens`, `replace-anthropic-cache-creation-input-tokens`)
- **UI — already function-form.** `src/ui/to_ui_message_stream.ts:17-21` uses
  `createUIMessageStream`, `createUIMessageStreamResponse`, `pipeUIMessageStreamToResponse`,
  `type UIMessageChunk` (the v7 stateless functions; the deprecated *method* forms are
  not used). Only `map_chunk` (`:88`) needs review for changed `UIMessageChunk` part
  shapes and the new `reasoning-file` part.
- `src/engine/generate.ts:675` `maxRetries: 0` and `abortSignal` are unchanged by v7.
- `to_sdk_tools` (`generate.ts:258`) passes only `description` + `inputSchema` to the SDK
  `tool()` helper (no `execute`). ⇒ the v6→v7 `needsApproval`→`toolApproval` move and the
  tool-context reshuffle are **non-issues** for fascicle.

### The Tool contract (for Phase 4)

- `src/engine/types.ts:125-139` — `Tool<i,o>` = `{ name, description, input_schema (zod),
  execute, needs_approval?, ends_turn? }`. **No output schema; `o` is typed but never
  validated.**
- `src/engine/tool_loop.ts:250-263` — `build_tool_result_message` serializes `execute`'s
  return into the `role:'tool'` message. This is the single provider-neutral chokepoint
  where an output schema would validate, on every provider.

---

## §4 — Design

### §4.1 Boundary posture (Phase 2)

A `research/explorations/` decision record (`status: accepted`) stating the rule in §2
and enumerating the declined v7 surface (§9), plus a one-paragraph pointer in
`docs/providers.md`. No code. Its purpose is to make the "decline" in every later phase a
cited decision rather than an omission, and to stop a future contributor from adopting
`ToolLoopAgent`/`WorkflowAgent` and inverting the architecture.

### §4.2 v7 core migration (Phase 3)

Order of operations inside the phase:

1. Bump every `ai` + `@ai-sdk/*` peer range (and `peerDependenciesMeta` unchanged) to the
   §3 targets; `pnpm install`.
2. Run the bulk codemod `npx @ai-sdk/codemod v7` over `src/`, then reconcile: the renames
   at `generate.ts:{14,671}` (`isStepCount`), `{648,685}` (`output`), `335` (`stream`),
   and the `system`→`instructions` hoist. Codemods are a starting point; each is
   hand-verified against the anchor.
3. Adopt the richer usage breakdown: keep the `Reflect.get` probes (already v7-shaped),
   and confirm each provider `normalize_usage` maps to fascicle's internal fields
   (`cached_input_tokens`, `cache_write_tokens`, `reasoning_tokens`) from the new nested
   locations. This is a required field-move that also *gains* cache-read / reasoning
   granularity for cost math.
4. Review `to_ui_message_stream.ts:map_chunk` against v7 `UIMessageChunk` part shapes;
   handle the new `reasoning-file` part in the switch (currently unhandled).
5. Review `tool_loop.ts` message construction for the v7 content-part changes
   (`{type:'image'}`→`{type:'file', mediaType}`, `media`→`file-data`) — only if fascicle
   constructs those parts (tool-result images); text/tool_use paths are unaffected.

Invariant #13 (only `generate.ts`/`tool_loop.ts`/`index.ts` may call
`generateText`/`streamText`) is **unchanged** by this spec; the call sites move only in
the sovereignty spec's §4.4b.

### §4.3 `Tool.output_schema` (Phase 4) — the provider-neutral output answer

Add an optional field to `Tool` and validate it in the loop, **not** via the SDK's
`outputSchema`/`toModelOutput` (which never runs, because `execute` is never handed to the
SDK):

```typescript
export type Tool<i = unknown, o = unknown> = {
  // ...existing fields...
  /**
   * Optional schema validated against execute()'s return, in the tool loop, before
   * the result is serialized into the tool message. Provider-neutral: applies
   * identically to ai_sdk, native, and external providers. Undefined ⇒ no validation
   * (current behavior). A failure is a tool error subject to the existing error policy.
   */
  output_schema?: z.ZodType<o>
}
```

Validation lands in `tool_loop.ts` immediately before `build_tool_result_message`
(`:250`). On failure it routes through the *existing* tool-error policy (feed-back vs
throw), so no new control path. This is the correct home precisely because output has
always been fascicle-owned; it is not an SDK adoption.

### §4.4 Capability spikes (Phase 5)

Each spike is a throwaway branch that answers one question and is kept only if it deletes
fascicle-owned code without adding coupling. See the triage table in §9 / the background
note for the full ride/evaluate/decline rationale.

---

## §5 — Phased Implementation Plan

### Phase 1 — Dependency sweep (Track A, no source change)

| ID | Task | Files | Acceptance | Deps |
|----|------|-------|------------|------|
| P1.1 | Bump all minor dev deps (`vitest`, `@vitest/coverage-v8`, `oxlint`, `oxlint-tsgolint`, `tsx`, `tsdown`, `zod`, `cspell`, `markdownlint-cli2`, `@ast-grep/cli`, `@arethetypeswrong/cli`) to §3 targets | `package.json`, lockfile | `pnpm check:all` exits 0 | — |
| P1.2 | Bump `@types/node` 24→26 (types-only; runtime already node 24) | `package.json`, lockfile | Typecheck green; no new `tsc` errors | P1.1 |
| P1.3 | Bump `fallow` 2.40→3.2; skim its changelog for rule/config breaks; reconcile `fallow.toml` if needed | `package.json`, `fallow.toml`? | `mcp__fallow__analyze` / `check:all` fallow step green | P1.1 |
| P1.4 | Bump `zod` dev pin 4.3.6→4.4.3 in lockstep with the peer range (`^4.0.0` already covers it) | `package.json` | Suite green; zod-dependent schema tests pass | P1.1 |

### Phase 2 — Boundary posture ADR

| ID | Task | Files | Acceptance | Deps |
|----|------|-------|------------|------|
| P2.1 | Write the decision record: fascicle rides the AI SDK as a provider/primitive layer, declines its agent layer; enumerate the declined v7 surface (§9) | `research/explorations/2026-07-ai-sdk-agent-layer-boundary.md` (`status: accepted`) | Cites the litmus test; lists each declined API with a one-line reason | — |
| P2.2 | Pointer paragraph + link from living docs | `docs/providers.md` | Renders; links resolve | P2.1 |

### Phase 3 — AI SDK v6 → v7 core (Track B, dedicated branch)

| ID | Task | Files | Acceptance | Deps |
|----|------|-------|------------|------|
| P3.1 | Bump `ai`→`^7.0.0` and every `@ai-sdk/*` peer to §3 targets; `pnpm install`; confirm `peerDependenciesMeta` optional set unchanged | `package.json`, lockfile | Installs clean; no peer-range warnings | — |
| P3.2 | Run `npx @ai-sdk/codemod v7` over `src/`; commit the mechanical diff separately for reviewability | `src/**` | Codemod completes; diff is renames only | P3.1 |
| P3.3 | Reconcile `generate.ts`: `stepCountIs`→`isStepCount` (`:14,671`); `experimental_output`→`output` (`:648,685`); `fullStream`→`stream` (`:335`); `system`→`instructions` hoist (`:255,664`) | `src/engine/generate.ts` | `tsc --noEmit` clean; single-step pin + retry behavior identical | P3.2 |
| P3.4 | Verify + adjust per-provider `normalize_usage` for the v7 nested usage shape; keep the `generate.ts:134-144` `Reflect.get` probes; wire cache-read / reasoning granularity into cost math | `src/engine/providers/{anthropic,openai,google,bedrock,openrouter,ollama,lmstudio}.ts`, `src/engine/generate.ts` | Usage/cost tests green; cached + reasoning tokens populate from nested details | P3.3 |
| P3.5 | Review `to_ui_message_stream.ts:map_chunk` vs v7 `UIMessageChunk`; handle new `reasoning-file` part; confirm function-form helpers unchanged | `src/ui/to_ui_message_stream.ts` | UI-stream mapping tests green; unknown-part path covered | P3.3 |
| P3.6 | Review `tool_loop.ts` content-part construction for `image`→`file` / `media`→`file-data`; adjust only if tool-result images are built | `src/engine/tool_loop.ts` | Message-shape tests green; no change if not applicable | P3.3 |
| P3.7 | Full gate: `pnpm check:all` (incl. mutation) exits 0 | — | Exit 0; mutation score not regressed on touched files | P3.4, P3.5, P3.6 |
| P3.8 | Real-provider smoke test: run a tool-loop flow against Anthropic **and** one OpenAI-compatible backend (text, tool call, streaming) via `/verify` or an example app | `examples/**`, manual | Both produce correct streamed + non-streamed results; usage/cost recorded | P3.7 |
| P3.9 | Docs: note v7 in `docs/providers.md` / `CHANGELOG.md`; bump the version | `docs/**`, `CHANGELOG.md`, `package.json` | Docs build; changelog entry present | P3.8 |

### Phase 4 — `Tool.output_schema` (provider-neutral, independent of v7)

| ID | Task | Files | Acceptance | Deps |
|----|------|-------|------------|------|
| P4.1 | Add optional `output_schema?: z.ZodType<o>` to `Tool` | `src/engine/types.ts` | Type compiles; `execute` return type still `o`; docblock explains loop-side validation | — |
| P4.2 | Validate `output_schema` in `tool_loop.ts` immediately before `build_tool_result_message`; route failures through the existing tool-error policy | `src/engine/tool_loop.ts` | Valid output passes through unchanged; invalid output becomes a policy-governed tool error (feed-back or throw) | P4.1 |
| P4.3 | Tests: valid output, invalid output under both error policies, `output_schema` undefined = current behavior; prove it fires identically for an `ai_sdk` and a non-SDK (`claude_cli`) provider | `src/engine/__tests__/*` | New tests pass; mutation survives | P4.2 |
| P4.4 | Docs: `output_schema` in the tool-authoring section | `docs/**` | Docs build; example type-checks | P4.2 |

### Phase 5 — Capability evaluation spikes (each keep-or-discard)

| ID | Task | Files | Acceptance | Deps |
|----|------|-------|------------|------|
| P5.1 | Spike: provider-agnostic `reasoning` control. Keep **only if** it lets us delete per-provider reasoning/effort branching without hiding provider capability | throwaway branch | Written verdict (keep+diff, or discard+why) appended to the background note | P3.7 |
| P5.2 | Spike: v7 structured-output repair vs our schema-repair loop (`generate.ts` outer repair). Keep **only if** it lets us thin our own repair without losing the plain-prose salvage case | throwaway branch | Verdict + measurement (does SDK repair cover our failure modes?) | P3.7 |
| P5.3 | Spike: first-class `timeout` budgets vs implementing per-tool/per-step budgets in `tool_loop.ts`. Default recommendation: implement our own (sovereign); confirm or overturn | throwaway branch | Verdict; if own-impl, a follow-up task stub | P3.7 |

---

## §6 — Cross-Cutting Concerns

### §6.1 Sequencing
Phase 1 ships first and alone (green baseline). Phase 2 is cheap and gates the §9
declines. Phase 3 is the risky core and wants its own branch + smoke test. Phases 4 and 5
are independent of v7 and can follow or interleave. This spec is independent of
`provider-sovereignty-spec.md`; doing v7 (Phase 3) first gives that work a clean baseline.

### §6.2 Boundary rules & invariants
- Invariant #13 (`generateText`/`streamText` call sites) is **unchanged** here.
- No new `rules/` entries required; the `no-engine-npm-dep-except-ai-zod` rule still holds
  (we add no runtime deps — `@ai-sdk/workflow` / `@ai-sdk/otel` are **not** taken; §9).

### §6.3 Tests, coverage, mutation
- `pnpm check:all` (incl. Stryker) is the gate at the end of Phases 1, 3, and 4.
- `normalize_usage` and `map_chunk` are logic-dense and prime mutation targets; assert on
  concrete token/part values, not smoke.
- Types alone will not catch wire-shape drift across a major — P3.8's live smoke test is a
  hard requirement, not optional.

### §6.4 Docs (update on completion, per `docs/` freshness rule)
- `docs/providers.md`: v7 note + the agent-layer boundary pointer (P2.2).
- Tool-authoring docs: `output_schema` (P4.4).
- `CHANGELOG.md` + version bump (P3.9).

---

## §7 — Risks & Tradeoffs

- **Major-version wire drift.** A `tsc`-clean build can still stream malformed parts under
  a v7 provider. Mitigated by P3.8 (live Anthropic + OpenAI-compatible smoke) as an
  explicit gate, not a nicety.
- **Usage/cost silent skew.** If a provider `normalize_usage` reads a removed top-level
  field, cost math silently under/over-counts rather than erroring. P3.4 asserts on
  concrete cached + reasoning token values from the nested shape.
- **Codemod over-reach.** The bulk codemod may touch test fixtures or comments referencing
  old names. P3.2 commits the mechanical diff separately so it is reviewable in isolation.
- **Provider majors move independently.** Bedrock is on `^5`, others on `^4`/`^3`; a peer
  that lags its v7 line can produce resolution conflicts. P3.1 pins exact targets from §3.
- **Boundary erosion.** The real long-term risk is not the upgrade but a later contributor
  adopting `ToolLoopAgent`. Phase 2 exists to make that a visibly-rejected decision.

---

## §8 — Definition of Done

1. All non-SDK dev deps current; `fallow` 3 and `@types/node` 26 in; `pnpm check:all`
   green. (Phase 1)
2. The agent-layer boundary is a written, cited decision record linked from `docs/`. (Phase 2)
3. `ai@^7` + all `@ai-sdk/*` v7 peers installed; the four `generate.ts` renames, the usage
   nested-shape mapping, and the `map_chunk` review complete; `pnpm check:all` exits 0; a
   live tool loop runs correctly (streamed + non-streamed) on Anthropic and one
   OpenAI-compatible backend with usage/cost recorded. (Phase 3)
4. `Tool.output_schema` validates in the loop, provider-neutral, proven on both an `ai_sdk`
   and a non-SDK provider, undefined = current behavior. (Phase 4)
5. Each Phase-5 spike has a written keep-or-discard verdict appended to the background note.
6. Zero new runtime dependencies; invariant #13 intact; the declined v7 agent surface (§9)
   remains unused.

---

## §9 — Out of Scope / Deferred (the declined v7 surface)

Declined by the boundary rule (at or above our seam — this is our layer):

- `ToolLoopAgent`, `WorkflowAgent` (`@ai-sdk/workflow`), `HarnessAgent` — the SDK's own
  loop / durability / external-runtime bridge. Study `WorkflowAgent`'s durability model
  for *ideas* toward our own `checkpoint`; do not depend on it.
- `toolApproval` + scoped tool context (`toolsContext` / `contextSchema`) — we own approval
  (`needs_approval`) and `ToolExecContext`.
- `@ai-sdk/otel` / `registerTelemetry` — keep trajectory sovereign; optionally *bridge*
  trajectory→OTel later, do not couple to it.
- `DirectChatTransport`, realtime WebSocket, video generation, MCP Apps — different
  interaction models / experimental; not engine concerns.

Deferred (evaluate, don't auto-adopt — Phase 5):

- Provider-agnostic `reasoning` control; v7 structured-output repair; first-class `timeout`
  budgets. Kept only if they delete fascicle-owned code without adding coupling.

Belongs to other specs:

- Raw-HTTP native providers, the open registry, the `subprocess`→`external` rename —
  `provider-sovereignty-spec.md`.
- `prepareStep` / `pruneMessages`-style native loop hooks — their own future spec.

---

## §10 — Open Questions

- **Adopt `generateSpeech` / `transcribe` (now stable) now, or on first audio need?**
  They are clean below-the-line provider primitives; recommend deferring until a flow
  actually needs audio, to avoid speculative surface.
- **Does the v7 structured-output repair subsume any of our schema-repair loop?** P5.2
  measures it; the plain-prose salvage case (no structured call at all) is almost certainly
  still ours regardless.
- **Flip the peer floor to `ai@^7` hard, or keep a compat window?** Given pre-1.0
  published-surface latitude, recommend a hard `^7` floor (no dual-major support burden).

# Phase 1: Engine Package Foundation

## Goal

Stand up the `@robmclarty/engine` workspace package and deliver every module that can be built and unit-tested in isolation from the public `generate` orchestrator. This is the non-I/O-orchestration backbone: the complete public type surface, every typed error class, the frozen default alias and pricing tables with their resolution and cost-computation algorithms, the support modules (retry, streaming, trajectory, usage, schema helpers), and all six provider adapters (Anthropic, OpenAI, Google, Ollama, LM Studio, OpenRouter) wrapping Vercel AI SDK v6 primitives.

This phase also installs the mechanically-enforced architectural guardrails that govern the package forever after: ast-grep rules banning value imports from `@robmclarty/core`, banning provider SDK imports outside `packages/engine/src/providers/`, extending the existing no-class / no-default-export / no-process-env / snake-case-exports rules to cover the new package, and extending `scripts/check-deps.mjs` to verify the dependency manifest.

By the end of this phase the package compiles under TypeScript strict mode, every architectural invariant passes under `pnpm check`, and colocated unit tests exercise every standalone module. The package does not yet expose a callable `generate` — that lands in phase 2, which composes the foundation delivered here.

## Context

The repository is a pnpm workspace that already ships `@robmclarty/core` (the composition layer) at `packages/core/`. This phase adds a sibling package at `packages/engine/`. Existing ast-grep rules under `rules/` enforce constraints on `packages/core/src/`; several of those rules need their scope extended to cover `packages/engine/src/`, and two new engine-specific rules must be added.

`@robmclarty/core` exposes shared types (`TrajectoryLogger`, `TrajectoryEvent`, `RunContext`) from `packages/core/src/types.ts`. The engine imports these via `import type { ... } from '@robmclarty/core'` only — no value imports. No composition-layer code is modified in this phase.

The engine wraps Vercel AI SDK v6 (`ai` package) and specifically its `generateText` / `streamText` primitives. The SDK's higher-level `Agent` / `ToolLoopAgent` abstractions are deliberately not used: the engine owns its own tool-call loop in phase 2. Provider SDKs (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `ai-sdk-ollama`, `@ai-sdk/openai-compatible`, `@openrouter/ai-sdk-provider`) are optional peer dependencies loaded via dynamic `import()` inside provider adapters.

## Acceptance Criteria

1. `packages/engine/package.json` exists, declares `name: "@robmclarty/engine"`, `type: "module"`, ESM exports pointing at a tsdown build output, a `build` script using `tsdown`, a `test` script using `vitest`, `ai` (^6) and `zod` (^4) as the only `dependencies`, and all six provider SDK packages (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `ai-sdk-ollama`, `@ai-sdk/openai-compatible`, `@openrouter/ai-sdk-provider`) in `peerDependencies` with each marked `optional: true` in `peerDependenciesMeta`.

2. The package is registered in the workspace `pnpm-workspace.yaml` (or equivalent workspace declaration). `packages/engine/tsconfig.json` extends the workspace base and sets `strict: true`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `verbatimModuleSyntax: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and ES2024 target.

3. `packages/engine/src/types.ts` exports every type enumerated in spec §5 with exact field names and optionality: `GenerateOptions`, `GenerateResult`, `Message`, `UserContentPart`, `AssistantContentPart`, `Tool`, `ToolExecContext`, `StreamChunk`, `ToolCallRecord`, `StepRecord`, `UsageTotals`, `CostBreakdown`, `FinishReason`, `EffortLevel`, `RetryPolicy`, `AliasTarget`, `AliasTable`, `Pricing`, `PricingTable`, `EngineConfig`, `ProviderConfigMap`, `ProviderInit`, `Engine`, `ToolApprovalHandler`, `ToolApprovalRequest`. Type and interface names are `PascalCase`; value field names are `snake_case`; optional fields use `exactOptionalPropertyTypes`-compatible `?:` syntax.

4. `packages/engine/src/errors.ts` declares each typed error as `class <name> extends Error` with the documented metadata fields from spec §5 and §9: `aborted_error` (`{ reason, step_index, tool_call_in_flight? }`), `rate_limit_error`, `provider_error`, `schema_validation_error` (carries zod error and raw text), `tool_error` (`{ tool_name, tool_call_id, cause }`), `tool_approval_denied_error` (`{ tool_name, step_index, tool_call_id }`), `model_not_found_error` (message lists registered aliases), `provider_not_configured_error`, `engine_config_error`, `on_chunk_error`, `provider_capability_error`. This file is the only one in the engine source permitted to use `class`.

5. `packages/engine/src/aliases.ts` exports a frozen `DEFAULT_ALIASES` (`Object.freeze`) matching spec §5.7 entry-for-entry, including the Anthropic, OpenAI, Google, and `or:*` OpenRouter entries. A `resolve_model(table, model)` function implements the algorithm: (a) if `model` contains a colon and the prefix is a known provider name, split on the **first colon only** and return `{ provider, model_id }` (so `openrouter:anthropic/claude-sonnet-4.5` round-trips with `model_id` equal to `anthropic/claude-sonnet-4.5`); (b) otherwise look up in the alias table; (c) otherwise throw `model_not_found_error` with a message listing available aliases.

6. `packages/engine/src/pricing.ts` exports a frozen `DEFAULT_PRICING` matching spec §5.10 exactly (Anthropic Opus 4.7 / 4.6 / Sonnet 4.6 / Haiku 4.5 with cache fields; OpenAI gpt-4o / gpt-4o-mini with cached_input; Google gemini-2.5-pro / flash; no entries for Ollama, LM Studio, OpenRouter), a frozen `FREE_PROVIDERS` set containing `ollama` and `lmstudio`, and a `compute_cost(usage, pricing)` function implementing the spec §5.10 formula: fresh-input subtracts cached and cache-write tokens, `cached_input_per_million` falls back to `input_per_million` when absent, `cache_write_per_million` falls back to `input_per_million`, `reasoning_per_million` falls back to `output_per_million` with reasoning rolled into `output_usd` when no separate rate is configured, components and total rounded to 6 decimal places, fields whose source usage was 0 across the whole call are omitted from `CostBreakdown` (not zeroed).

7. `packages/engine/src/retry.ts` exports `DEFAULT_RETRY` matching spec §6.8 and a `retry_with_policy(fn, policy, abort)` helper implementing jittered exponential backoff bounded by `max_delay_ms`, honoring both numeric-seconds and HTTP-date `Retry-After` forms for 429s, interrupting the backoff wait when `abort.aborted` fires (rejecting with `aborted_error`), and only retrying failures whose class appears in `policy.retry_on`. On exhaustion it throws `rate_limit_error` for 429s and `provider_error` for 5xx / network. The helper does not retry streaming responses once any chunk has been delivered (the helper exposes a boundary the phase-2 generate orchestrator sets before streaming starts).

8. `packages/engine/src/streaming.ts` exports chunk normalization helpers that map AI SDK v6 stream events into the discriminated `StreamChunk` union from spec §5.6 with correct `step_index` bookkeeping and the documented ordering guarantees (text and reasoning interleave within a step; `tool_call_start` precedes its deltas and end; `tool_result` follows the matching end; `step_finish` is the last chunk of a step; `finish` is the last chunk of the call). It exposes a dispatcher that invokes `on_chunk` synchronously per provider event (no internal buffering), catches synchronous throws and rejected promises from `on_chunk`, and signals the caller to abort the in-flight request and surface `on_chunk_error` (actual request abort is wired in phase 2).

9. `packages/engine/src/trajectory.ts` exports span and record helpers that no-op cleanly when `trajectory` is `undefined` and otherwise emit the exact event kinds documented in spec §5.3 and §6.2: the parent span `engine.generate` with start attributes `{ model, provider, model_id, has_tools, has_schema, streaming }`, per-step child spans `engine.generate.step` keyed by index, and records of kind `request_sent`, `response_received`, `tool_call`, `cost`, `pricing_missing` (caller-side deduplication helper for once-per-generate emission), `effort_ignored`, `tool_approval_requested`, `tool_approval_granted`, `tool_approval_denied`. Spans close with `{ usage, finish_reason }` on success and `{ error }` on rejection.

10. `packages/engine/src/usage.ts` exports a `sum_usage(steps)` helper that sums `UsageTotals` fields across step records, treating absent fields as 0 for arithmetic, but leaving a field `undefined` on the aggregated total if no step reported it at all (rather than zeroing). `packages/engine/src/schema.ts` exports a parse-with-zod helper and a repair-prompt-construction helper using the exact repair message from spec §6.5; the repair-loop iteration itself is owned by the phase-2 tool loop / generate orchestrator.

11. `packages/engine/src/providers/registry.ts` exposes a lookup from provider name to adapter factory covering `anthropic`, `openai`, `google`, `ollama`, `lmstudio`, `openrouter`. Unknown provider names throw `provider_not_configured_error`.

12. Each file under `packages/engine/src/providers/` (`anthropic.ts`, `openai.ts`, `google.ts`, `ollama.ts`, `lmstudio.ts`, `openrouter.ts`) exports an adapter factory that: dynamically `import()`s its underlying SDK package and surfaces a clear message naming the missing peer when the import fails; accepts the credentials and base URL shape documented in spec §5.8 for its provider; exposes a uniform internal interface for non-streaming generation, streaming generation, and effort translation (non-reasoning providers signal that `effort` was ignored so the orchestrator can record `effort_ignored`); normalizes provider-specific usage shapes into `UsageTotals` (Anthropic cache reads + writes, OpenAI cached_input, Google without cache); surfaces `provider_capability_error` when asked to use an unsupported feature (e.g. image input on a text-only model). Adapters are thin: tool-call loop orchestration, schema repair iteration, and retry live outside the adapter.

13. Effort mapping (`'none'` / `'low'` / `'medium'` / `'high'`) is implemented in the appropriate provider adapters per spec §6.3: Anthropic thinking-budget tokens (0 / 1024 / 5000 / 20000), OpenAI `reasoning_effort` string (omitted / `low` / `medium` / `high`), Google `thinking_budget` (low / medium / high). Providers without reasoning support accept and drop the field, signaling that it was ignored.

14. Imports of `@ai-sdk/*`, `ai-sdk-ollama`, `@ai-sdk/openai-compatible`, and `@openrouter/ai-sdk-provider` appear only in files under `packages/engine/src/providers/`. No value import from `@robmclarty/core` appears anywhere in `packages/engine/src/`; `import type { ... } from '@robmclarty/core'` is used wherever shared types are referenced. No file in `packages/engine/src/` reads `process.env`.

15. Frozen defaults: a unit test verifies that mutating a property on `DEFAULT_ALIASES` or `DEFAULT_PRICING` throws in strict mode (Node runs ES modules in strict mode natively).

16. Colocated unit tests exist and pass:
    - `aliases.test.ts` — default alias resolution; colon-bypass with `openrouter:anthropic/claude-sonnet-4.5` proving split-on-first-colon; unknown alias throws `model_not_found_error` whose message lists registered aliases.
    - `pricing.test.ts` — `DEFAULT_PRICING` entry correctness; full-usage cost computation; cache-hit math (Anthropic Sonnet 1500 input / 1000 cached / 200 output); partial-usage path omitting cache fields from `CostBreakdown`; free-provider zero breakdown via `FREE_PROVIDERS`; missing pricing for a non-free provider returns `undefined`; 6-decimal rounding; reasoning fallback to output rate.
    - `retry.test.ts` — 429 with numeric `Retry-After` waits ≥ specified seconds; 429 with HTTP-date `Retry-After`; 5xx exponential backoff with jitter bounded by `max_delay_ms`; abort-during-wait rejects with `aborted_error` without further attempts; unlisted failure classes are not retried.
    - `usage.test.ts` — absent-stays-absent aggregation; present-somewhere fields sum correctly treating absent as 0.
    - `streaming.test.ts` — chunk normalization preserves ordering invariants; `on_chunk` sync throw and rejected-promise paths both signal abort to the caller.
    - `trajectory.test.ts` — no-op behavior when `trajectory` is undefined; correct event kinds emitted when supplied.
    - `errors.test.ts` — each typed error carries its documented metadata; `instanceof Error` holds.
    - `providers/<provider>.test.ts` for each provider — dynamic-import missing-peer error path; usage normalization from representative mocked provider responses; effort translation per §6.3.

17. Architectural rules in place and green under `pnpm check`:
    - `rules/no-class.yml` scope now includes a permitted-exceptions list covering `packages/core/src/errors.ts` and `packages/engine/src/errors.ts`.
    - `rules/no-default-export.yml`, `rules/no-process-env-in-core.yml`, and `rules/snake-case-exports.yml` scopes extended to `packages/engine/src/**`.
    - A new `rules/no-core-value-import-in-engine.yml` forbids value imports from `@robmclarty/core` in `packages/engine/src/**` while permitting `import type`.
    - A new `rules/no-provider-sdk-outside-providers.yml` forbids `@ai-sdk/*`, `ai-sdk-ollama`, `@ai-sdk/openai-compatible`, and `@openrouter/ai-sdk-provider` imports outside `packages/engine/src/providers/**`.
    - `scripts/check-deps.mjs` is extended to assert `@robmclarty/engine`'s `package.json` declares exactly `ai` and `zod` as production `dependencies` and that all six provider SDK packages are declared as optional `peerDependencies`.

18. Running `pnpm check` from the repository root exits zero with this phase's files in place: oxlint (+ oxlint-tsgolint), fallow, `tsc --noEmit`, vitest (for tests delivered in this phase), every ast-grep rule above, cspell, markdownlint, and the dependency audit all pass.

## Spec Reference

- **spec.md §2** — layer boundary; engine depends downward on Vercel AI SDK and never imports from core at runtime.
- **spec.md §5 (all subsections)** — complete public type surface, typed errors, alias table shape and defaults, engine factory signature, pricing table shape and defaults.
- **spec.md §6.2** — trajectory event structure (`engine.generate` parent span, `engine.generate.step` children, documented record kinds).
- **spec.md §6.3** — effort mapping table per provider family.
- **spec.md §6.8** — retry policy defaults, `Retry-After` honoring, exponential backoff, abort-interruption, non-retry classes.
- **spec.md §5.10 + §6.9** — cost computation formula, free providers, missing-pricing semantics, field omission for absent usage.
- **spec.md §9** — failure modes F1 (alias not found), F2 (credentials missing), F3–F5 (retry / network), F16 (pricing missing), F17 (partial usage) are shape-level and are covered by unit tests in this phase for the helpers that implement them.
- **spec.md §11** — file structure; this phase creates every file listed except the orchestration-owning `generate.ts`, `tool_loop.ts`, `create_engine.ts`, and `index.ts` (those land in phase 2).
- **spec.md §12** — configuration source; the engine reads no env vars, all config flows through `create_engine(config)`.
- **constraints.md §1–§4** — language, code style, architectural boundaries, runtime dependencies.
- **constraints.md §7 invariants 1, 2, 3, 4, 10, 11, 12, 15** — every mechanically-checked rule in scope for this phase.
- **constraints.md §8** — packaging and distribution targets.
- **constraints.md §9** — testing requirements, colocation, mocking at the AI SDK boundary, fixture pricing.

# Build report — Harden anthropic_native.ts mutation coverage

**Status:** Done (5/5 steps). `pnpm check:all` (incl. mutation) exits 0.

## What shipped

`anthropic_native.ts`, the native-transport exemplar and the tree's single biggest
mutation gap, went from **73.9% → 98.22%** killed (664/676, **zero no-coverage**),
clearing the ~96.5% sibling bar set by `openai_compatible_native` / `ollama_native`.
The full-repo aggregate rose **~85.2% → 86.84%**, and the mutation break gate ratcheted
**82 → 83**.

The work ran region by region against the colocated `__tests__/` suites, then closed at
a gate (the `## Log` timeline carries the per-step SHAs and durations):

- **Step 1 — request + message mapping (51-229):** 53 bad (33 surv + 20 nocov) → 0; 169
  killed, 100%. `ANTHROPIC_THINKING_BUDGETS` exact values, empty-trim / image-capability
  branches, role-merge + mid-conversation-system throw, and the whole `build_messages_body`
  wire body at both boundaries.
- **Step 2 — response + usage/stop maps (231-314):** 14 survivors → 0; 100% (2 pre-annotated).
  Every `map_anthropic_stop_reason` arm, the cache-inclusive usage math with `toStrictEqual`
  on present-only-when-defined keys (D6), and the malformed-block throw.
- **Step 3 — streaming aggregator (315-530):** 74 bad → 12 survivors, 0 nocov, 95.4%. The
  full SSE event state machine, with the streamed `TurnResult` proven equal to the
  non-streamed one by construction.
- **Step 4 — error-classify + SSE-drain + adapter (532-703):** 41 bad (29 surv + 12 nocov)
  → 0; 129 killed + 2 timeout, 100% (10 annotated). Error classification, the drain
  lifecycle (null-body, network-catch, cancel, tail flush, abort-vs-network), and the
  adapter's headers/path/stream-vs-json wiring.
- **Step 5 — final gate + ratchet:** full-repo `check:all` green at break=83; the
  before/after per-region table and equivalents list recorded in the build log.

Tests-only across the build (C2): no public surface moved, and the only source latitude
taken was the inline equivalence annotations and one trivially-correct dead-branch
simplification.

## Decisions and why

- **D2 — kill with concrete-value assertions; annotate true equivalents inline**
  (`// Stryker disable next-line <mutator>: <reason>`), not config excludes or blanket
  disables. The build ended with **13 annotated equivalents**: `:233` passthrough merge
  (×2), `:368` content-accumulator seed, and `:548`/`:553` `extract_error_message`
  object-guards (×5 each — the try/catch funnels every non-object parse to the same raw
  snippet).
- **D4 — "done" per region = zero no-coverage + every residual survivor killed or annotated**,
  target ≥90%. Every region met it; three hit 100%.
- **D5 — ratchet `break` upward only, preserving the established ~3pt cushion.** 86.84%
  aggregate → break **83** leaves 3.84pt of headroom (≥ the cushion that absorbs the 91
  timing-sensitive Timeout mutants). Held to 83, not 84 (which would leave 2.84pt). `low`
  bumped 82→83 alongside to keep `break ≤ low ≤ high`; `high` unchanged at 85.
- **D6 — `toStrictEqual` for present-only-when-defined keys**, because vitest `toEqual`
  ignores `key: undefined` and would leave the optional-key mutants alive.

The one call worth flagging: the **12 residual survivors in the R3 aggregator are left
un-annotated on purpose.** They are a Stryker 9.6.1 / vitest 4.1.10 blind spot —
whole-condition `ConditionalExpression` guard mutants that the new async tests provably
kill (verified four ways at step 3) but the runner reports Survived. A per-line disable
would also suppress the *killed* sub-expression mutants on those lines, shrinking the
denominator and losing real signal — worse than the phantom survivor. Two (L485, L524)
are genuine equivalents. This is logged to the mutation-landscape memory so it is not
re-chased.

## Parked & harvested

Nothing parked (0). No tangents surfaced mid-build — each region was a clean contiguous
slice, exactly as the plan's region split anticipated.

## Open questions — both resolved

- **Q1** (step 3): hand-authored SSE fixtures per case were enough; no shared
  property-style helper needed (matched the e2e suite's existing pattern).
- **Q2** (step 5): the aggregate lift **does** clear 82→83 with the cushion intact —
  resolved in favor of the ratchet (see D5).

## Deferred tangents (future work)

Out of scope by design, now the biggest remaining mutation gaps in the tree:

- The shared-giant **loop-knob survivors**: `turn_timeout_ms` in `generate.ts` (plus its
  ~122-survivor orchestration body) and `prepare_step` in `tool_loop.ts` — the
  predecessor's Q1, its own build.
- `define_agent.ts` (~64%).
- A viewer **exclude-vs-test decision** for `viewer/tail.ts` (61.8%) and `viewer/server.ts`.
- The `ai_sdk` Anthropic adapter (`providers/ai_sdk/anthropic.ts`) — different transport,
  different surface.

## Checkpoints

- baseline 910aa4aa588a40706056ff9623ddedca1842dc40
- plan 8695fe88286815608c25c73bb35950092c883c97
- step 1 63e1680594242f94612a0ccf8a82aa0d31ab2017
- step 2 84ef0d486fd122ebd2008610d7ee8c73ef89ef24
- step 3 da27020a11e166edbff7a28145aa285253c95a38
- step 4 8d0131a411bda76a259c8844d7e05efbf69677cb
- step 5 741b1ccbf300ec287e6b5df4163b11f6a1e193ca

## Stats

| step | red checks | drift warnings | reverts | wall-clock |
|------|------------|----------------|---------|------------|
| 1 | 0 | 0 | 0 | 26m |
| 2 | 0 | 0 | 0 | 16m |
| 3 | 0 | 0 | 0 | 75m |
| 4 | 0 | 0 | 0 | 22m |
| 5 | 0 | 0 | 0 | 12m |
| **total** | 0 | 0 | 0 | 151m |

# Harden generate.ts + tool_loop.ts mutation coverage

**Phase:** frame
**Size:** medium (six steps: five region-hardening + a gate)

The direct follow-up to "Harden anthropic_native.ts mutation coverage" (5/5,
2026-07-11), whose deferred tangent named these two files, and to the native-provider
build before it, whose **Q1** first carved out the "loop-knob survivors." With the
native transport family now at 96-98%, `generate.ts` (77.6%) and `tool_loop.ts`
(83.7%) are the two biggest remaining single-file mutation gaps in the tree — the
shared orchestration giants every provider path funnels through. Same C7 assertion
debt, same D2 playbook that just took five sibling files to 93-100%.

## Frame

- **Problem:** `generate.ts` and `tool_loop.ts` are the shared orchestration core, and
  they carry the tree's largest remaining surviving-mutant cluster now that the
  provider adapters are hardened. From the fresh full-repo `.check/mutation.json`
  (2026-07-11, the gate the anthropic_native build left green at 86.84%):
  - `generate.ts`: 452 killed + 2 timeout of 585 = **77.6%**, **109 survived + 22
    no-coverage**. Survivor mix: ConditionalExpression 56, StringLiteral 21,
    EqualityOperator 17, BlockStatement 13, ObjectLiteral 13, LogicalOperator 4,
    OptionalChaining 2, ArrowFunction 2, BooleanLiteral 2, AssignmentOperator 1.
  - `tool_loop.ts`: 348 killed + 1 timeout of 417 = **83.7%**, **56 survived + 12
    no-coverage**. Survivor mix: StringLiteral 20, ObjectLiteral 18,
    ConditionalExpression 18, LogicalOperator 4, BlockStatement 3, EqualityOperator 2,
    others 3.

  The named "loop-knobs" (`turn_timeout_ms` in `generate.ts`, `prepare_step` in
  `tool_loop.ts`) are specific survivors inside a much broader residual — the
  timeout/retry machinery, the `generate()` streaming/HITL/schema-repair body, and the
  `run_tool_loop` dispatch/approval/abort loop. Unlike the wire adapters, these are
  orchestration internals: expect a higher share of genuine equivalents (Date.now()
  duration object-literals, promise-internal branches, AbortSignal listener hygiene)
  per the mutation-landscape ledger.
- **Smallest thing that solves it:** Add C7-style concrete-value assertions to the
  colocated `__tests__/`, region by region, reusing the existing harnesses (the
  scripted mock-engine that captures invoke opts; `tool_loop`'s `base_config` harness;
  the exported-pure-helper unit tests), killing every killable survivor and eliminating
  no-coverage; annotate genuine equivalents inline. No source behavior change beyond a
  trivially-correct dead-branch deletion. This is the D2 playbook, five files deep.
- **Done looks like:** Each region reaches zero no-coverage and every residual survivor
  is either killed or carries an inline equivalence rationale (target ≥90% killed per
  file, allowing a higher annotated-equivalent count than the wire adapters);
  `pnpm check:all` (incl. mutation) exits 0; a before/after per-region table and the
  equivalents list land in the build log; `thresholds.break` is ratcheted up if the new
  aggregate gives headroom (never down, D5).
- **Explicitly NOT doing:**
  - The other remaining gaps: `define_agent.ts` (~64%), the viewer exclude-vs-test
    decision (`viewer/tail.ts` 61.8%, `viewer/server.ts`), the `ai_sdk` Anthropic
    adapter — each its own future build.
  - Gaming the metric: no blanket `Stryker disable`, no lowering `thresholds.break`, no
    loosening the `mutate` globs.
  - Refactoring source to be mutation-friendly, beyond a trivially-correct
    simplification that deletes a genuinely-equivalent (dead/defensive) branch.
  - Changing orchestration behavior, public surface, or the retry/HITL/schema-repair
    semantics — tests only.

## Architecture sketch

Not architecture — the baseline and the region split the survivors imply. Two files,
each an orchestration core with a helper belt around a giant body; the survivors
cluster by function group, so each step is a contiguous slice reviewable in one pass.

```text
File / region (lines)                                funcs                          surv nocov step
generate.ts
  helpers + timeout/retry machinery (96-420)         split_leading_system_messages,  ~24   0   1
                                                      classify_provider_error,
                                                      arm_turn_timeout (turn_timeout_ms
                                                      knob), retry_turn,
                                                      build_ai_sdk_invoke,
                                                      build_native_invoke
  generate() body A: invoke + stream (422-549)        generate() dispatch, streaming, ~31  ~7   2
                                                      per-chunk aggregation
  generate() body B: HITL + schema-repair +           generate() approval loop,       ~28  ~12  3
    cost + finish (550-726)                           schema-repair retry, cost
                                                      aggregate_cost/round6, finish map
tool_loop.ts
  helpers + apply_prepare_step (149-352)              throw_if_aborted*, serialize_    ~13  ~4   4
                                                      error, request_approval,
                                                      build_*_message, safe_json,
                                                      compute_and_record_cost,
                                                      validate_tool_input,
                                                      apply_prepare_step (knob)
  run_tool_loop body (354-851)                        the loop: dispatch, approval    ~43  ~8   5
                                                      flow, cost, results, abort

Survivor shape → assertion strategy (same as the five prior builds):
  ConditionalExpression / EqualityOperator / LogicalOperator → assert BOTH boundaries
     (turn_timeout_ms <=0 / undefined / expiry; retry pre-chunk vs mid-chunk; approval
      grant/deny; schema-repair attempt-count; abort-in-flight; cost thresholds)
  StringLiteral → assert EXACT wire/error strings
     (error messages, finish reasons, tool-result role/type, config-error text)
  ObjectLiteral / BlockStatement → assert the emitted shape / that the block runs
     (StreamChunk/step objects, tool_result messages, cost records)
  NoCoverage → execute the untested path
     (the L550-599 generate() cluster and the L700-749 run_tool_loop cluster)
```

Per-region inner loop: `pnpm exec stryker run --mutate 'src/engine/generate.ts'` (or
`tool_loop.ts`) — incremental keeps it fast — then re-parse `.check/mutation.json` for
the region's killed/survived/no-coverage. `pnpm check` (excludes mutation) for
test-authoring iterations; `pnpm check:all` once at the end (C1). Process notes from
the ledger: a failing test aborts Stryker's dry run so a scoped score reads STALE —
confirm `vitest` is green before trusting a number; the `--mutate` CLI override
re-mutates test files, so ignore `__tests__` rows in scoped runs; and the Stryker 9.6.1
/ vitest 4.1.10 phantom-survivor tax on whole-condition guard mutants killed by
*newly-added async* tests applies here too — verify the kill four ways before
annotating, and never add a per-line disable that also suppresses killed sub-expression
mutants (see the anthropic_native step-3 entry).

## Decisions

- D1: Scope this one build to **both** `generate.ts` and `tool_loop.ts` in full (not
  just the `turn_timeout_ms` / `prepare_step` knobs), split into five contiguous regions
  plus a gate — *because* the anthropic_native report bundled "the ~122-survivor
  orchestration body" with the loop-knobs as one deferred unit, the two files are the
  shared core every path funnels through, and a knobs-only pass would leave ~180 of the
  ~199 residual mutants alive. (If a body region proves too big to verify in one pass,
  `/pb-step` re-splits it — see Q2.)
- D2: Kill with concrete-value assertions in the colocated `__tests__/`, reusing the
  existing harnesses; document true equivalents inline with
  `// Stryker disable next-line <mutator>: <reason>` — *because* config excludes and
  blanket disables defeat the purpose; the sibling bar (native family ~96.5-98%) is the
  target, not 100%.
- D3: No-coverage mutants are the priority within each region — *because* they are code
  paths with zero test execution (the highest-value kills); here they sit in the
  `generate()` HITL/schema-repair cluster (L550-599) and the `run_tool_loop` results
  cluster (L700-749).
- D4: "Done" per step is **zero no-coverage in the region + every residual survivor
  killed or annotated equivalent** (target ≥90% killed) — *because* a bare % floor
  collides with unkillable equivalents; the annotation makes the verify unambiguous.
  These orchestration bodies carry more genuine equivalents than the wire adapters
  (timing object-literals, promise internals, listener hygiene), so a region may land at
  90-93% with a longer annotated list rather than 100%.
- D5: At the gate, re-run the full mutation, record the before/after, and ratchet
  `thresholds.break` upward only if the new aggregate leaves the established ~3pt cushion
  (never down) — *because* the config comment says to; killing ~150 survivors across a
  ~1000-mutant surface lifts the ~10340-denom aggregate ~1.4pt (~86.8%→~88%), which
  likely supports 83→84 or 85, but the exact number is a step-6 read of the real delta.
- D6: Use `toStrictEqual` (not `toEqual`) for present-only-when-defined keys and emitted
  option/chunk/usage objects — *because* vitest `toEqual` ignores `key: undefined` and
  will not kill the mutants that add or drop an optional key (the known trap from the
  ledger; it is why generate.ts's option-forwarding survivors persist).

## Constraints

- C1: `pnpm check:all` (incl. mutation) exits 0 at the final gate; `pnpm check` for
  inner iteration; `pnpm exec stryker run --mutate '<file>'` for per-region loops.
- C2: Tests only. Source behavior is unchanged and no public surface moves; the sole
  source latitude is D2's equivalence annotations and a trivially-correct dead-branch
  deletion. No new runtime dependencies.
- C3: No metric gaming — no blanket `Stryker disable`, no lowering the break threshold,
  no loosening the `mutate` globs (D2).
- C4: No live network; the scripted mock-engine / captured-opts harnesses and
  hand-authored payloads only. Reuse the existing generate/tool_loop test harnesses.
- C5: Scope is `src/engine/generate.ts`, `src/engine/tool_loop.ts`, their colocated
  `src/engine/__tests__/` suites, and `stryker.config.mjs` (threshold ratchet only).
  Every other file is untouched.

## Steps

1. [x] Harden generate.ts helpers + timeout/retry machinery (96-420) — **done when:**
   zero no-coverage and every residual survivor in the region killed or annotated
   (target ≥90%): `split_leading_system_messages` and `classify_provider_error`
   branches, `arm_turn_timeout` (the `turn_timeout_ms` knob: `undefined` no-arm vs
   armed deadline, the `<= 0` config-error at both boundaries with exact message),
   `retry_turn`'s pre-chunk-vs-mid-chunk classification and `turn_timeout_error` throw,
   and `build_ai_sdk_invoke` / `build_native_invoke` config forwarding each asserted at
   both boundaries with exact values
   - seam: `src/engine/__tests__/`, `src/engine/generate.ts`
   - model: opus — the AbortSignal.any timeout race and the pre-chunk-vs-mid-chunk retry classification are the judgment
2. [x] Harden generate() body A: invoke dispatch + streaming (422-549) — **done when:**
   zero no-coverage and residual survivors killed or annotated (target ≥90%): the
   ai_sdk-vs-native invoke branch, per-chunk stream aggregation and dispatch, and the
   emitted StreamChunk/step shapes asserted concretely against a dispatch spy
   - seam: `src/engine/__tests__/`, `src/engine/generate.ts`
   - model: opus — streaming-internal reconstruction is the subtle part
3. [x] Harden generate() body B: HITL + schema-repair + cost + finish (550-726) —
   **done when:** zero no-coverage (the L550-599 cluster) and residual survivors killed
   or annotated (target ≥90%): the approval/HITL loop, the schema-repair retry
   (attempt-count boundaries, repair-vs-give-up), `aggregate_cost`/`round6`, and the
   finish/usage mapping asserted with exact values (D6)
   - seam: `src/engine/__tests__/`, `src/engine/generate.ts`
   - model: opus — the schema-repair retry loop and HITL flow are the subtlest orchestration
4. [x] Harden tool_loop.ts helpers + apply_prepare_step (149-352) — **done when:** zero
   no-coverage and residual survivors killed or annotated (target ≥90%):
   `throw_if_aborted` / `throw_if_aborted_in_flight`, `serialize_error`,
   `request_approval`, `build_tool_result_message` / `build_assistant_message`,
   `safe_json_stringify`, `compute_and_record_cost`, `validate_tool_input`, and
   `apply_prepare_step` (the `prepare_step` knob: absent-hook passthrough vs
   prepared-messages override) each asserted concretely
   - seam: `src/engine/__tests__/`, `src/engine/tool_loop.ts`
   - model: sonnet — mostly small pure helpers + one hook; exact-value assertions, mechanical apart from the prepare_step override
5. [x] Harden tool_loop.ts run_tool_loop body (354-851) — **done when:** zero
   no-coverage (the L700-749 cluster) and residual survivors killed or annotated (target
   ≥90%): the per-turn dispatch loop, the approval grant/deny flow, cost recording, the
   tool-result assembly, and abort-in-flight handling asserted against the base_config
   harness with the emitted trajectory/chunks proven equal
   - seam: `src/engine/__tests__/`, `src/engine/tool_loop.ts`
   - model: opus — the tool-dispatch/approval/abort loop is the subtle part
6. [ ] Final gate + ratchet — **done when:** `pnpm check:all` (incl. mutation) exits 0,
   a before/after per-region mutation-score table and the equivalents list are recorded
   in the build log, and `thresholds.break` is ratcheted up to the new aggregate minus
   the ~3pt cushion if the delta supports it (never down, D5)
   - seam: `stryker.config.mjs`, `.plumbbob/`
   - model: opus — reading the mutation delta and choosing the ratchet is the judgment

## Open questions

- Q1: Scope — full hardening of both orchestration bodies (D1, recommended) vs a narrow
  pass on just the `turn_timeout_ms` + `prepare_step` knobs? *Resolve by:* ask at the
  plan pause; default to full (D1). A narrow pass would collapse to ~2 steps and leave
  ~180 residual, so it is only right if the intent was a quick knob-fix.
- Q2: Does `generate()`'s body split cleanly at 549/550 (body A invoke+stream / body B
  HITL+schema-repair+cost), or does the schema-repair loop want its own step?
  *Resolve by:* decide in step 2/3 once the first body region is written; default to the
  two-way split, re-split with `/pb-step` if either half won't verify in one pass.
- Q3: Does the aggregate lift clear a further ratchet (83→84 or 85), or is the headroom
  too thin? *Resolve by:* step 6 reads the real full-repo delta; ratchet only if the new
  aggregate leaves the established ~3pt cushion.

## Verdicts

*(Filled in as spikes and forks resolve — the audit trail of "these were my calls.")*

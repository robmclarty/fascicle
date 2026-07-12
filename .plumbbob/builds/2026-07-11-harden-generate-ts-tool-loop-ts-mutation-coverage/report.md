# Report — Harden generate.ts + tool_loop.ts mutation coverage

**Status:** done (6/6 steps checkpointed). `pnpm check:all` (incl. full-repo
mutation) exits 0 at a new aggregate of **88.33%**; `thresholds.break` ratcheted
83 → 84.

## What shipped

The direct follow-up to the anthropic_native hardening, this build took the two
shared orchestration giants every provider path funnels through from the tree's
largest remaining survivor cluster to the sibling bar:

| File | before | after | remaining survivors |
|---|---|---|---|
| `generate.ts` | 77.6% | **95.79%** | all verified equivalents / phantoms; **0 no-coverage** |
| `tool_loop.ts` | 83.7% | **94.59%** | all verified equivalents / phantoms; 1 documented no-coverage |
| repo aggregate | 86.84% | **88.33%** | — |

Five contiguous region-hardening steps plus a gate, landed step-by-step (see the
`## Log`). Tests-only: ~70 concrete-value tests added across `generate_helpers`,
`turn_timeout`, `native_loop_inheritance`, `generate`, and `tool_loop` suites,
reusing the existing scripted-mock / captured-opts / base_config harnesses. The
only source changes are ~25 inline `// Stryker disable next-line` equivalence
annotations and the step-6 threshold ratchet. No orchestration behavior, public
surface, or retry/HITL/schema-repair semantics moved.

## Decisions and why

- **Full both-file scope (D1), not a knobs-only pass.** A `turn_timeout_ms` +
  `prepare_step` pass would have left ~180 of the ~199 residual mutants alive; the
  files are the shared core, so the whole body was in scope. (Q1 resolved to full.)
- **Method: baseline → test → verify → *classify*.** Each region got a fresh
  non-incremental scoped mutation baseline, then targeted concrete-value tests, then
  a scoped re-verify. Every residual survivor was then classified *empirically* —
  apply the mutation by hand, run the exercising suites — to separate three cases the
  raw report conflates:
  - **Genuine equivalents** (no test can fail) → annotated inline where the line has
    no killed same-mutator twin; documented otherwise.
  - **Stryker 9.6.1 / vitest 4.1.10 phantoms** (provably killed, mis-reported
    Survived) → left unannotated by design and documented, because a per-line disable
    would also suppress the *killed* `=> false`/sub-expression twin and destroy real
    coverage signal. Verified with hard failure counts (e.g. classify guards 8/6/2/4;
    max_tool_calls 83; salvage 5/13; clamp 13).
  - **Killable-but-missed** → a new test (e.g. the pre-abort span-count spy, the 0ms-vs-25ms
    deadline distinguisher, the has_schema span flag, the max_steps repair boundary).
- **Equivalence annotations never game the metric (D2/C3).** Each `// Stryker
  disable` is scoped to the exact equivalent mutator(s) and audited per line so no
  killed twin is suppressed; the type-required-but-unreachable `?? 'unknown'`/`'json'`
  defaults are annotated only where their line has no killed StringLiteral twin.
- **Ratchet to 84, not 85 (D5).** The +1.49pt aggregate lift supports a raise; 88.33
  − 84 = 4.33pt keeps the established ~3.8pt cushion (the prior build accepted 3.84
  and rejected tighter), which absorbs the 91 flippable Timeout mutants. 85 would
  erode it to 3.33pt, so 84 is the disciplined upward step. Never lowered. (Q3 resolved.)
- **Two-way generate() body split held (Q2).** Body A (dispatch + invoke
  construction) and body B (HITL + schema-repair + cost + finish) each verified in one
  pass; no `/pb-step` re-split of the schema-repair loop was needed.

## Parked & harvested

Nothing parked (0 items) — each region stayed within its seam; mid-build discoveries
(phantoms, equivalents) were resolved in place as part of the classification, not
deferred.

## Final status

Done. All of `generate.ts` and `tool_loop.ts` are hardened to the sibling bar with
zero killable survivors; every residual is a verified equivalent or a verified
Stryker phantom. One lone no-coverage remains (`tool_loop.ts` L710:88, a
type-required-unreachable `?? 'unknown'` default whose line carries a killed
template-literal twin) — documented rather than gamed. Full before/after per-file
table, aggregate, and the equivalents/phantoms ledger live in the build log.

## Deferred tangents (future builds)

From intent's "explicitly NOT doing" — each its own future increment:

- **`define_agent.ts`** (~64%) — the next single-file mutation gap.
- **Viewer exclude-vs-test decision** — `viewer/tail.ts` (61.8%), `viewer/server.ts`:
  decide whether to unit-test or add to the `mutate` excludes (like the CLI glue).
- **The `ai_sdk` Anthropic adapter** — the remaining wire adapter.
- **Stryker phantom-survivor tax** — the whole-condition-guard blind spot recurs
  (classify/capability/salvage/clamp guards here). Logged to the mutation-landscape
  memory; a Stryker/vitest upgrade may retire it.

## Checkpoints

- baseline bbca9d1ada645d02f52b234891a842176f0bf4f7
- plan 07f7035760297cd8575878a06d5bb12963fe42d3
- step 1 4092f1f1544ab232a9d00d09c4378a3917a47ba2
- step 2 15ca58822495df45b6fc868e183bdcd3680d6431
- step 3 715ba333c760c09187fa284c3a9481d4cb275ed3
- step 4 ca5699e4818377aafc317b4e0099b7fc08ccbf64
- step 5 94aad950b677a1b3f2cdd628946526b0455c464e
- step 6 2b86f0cf99ede02418c3bc7e0a8deba86e71c2f2

## Stats

| step | red checks | drift warnings | reverts | wall-clock |
|------|------------|----------------|---------|------------|
| 1 | 0 | 0 | 0 | 36m |
| 2 | 0 | 0 | 0 | 17m |
| 3 | 0 | 0 | 0 | 18m |
| 4 | 0 | 0 | 0 | 12m |
| 5 | 0 | 0 | 0 | 17m |
| 6 | 0 | 0 | 0 | 7m |
| **total** | 0 | 0 | 0 | 106m |

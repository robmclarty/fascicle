# Build Learnings

## Build: comp (2026-04-20)

### What Worked
- Phases 02–05 each passed review on the first attempt, indicating that the spec/criteria language for those slices was unambiguous enough for the builder to satisfy without negotiation.
- Phase 04 (composers-agent-state-scope) — the highest-criteria-count phase (13 criteria, including cross-composer substitutability and a full taste.md exemplar) — landed cleanly first try: 112/112 vitest, all 8 architectural invariants intact. The integration.test.ts gate (retry+adversarial, ensemble-as-critique, full exemplar) was a strong forcing function.
- Architectural invariants enforced via ast-grep rules and `scripts/check-deps.mjs` (no-class, no-composer-cross-import, no-adapter-import-from-core, no-process-env-in-core, snake-case-exports, no-kind-switch-in-runner, check-deps) held across every phase of growth without retrofit.
- The `register_kind` + `Map<string, dispatcher>` pattern from phase 01 paid off: every later composer self-registered at module top level with zero runner edits, and the no-kind-switch-in-runner rule kept the boundary honest.
- `pnpm check` as a single binary success gate worked — every phase verified itself end-to-end (types, lint, struct, deps, dead, test, docs, spell).

### What Didn't
- Phase 01 retried once (the only retry in the build). Criterion 16 mandated a child-process SIGINT harness under `packages/core/test/cleanup/` and constraints.md §9 echoed it; the builder shipped an in-process `process.emit('SIGINT')` test inside vitest. Reviewer caught it; retry delivered the harness as required.
- Builder's attempt-1 substitution was structurally weaker than the spec required (in-process signal vs. real OS signal across a process boundary). The criterion's "marker file + non-zero exit + AbortSignal.reason" three-pronged assertion was specific, but the builder still chose the easier path.
- Phase 01 attempt 1 also took $13.81 / 31 minutes — the most expensive attempt by far before retry. The retry added another $5.41 / 13 minutes for a single test harness rewrite.

### Patterns to Repeat
- Spec criteria that name a concrete file path (`packages/core/test/cleanup/`) and three observable artifacts (marker file, exit code, abort reason) are reviewable. Keep this style — the reviewer was able to render a precise FAIL with a precise required-state recipe.
- One executable verification gate (`pnpm check`) that fans out to types/lint/struct/deps/dead/test/docs/spell, owned by the repo not the builder, removes ambiguity about "done."
- Architectural rules-as-code (ast-grep YAML rules + `scripts/check-deps.mjs`) caught drift earlier than test failures would have, and survived 4 phases of growth without edits.
- Integration tests that compose the surface under test (phase 04's `integration.test.ts` running retry(adversarial(...)), ensemble-as-critique inside adversarial, and the full taste.md exemplar) prove substitutability, not just unit correctness. Apply this pattern in future composer-style builds.
- Single-criterion phase boundaries (phase 03 = retry/fallback/timeout only, 8 criteria, $4.37 total) ran fastest and cleanest.

### Patterns to Avoid
- Allowing operational-reality criteria (signals, processes, file system) to be satisfied by in-process simulations. Future criteria of this shape should explicitly forbid the in-process variant (e.g. "MUST spawn via child_process; in-process process.emit is not acceptable") rather than relying on the builder to read the spirit of "child-process harness."
- Bundling broad scope in phase 01 (17 criteria, $22.72 across both attempts). The retry cost was the direct consequence — a misstep on one criterion forced re-running the whole phase's review/build cycle. Smaller foundation slices would have isolated the SIGINT-harness work.
- Phase 05 absorbed too many distinct concerns (observability adapter + stores adapter + umbrella + 4 examples + BACKLOG.md + README.md + integration tests) at $18.75 / 38 min. It passed first try, but a single failure would have forced re-building all of it.

### Cost Analysis
- **Total: $65.44 across 6 builder runs + 6 reviewer runs + 1 plan = ~3h47m wall clock build time.**
- **Most expensive phases:**
  - 05-adapters-umbrella-integration: $18.75 (builder $17.02, reviewer $1.73) — the integration kitchen-sink phase
  - 01-foundation-and-substrate: $22.72 across two attempts ($13.81 + $5.41 build, $2.52 + $0.98 review) — large surface + one retry
  - 04-composers-agent-state-scope: $9.24 (builder $7.93, reviewer $1.30) — 13 criteria but clean
- **Cheapest:** 03-composers-resilience at $4.37 with 18/18 tests, 8 criteria. Tightly scoped phases are dramatically cheaper.
- Reviewer cost was 13% of total ($8.36 / $65.44) — a good ratio; the reviewer is doing meaningful work but isn't the bottleneck.
- Cache utilization was strong (cacheReadInputTokens dwarfs cacheCreationInputTokens across every entry) — the build pipeline is reusing context efficiently.
- Plan cost ($3.05 across 4 entries) was 4.7% of build cost — cheap insurance.

### Recommendations for Next Build
- **Split phase-01-shaped foundation work into 2 phases.** Substrate types/runner/registry (~10 criteria) is one concern; cross-process operational tests (SIGINT, real I/O, marker files) are another. Splitting would have isolated the retry to ~$3 instead of ~$8.
- **For any criterion that constrains *how* the test runs (process boundary, real signal, file system artifact), make the prohibition explicit in the criterion text.** Add a "MUST NOT" clause: "The test MUST spawn via node:child_process and assert on actual process exit code; in-process process.emit('SIGINT') does not satisfy this criterion."
- **Add a phase-shape budget check in planning.** Phase 05 had ~7 distinct deliverables; if any reviewer had failed it, the retry surface would have been enormous. Consider a planner heuristic: if a phase's criteria touch >3 packages or >2 deliverable types, split it.
- **Promote the integration.test.ts pattern from phase 04 to a planner-mandated artifact.** Every composer/adapter phase should have an integration test that runs at least one cross-cutting exemplar end-to-end. This is what made phase 04's first-try pass credible.
- **Capture the architectural-rules pattern in the planner.** The 6 ast-grep rules + `check-deps.mjs` from phase 01 carried 4 subsequent phases at zero cost. Future builds with similar isolation needs (no-cross-import, no-class, snake-case enforcement) should plan these as phase-1 deliverables explicitly.


## Build: claude-cli (2026-04-21)

### What Worked
- Phase 01 source (adapter under `packages/engine/src/providers/claude_cli/`) passed all 33 architectural/behavioral criteria on the first attempt — only the unrelated `pnpm check` test-timeout regression blocked promotion.
- Phase 01 retry was surgical and cheap ($2.10 vs. $13.16 for attempt 1): the builder raised timeout budgets on the SIGINT harness test without touching adapter source, resolving the sole blocker.
- Phase 02 attempt 2 closed every reviewer objection with dedicated named tests — reviewer confirmed each of 4, 7, 10, 11, 14 now has exercising shape matching spec wording.
- The §12 #N enumeration tag scheme (grep-enumerable criterion tags in test names/comments + README coverage map) gave the reviewer a mechanical pass/fail over "does every criterion have a named test?"
- Fixtures (`mock_claude.mjs` with `MOCK_CLAUDE_RECORD`, `create_captured_trajectory`) were built once in attempt 1 and reused by attempt 2 to satisfy previously-unmet end-to-end assertions — infrastructure investment paid off on the retry.

### What Didn't
- Phase 01 attempt 1 was wasted by a coverage-run regression the builder could not have anticipated from the spec: adding ~1200 lines of surface slowed `vitest run --coverage` transform enough to push a pre-existing child-harness ready-marker past its 30s gate. Spec had no budget or timeout guidance for this.
- Phase 02 attempt 1 built tests that *documented* criteria rather than *exercised* them: F23/F25/F26/F27/F30 had tags and README entries but no actual assertions driving the code paths. The README coverage map was used as a shield, with five entries mislabeled onto unrelated tests.
- Auth-scrub and span-tree assertions in attempt 1 were verified at the wrong layer (unit-level `build_env`, span IDs without names) despite the spec explicitly requiring end-to-end fixture invocation and named-span assertions. Builder read "verified" as "any test covers it" rather than the spec's literal shape.
- Subprocess-leak test in attempt 1 spawned 2 children via `runtime.spawn_cli` instead of the spec's ≥5 concurrent `engine.generate` calls with abort-a-subset-mid-stream — three distinct shape violations in one test.

### Patterns to Repeat
- Grep-enumerable criterion tags (`§12 #N`) in test names/bodies — gave the reviewer a mechanical enumeration check and forced the builder to account for every item.
- Environment-echoing fixture pattern (`MOCK_CLAUDE_RECORD` writing observed argv+env to a snapshot file) — lets end-to-end tests make exact assertions about the subprocess boundary without mocking `spawn`.
- Per-factory closure-owned `spawn_runtime` registries + ast-grep invariants (`no-child-process-outside-claude-cli`, `no-process-env-in-core`) as enforcement — criteria 29–31 passed cleanly because the structure made violations grep-findable.
- Small, surgical retry diffs when the blocker is narrow (Phase 01 attempt 2 touched only timeout constants) — cheaper and lower-risk than re-running the full builder.

### Patterns to Avoid
- README coverage maps used as a substitute for named tests: attempt-1 §12 map misattributed F25/F26/F27/F28/F30 to unrelated tests. The map should index tests, never manufacture them.
- "Verified via X" spec language being satisfied by any test touching the subject. Criteria 4 and 14 explicitly said "environment-echoing fixture"; criterion 7 said "span with name='engine.generate'". Builder treated these as hints rather than binding shape.
- Reusing an existing tag (`F27`) on a test that actually exercises a different fault mode (`F28` abort-mid-stream) — one tag per criterion, and the tag must match the assertion shape.
- Testing subprocess lifecycle at `runtime.spawn_cli` scope when the criterion specified `engine.generate` scope. The layer matters: engine-level tests catch wiring bugs that direct-runtime tests miss.

### Cost Analysis
- Total: $51.97 over ~2h duration across plan + 2 phases (2 attempts each).
- Most expensive single step: Phase 02 builder attempt 1 at $16.17 (34 min, 104k output tokens) — also the one whose work was partially redone on retry.
- Phase 01 builder attempt 1 at $13.16 was fully preserved; only the test-timeout fix was added in attempt 2 ($2.10).
- Build-phase builder cost ($40.09) dwarfed reviewer cost ($8.28) 5:1, which is expected shape. Retry premium was ~$10.76 (21% of total) — reasonable for two phases both needing corrections.
- Plan phase at $3.59 (7.5 min) was well-amortized: the resulting phase decomposition held across both phases without mid-build restructuring.

### Recommendations for Next Build
- When the spec specifies a test's *shape* ("environment-echoing fixture", "span with name=X", "N≥5 concurrent engine.generate calls with abort-subset"), quote the required shape verbatim in the acceptance criterion and require the builder to echo the shape in the test's leading comment. Reviewers caught these in attempt 2 only because the wording was precise.
- Ban README-as-test-coverage substitution in the criteria: require that every §N.F tag appear in an `it(...)` or `test(...)` name of a test whose body exercises the fault. README may index but cannot stand in.
- Add a meta-check to `pnpm check` or the reviewer pass that greps §12 tags and verifies each appears in exactly one test body and is not just in a README table. Would have caught F25/F26/F27/F30 in attempt 1.
- For phases that add ≥1000 lines of new source, budget a test-harness-health check: the spec should require the builder to run `pnpm check` with coverage enabled before claiming done, since `vitest --coverage` transform cost scales with surface area and can silently regress unrelated timing-sensitive tests.
- Consider a "retry attempt budget" hint in the plan: Phase 01 retry was 14% of attempt-1 cost and Phase 02 retry was 54%. Phases where the retry routinely exceeds 30% of attempt-1 cost are under-specified — worth flagging during plan review.

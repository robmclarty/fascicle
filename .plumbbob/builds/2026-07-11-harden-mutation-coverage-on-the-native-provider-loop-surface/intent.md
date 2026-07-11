# Harden mutation coverage on the native provider + loop surface

**Phase:** frame
**Size:** medium (five steps: four file-hardening + a gate)

The follow-up to "Native expansion: OpenAI-compatible core, native Ollama, loop
knobs, otel" (12/12, 2026-07-11). That build added a large native-transport and
observability surface under constraint C7 ("wire mapping, SSE/NDJSON parsing, and
usage math assert concrete values, not smoke; prime mutation targets"). The tests
are real and the gate is green, but a fresh full-repo Stryker report shows the new
surface still carries hundreds of surviving and no-coverage mutants — the debt is
invisible because the gate floor is a repo-wide aggregate, not per file.

## Frame

- **Problem:** The `transport: 'native'` surface this build introduced is the
  repo's live mutation gap. From `.check/mutation.json` (full run, 2026-07-11):
  `openai_compatible_native.ts` 82.2% (104 survived / 10 no-coverage),
  `ollama_native.ts` 78.2% (82 / 29), `otel/trajectory_logger.ts` 83.2% (22 / 2),
  `providers/ai_sdk/telemetry.ts` 68.0% (8 / 0). The survivors are dominated by
  `ConditionalExpression`, `EqualityOperator`, and `StringLiteral` mutants —
  branch boundaries and exact wire strings that no assertion pins — plus
  no-coverage clusters in the streaming/error-drain regions. The mutation gate
  passes anyway because `thresholds.break` is 78 across the whole repo (~83.5%
  aggregate), so a file at 78% never trips it.
- **Smallest thing that solves it:** Add C7-style concrete-value assertions to
  the colocated `__tests__/` for the files this build introduced, killing every
  killable survivor and eliminating no-coverage on them; annotate the genuine
  equivalent mutants inline instead of chasing them. No source behavior change.
- **Done looks like:** Each targeted file has zero no-coverage mutants and every
  residual survivor carries an inline equivalence rationale (targeting ≥90%
  killed); `pnpm check:all` (incl. mutation) exits 0; `thresholds.break` is
  ratcheted up to lock the gain; a before/after per-file table is in the build log.
- **Explicitly NOT doing:**
  - The prior/shared debt: `anthropic_native.ts` (the predecessor's exemplar,
    73.9% / 182 holes — biggest single gap), and the loop-knob survivors buried
    in the giant shared `generate.ts` (118) and `tool_loop.ts` (56). Both are
    Open questions below, not silent scope.
  - Non-native gaps: `core/runner.ts`, `composites/*`, `claude_cli/*`, the
    `ai_sdk` Anthropic adapter. Different surface, different build.
  - Gaming the metric: no blanket `Stryker disable`, no lowering
    `thresholds.break`, no loosening the `mutate` globs to hide a file.
  - Refactoring source to be mutation-friendly, beyond a trivially-correct
    simplification that deletes a genuinely-equivalent (dead/defensive) branch
    with identical behavior.

## Architecture sketch

Not architecture — the baseline scores and the assertion strategy they imply.

```text
Target file (this build's surface)          killed%  surv  nocov  step
  providers/openai_compatible_native.ts       82.2   104    10     1
  providers/ollama_native.ts                  78.2    82    29     2
  otel/trajectory_logger.ts                   83.2    22     2     3
  providers/ai_sdk/telemetry.ts               68.0     8     0     3
  create_engine.ts (with_providers region)    77.6    29     9     4

Survivor shape → assertion strategy:
  ConditionalExpression / EqualityOperator  → assert BOTH branch boundaries
     (dialect flags, finish_reason/done_reason maps, usage tolerance, timeouts)
  StringLiteral                             → assert EXACT wire strings
     (header names, JSON field names, endpoint paths, auth scheme)
  NoCoverage clusters                       → execute the untested path
     (ollama NDJSON drain/error-classify ~L394-478; openai SSE edges ~L276-286,
      L519-633) — highest-value kills; a path with zero test execution
```

Per-file inner loop: `pnpm exec stryker run --mutate '<path>'` (overrides the
config glob; incremental keeps it fast), then re-parse `.check/mutation.json` for
the file's killed/survived/no-coverage. `pnpm check` (excludes mutation) for the
test-authoring iterations; `pnpm check:all` once at the end (C1).

## Decisions

- D1: Scope to the surface THIS build introduced — the four new native/otel/
  telemetry files plus the `with_providers` derivation — not prior or shared
  debt — *because* the native-expansion build is what put this coverage on the
  board, same-ownership keeps the diff reviewable, and `anthropic_native.ts` /
  `generate.ts` / `tool_loop.ts` are large enough to be their own decision (Q1/Q2).
- D2: Kill with concrete-value assertions in the colocated `__tests__/`; document
  true equivalents inline with `// Stryker disable next-line <mutator>: <reason>`
  — *because* config excludes and blanket disables defeat the purpose; the
  `src/mcp` precedent (97.4%, 8 annotated equivalents) is the bar, not 100%.
- D3: No-coverage mutants are the priority within each file — *because* they are
  code paths with zero test execution (the highest-value kills), and they cluster
  in the streaming/error-drain regions where wire bugs actually hide.
- D4: "Done" per file is expressed as **zero no-coverage + every residual
  survivor annotated equivalent** (target ≥90% killed), not a raw percentage —
  *because* a bare % floor collides with unkillable equivalents; the annotation
  makes the verify unambiguous and reviewable.
- D5: At the end, ratchet `thresholds.break` upward to lock the gain (never down)
  — *because* the config's own comment says to ("Bump it further as coverage
  climbs; never lower it"); the exact number is set from the final aggregate with
  headroom for the timing-sensitive suites.

## Constraints

- C1: `pnpm check:all` (incl. mutation) exits 0 at the final gate; `pnpm check`
  for inner iteration; `pnpm exec stryker run --mutate '<file>'` for per-file loops.
- C2: Tests only. Source behavior is unchanged and no public surface moves; the
  sole source latitude is D2's equivalence annotations and D1's trivially-correct
  dead-branch deletions. No new runtime dependencies.
- C3: No metric gaming — no blanket `Stryker disable`, no lowering the break
  threshold, no loosening the `mutate` globs (D2).
- C4: No live network; recorded fixtures only (carried from the predecessor's C5).
  New fixtures are hand-authored or captured, never fetched in the suite.
- C5: Scope is `src/engine/providers/openai_compatible_native.ts`,
  `src/engine/providers/ollama_native.ts`, `src/otel/trajectory_logger.ts`,
  `src/engine/providers/ai_sdk/telemetry.ts`, `src/engine/create_engine.ts`,
  their colocated `__tests__/`, and `stryker.config.mjs` (threshold ratchet only).
  Every other file is untouched.

## Steps

1. [ ] Harden `openai_compatible_native.ts` — **done when:** the file has zero
   no-coverage mutants and every residual survivor carries an inline equivalence
   rationale (target ≥90% killed): the dialect branches (auth strategy, extra
   headers, stream-usage behavior, usage tolerance per D10), the `finish_reason`
   and usage maps (exact values per Appendix A2/A3), and the SSE edge lines
   (~276-286, 519-633) are each asserted at both boundaries
   - seam: `src/engine/providers/__tests__/openai_compatible_native.test.ts`, `src/engine/providers/__tests__/openai_compatible_native_e2e.test.ts`, `src/engine/providers/openai_compatible_native.ts`
   - model: opus — strong-assertion authoring plus equivalent-mutant judgment on the dialect/finish/usage branches
2. [ ] Harden `ollama_native.ts` — **done when:** zero no-coverage and residual
   survivors annotated (target ≥90%), with the NDJSON stream-drain and
   error-classification region (~394-478) and the `done_reason` /
   `prompt_eval_count`/`eval_count` maps (zeroed-when-absent per D10) asserted at
   both boundaries
   - seam: `src/engine/providers/__tests__/ollama_native.test.ts`, `src/engine/providers/ollama_native.ts`
   - model: opus — a second wire dialect (NDJSON) with the error-drain paths as the named subtle part
3. [ ] Harden the otel surface — **done when:** `otel/trajectory_logger.ts` and
   `providers/ai_sdk/telemetry.ts` each reach zero no-coverage with residual
   survivors annotated (target ≥90%): the span-structure conditionals, optional
   chaining, and the opt-in telemetry `enabled` gate are asserted against the
   in-memory exporter / a telemetry spy
   - seam: `src/otel/__tests__/trajectory_logger.test.ts`, `src/engine/providers/ai_sdk/__tests__/`
   - model: sonnet — small survivor sets, mechanical against an existing exporter harness
4. [ ] Harden `with_providers` in `create_engine.ts` — **done when:** the
   survivors and no-coverage attributable to the `with_providers` derivation are
   killed or annotated, with its value-semantics invariants (merged config,
   custom-first resolution, shadow-throws vs built-ins, fresh adapters, disposal
   independent of the parent) each asserted concretely
   - seam: `src/engine/__tests__/`, `src/engine/create_engine.ts`
   - model: opus — the invariants are the assertions; the parent-untouched proof is the subtle part
5. [ ] Final gate + ratchet — **done when:** `pnpm check:all` (incl. mutation)
   exits 0, a before/after per-file mutation-score table and the equivalents list
   are recorded in the build log, and `thresholds.break` is ratcheted up to the
   new aggregate minus headroom (never down, D5)
   - seam: `stryker.config.mjs`, `.plumbbob/`
   - model: opus — reading the mutation delta and choosing the ratchet is the judgment

## Open questions

- Q1: Harden the loop-knob survivors this build added inside the shared giants —
  `turn_timeout_ms` in `generate.ts` (118 survived) and `prepare_step` in
  `tool_loop.ts` (56)? Isolating this build's mutants from the rest of those
  files is fuzzy — *resolve by:* decide after Steps 1-4 land and the residual is
  sized; likely a scoped follow-up, not this build.
- Q2: Include `anthropic_native.ts` (73.9%, 145 survived / 37 no-coverage — the
  single biggest gap, and the native exemplar)? It is the predecessor's code, not
  this build's — *resolve by:* ask; probably its own hardening build.
- Q3: `viewer/tail.ts` (61.8%) and `viewer/server.ts` (78.8%) are the low scorers
  and were flagged as Stryker-exclude candidates (like `viewer/cli.ts` already
  is) — exclude as IO glue or test? Out of the native scope — *resolve by:*
  separate housekeeping decision.

## Verdicts

*(Filled in as spikes and forks resolve — the audit trail of "these were my calls.")*

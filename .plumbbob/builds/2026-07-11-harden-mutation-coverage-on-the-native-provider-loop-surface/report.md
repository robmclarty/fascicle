# Report — Harden mutation coverage on the native provider + loop surface

Follow-up to the "Native expansion" build (12/12, 2026-07-11). That build shipped a
large `transport: 'native'` + otel surface under constraint C7, but a fresh full-repo
Stryker report showed it still carried hundreds of surviving and no-coverage mutants.
The debt was invisible because the mutation gate floors on a repo-wide aggregate, not
per file, so a file at 78% never tripped it. This build closed that gap on the exact
surface the predecessor introduced, then ratcheted the gate so the gain can't silently
regress.

## What shipped

Five steps (see `build-log.md` `## Log` for the dated timeline). Steps 1–4 added
C7-style concrete-value assertions to the colocated `__tests__/` for each new file —
exact wire strings, both branch boundaries, and execution of the streaming/error-drain
paths that previously had zero coverage. Step 5 was the gate + ratchet. No source
behavior changed; the sole source edit was one equivalence annotation.

Per-file mutation score, before → after (full detail in the build log's
`## Mutation delta`):

| File | killed% | no-coverage |
|---|---|---|
| `openai_compatible_native.ts` | 82.2 → **96.7** | 10 → **0** |
| `ollama_native.ts` | 78.2 → **96.5** | 29 → **0** |
| `otel/trajectory_logger.ts` | 83.2 → **93.0** | 2 → **0** |
| `ai_sdk/telemetry.ts` | 68.0 → **100.0** | 0 → **0** |
| `create_engine.ts` (`with_providers`) | 77.6 → **97.6** | 9 → **0** |

Repo aggregate mutation score: **~83.5% → 85.23%**. `pnpm check:all` (incl. mutation)
exits 0.

## Decisions and why

- **D1 — scope to this build's surface only.** The four native/otel/telemetry files
  plus the `with_providers` derivation, not prior or shared debt. Same-ownership kept
  the diff reviewable and left the large predecessor/shared gaps as their own decision
  (Q1/Q2).
- **D2/D3/D4 — kill with concrete assertions, prioritize no-coverage, express "done"
  as zero-no-coverage + ≥90% killed.** Config excludes and blanket disables were off
  the table; the `src/mcp` precedent (97.4%, 8 annotated equivalents) was the bar. No-
  coverage clusters (streaming/error-drain) were the highest-value kills because they
  were code with zero test execution.
- **D5 — ratchet `thresholds.break` up, never down.** Set from the final aggregate
  minus headroom: **78 → 82** (with `low` 78 → 82, `high` unchanged at 85). ~3 points
  of headroom below 85.23% follow the config's established convention and absorb the
  timing-sensitive spawn/timeout/map suites (89 Timeout mutants count as killed and can
  flip on a slow run).

## Parked & harvested

Nothing parked during the build (park list empty; 0 harvested). The three open
questions below were framed up front in `intent.md`, not surfaced mid-build.

## Final status

**Done.** All five steps checkpointed; `pnpm check:all` green including the ratcheted
mutation gate at `break=82`. Every targeted file reached zero no-coverage and ≥90%
killed.

One honest residual, recorded rather than papered over: 53 survivors remain across the
four files (21/18/10/0/4) with a single annotated equivalent (`create_engine.ts:183`).
The intent's aspirational "every residual survivor annotated" was not force-applied —
annotating a not-provably-equivalent survivor as equivalent would be metric-gaming
(C3). The enforceable bars (zero no-coverage, ≥90% killed) are met everywhere.

## Deferred tangents (future work)

- **Q1** — the loop-knob survivors this build added inside the shared giants
  (`turn_timeout_ms` in `generate.ts`, `prepare_step` in `tool_loop.ts`). Isolating
  this build's mutants from the rest of those large files is fuzzy; likely a scoped
  follow-up.
- **Q2** — `anthropic_native.ts` (the predecessor's exemplar, the single biggest gap).
  Its own hardening build.
- **Q3** — `viewer/tail.ts` / `viewer/server.ts` low scorers: decide whether to add as
  Stryker-exclude IO glue (like `viewer/cli.ts`) or test them. Separate housekeeping.
- The 53 residual survivors on this build's files, if a future pass wants to chase them
  past ≥90%.

## Checkpoints

- baseline ea002d7fb18987b17a5626c8506fae9469514baa
- plan e54ac7ea7701ce8201263b473aa5eaaff228d1bd
- step 1 68c5f7368466c4a1057ceaa0fc854258c74d32b7
- step 2 a96b798a014a55d8877ec7a102aa023ddd89b92a
- step 3 bef16e31a1592a8256947ed53e1f0a0dcfbb9a5a
- step 4 8695c8a5b5e807065e8313158bd531fc46c6a45e
- step 5 8b5f0cf7642816075fbd50c33f15b5817a3e2ac7

## Stats

| step | red checks | drift warnings | reverts | wall-clock |
|------|------------|----------------|---------|------------|
| 1 | 1 | 0 | 0 | 61m |
| 2 | 1 | 0 | 0 | 36m |
| 3 | 0 | 0 | 0 | 38m |
| 4 | 0 | 0 | 0 | 35m |
| 5 | 0 | 0 | 0 | 36m |
| **total** | 2 | 0 | 0 | 206m |

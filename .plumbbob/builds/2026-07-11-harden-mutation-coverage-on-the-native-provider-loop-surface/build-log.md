<!--
build-log.md — your live ledger for execution. Append constantly; reorganize at
step boundaries. The antidote to "my plan got lost in the noise."

  Steps     : where you are. One step in flight at a time.
  Park list : where ideas go so you do not chase them. CAPTURE, never act inline.
  Harvest   : the boundary ritual that keeps you on one branch.
  Log       : the build's history. `plumbbob checkpoint` appends a line per step as it
              lands; feeds the /pb-finish report, which rides the branch into the PR.
-->

# Build log — Harden mutation coverage on the native provider + loop surface

**Current step:** none (at the boundary)
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status. Only ONE step is in flight. A step
is done only after a checkpoint — check green + checkpoint taken, via `/pb-verify` or
`/pb-build`.)*

- ☐ 1. <step>

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/pb-park` composes it). Harvest happens only at the boundary.

## Harvest  *(run `/pb-harvest` at each step boundary, after green)*

Classify each parked item as exactly ONE. Naming it before acting is what keeps you
from sprawling across branches.

| Class            | Meaning                                   | Action                          |
|------------------|-------------------------------------------|---------------------------------|
| **blocker**      | Plan was wrong/incomplete; can't proceed  | `/pb-revert`, fold into intent  |
| **tangent**      | A different path, not clearly better      | Defer or kill. Default here.    |
| **pivot signal** | Evidence the whole approach is wrong      | Stop. Replan deliberately.      |

> Reality check: almost everything that *feels* like a pivot is a tangent. Require a
> failed assumption, not a shinier idea, before you pivot.

Harvest results this boundary:

- (none yet)

## Mutation delta (step 5 gate)

Full-repo `pnpm check:all` (incl. mutation, incremental) exits 0 — all 11 checks
green; mutation ran ~20m. Per-file killed% / survived / no-coverage, before
(intent frame, 2026-07-11) → after (this build's final gate):

| File (mutate target)                       | killed%        | survived   | no-cov   |
|--------------------------------------------|----------------|------------|----------|
| providers/openai_compatible_native.ts      | 82.2 → **96.7**| 104 → 21   | 10 → **0** |
| providers/ollama_native.ts                 | 78.2 → **96.5**| 82 → 18    | 29 → **0** |
| otel/trajectory_logger.ts                  | 83.2 → **93.0**| 22 → 10    | 2 → **0**  |
| providers/ai_sdk/telemetry.ts              | 68.0 → **100.0**| 8 → 0     | 0 → **0**  |
| create_engine.ts (with_providers)          | 77.6 → **97.6**| 29 → 4     | 9 → **0**  |

Repo aggregate mutation score: ~83.5% → **85.23%** (killed 8741 + timeout 89 over
denom 10360; RuntimeError/Ignored excluded per Stryker convention).

**Equivalents annotated** (the only inline `// Stryker disable next-line` added by
this build; D2):

- `create_engine.ts:183` — `ArrayDeclaration` on the `tasks: Promise<void>[]`
  accumulator seed. Seeding it non-empty is observationally identical: every
  element is awaited by the `Promise.all` below and then discarded by
  `.then(() => undefined)`, so a stray value cannot change what `dispose()`
  resolves to or when.

**Residual survivors** (53 across the four files: 21 / 18 / 10 / 0 / 4) are left as
honest, hard-to-kill-but-not-provably-equivalent survivors. They are deliberately
*not* annotated as equivalents — annotating a non-equivalent survivor as equivalent
would be metric-gaming (C3). The enforceable per-file bars — **zero no-coverage**
and **≥90% killed** — are met on every targeted file.

**Ratchet** (D5): `thresholds.break` 78 → **82** (and `low` 78 → 82, kept equal to
break as before; `high` unchanged at 85). ~3 points of headroom below the 85.23%
aggregate absorb the timing-sensitive spawn/timeout/map suites (89 Timeout mutants
count as killed and can flip on a slow run). Never lowered.

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends a dated line here
every time a step lands — via `/pb-build` or `/pb-verify` — so this
fills in as you go, not at the end. Add your own decision/event lines too: this is what
you point at to say "I did that — the LLM helped, but those were my calls."
`/pb-finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*
- 2026-07-11 — step 1 checkpointed · 68c5f7368 — Harden `openai_compatible_native.ts` (1 red, 61m)
- 2026-07-11 — step 2 checkpointed · a96b798a0 — Harden `ollama_native.ts` (1 red, 36m)
- 2026-07-11 — step 3 checkpointed · bef16e31a — Harden the otel surface (38m)
- 2026-07-11 — step 4 checkpointed · 8695c8a5b — Harden `with_providers` in `create_engine.ts` (35m)
- 2026-07-12 — step 5 checkpointed · 8b5f0cf76 — Final gate + ratchet (36m)

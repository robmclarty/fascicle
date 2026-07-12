<!--
build-log.md — your live ledger for execution. Append constantly; reorganize at
step boundaries. The antidote to "my plan got lost in the noise."

  Steps     : where you are. One step in flight at a time.
  Park list : where ideas go so you do not chase them. CAPTURE, never act inline.
  Harvest   : the boundary ritual that keeps you on one branch.
  Log       : the build's history. `plumbbob checkpoint` appends a line per step as it
              lands; feeds the /pb-finish report, which rides the branch into the PR.
-->

# Build log — Harden anthropic_native.ts mutation coverage

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

## Step 5 — final gate: mutation delta + ratchet

Full-repo `pnpm check:all` (incl. mutation) green. Numbers below are from the
clean full-repo `.check/mutation.json` on the step-4 commit (working tree clean;
source + tests unchanged since).

### Per-region before/after (anthropic_native.ts)

| Region (lines)                               | Before (bad = surv + nocov) | After                              | Killed |
|----------------------------------------------|-----------------------------|------------------------------------|--------|
| R1 request + message mapping (51-229)        | 53 (33 surv + 20 nocov)     | 0 residual, 169 killed             | 100.0% |
| R2 response + usage/stop maps (231-314)      | 14 (14 surv + 0 nocov)      | 0 residual, 109 killed, 2 annot.   | 100.0% |
| R3 streaming aggregator (315-530)            | 74 (survivors + nocov)      | 12 surv, 0 nocov, 1 annot.         | 95.4%  |
| R4 error-classify + SSE-drain + adapter (532-703) | 41 (29 surv + 12 nocov) | 0 residual, 129 killed + 2 to, 10 annot. | 100.0% |
| **Whole file**                               | **73.9% (514/696)**         | **98.22% (664/676)**               | +24.3pt |
| **Whole repo (aggregate)**                   | **~85.2%**                  | **86.84% (8979/10340)**            | +1.6pt |

### Ratchet (D5)

`thresholds.break` 82 → **83**; `low` 82 → 83 to keep `break <= low <= high` (high
stays 85). Aggregate 86.84% leaves 3.84pt of headroom above break=83, at/above the
established ~3pt cushion that absorbs the 91 timing-sensitive Timeout mutants (they
count as killed and can flip Survived on a slow run). break=84 would leave only
2.84pt — under the cushion — so 83 is the disciplined upward step D5 anticipated.

### Equivalents / annotated survivors

**Inline `// Stryker disable next-line` annotations (13 Ignored mutants):**

- **L233** (R2) `ConditionalExpression` ×2 — `passthrough === undefined ? body : { ...body, ...passthrough }`. The passthrough is a no-op merge, so `{ ...body, ...undefined }` deep-equals the fast-path return; only the merge branch is observable.
- **L368** (R3) `ArrayDeclaration` — the stream content accumulator. A seeded initial element is dropped by `parse_messages_response`'s block guard, so a non-empty content array is unobservable.
- **L548** (R4) `ConditionalExpression` + `LogicalOperator` ×5 — `extract_error_message`'s `parsed` object guard. The enclosing try/catch funnels every non-object parse to the raw snippet, so forcing the guard true/false throws-and-catches to the same fallback.
- **L553** (R4) `ConditionalExpression` + `LogicalOperator` ×5 — same shape for the nested `error` object guard: a non-object error still reaches the raw-snippet fallback.

**R3 whole-condition guard survivors (12, not annotated by design):**

L324/326/328, 378, 387, 422, 427, 442, 485, 489, 505, 524 — whole-condition
`ConditionalExpression` mutants on the aggregator's `x === null || typeof x !== 'object'`
guards. These are a Stryker 9.6.1 / vitest 4.1.10 blind spot: the new async tests
provably kill them (verified four ways at step 3) but the runner reports Survived. Left
unannotated on purpose — a per-line `Stryker disable` would also suppress the *killed*
sub-expression mutants on those lines, losing real coverage signal. Two (L485 event-guard
right operand, L524 switch default) are genuine equivalents. File still scores 98.22%,
above the ~96.5% sibling bar. Logged to the mutation-landscape memory.

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends a dated line here
every time a step lands — via `/pb-build` or `/pb-verify` — so this
fills in as you go, not at the end. Add your own decision/event lines too: this is what
you point at to say "I did that — the LLM helped, but those were my calls."
`/pb-finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*
- 2026-07-12 — step 1 checkpointed · 63e168059 — Harden the request + message-mapping region (51-229) (26m)
- 2026-07-12 — step 2 checkpointed · 84ef0d486 — Harden the response + usage/stop maps (231-314) (16m)
- 2026-07-12 — step 3 checkpointed · da27020a1 — Harden the streaming aggregator (315-530) (75m)
- 2026-07-12 — step 4 checkpointed · 8d0131a41 — Harden error-classification + SSE-drain + adapter (532-703) (22m)

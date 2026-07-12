<!--
build-log.md — your live ledger for execution. Append constantly; reorganize at
step boundaries. The antidote to "my plan got lost in the noise."

  Steps     : where you are. One step in flight at a time.
  Park list : where ideas go so you do not chase them. CAPTURE, never act inline.
  Harvest   : the boundary ritual that keeps you on one branch.
  Log       : the build's history. `plumbbob checkpoint` appends a line per step as it
              lands; feeds the /pb-finish report, which rides the branch into the PR.
-->

# Build log — Harden generate.ts + tool_loop.ts mutation coverage

**Current step:** none (at the boundary)
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status. Only ONE step is in flight. A step
is done only after a checkpoint — check green + checkpoint taken, via `/pb-verify` or
`/pb-build`.)*

- ☑ 1. Harden generate.ts helpers + timeout/retry machinery (96-420)
- ☑ 2. Harden generate() body A: invoke dispatch + streaming (422-549)
- ☐ 3. Harden generate() body B: HITL + schema-repair + cost + finish (550-726)
- ☐ 4. Harden tool_loop.ts helpers + apply_prepare_step (149-352)
- ☐ 5. Harden tool_loop.ts run_tool_loop body (354-851)
- ☐ 6. Final gate + ratchet

## Step 1 results — generate.ts helpers + timeout/retry machinery

Scoped non-incremental mutation on `src/engine/generate.ts` (whole file):
**77.61% -> 84.46%** killed (452 -> 487 killed, 109 -> 73 survived, 22 -> 17
no-coverage, 6 ignored). The step-1 region (split_leading_system_messages,
classify_provider_error, arm_turn_timeout, retry_turn, build_native_invoke)
reaches **zero no-coverage** and every killable mutant killed; the 65 remaining
survivors + 17 no-coverage are all in the step 2-5 regions (L432+).

Tests added: 4 for `split_leading_system_messages` (generate_helpers.test.ts);
option-forwarding present/absent/system-hoist + on_chunk-throw + untimed
passthrough + generous-budget-no-divert + fake-timer dispose (turn_timeout.test.ts
+ native_loop_inheritance.test.ts). Extended existing mid-stream tests to assert
the exact aborted_error message/reason and provider_error cause_kind.

### Annotated equivalents (6 Ignored, inline `// Stryker disable next-line`)

- **L126** `OptionalChaining` — `m?.role`: m is always in-bounds within the loop
  guard, so `m.role` reads identically.
- **L234** `ArrowFunction` — `timed_out: () => false` -> `() => undefined`: only
  consumer is `if (deadline.timed_out())`, where both are falsy.
- **L374** `BlockStatement` (was no-coverage) — the pre-abort guard
  `if (turn_abort.aborted)`. Unreachable: retry_with_policy re-checks
  abort.aborted at the top of every attempt and there is no await before this
  synchronous read, so the composed turn_abort is never already-aborted at
  call_once entry.
- **L378** `ObjectLiteral` + `BooleanLiteral` — `{ once: true }`: cleanup
  optimization; the abort event is terminal and the finally removes the listener.
- **L413** `StringLiteral` — the removeEventListener event name: unobservable
  cleanup (see finally note).

### Documented survivors (8, not annotated by design)

- **L123** `EqualityOperator` `<` -> `<=` — genuine equivalent (reads one past the
  end, hits the undefined->break guard, never pushes). Left unannotated because a
  per-line `EqualityOperator` disable would also suppress the *killed* `<` -> `>=`
  twin on the same line.
- **L142/155/161/171** `ConditionalExpression => true` — the four
  classify_provider_error whole-condition guards. Stryker 9.6.1 / vitest 4.1.10
  phantom survivors: the generate_helpers unit tests provably kill them (verified
  by applying each mutation by hand: 8 / 6 / 2 / 4 test failures respectively) but
  the runner reports Survived. Left unannotated so the killed `=> false` twins on
  those lines keep their signal.
- **L310** `ConditionalExpression => false` — retry_turn's below-loop
  `if (err instanceof aborted_error) throw err`. Genuine equivalent:
  classify_provider_error passes an aborted_error through unchanged, so
  `throw err` and `throw classify(err)` are identical. Cannot annotate without
  suppressing the killed `=> true` twin.
- **L374** `ConditionalExpression => false` — the pre-abort guard forced false =
  current behavior (branch never taken). Cannot annotate without suppressing the
  killed `=> true` twin (already covered by the BlockStatement annotation above).
- **L411** `BlockStatement` — the finally's listener-removal block. Genuine
  equivalent (with { once: true } + attempt-scoped signal a leaked listener is
  unobservable); a leading `// Stryker disable` cannot attach to a `} finally {`
  line without reformatting, so documented instead.

## Step 2 results — generate() dispatch + invoke construction

Scoped mutation on `src/engine/generate.ts`: **84.46% -> 88.56%** (487 -> 509
killed, 73 -> 54 survived, 17 -> 12 no-coverage, 6 -> 8 ignored). The step-2 region
(upfront-abort guard, capability gating, option resolution, ai_sdk-vs-native invoke
construction) reaches **zero no-coverage**.

Tests added to generate.test.ts: pre-aborted signal rejected before a span opens
(kills the abort guard via a span-count spy, since run_tool_loop's own abort check
otherwise masks it); provider_capability_error naming schema / tools / streaming
(capability_overrides); schema-free and tool-free calls on non-capable adapters
(false-branch coverage); exact turn_timeout_ms config message; positive-budget
success; default_system applied vs call-override; anthropic provider-name fallback
on a multi-adapter engine; effort_ignored recorded on high vs not on none; empty
provider_options merge omitted.

### Annotated equivalents (2 new Ignored)

- **L505** `LogicalOperator` + `StringLiteral` — `effort !== 'none' && effort_ignored`:
  no adapter reports effort_ignored for effort 'none', so `&&` vs `||` and `'none'`
  vs `''` cannot change whether the event records. (The ConditionalExpression twins
  are covered by the effort tests.)

### Documented survivors (5 `ConditionalExpression => true`, not annotated)

Each has a *killed* `=> false` twin on its line, so a per-line disable would
suppress real signal.

- **L456:39** — `engine.default_system !== undefined` sub-guard. Genuine equivalent
  (verified: forcing it true only sets opts.system = undefined when the default is
  undefined, a no-op; full suite passes under the mutation).
- **L459:7** — `if (merged_provider_options !== undefined)`. Genuine equivalent
  (forcing true assigns undefined over the identical spread value; full suite passes).
- **L494:7** — the `turn_timeout_ms <= 0` gate. Phantom (verified killed: forcing
  true rejects every call, 50 test failures) but reported Survived.
- **L505:9** — the `effort_ignored` gate. Phantom (verified killed by the
  effort-none test, 1 failure).
- **L517:7** — the combined-provider_options `length > 0` gate. Phantom (verified
  killed by the empty-merge test, 1 failure; merge returns `{}` not undefined, so
  the guard is real).

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

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends a dated line here
every time a step lands — via `/pb-build` or `/pb-verify` — so this
fills in as you go, not at the end. Add your own decision/event lines too: this is what
you point at to say "I did that — the LLM helped, but those were my calls."
`/pb-finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*
- 2026-07-12 — step 1 checkpointed · 4092f1f15 — Harden generate.ts helpers + timeout/retry machinery (96-420) (36m)

# Red-Green-Refactor harness

A fascicle example that codifies Kent Beck's TDD loop as a runnable agent harness. It drives Claude Code (via the `claude_cli` provider) through one full **Red → Green → Refactor** cycle per behavior, with structural backstops that prevent the model from splatting tests or "fixing" failures by editing the test.

## Why

LLMs love to splat 90 tests in a single edit and one-shot an implementation that passes all of them. That produces a lot of weak tests. The fix is to force one test → implementation → next test, and to verify each transition with an oracle the model can't fake. This harness wires up exactly that:

- **Oracle** — a real `vitest run` against the toy module. Exit code is the only signal each phase trusts.
- **Backstop** — `*.test.ts` files are snapshotted before RED and frozen during GREEN/REFACTOR. RED is gated on "exactly one new `it(...)` was added"; GREEN/REFACTOR are gated on "no test file changed."
- **Loop bound** — GREEN is an `adversarial` loop with `max_rounds: 4`; the whole cycle is wrapped in a 10-minute `timeout` per behavior.

## Layout

```text
examples/red-green-refactor/
├── package.json            workspace package; declares vitest + tsx
├── vitest.config.ts        runs the toy's tests only
├── src/
│   ├── main.ts             CLI driver — iterates SEED_BEHAVIORS one at a time
│   ├── harness.ts          the RGR cycle as a fascicle Step (scope/stash/use)
│   ├── oracle.ts           shells out to vitest, returns TestVerdict
│   ├── backstop.ts         test-file snapshots + structural assertions
│   ├── prompts.ts          per-phase prompt builders
│   └── behaviors.ts        the seed list of behaviors to drive
└── toy/
    └── src/
        ├── calculator.ts          empty stub the agent fills in
        └── calculator.test.ts     placeholder sanity test
```

## How the flow is built

The cycle is a single `scope` so we can `stash` the Behavior at the top and `use` it inside each phase, even though the phases mostly emit other types (`TestVerdict`, `GenerateResult`):

```ts
scope([
  stash('behavior',          step('init', (b: Behavior) => b)),
  stash('snapshot_before',   step('snap', () => snapshot_tests())),
  red_phase,        // assert vitest red AND exactly one new it(...)
  green_phase,      // adversarial loop until vitest green; tests must be frozen
  refactor_phase,   // optional cleanup; tests must still pass and remain frozen
]);
```

GREEN uses fascicle's `adversarial` composer:

```ts
adversarial<Behavior, TestVerdict>({
  build: sequence([
    step('prompt', (i) => green_prompt(i.input, i.prior)),  // sees prior verdict on retry
    ask, discard, run_tests,
  ]),
  critique: step('verdict', (v) => ({ verdict: v.passed ? 'pass' : 'fail', notes: v.tail })),
  accept:    (c) => c.verdict === 'pass',
  max_rounds: 4,
});
```

The whole cycle is wrapped in `timeout(cycle, 10 * 60 * 1000)` so a stuck behavior cannot burn the whole budget.

## Running it

This example needs `claude` on PATH and an authenticated session (`claude login`). The harness drives Claude Code as a subprocess via the `claude_cli` adapter.

From the repo root:

```bash
pnpm install                                        # picks up the example workspace package
pnpm --filter @repo/example-red-green-refactor rgr  # runs main.ts
```

Trajectory logs are written to `examples/red-green-refactor/.trajectory/<behavior_id>.jsonl`, one file per behavior.

To run just the toy's vitest manually (to see the oracle in isolation):

```bash
pnpm --filter @repo/example-red-green-refactor test:toy
```

## Tuning the loop

- **Behaviors.** Edit `src/behaviors.ts`. Each entry is one slice of intent — the prompt + backstop force the agent to add one test for it before any implementation appears.
- **GREEN budget.** `GREEN_MAX_ROUNDS` in `src/harness.ts`. Each round is one full prompt + vitest run; raise it for harder behaviors, lower it to fail faster on stuck ones.
- **Per-behavior timeout.** `PER_BEHAVIOR_TIMEOUT_MS` in `src/harness.ts`.
- **Backstop strictness.** `assert_one_test_added` and `assert_tests_unchanged` in `src/backstop.ts`. The current rule is "+1 net test definitions in RED; zero byte changes to test files in GREEN/REFACTOR." Loosen if your domain genuinely needs paired tests per slice.

## Final gate

The harness's per-phase oracle is `vitest`. It is the inner-loop signal, not the project "done" signal. After a full run, run the project gate as the contract requires:

```bash
pnpm check:all
```

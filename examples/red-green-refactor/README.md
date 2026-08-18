# Red-Green-Refactor harness

A fascicle example that codifies Kent Beck's TDD loop as a runnable agent harness. It drives Claude Code (via the `claude_cli` provider) through one full **Red → Green → Refactor** cycle per behavior, with structural backstops that prevent the model from splatting tests or "fixing" failures by editing the test.

## Why

LLMs love to splat 90 tests in a single edit and one-shot an implementation that passes all of them. That produces a lot of weak tests. The fix is to force one test → implementation → next test, and to verify each transition with an oracle the model can't fake. This harness wires up exactly that:

- **Oracle** — a real `vitest run` against the toy module. Exit code is the only signal each phase trusts.
- **Backstop** — `*.test.ts` files are snapshotted before RED and frozen during GREEN/REFACTOR. RED is gated on "exactly one new `it(...)` was added"; GREEN/REFACTOR are gated on "no test file changed."
- **Loop bound** — GREEN is an `adversarial` loop with `max_rounds: 4`; the whole cycle is wrapped in a 10-minute `timeout` per behavior.

## Layout

Laid out per [docs/blueprint.md](../../docs/blueprint.md): one composition layer, one `create_engine` call site, markdown prompts, IO behind ports.

```text
examples/red-green-refactor/
├── package.json            workspace package; declares vitest + tsx
├── vitest.config.ts        runs the toy's tests only
├── rules/                  the blueprint's ast-grep rules (pnpm check:rules)
├── src/
│   ├── main.ts             the shell — iterates SEED_BEHAVIORS one at a time
│   ├── flow.ts             THE composition layer: the RGR cycle as one Step
│   ├── engine.ts           the only create_engine call site
│   ├── types.ts            Behavior, TestVerdict, Snapshot, FlowModels
│   ├── messages.ts         per-phase user messages (format_*)
│   ├── backstop.ts         pure structural assertions over snapshots
│   ├── behaviors.ts        the seed list of behaviors to drive
│   ├── prompts/
│   │   ├── coder.md        the coder role, as markdown with frontmatter
│   │   └── load.ts         frontmatter + body loader
│   ├── stages/
│   │   └── coder.ts        make_coder_step: the one model_step factory
│   ├── services/
│   │   ├── vitest.ts       spawns vitest, returns TestVerdict (TestOracle port)
│   │   └── snapshot.ts     reads the toy's test files (Snapshotter port)
│   └── __tests__/
│       └── flow.test.ts    the whole cycle, stub engine + scripted ports
└── toy/
    └── src/
        ├── calculator.ts          empty stub the agent fills in
        └── calculator.test.ts     placeholder sanity test
```

The oracle and the snapshotter reach `flow.ts` as ports on `FlowEnv` rather than being called directly, which is what lets `__tests__/flow.test.ts` script a phase sequence (RED fails, GREEN passes, REFACTOR edits a test) and assert the harness reacts correctly, without spawning a subprocess or running a test suite inside a test suite.

## How the flow is built

The cycle is a single `chain` whose stage barriers mark the three phases; the behavior and both snapshots thread through typed bindings, so each phase reads exactly what it names:

```ts
chain<Behavior, 'behavior'>('behavior')
  .step('before_red', () => env.snapshot())
  .stage('red')       // ask → run tests → assert red → exactly one new it(...)
  .stage('green')     // adversarial loop until vitest green; tests must be frozen
  .stage('refactor')  // optional cleanup; tests must still pass and remain frozen
  .output(() => undefined);
```

GREEN uses fascicle's `adversarial` composer:

```ts
adversarial<Behavior, TestVerdict>({
  build: step('green_round', async (i, ctx) => {
    await ctx.call(ask, format_green_message(i.input, i.prior));  // sees prior verdict on retry
    return ctx.call(run_tests, undefined);
  }),
  critique: step('verdict', (v) => ({ verdict: v.passed ? 'pass' : 'fail', notes: v.tail })),
  accept:    (c) => c.verdict === 'pass',
  max_rounds: 4,
});
```

The whole cycle is wrapped in `timeout(cycle, 10 * 60 * 1000)` so a stuck behavior cannot burn the whole budget.

## Running it

This example needs `claude` on PATH and an authenticated session (run `claude` and use `/login`, or `claude setup-token`). The harness drives Claude Code as a subprocess via the `claude_cli` adapter.

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
- **GREEN budget.** `GREEN_MAX_ROUNDS` in `src/flow.ts`. Each round is one full prompt + vitest run; raise it for harder behaviors, lower it to fail faster on stuck ones.
- **Per-behavior timeout.** `PER_BEHAVIOR_TIMEOUT_MS` in `src/flow.ts`.
- **Backstop strictness.** `assert_one_test_added` and `assert_tests_unchanged` in `src/backstop.ts`. The current rule is "+1 net test definitions in RED; zero byte changes to test files in GREEN/REFACTOR." Loosen if your domain genuinely needs paired tests per slice.

## Final gate

The harness's per-phase oracle is `vitest`. It is the inner-loop signal, not the project "done" signal. After a full run, run the project gate as the contract requires:

```bash
pnpm check:all
```

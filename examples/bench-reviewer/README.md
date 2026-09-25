# bench-reviewer

Drives the `bench` primitive against the markdown-defined `reviewer` agent.
Cases come from `bench/reviewer/cases.json` at the repo root, so the example
file stays focused on the wiring. Two judges score each case: one checks that
at least one finding's category matches the expected category, and the other
checks that the worst finding's severity matches the expected severity.

![terminal output of the bench-reviewer example: pass rate, mean judge scores, cost, and the no-regressions verdict](./screenshot.png)

The engine is a stub that returns canned, schema-conforming findings keyed by
case id. Swap `make_stub_engine` for `create_engine({...})` to drive the same
flow against a real provider. The agent definition itself is demo code in
[`../agents/`](../agents/); copy it alongside this example when porting it
into your own project.

## Flow

`bench` is a function rather than a Step, and the flow it runs is the single
`reviewer` step, so this tree draws the program around it.

```text
run_bench_reviewer       score the reviewer on bench/reviewer/cases.json
├─ bench                 run all three cases at once, then judge each output
│  ├─ reviewer           the model call; the stub picks a canned reply by case
│  ├─ flagged_correctly  pure: 1 if a finding has the expected category
│  └─ severity_match     pure: 1 if the worst severity is the expected one
├─ write_baseline        with WRITE_BASELINE=1, save the report and stop
└─ regression_compare    otherwise diff against baseline.json, exit 1 if worse
```

## Run

```bash
WRITE_BASELINE=1 pnpm exec tsx examples/bench-reviewer/main.ts
pnpm exec tsx examples/bench-reviewer/main.ts
```

The first command records a baseline. Subsequent runs compare against
`bench/reviewer/baseline.json` and exit 1 on regression.

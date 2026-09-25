# adversarial-build

The build-and-critique pattern with ensemble judging. A candidate is produced,
a critique judges it, and the loop repeats until the critique accepts. Here
the critique is an ensemble of judges that each score the candidate, and the
best-scoring verdict wins.

![terminal output of the adversarial-build example: the accepted candidate, convergence flag, and round count](./screenshot.png)

Every step is a deterministic stub, so the example runs with no engine layer,
no network, and no LLM calls.

## Flow

```text
adversarial                             compose: rebuild until pass or 3 rounds
└─ loop
   ├─ scope
   │  ├─ stash
   │  │  └─ snapshot                    step
   │  ├─ to_build_input                 step
   │  ├─ build                          stub: wrap the brief as a candidate
   │  └─ use
   └─ guard  scope
      ├─ stash
      │  └─ snapshot                    step
      ├─ extract_candidate              step
      ├─ ensemble                       compose: the most confident judge wins
      │  └─ sequence
      │     ├─ parallel
      │     │  ├─ opus  judge_opus      stub: pass at confidence 0.9
      │     │  ├─ sonnet  judge_sonnet  stub: pass at confidence 0.8
      │     │  └─ haiku  judge_haiku    stub: pass at confidence 0.6
      │     └─ pick_winner              step
      └─ use
```

## Run

```bash
pnpm exec tsx examples/adversarial-build/main.ts
```

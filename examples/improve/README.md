# improve

Bounded online self-improvement with a toy scoring function. The flow
optimizes a single integer toward a fixed target: the propose step walks
`parent + 1` each round, and the score step rewards proximity to the target
via `-(value - TARGET)^2`. Once the loop overshoots, plateau detection trips
and the run stops.

![terminal output of the improve example: nine rounds of proposals with scores climbing to zero, stopped by plateau detection](./screenshot.png)

Every step is pure TypeScript: no engine layer, no network, no LLM calls.

## Flow

```text
improve                                                 compose: stop on 2 flat rounds, or 12 max
└─ scope
   ├─ seed                                              start at 0, scored -49
   ├─ improve_init_state                                step
   ├─ loop
   │  ├─ scope
   │  │  ├─ stash
   │  │  │  └─ improve_snapshot                         step
   │  │  ├─ improve_to_round_input                      step
   │  │  ├─ improve_round                               compose
   │  │  │  └─ scope
   │  │  │     ├─ stash
   │  │  │     │  └─ parallel
   │  │  │     │     └─ p0  propose                     the lone proposer walks parent + 1
   │  │  │     ├─ ensemble_step_to_pairs                step
   │  │  │     ├─ map
   │  │  │     │  └─ scope
   │  │  │     │     ├─ stash
   │  │  │     │     │  └─ ensemble_step_item_snapshot  step
   │  │  │     │     ├─ ensemble_step_extract_value     step
   │  │  │     │     ├─ score                           pure: -(value - 7)^2, zero at the target
   │  │  │     │     └─ use
   │  │  │     └─ use
   │  │  ├─ use
   │  │  └─ use
   │  └─ guard  improve_guard                           step
   └─ improve_stop                                      step
```

## Run

```bash
pnpm exec tsx examples/improve/main.ts
```

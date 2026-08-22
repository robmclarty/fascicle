# ensemble-judge

Pick the best of N judges. Three stand-in judges score a shared input, and
the winner is the one with the highest confidence. This is the canonical
"N-of-M pick best" pattern.

![terminal output of the ensemble-judge example: the winning verdict and the per-judge confidence scores](./screenshot.png)

Every step is a deterministic stub: no engine layer, no network, no LLM calls.

## Run

```bash
pnpm exec tsx examples/ensemble-judge/main.ts
```

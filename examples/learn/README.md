# learn

Offline self-improvement over a recorded trajectory. The example synthesizes
a tiny JSONL trajectory file in a temp directory, then runs `learn` with a
trivial analyzer that tallies events by kind and emits one "improvement"
proposal per kind.

![terminal output of the learn example: the events considered, the run ids, and one proposal per event kind](./screenshot.png)

The analyzer is pure TypeScript: no engine layer, no network, no LLM calls.

## Run

```bash
pnpm exec tsx examples/learn/main.ts
```

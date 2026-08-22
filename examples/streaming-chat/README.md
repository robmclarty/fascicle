# streaming-chat

Observe token-like events through `run.stream()`. A step emits a small
sequence of chunks via `ctx.emit`, and the caller iterates the event stream
as the flow runs. The final result equals what plain `run(...)` would return.

![terminal output of the streaming-chat example: the emitted tokens and the identical final result](./screenshot.png)

Every step is a deterministic stub: no engine layer, no network, no LLM calls.

## Run

```bash
pnpm exec tsx examples/streaming-chat/main.ts
```

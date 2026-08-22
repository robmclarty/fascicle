# hitl-http

End-to-end human-in-the-loop over HTTP. A flow drafts something, then
`suspend`s at an approval gate. `run.until_suspended` reports the pause as a
typed outcome; the server stashes the outcome's `resume` closure under an id
and returns a pending record (the "confirmation UI" payload). A human (here,
a scripted client) fetches the pending record, decides, and POSTs the
decision back; the server calls `resume(decision)` and returns the final
result. Nothing blocks a socket while the human decides.

![terminal output of the hitl-http example: the pending status code and the resumed result after approval](./screenshot.png)

The store is an in-memory Map for brevity, and a closure cannot outlive the
process: a real deployment persists the original input (for example,
`filesystem_store` from `fascicle/adapters`, a DB, or a queue) and calls
`run.until_suspended` again after a restart to rebuild the outcome.

Every step is a deterministic stub: no engine layer, no network beyond
localhost, no LLM calls.

## Run

```bash
pnpm exec tsx examples/hitl-http/main.ts
```

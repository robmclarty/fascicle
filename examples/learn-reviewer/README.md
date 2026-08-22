# learn-reviewer

An end-to-end demo that combines the `reviewer` agent with `learn`. First it
runs the markdown-defined `reviewer` agent on three hand-crafted diffs and
writes each run's trajectory to its own JSONL file via `filesystem_logger`.
Then it runs the `learn` composer over the directory of trajectories with a
pure-TypeScript analyzer that aggregates `agent.call` token usage and
proposes prompt-tightening improvements.

![terminal output of the learn-reviewer example: per-agent token usage aggregated across three runs and a prompt-tightening proposal](./screenshot.png)

The engine is a stub that returns canned, schema-conforming findings, so the
demo proves the wiring without any API keys. Swap `make_stub_engine` for
`create_engine({...})` to drive the same flow against a real provider. The
agent definition itself is demo code in [`../agents/`](../agents/); copy it
alongside this example when porting it into your own project.

## Run

```bash
pnpm exec tsx examples/learn-reviewer/main.ts
```

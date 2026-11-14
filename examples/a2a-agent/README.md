# a2a-agent

One flow served as an [Agent2Agent](https://a2a-protocol.org) (A2A) agent, and
a second flow that calls it, with a restart in the middle. Every A2A task is a
durable run, so the task that waits for its answer outlives the server that
opened it.

The served agent writes release notes. It drafts them, stops at a gate to ask
whether to publish, and publishes once someone says yes:

1. `serve_a2a` serves the notes flow on a free local port. Its runs and its
   task records share one SQLite file in a temporary directory.
2. A second flow, driven by its own `durable` over `memory_store`, asks the
   agent for notes on v1.2 through an `a2a_step`. The agent's question comes
   back as a gate on the caller's own run, so both sides are now waiting.
3. The example closes the server and serves the same flow again over the same
   file. The new server reads the task back, still waiting for its answer.
4. The caller's run resumes with `{ approved: true }`. The answer goes to the
   task that the first server opened, and the second server finishes it.

The draft sits inside a `checkpoint`, so the answer in step 4 doesn't pay for
it a second time.

Every step is a deterministic stub, and the only network is localhost. Pass
`--model` to have a model draft the notes instead, on OpenRouter unless
`--provider` names another. [`../acp-agent/engines.ts`](../acp-agent/engines.ts)
lists the providers, along with the key that each one reads.

## Flow

```text
release_notes  sequence: draft release notes and publish them once they are approved
├─ checkpoint  keep the draft, so the answer never pays for it again
│  └─ draft    draft the notes, the part that would cost money
├─ approve     suspend: ask whoever sent the task whether to publish
└─ publish     publish what was approved
```

## Run

```bash
pnpm exec tsx examples/a2a-agent/main.ts
pnpm exec tsx examples/a2a-agent/main.ts --model anthropic/claude-sonnet-5.5
```

The output shows each state the task passes through, as the caller hears of
it:

```text
serving release-notes at http://127.0.0.1:64841
asking for notes on v1.2
  task TASK_STATE_WORKING
  task TASK_STATE_INPUT_REQUIRED
the agent asks: Waiting for input at "approve".
restarting the agent over the same file
  task TASK_STATE_INPUT_REQUIRED (read back from the new server)
answering: approved
  task TASK_STATE_WORKING
  task TASK_STATE_COMPLETED
done: Published. v1.2: faster cold starts, and the export bug is fixed.
```

[docs/a2a.md](../../docs/a2a.md) covers the rest: gates that something other
than the client answers, streaming, authentication, and the stores.

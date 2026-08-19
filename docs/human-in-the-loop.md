# Human-in-the-Loop

fascicle gives you two shapes for putting a person in the loop, and they solve
different problems. Pick by whether you can afford to hold the process open:

- **Asynchronous approval (`suspend` / resume).** The flow pauses, unwinds, and
  hands control back to your program. A human decides minutes, hours, or days
  later, out of band. Nothing holds a socket or a process open while you wait.
- **Synchronous approval (`on_tool_approval`).** A tool call blocks inside a
  single run until a handler returns yes or no. Right when the decision is fast
  and in-band, like a confirm dialog on a request that's already in flight.

## Asynchronous: Suspend and Resume

`suspend(...)` fires an `on(...)` side effect (notify a human), then pauses
the run. Drive the flow with `run.until_suspended`, which reports the pause
as a typed outcome instead of an exception. You get `{ kind: 'done', output }`
when the flow completes, or `{ kind: 'suspended', id, payload, resume }` when a
gate fires. `payload` carries the value that the suspend gate surfaced (the draft
awaiting approval, say), so the harness can render what's being decided
without re-deriving it. When the decision arrives, call `resume(data)`. That
re-runs the flow with the decision keyed under the gate's id, the flow continues
into `combine`, and the promise resolves to the next outcome, so you drive
several gates by resuming repeatedly. Real errors still throw.

<!-- snippet: check -->

```ts
import { run, sequence, step, suspend } from 'fascicle';
import { z } from 'zod';

const flow = sequence([
  step('draft', ({ brief }: { brief: string }) => ({ brief, draft: `PR for ${brief}` })),
  suspend({
    id: 'approve',
    on: () => {
      // Notify a human out of band (Slack, email, a task queue). The run then
      // unwinds; nothing blocks while you wait for the decision.
    },
    resume_schema: z.object({ approved: z.boolean() }),
    combine: (drafted: { brief: string; draft: string }, resume) =>
      resume.approved ? `merged: ${drafted.draft}` : `discarded: ${drafted.draft}`,
  }),
]);

export async function drive(input: { brief: string }): Promise<string> {
  const outcome = await run.until_suspended(flow, input);
  if (outcome.kind === 'done') return outcome.output;
  // Persist `input` keyed by an id, return control to your server, and wait.
  // Later, when the human approves, resume with the decision:
  const resumed = await outcome.resume({ approved: true });
  if (resumed.kind !== 'done') throw new Error('a later gate suspended again');
  return resumed.output;
}
```

The underlying signal is still a thrown `suspended_error`, so if you'd rather
call plain `run(...)` you can catch it and re-run with
`{ resume_data: { [id]: data } }` yourself. `run.until_suspended` packages
exactly that dance for you.

Two things to know before you ship this:

- **Resume replays from the original input.** `resume(...)` re-executes every
  step before the suspend point. That's harmless for pure steps, but wrap any
  expensive or side-effecting prior step in `checkpoint(...)` against a
  `checkpoint_store` so it's memoized instead of repeated on resume.
- **Persist the suspended input durably.** The outcome's `resume` is a
  closure, so it can't outlive the process. An in-memory map is fine for a demo,
  but a real deployment persists the original input (`filesystem_store` from
  `fascicle/adapters`, a database, a queue) and calls
  `run.until_suspended` again after a restart to rebuild the outcome.

> **Paid steps replay on resume.** Resuming after a process restart replays
> every step before the gate that isn't checkpointed, and that includes paid
> model calls. The provider bills the replay like any other call. Wrap your paid
> leaves in `checkpoint(...)` with a `checkpoint_store` before any `suspend`
> gate, and a resume reads the memoized result instead of buying it again.

The packaged form of that rule is the `gate` composite:

```ts
import { gate } from 'fascicle';

const approved = gate(draft_step, { id: 'approve', store });
```

`gate` runs the inner step, checkpoints its result under `gate:<id>`, then
suspends with the result as the payload (`format` projects the approver's view,
and the store always holds the raw result). A resume, or a fresh run after a
restart with the same store, serves the inner result from the checkpoint instead
of re-running it, so you don't pay for the model call twice, and approval passes
the inner result through unchanged. Reach for raw `checkpoint` plus `suspend`
when the approval decision has to shape the output (`combine`).

A complete server that runs this over HTTP (POST to start, GET the pending
approval, POST the decision to resume) is in
[`examples/hitl_http.ts`](../examples/hitl_http.ts). The minimal mechanical
version is [`examples/suspend_resume.ts`](../examples/suspend_resume.ts).

## Streaming the Outcome to a UI

Once a run is resumed, stream its model output straight to a `useChat` endpoint
(rendered by AI Elements or Streamdown) with `fascicle/ui`. It maps the run's
event stream onto the AI SDK UI message-stream protocol and returns an SSE
`Response` you can hand back from a route handler.

This subpath speaks the AI SDK's UI protocol, so it imports `ai` directly and is
the one subpath that needs that optional peer even on `transport: 'native'`. Run
`pnpm add ai`, because without it your import fails at module resolution.

<!-- snippet: check -->

```ts
import { create_engine, model_step, run } from 'fascicle';
import { to_ui_message_response } from 'fascicle/ui';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY ?? '' } },
});
const chat = model_step({ engine, model: 'claude-sonnet-4-6' });

export function chat_handler(): Response {
  return to_ui_message_response(
    run.stream(chat, 'Summarize the approved change.', { install_signal_handlers: false }),
  );
}
```

For a `node:http` server that holds a `ServerResponse` rather than returning a
web `Response`, use `pipe_ui_message_stream_to_response(handle, res)` from the
same module.

## Synchronous: Tool Approval

When the decision is in-band and immediate, gate a tool instead of suspending.
Flag the tool with `needs_approval` and pass an `on_tool_approval` handler to
`model_call`, and a denied call throws `tool_approval_denied_error`. See the tool
loop recipe in [docs/cookbook.md](./cookbook.md#tool-loops) for the full shape.

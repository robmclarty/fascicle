# Human-in-the-loop

fascicle gives you two shapes for putting a person in the loop, and they solve
different problems:

- **Asynchronous approval (`suspend` / resume).** The flow pauses, unwinds, and
  hands control back to your program. A human decides minutes, hours, or days
  later, out of band. Nothing holds a socket or a process open while you wait.
- **Synchronous approval (`on_tool_approval`).** A tool call blocks inside a
  single run until a handler returns yes or no. Right when the decision is fast
  and in-band (a confirm dialog on a request already in flight).

## Asynchronous: suspend and resume

`suspend(...)` fires an `on(...)` side effect (notify a human), then pauses
the run. Drive the flow with `run.until_suspended`, which reports the pause
as a typed outcome instead of an exception: `{ kind: 'done', output }` when
the flow completes, or `{ kind: 'suspended', id, resume }` when a gate
fires. When the decision arrives, call `resume(data)`; it re-runs the flow
with the decision keyed under the gate's id, the flow continues into
`combine`, and the promise resolves to the next outcome (so several gates
are driven by resuming repeatedly). Real errors still throw.

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

The underlying signal is still a thrown `suspended_error`, so a plain
`run(...)` caller can catch it and re-run with
`{ resume_data: { [id]: data } }` itself; `run.until_suspended` packages
exactly that dance.

Two things to know before you ship this:

- **Resume replays from the original input.** `resume(...)` re-executes every
  step before the suspend point. That is harmless for pure steps; wrap any
  expensive or side-effecting prior step in `checkpoint(...)` against a
  `checkpoint_store` so it is memoized rather than repeated on resume.
- **Persist the suspended input durably.** The outcome's `resume` is a
  closure, so it cannot outlive the process. An in-memory map is fine for a
  demo; a real deployment persists the original input (`filesystem_store`
  from `fascicle/adapters`, a database, a queue) and calls
  `run.until_suspended` again after a restart to rebuild the outcome.

A complete server that runs this over HTTP (POST to start, GET the pending
approval, POST the decision to resume) is in
[`examples/hitl_http.ts`](../examples/hitl_http.ts). The minimal mechanical
version is [`examples/suspend_resume.ts`](../examples/suspend_resume.ts).

## Streaming the outcome to a UI

Once a run is resumed, stream its model output straight to a `useChat` endpoint
(rendered by AI Elements or Streamdown) with `fascicle/ui`. It maps the run's
event stream onto the AI SDK UI message-stream protocol and returns an SSE
`Response` you can hand back from a route handler.

This subpath speaks the AI SDK's UI protocol, so it imports `ai` directly and is
the one subpath that needs that optional peer even on `transport: 'native'`:
`pnpm add ai`. Without it the import fails at module resolution.

<!-- snippet: check -->

```ts
import { create_engine, model_step, run } from 'fascicle';
import { to_ui_message_response } from 'fascicle/ui';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY ?? '' } },
});
const chat = model_step({ engine, model: 'sonnet' });

export function chat_handler(): Response {
  return to_ui_message_response(
    run.stream(chat, 'Summarize the approved change.', { install_signal_handlers: false }),
  );
}
```

For a `node:http` server that holds a `ServerResponse` rather than returning a
web `Response`, use `pipe_ui_message_stream_to_response(handle, res)` from the
same module.

## Synchronous: tool approval

When the decision is in-band and immediate, gate a tool instead of suspending.
Flag the tool with `needs_approval` and pass an `on_tool_approval` handler to
`model_call`; a denied call throws `tool_approval_denied_error`. See the tool
loop recipe in [docs/cookbook.md](./cookbook.md#tool-loops) for the full shape.

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

`suspend(...)` fires an `on(...)` side effect (notify a human), then throws
`suspended_error` carrying the run state. Your caller catches it, persists the
input, and returns. When the decision arrives, you re-run the same flow with
`resume_data` keyed by the suspend id, and the flow continues into `combine`.

<!-- snippet: check -->

```ts
import { run, sequence, step, suspend, suspended_error } from 'fascicle';
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
  try {
    return await run(flow, input);
  } catch (err) {
    if (!(err instanceof suspended_error)) throw err;
    // Persist `input` keyed by an id, return control to your server, and wait.
  }
  // Later, when the human approves, re-run with the decision:
  return run(flow, input, { resume_data: { approve: { approved: true } } });
}
```

Two things to know before you ship this:

- **Resume replays from the original input.** The second `run(...)` re-executes
  every step before the suspend point. That is harmless for pure steps; wrap any
  expensive or side-effecting prior step in `checkpoint(...)` against a
  `checkpoint_store` so it is memoized rather than repeated on resume.
- **Persist the suspended input durably.** An in-memory map is fine for a demo,
  but a process restart loses it. Use `filesystem_store` from `fascicle/adapters`,
  a database, or a queue so a pending approval survives a redeploy.

A complete server that runs this over HTTP (POST to start, GET the pending
approval, POST the decision to resume) is in
[`examples/hitl_http.ts`](../examples/hitl_http.ts). The minimal mechanical
version is [`examples/suspend_resume.ts`](../examples/suspend_resume.ts).

## Streaming the outcome to a UI

Once a run is resumed, stream its model output straight to a `useChat` endpoint
(rendered by AI Elements or Streamdown) with `fascicle/ui`. It maps the run's
event stream onto the AI SDK UI message-stream protocol and returns an SSE
`Response` you can hand back from a route handler:

<!-- snippet: check -->

```ts
import { create_engine, model_call, run } from 'fascicle';
import { to_ui_message_response } from 'fascicle/ui';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY ?? '' } },
});
const chat = model_call({ engine, model: 'sonnet' });

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

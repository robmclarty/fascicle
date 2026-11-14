# Human-in-the-Loop

Fascicle gives you two shapes for putting a person in the loop, and they solve
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
gate fires. `payload` is `{ input }`, where `input` is the value that reached
the suspend gate (the draft awaiting approval, say), so the harness can render
what's being decided without re-deriving it. When the decision arrives, call
`resume(data)`. That re-runs the flow with the decision keyed under the gate's
id, the flow continues into `combine`, and the promise resolves to the next
outcome, so you drive several gates by resuming repeatedly. Real errors still
throw.

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

Three things to know before you ship this:

- **Each id takes one decision per run.** Resume data is keyed by id, so a
  flow uses each `suspend` id once, and a run reaches each `suspend` once, or
  again on the same input, as a `retry` does when it runs the step again. If
  your flow holds one id in two places, the run refuses it before any step
  runs, with a `duplicate_suspend_id_error` whose `reason` is
  `declared_twice`, and its message names each place and tells you to give
  each `suspend` and `gate` an id of its own. A `gate` counts through the
  `suspend` inside it, and two arms of a `branch` count too, since a resume
  replays the branch's condition and could hand one arm's approval to the
  other. A run that reaches one `suspend` again on another input, in a later
  round of a `loop` or for the next item of a `map`, fails there with
  `reason: 'reached_twice'`, because its datum answered a question about the
  first input. When you want one decision for all of them, the message says
  how: approve a map's batch at a gate before the map, or a loop's result at
  a gate after it.
- **Resume replays from the original input.** `resume(...)` re-executes every
  step before the suspend point. That's harmless for pure steps, but wrap any
  expensive or side-effecting prior step in `checkpoint(...)` against a
  `checkpoint_store` so it's memoized instead of repeated on resume.
- **Persist the run if it has to outlive the process.** The outcome's
  `resume` is a closure, so it can't survive a restart. An in-memory map is
  fine for a demo. A deployment that restarts, or that resumes runs from
  events in short-lived invocations, should keep its runs with
  [`durable`](#durable-runs), which persists the input and the resume data for
  you.

> **Paid steps replay on resume.** Resuming after a process restart replays
> every step before the gate that isn't checkpointed, and that includes paid
> model calls. The provider bills the replay like any other call. Wrap your paid
> leaves in `checkpoint(...)` with a `checkpoint_store` before any `suspend`
> gate, and a resume reads the memoized result instead of buying it again.
> When the gate shows that result to an approver, pass both
> `on_write_error: 'fail'` and `on_read_error: 'fail'` to the `checkpoint`. A
> failed write then fails the run before anyone is asked, and a failed read
> fails it rather than run the step again. By default each is only recorded,
> so the run would go on, and a resume would run the step again and carry on
> with a result that nobody approved.
>
> Every `model_call` counts as a side effect, and so does any step you mark with
> `{ side_effect: true }`. When a resumed run runs one of them again before it
> reaches the gate it was resumed at, the trajectory records a `step_replayed`
> event that names the step, and you'll see a replay that costs money there
> long before it's on the bill.
>
> You don't have to wait for a resume to find them, either.
> `describe.replays(flow)` reads the flow's shape and names every marked step
> that can run before a gate with no checkpoint to protect it, so a test that
> expects it to come back empty catches them before anything runs. It can't see
> a model call that a step's body makes without declaring it as an `arm`, which
> is one more reason to declare your arms.

The packaged form of that rule is the `gate` composite:

```ts
import { gate } from 'fascicle';

const approved = gate(draft_step, { id: 'approve', store });
```

`gate` runs the inner step, checkpoints its result under `gate:<id>`, then
suspends with `{ input: result }` as the payload (`format` projects the
approver's view into `input`, and the store always holds the raw result). A
resume, or a fresh run after a restart with the same store, serves the inner
result from the checkpoint instead of re-running it, so you don't pay for the
model call twice, and approval passes the inner result through unchanged. A
store that fails the write fails the run before it suspends, since `gate` passes
`on_write_error: 'fail'` to its checkpoint.

A resumed gate never runs its inner step again. It serves the result that it
stored, which is the one the approver saw, or it fails the run with
`gate_result_error`. Its `reason` is `read_error` when the store failed the
read, and resuming again once the store reads finishes the run, since the
approval is still in its resume data. It's `missing` when the store no longer
holds the result, and then all you can do is delete the run and start it
again. It's `no_store` when the gate has no store at all, so a gate needs a
store to resume, either its own `store` or the run's `checkpoint_store`. When
the step is cheap and deterministic enough to run again on every resume, use a
plain `suspend` instead. If you hand a gate its approval through `resume_data`
before it ever suspended, it counts as resuming too, so it fails with
`missing`, or with `no_store` when it has no store, since nobody has seen
anything yet.

One run reaches a gate once per input. A gate's key is fixed, so in a `map` or
a `loop` it would serve one stored result to every item or round, when the
approver had seen only one of them. Instead it fails at the second item or round
with `duplicate_suspend_id_error` (`reason: 'reached_twice'`), before that
item runs the inner step, and a `retry` that runs the gate again on the same
input still passes. If you want one decision for all of them, approve a map's
batch at one gate before the `map`, or a loop's result at one gate after the
`loop`.

Reach for raw `checkpoint` plus `suspend` when the approval decision has to
shape the output (`combine`), and pass both `on_write_error: 'fail'` and
`on_read_error: 'fail'` to the checkpoint there. A hand-built pair can't tell a
first run from a resume, so it fails a first run's failed read as well, which
costs you a retry and never an approval of a result that nobody saw.

A complete server that runs this over HTTP (POST to start, GET the pending
approval, POST the decision to resume) is in
[`examples/hitl-http/main.ts`](../examples/hitl-http/main.ts). The minimal mechanical
version is [`examples/suspend-resume/main.ts`](../examples/suspend-resume/main.ts).

## Durable Runs

`run.until_suspended` works while the process that suspended a run is still
around to call `resume`. Plenty of deployments don't work that way. A review
bot that waits on CI, a job that hands work to a container, or anything that
runs in a short-lived function gets each event (a webhook, a finished task, a
deadline timer) in a fresh invocation, and by then the closure that could have
resumed the run is long gone.

With `durable`, you keep the run in a store instead. It saves the run's
input, the resume data that its gates have taken, and where it stopped, all
under one scope per run id. When an event lands, you hand it to the run, and
the driver runs the flow again from the input, so replay and checkpoints work
the same way they do with `run.until_suspended`.

<!-- snippet: check -->
```ts
import { durable, sequence, step, suspend } from 'fascicle';
import { filesystem_store } from 'fascicle/adapters';
import { z } from 'zod';

type Gathered = { pr: number; diff: string };

const review = sequence([
  step('gather', ({ pr }: { pr: number }): Gathered => ({ pr, diff: `diff of #${pr}` })),
  suspend({
    id: 'ci',
    deadline_ms: 60 * 60 * 1000,
    on: () => {
      // The push already started CI, so there's nobody to notify.
    },
    resume_schema: z.object({ green: z.boolean(), timed_out: z.boolean().optional() }),
    combine: (gathered: Gathered, ci) =>
      ci.green ? `review of the ${gathered.diff}` : `hold #${gathered.pr}`,
  }),
]);

const runs = durable({ store: filesystem_store({ root_dir: '.fascicle/runs' }) });

// A pull request opened.
export async function on_opened(pr: number): Promise<void> {
  const outcome = await runs.start(`pr-${pr}`, review, { pr });
  if (outcome.kind === 'suspended' && outcome.deadline_at !== undefined) {
    // Schedule on_ci(pr, { green: false, timed_out: true }) for deadline_at.
  }
}

// CI reported, or the deadline timer fired.
export async function on_ci(pr: number, ci: { green: boolean; timed_out?: boolean }): Promise<void> {
  await runs.resume(`pr-${pr}`, review, { ci });
}
```

`start` and `resume` both resolve to an outcome: `done` with the output,
`suspended` with the gate the run waits at, or `busy`. Here's what the driver
takes care of so that your handlers don't have to:

- **One drive at a time.** A drive holds a lease on its run and renews it while
  it works, and every write it makes lands only if nobody else has written the
  record since it read it, so a drive that stalls past its lease can't
  overwrite the one that took the run over. If you resume a run mid-drive, you
  get `busy` back, and the data you passed waits in the run's inbox, which is
  part of its record. The drive that holds the run takes it up when the run
  reaches that gate, and if that drive dies first, the next call on the run
  does (a resume with no data is enough to nudge it). A CI webhook and a
  deadline timer that land together can't both post the review.
- **Repeated events are safe.** If you start a run that already exists, it
  doesn't start over. A run that's waiting or done reports where it is, and
  one that failed or died mid-drive is driven again from its input. The first
  data to reach a gate is the data it gets, so a later event for the same gate
  is dropped, and so is data for a gate the run already passed, because
  changing it would change the replay. A webhook that's delivered twice
  changes nothing.
- **A bad event doesn't wedge the run.** When a gate's `resume_schema` refuses
  the data you sent, `resume` throws `resume_validation_error` and the run goes
  back to waiting at that gate. A step that throws marks the run failed, and
  the next event drives it again.
- **A changed flow fails loudly.** Each run records a fingerprint of its flow's
  shape, meaning the kinds, the ids you chose, and how they nest. If a deploy
  changes that shape while a run waits, the next drive throws
  `flow_changed_error` rather than replay different steps against old
  checkpoints. You can rename a step or edit a prompt without tripping it. Pass
  `on_flow_change: 'replay'` when you mean to move the waiting runs onto the
  new shape.
- **Deadlines start once.** A gate with `deadline_ms` reports `deadline_at` on
  its outcome, counted from the moment the run first stopped there. Schedule a
  timer for it (a queue message, a scheduler entry), and have the timer resume
  the gate with whatever a timeout means to your flow.

Everything the driver keeps (the input, resume data, gate payloads, and the
output) goes through the store, so it has to survive JSON, the same as any
checkpointed value. Even the first drive reads the input back from the store,
so a run sees it the same way on every drive.

Nothing in the store expires on its own. Call `runs.delete(run_id)` once
you're done with a run, and it clears everything that the run kept. When your
store has retention of its own (an S3 lifecycle rule on the run's prefix,
say), you can let that do the job instead.

[`examples/durable-runs/main.ts`](../examples/durable-runs/main.ts) drives one
run through all of this, with a start, a webhook and a timer that land
together, and a webhook that's delivered twice.

### The Store a Run Lives In

The store you hand to `durable` has to offer `scope`, `claim`, `release`,
`get_versioned`, and `set_if` on top of `get`, `set`, and `delete`. The last
two are a compare-and-set. `get_versioned` reads a value with its version, and
`set_if` writes only while the key is still at that version, or only while the
key is absent. The driver makes every write to a run's record through them,
which is what decides a race between two of your handlers, or between a drive
and an event that arrives while it works.

You get four stores in `fascicle/adapters`, and which one you want depends on
where your events land:

- **`filesystem_store`** holds your runs between the processes of one machine.
  Its claims and its conditional writes lean on the local filesystem being
  atomic, which a network filesystem doesn't promise, so don't share its
  directory between hosts.
- **`sqlite_store`** holds them between the processes of one machine too, in
  one file, on Node's built-in `node:sqlite`. SQLite runs each statement
  atomically across connections, so its claims and its conditional writes are
  one statement each. `sqlite_store({ path })` opens the file in WAL mode and
  waits `timeout_ms` (five seconds unless you say otherwise) on another
  connection's lock, and `close()` closes it.
- **`memory_store`** holds them for as long as the process lives. It's the
  store for a test, and for a server whose runs may end when it does.
- **`object_store`** holds them across a fleet. It keeps a run in a bucket,
  through a small client interface that you write over the SDK you already
  use, so when you run several instances of a web service, or workers on
  several machines, any of them can drive the same run.

```ts
import { durable } from 'fascicle';
import { object_store } from 'fascicle/adapters';
import { S3Client } from '@aws-sdk/client-s3';
import { s3_object_client } from './s3_object_client.js';

const client = s3_object_client(new S3Client({}), 'my-bucket');
const runs = durable({ store: object_store({ client, prefix: 'runs/' }) });
```

Fascicle depends on no cloud SDK, so the client is yours to paste. This one is
for `@aws-sdk/client-s3`:

```ts
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectClient } from 'fascicle/adapters';

// A 412 says the condition failed. S3 answers 409 when a conditional write
// overlapped another, and the store reads the object again either way.
function lost(err: unknown): boolean {
  if (!(err instanceof S3ServiceException)) return false;
  const status = err.$metadata.httpStatusCode;
  return status === 412 || status === 409;
}

export function s3_object_client(s3: S3Client, Bucket: string): ObjectClient {
  return {
    get: async (Key) => {
      try {
        const found = await s3.send(new GetObjectCommand({ Bucket, Key }));
        return { body: (await found.Body?.transformToString()) ?? '', etag: found.ETag ?? '' };
      } catch (err) {
        if (err instanceof NoSuchKey) return undefined;
        throw err;
      }
    },
    put: async (Key, Body, condition) => {
      const IfNoneMatch = condition && 'if_none_match' in condition ? '*' : undefined;
      const IfMatch = condition && 'if_match' in condition ? condition.if_match : undefined;
      try {
        await s3.send(new PutObjectCommand({ Bucket, Key, Body, IfNoneMatch, IfMatch }));
        return true;
      } catch (err) {
        if (condition !== undefined && lost(err)) return false;
        throw err;
      }
    },
    delete: async (Key) => {
      await s3.send(new DeleteObjectCommand({ Bucket, Key }));
    },
    list: async (Prefix, StartAfter) => {
      const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, StartAfter }));
      const keys = (page.Contents ?? []).flatMap(({ Key }) => (Key === undefined ? [] : [Key]));
      const last = keys.at(-1);
      return page.IsTruncated && last !== undefined ? { keys, next: last } : { keys };
    },
  };
}
```

The role you run it under needs `s3:GetObject`, `s3:PutObject`, and
`s3:DeleteObject` on your prefix, and `s3:ListBucket` on the bucket. S3 checks
a conditional write against the object, so `s3:PutObject` alone won't get you
one. A bucket policy can require a condition on every put, and you shouldn't
add one here, because the store writes your checkpoint values without a
condition and the policy would refuse them.

Here's what you change for another service:

- **Cloudflare R2 and Tigris** take this client as it is, once you set the
  endpoint on your `S3Client`. On Tigris, pick a bucket whose reads see the
  last write everywhere, since a run can't live in a bucket whose reads lag.
- **Google Cloud Storage** wants a client that you write over its own SDK.
  Google documents `If-Match` and `If-None-Match` on its S3-compatible API
  for reads only, so you condition a write on the object's generation
  instead. Create with `ifGenerationMatch: 0`, replace with the generation
  you read, and hand the generation back as the `etag`. GCS throttles writes
  to one object name past about one a second, so retry a 429.
- **Azure Blob Storage** wants a client over its own SDK as well. Its
  conditions are the same two headers, and a create that loses can come back
  as a 409 `BlobAlreadyExists` in place of a 412, which your client should
  report as a failed condition.
- **MinIO's community server and Backblaze B2** aren't ones you should use.
  MinIO's server is archived, and its last release can let a conditional put
  through unchecked. B2 documents no conditional write at all.

The worst failure for this design is a service that accepts your condition
and quietly ignores it, since two writers then both win and nothing errors. So
before you trust a service with your runs, run `checkpoint_store_conformance`
from `fascicle/testing` against a real bucket once (see
[testing.md](./testing.md#checkpoint_store_conformance)). Its racing checks
are what catch a service like that.

If you'd rather keep runs in Postgres or DynamoDB, write a store over the
client you already use and prove it with the same suite. Each has the
conditional write the contract asks for. In Postgres it's a version column,
with `UPDATE ... WHERE version = $1` to replace a value and `INSERT ... ON
CONFLICT DO NOTHING` to create one. In DynamoDB it's a condition expression,
`attribute_not_exists` to create and a comparison on a version attribute to
replace. [`examples/object-store/`](../examples/object-store/) walks through
how `object_store` builds its keys, its claims, and its `clear`, which is the
pattern to copy.

When you upgrade, mind the record's format. The driver now writes
`format: 2`, which keeps the inbox inside the record, and it brings your
`format: 1` runs forward on their first drive, with whatever waited in each
run's inbox. A driver from 0.18 or earlier can't read `format: 2`. It takes
the run for one it has never seen, so its `start` begins your run again from
its input and its `resume` throws `run_not_found_error`. Run one version of
the driver across your hosts at a time, and don't roll back past this one
while you have runs waiting.

### Streaming a Durable Run

A drive runs your flow without `run.stream`, so by default its model calls
don't record their chunks. Pass `record_chunks: true` and they do. Every
`model_call` in the drive then records a `model_chunk` event on the drive's
`trajectory` for each chunk the provider sends, the same events that
`run.stream` yields, and the call streams from the provider as it would under
`run.stream`.

```ts
import { durable } from 'fascicle';
import type { TrajectoryLogger } from 'fascicle';
import { filesystem_store } from 'fascicle/adapters';

const runs = durable({ store: filesystem_store({ root_dir: '.runs' }) });

const to_client: TrajectoryLogger = {
  record: (event) => {
    if (event.kind === 'model_chunk') send_to_client(event);
  },
  start_span: (name) => name,
  end_span: () => {},
};

await runs.start('pr-42', flow, { pr: 42 }, { trajectory: to_client, record_chunks: true });
```

No channel or buffer comes with the flag. The chunks reach your logger
synchronously and in order, so the logger is where you forward them, to a
socket or a server-sent event stream or wherever your client listens.

A drive that resumes runs the flow again from its input, so a `model_call`
before the gate streams the same text a second time unless a `checkpoint`
holds it. The runner records a `step_replayed` event when such a step starts,
which is your cue to drop its chunks. `fascicle/a2a` builds on exactly this,
and [a2a.md](./a2a.md#streaming) describes what it does with the chunks.

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

export function chat_handler(request: Request): Response {
  return to_ui_message_response(
    run.stream(chat, 'Summarize the approved change.', {
      abort: request.signal,
      install_signal_handlers: false,
    }),
  );
}
```

The stream doesn't stop the run on its own. When the user closes the tab, the
response goes away, but the run keeps calling the model (and paying for it)
until its flow ends. A route handler's `request.signal` fires when the client
disconnects, so passing it as `abort` ends the run along with the request, and
the run's cleanup handlers still run on the way out.

For a `node:http` server that holds a `ServerResponse` rather than returning a
web `Response`, use `pipe_ui_message_stream_to_response(handle, res)` from the
same module, which resolves once the response has ended. A `ServerResponse`
carries no signal of its own, so abort a controller of your own when the
response closes:

<!-- snippet: check -->
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { create_engine, model_step, run } from 'fascicle';
import { pipe_ui_message_stream_to_response } from 'fascicle/ui';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY ?? '' } },
});
const chat = model_step({ engine, model: 'claude-sonnet-4-6' });

export async function chat_listener(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  await pipe_ui_message_stream_to_response(
    run.stream(chat, 'Summarize the approved change.', {
      abort: controller.signal,
      install_signal_handlers: false,
    }),
    res,
  );
}
```

The response closes after a normal finish too, and that's harmless, because an
abort that arrives once the run has ended does nothing.

## Synchronous: Tool Approval

When the decision is in-band and immediate, gate a tool instead of suspending.
Flag the tool with `needs_approval` and pass an `on_tool_approval` handler to
`model_call`. Under the default `tool_error_policy: 'feed_back'`, a denied call
goes back to the model as a `tool_approval_denied` tool error and the loop
carries on, and under `tool_error_policy: 'throw'` it throws
`tool_approval_denied_error` instead. A flagged tool with no handler to ask
always throws, so a missing handler fails closed. See the tool
loop recipe in [docs/cookbook.md](./cookbook.md#tool-loops) for the full shape.

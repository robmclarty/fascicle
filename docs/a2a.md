# Serving a Flow over A2A

`serve_flow` lets an MCP client call a flow as a tool, and [`serve_acp`](./acp.md) makes a flow the agent in an editor. This guide covers the third shape, which is a flow as a network agent that other agents hand work to, whatever framework they're built on. [Agent2Agent](https://a2a-protocol.org) (A2A) is the protocol for that. An agent publishes a card that says what it does, a client sends it a message, and the work that follows is a task with a lifecycle of its own. `serve_a2a` from `fascicle/a2a` serves your flow as an A2A v1.0 agent over HTTP, and `a2a_step` calls a remote agent from inside a flow.

A2A's task lifecycle is why this is more than a wrapper. A task can stop and wait for the client's answer, and a Fascicle flow already stops at a `suspend` gate and waits for its resume data. [`durable`](./human-in-the-loop.md#durable-runs) already keeps a suspended run in a store across processes. So every A2A task here is a durable run, and a task that waits for an answer can outlive the process that opened it.

`fascicle/a2a` needs the A2A SDK, which is an optional peer:

```bash
pnpm add @a2a-js/sdk
```

Without it, `serve_a2a` and `a2a_step` reject with an `a2a_sdk_missing_error` that names the install. The stores run on `node:sqlite`, which is built into Node, so they need nothing more.

## `serve_a2a`

Your entry point stays yours. You call `serve_a2a` from your own file:

<!-- snippet: check -->
```ts
import { step } from 'fascicle'
import { serve_a2a } from 'fascicle/a2a'

const server = await serve_a2a({
  flow: step('echo', (text: string) => `you said: ${text}`),
  card: {
    name: 'echo',
    description: 'Says back what it was sent.',
    url: 'http://127.0.0.1:41241/',
    skills: [{ id: 'echo', name: 'Echo', description: 'Repeats a message.' }],
  },
  port: 41241,
})
console.log(`listening at ${server.url}`)
```

The server answers two things. A `GET` of `/.well-known/agent-card.json` returns the card, which is how a client discovers the agent, and a `POST` to `/` takes JSON-RPC, which is the one A2A binding this module serves. `card.url` is the address that clients reach the agent at. You state it because a server behind a proxy can't work it out for itself.

The server binds to `127.0.0.1` unless `host` says otherwise, so reaching the network is a decision that someone makes. It serves until you call `close`, and a SIGTERM or SIGINT does the same and then exits with the signal's code. Closing stops new connections, aborts every task that's running, and disposes the `engine` you gave it.

The flow takes the message's text, since `to_input` defaults to `turn.text`. A flow that takes anything else needs a `to_input`, and the turn it's handed has more to offer:

| Field | What it holds |
| --- | --- |
| `text` | the message's text parts, joined |
| `data` | its data parts, in order |
| `files` | its file parts as sent, with bytes as base64 and a URL as a URL (the agent fetches nothing) |
| `message` | the raw A2A message |
| `history` | earlier exchanges in the same context, oldest first |
| `user` | the caller, as `authenticate` named them |
| `task_id`, `context_id` | the task this message belongs to, and its conversation |

## A Task Is a Durable Run

The task id is the run id. The agent drives its runs through the `runs` you hand it, or through `durable` over `memory_store` when you hand it none, so a task that survives a restart is a choice of store and not a second code path.

| What arrives | What the agent does |
| --- | --- |
| A message with no task id | Starts a task and a run, with `to_input(turn)` as the run's input |
| A message for a task that waits on its client | Resumes the run at its gate with `to_resume(turn, gate)` |
| A message for a task that's working, or that waits on something else | Refuses it with `UnsupportedOperationError`, before the message is recorded |
| A message for a task that has ended | The SDK refuses it with `UnsupportedOperationError` |

Where the run comes to rest decides the task's state:

| The run | The task |
| --- | --- |
| finishes | `COMPLETED`, with the output as its last artifact |
| stops at a gate that the client answers | `INPUT_REQUIRED`, with the gate's question as the status message |
| stops at a gate that something else answers | `WORKING`, with a status message that names the gate |
| refuses the client's answer | `INPUT_REQUIRED` again, with the schema's issues as the status message |
| throws | `FAILED`, with the error's message |
| is canceled | `CANCELED` |

`FAILED` is final in A2A, while `durable` drives a failed run again at the next event, and the A2A side wins. Once a task is `COMPLETED`, `FAILED`, or `CANCELED`, the agent deletes its run, because the task record keeps the result and nothing will drive the run again. The run store only ever holds live tasks.

A failed task's status carries the error's message, and an error's message can hold a connection string or a path that shouldn't leave the server. `to_failure` replaces it:

```ts
to_failure: () => 'The agent could not finish the task.'
```

## Gates: Client or External

A flow that asks a question does it with `suspend`, as it does anywhere else. The task stops at `INPUT_REQUIRED`, and the client's next message for that task is the answer:

<!-- snippet: check -->
```ts
import { z } from 'zod'
import { checkpoint, sequence, step, suspend } from 'fascicle'
import { serve_a2a } from 'fascicle/a2a'

const flow = sequence([
  checkpoint(step('draft', (version: string) => `Notes for ${version}.`), { key: 'draft' }),
  suspend({
    id: 'approve',
    on: () => {},
    resume_schema: z.object({ approved: z.boolean() }),
    combine: (notes: string, answer) => (answer.approved ? notes : `withheld: ${notes}`),
  }),
  step('publish', (notes: string) => `Published. ${notes}`),
])

await serve_a2a({
  flow,
  card: {
    name: 'release-notes',
    description: 'Drafts release notes and publishes them once they are approved.',
    url: 'http://127.0.0.1:41241/',
    skills: [{ id: 'notes', name: 'Release notes', description: 'Notes for the version you name.' }],
  },
  port: 41241,
})
```

The answer is the message's first data part, or its text when it has none, so a client that sends `{ "approved": true }` as data passes this gate's schema. `to_resume(turn, gate)` maps the message yourself, for a client that only sends text.

What the client is asked comes from `to_question(gate, payload)`. By default it's a line of text that names the gate (`Waiting for input at "approve".`), followed by the gate's payload as a data part, so the client can see what the run is asking about. Be aware of what that sends. The built-in `suspend` raises its whole input as its payload, which in the flow above is the draft, and in another flow could be state you meant to keep inside. Write a `to_question` when the default says too much:

```ts
to_question: (gate) => `Publish these notes? Answer { "approved": true } or { "approved": false } at ${gate}.`
```

The status message's metadata names the gate, as `metadata.fascicle.gate`, and carries a gate's `deadline_at` beside it when the gate set a `deadline_ms`. The timer stays with you, as it does for `durable`.

Not every gate is the client's to answer. A run can wait for a CI result, a timer, or a person who answers in some other interface, and `gates` says which gates those are:

```ts
gates: (gate) => (gate === 'ci' ? 'external' : 'client')
```

A task at an external gate rests `WORKING`, and a message for it is refused. The event it waits for resumes the run through `resume`, which both `a2a_agent` and the value that `serve_a2a` resolves carry:

```ts
await server.resume(task_id, { ci: { green: true } })
```

`resume` drives the run the way a message does and writes what follows to the task store, so the next `GetTask` reports it. The client's stream ended when the task came to rest at the gate, so a client that wants to watch the drive calls `SubscribeToTask` while `resume` is running, and it reads the drive from there to the end. A `CancelTask` that arrives in that time aborts the drive, as it does for any task that's running. An agent with an `authenticate` hook keeps each caller's tasks apart, so after a restart `resume` needs to be told whose task it is, with `{ user }` as its third argument.

A process that only holds the store (a webhook worker, say) can call `runs.resume` directly instead. The next `GetTask` picks up the change, and so does a `ListTasks` whose page holds the task. A `ListTasks` that filters by state reads the state that's stored, so the task shows up under its new state once something has read it.

## Streaming

A client that calls `SendStreamingMessage` reads the task as server-sent events. Every drive records model chunks (see [Streaming a Durable Run](./human-in-the-loop.md#streaming-a-durable-run)), and the agent turns each `model_call`'s text into artifact updates as the model writes it.

- **Text** goes into an artifact in chunks, with `append` on every chunk after the first and `lastChunk` on the last. Each drive streams into an artifact of its own, so the work that leads up to a question stays apart from the final answer.
- **`stream(step_id)`** routes each model call's text to `'artifact'` or `'none'`. A call with a `schema` streams raw JSON, and a flow with several calls would stream every draft, so route those away by their `step_id`.
- **Reasoning and tool calls** map to nothing, because A2A has no thought channel and no tool card. `to_events` is the escape hatch: it's handed every run event, and it can wrap `to_task_events` and add to what that returns.
- **The output.** When a drive finishes without streaming any text, the output becomes its artifact, a string as a text part and anything else as a data part. When text did stream and the output isn't a string, the output's data part closes the same artifact, so an agent client gets the structured result as well as the prose. `to_parts` replaces the mapping.
- **Replays stay quiet.** A resumed drive runs the flow again from its input, and a `model_call` before the gate that no `checkpoint` holds would stream the same text twice. The agent drops the chunks of every step that's replaying. A step speaks again once the drive is past the gate that was answered, which is how the text an `a2a_step` receives after a remote question still streams.

A quiet replay still bills. `a2a_agent` writes a warning to stderr when the flow has such a step, and wrapping the step in a `checkpoint` is the fix, as it is for any flow that suspends (see [Durable Runs](./human-in-the-loop.md#durable-runs)).

A stream ends when the task does, and also when the task stops to ask a question, in which case the client's answer opens a new one. A task that comes to rest `WORKING` at an external gate ends its stream too, and the client polls `GetTask` or calls `SubscribeToTask`. A client that disconnects stops the stream it was reading and nothing else, since A2A keeps a dropped connection apart from a cancel.

A blocking `SendMessage` gets the same events, folded into the task that it returns, and `returnImmediately: true` returns the task at once.

## Cancel

`CancelTask` aborts a task that's running in this process. The agent waits for the flow to settle (even when the flow ignores the abort), ends the task `CANCELED`, and deletes the run. A task that waits at a gate is canceled where it stands.

After a restart, or when another process is driving the task, the task record still goes `CANCELED` at once and the run is deleted as soon as nothing holds it. A drive in another process runs on to its next resting place, and its result is dropped. Stopping it early would take a cancel flag in core, which doesn't exist yet.

## Keeping Tasks Past a Restart

Two stores sit under an agent. The runs go in a `DurableStore`, and the task records, which are what `GetTask` and `ListTasks` answer from, go in the SDK's `TaskStore`. Both default to memory. `sqlite_store` from `fascicle/adapters` and `sqlite_task_store` from `fascicle/a2a` keep them on disk, and they can share one file:

<!-- snippet: check -->
```ts
import { durable, step } from 'fascicle'
import { serve_a2a, sqlite_task_store } from 'fascicle/a2a'
import { sqlite_store } from 'fascicle/adapters'

const path = './agent.db'

await serve_a2a({
  flow: step('echo', (text: string) => `you said: ${text}`),
  card: { name: 'echo', description: 'Says back what it was sent.', url: 'http://127.0.0.1:41241/', skills: [] },
  port: 41241,
  runs: durable({ store: sqlite_store({ path }) }),
  task_store: sqlite_task_store({ path }),
})
```

Keep both or neither. A durable run store beside a task store in memory answers `TaskNotFoundError` after a restart, for runs that still exist.

The two stores can't share a transaction, so the runs are the source of truth. Whenever the agent loads a task that hasn't ended, it reads the task's run and brings the record up to date. That keeps `GetTask` honest when something else drove the run, and it repairs a record that a crash left behind between the two writes.

`filesystem_store` and `object_store` hold the runs as well, and so does any store that passes `checkpoint_store_conformance`. The SDK ships task stores of its own for Postgres, MySQL, and SQLite, and a `TaskStore` is three functions if you want to write one.

Several agents can serve from one pair of stores. A task belongs to whichever process is driving it, and the others report it `WORKING` and refuse its messages until it rests. A client that's subscribed in one process doesn't see events from a drive in another, since that would take a broker between them.

## Context History

A2A groups tasks into a conversation by `contextId`. `turn.history` holds the earlier exchanges in the turn's context, oldest first: what the user opened each earlier task with, and the text it ended with. It reads the 20 most recent tasks unless `history_limit` says otherwise. Within one task, the rounds are gates and not history.

## Callers and Limits

An ACP agent runs on stdio for one user at a time. An A2A agent faces the network, and every message it takes runs paid model calls, so its defaults are cautious.

`authenticate(request)` returns the caller, or `null`, which answers 401:

```ts
authenticate: (request) => {
  const token = request.headers.get('authorization')
  return token === `Bearer ${process.env['AGENT_TOKEN']}` ? { name: 'ci', authenticated: true } : null
}
```

The caller's name scopes their task records, so one caller can't read, list, or cancel another's tasks, and it reaches the flow as `turn.user`. The card advertises `security_schemes` and `security_requirements` as you give them, and Fascicle checks nothing that the hook doesn't. With no hook, every caller is anonymous and they all share one set of tasks. Keep such an agent on localhost, or behind something that authenticates. The card itself is always public, since reading it is how a client finds out what to send.

Don't serve [`workspace_tools`](./acp.md#coding-sessions), or any tool that touches the machine, without an `authenticate` hook. Anyone who can reach the port can otherwise run the tool.

| Limit | Default | What happens past it |
| --- | --- | --- |
| `max_body_bytes` | 1,048,576 | 413 |
| `max_drives` | 8 | a message that would start a task answers 429 with `retry-after` |
| `host` | `127.0.0.1` | nothing off the machine can connect |

An answer to a waiting task isn't held to `max_drives`, since refusing it would strand a task that's already been paid for.

The JSON-RPC path takes only a body that says it's `application/json`. A web page can post to localhost without the browser asking first, but it can't post a body with that content type, so a page you happen to visit can't start tasks on an agent that's listening on your machine.

## Without the Server

`serve_a2a` is process glue around `a2a_agent`, which builds the same agent with its handlers ready and nothing listening:

<!-- snippet: check -->
```ts
import { step } from 'fascicle'
import { a2a_agent } from 'fascicle/a2a'

const agent = await a2a_agent({
  flow: step('echo', (text: string) => `you said: ${text}`),
  card: { name: 'echo', description: 'Says back what it was sent.', url: 'https://agents.example.com/echo/', skills: [] },
  rpc_path: '/echo/',
})

const response = await agent.fetch(new Request('https://agents.example.com/.well-known/agent-card.json'))
console.log(response.status)
```

`agent.fetch` is a web handler from a `Request` to a `Response`, so the agent runs under whatever framework you already have, and `rpc_path` moves JSON-RPC off the root. `agent.request_handler` is the SDK's own handler, for mounting the REST or gRPC binding with the SDK's helpers. `agent.close` aborts every drive and waits for each to settle, and it leaves the stores to you, since you opened them. A task that was running when the agent closed ends `FAILED`, while a task that waits at a gate is untouched and takes its answer after a restart. A closed agent answers 503 to everything.

## Calling a Remote Agent

`a2a_step` is a step that sends its input to a remote agent as one message and resolves what the task produced:

<!-- snippet: check -->
```ts
import { run, sequence, step } from 'fascicle'
import { a2a_step } from 'fascicle/a2a'
import type { A2aResult } from 'fascicle/a2a'

const flow = sequence([
  a2a_step({ id: 'notes', url: 'http://127.0.0.1:41241' }),
  step('report', (result: A2aResult) => result.text),
])

console.log(await run(flow, 'v1.2'))
```

The step reads the agent's card from `/.well-known/agent-card.json` under `url`, once for each step value. A string input is the message's text. An object's `text` and `data` become a text part and a data part, and its `context_id` continues a conversation with the agent. The result holds the task's artifacts, with their text parts joined as `text` and their data parts as `data`.

- **Streaming.** The step reads the reply as a stream when the card says the agent can stream. Under `run.stream` or `record_chunks`, each chunk of the remote agent's text becomes a `model_chunk` event under the step's id, so everything that already shows a model call's text (`fascicle/ui`, an ACP thread, an A2A artifact) shows the remote agent's text too. Each change of the task's state becomes an `emit` event that carries `a2a_status` (the `task_id`, the `state`, and the status `text`), and the task a round opens is named once in an `emit` event that carries `a2a_task` (the `task_id` and the `context_id`).
- **Without streaming**, the step sends a blocking `SendMessage`. Either way, while the task is still working it polls `GetTask`, on a backoff that starts at half a second and stops growing at five.
- **Failures.** A task that ends `FAILED`, `REJECTED`, or `CANCELED`, or that wants credentials partway through, throws `a2a_error`, which carries the state and the status text.
- **Abort** stops the stream and asks the remote agent to cancel the task before the step throws.
- **Headers.** `headers` go with every request to the origin of `url`, the card's included. A function runs before each request, for a token that refreshes. The agent's card chooses where messages are sent, so a card that names another origin gets its requests without your headers, and your token stays with the host that you named.

A remote question becomes a local `suspend`. When the remote task stops at `INPUT_REQUIRED`, the step suspends its own run at a gate named `<step id>_<round>` (`notes_1` above), with the remote question as the gate's payload. Resuming that gate sends the answer to the same remote task as its next message, a string as text and anything else as data.

That's what lets agents chain. A Fascicle agent that calls another and gets a question surfaces it as its own `INPUT_REQUIRED`, all the way up to whoever runs the outermost flow, and the answer travels back down the same way. The remote agent's text streams into the outer task's artifact as it would for a model call. When a later step's output is what the client should read instead, route the `a2a_step` to `'none'` with `stream`.

It needs a checkpoint store, because the step keeps each round's result in a `checkpoint` so that a replay doesn't send the message again. `durable` gives every drive one, and so does an `a2a_agent`. Under a plain `run` with no `checkpoint_store`, a remote question throws an `a2a_error` that says so.

The checkpoint's key is the step id, the round, and a digest of what the round sends. A second call that sends the same thing under the same store gets the first call's reply back and never reaches the agent. `durable` keeps a store for each run, so there it takes one run that calls the step twice with the same input. A `checkpoint_store` that you pass to `run` is shared by every run you pass it to, so give each run a store of its own when the agent should be asked again.

## What's Left Out

- **Push notifications.** They'd have the server call URLs that clients hand it, which brings server-side request forgery and stored credentials with it.
- **The REST and gRPC bindings.** `request_handler` lets you mount either with the SDK's own helpers.
- **Signed cards, the extended card, and multi-tenancy.**
- **A2A v0.3.** A request that doesn't say `A2A-Version: 1.0` is refused with `VersionNotSupportedError`.
- **A remote agent as a model call's tool.** A tool can't suspend, so a remote question would come back as a tool result.
- **Deadline timers and retention sweeps**, which stay with you, as they do for `durable`. Task records are kept until you delete them.
- **Fetching a file part's URL.** The part reaches the flow in `turn.files`, as sent.

## A Worked Example

[`examples/a2a-agent/`](../examples/a2a-agent/) runs both halves in one file with no key. It serves a release-notes flow over one SQLite file, calls it from a second flow through `a2a_step`, restarts the server while both sides wait on the agent's question, and then answers.

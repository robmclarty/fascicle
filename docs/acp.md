# Serving a Flow over ACP

[Embedding under a harness](./embedding-under-a-harness.md) covers a flow another program runs once and reads one result from. This guide covers a flow a person talks to. The [Agent Client Protocol](https://agentclientprotocol.com) (ACP) is how Zed, and a growing set of editors and orchestrators, run an agent beside Claude Code, Codex, and Gemini CLI. `serve_acp` from `fascicle/acp` makes your flow one of those agents. The editor launches your process and opens a session, each prompt the user sends becomes a turn that runs the flow, and the answer streams back into the editor's agent panel as it arrives.

It's the other side of `serve_flow`. `serve_flow` (from `fascicle/mcp`) turns a flow into a tool that another agent calls, while `serve_acp` makes the flow the agent itself, with its own sessions and its own thread in the editor.

`fascicle/acp` needs the ACP SDK, which is an optional peer, and the SDK needs zod:

```bash
pnpm add @agentclientprotocol/sdk zod
```

Without them, `serve_acp` rejects with an `acp_sdk_missing_error` that names the install.

## `serve_acp`

Your entry point stays yours. You call `serve_acp` from your own file, and the editor runs that file:

<!-- snippet: check -->
```ts
import { step } from 'fascicle'
import { serve_acp } from 'fascicle/acp'

await serve_acp({
  name: 'echo',
  flow: step('echo', (text: string) => `you said: ${text}`),
})
```

Each prompt runs the flow once through `run.stream`, and as the run records its events, they become the session updates the editor shows while it works. The process serves until the editor closes stdin. Then it aborts any turn that's still running and disposes the engine you gave it. A SIGTERM or SIGINT does the same and then exits, so a host that ends the agent with a signal doesn't leave a run going after the editor has closed.

Options:

- `name` (required) is the name the agent reports to the editor, and `version` sits beside it (default `'0.0.0'`).
- `flow` (required) is the step each turn runs, or a function that builds one per session. The function is called once for each new session with the session's `id`, its `cwd`, and the capabilities the client announced, so a flow whose tools close over the session can be built for it.
- `to_input` maps the turn to the flow's input. It defaults to `turn.text`, so you need it only when the flow takes something other than a string.
- `to_text` is the turn's reply when the flow streamed none (see [Structured Output and `to_text`](#structured-output-and-to_text)).
- `stream` says where each model call's text goes (see [Routing a Model Call's Text](#routing-a-model-calls-text)).
- `to_updates` maps each run event to the updates that go to the editor, in place of the exported `to_session_updates`. Wrap that function and add to what it returns when you want an `emit` of your own in the thread, or a tool card with its own icon.
- `engine` (anything that has a `dispose(): Promise<void>`) is disposed once the editor disconnects.
- `trajectory` receives every run's events, and it must never write to stdout.
- `abort` (an `AbortSignal`) aborts every active run when it fires.

`acp_agent` takes the same config and returns the SDK's agent app. Its handlers are registered but it isn't connected yet, so you can connect it to a transport of your own, or to an in-process client in a test. `serve_acp` is `acp_agent` plus the process: stdin, stdout, the console, and the signals.

## What a Turn Carries

A flow that wants the whole turn sets `to_input: (turn) => turn` and receives an `AcpTurn`:

| Field | What it holds |
| --- | --- |
| `session_id` | the session the turn belongs to |
| `cwd` | the working directory the editor sent when it opened the session |
| `text` | the prompt as one string. A resource link or an attached file reads as its URI where it sat, and each attached file's text follows the prompt in a `<context ref="…">` block |
| `prompt` | the raw ACP content blocks, for a flow that wants more than text |
| `history` | the earlier turns, oldest first, as `{ role, text }` with a role of `'user'` or `'agent'` |

The agent tells the editor it accepts embedded context, so a file the user @-mentions in Zed arrives with its text, rather than as a bare URI the flow has no way to read.

`history` is a copy, so a flow can't change the session's own, and it holds what the user actually saw. A cancelled turn still records the prompt, along with any reply text that had already streamed before the stop, so the next turn's "as I said above" points at something. Sessions live in the process's memory, and the agent doesn't offer `session/load`, so a session ends when the process does.

## Stdout Belongs to the Protocol

ACP runs as newline-delimited JSON-RPC over stdin and stdout, which means stdout carries the protocol and nothing else. A single stray line from a flow or a dependency corrupts the stream.

`serve_acp` sends `console.log`, `console.info`, and `console.debug` to stderr for the life of the process, which covers the usual offender. `acp_agent` leaves the console alone, because it doesn't own the process. Neither one can catch a write that goes straight to `process.stdout`.

Key rules:

- Trajectory loggers write to stderr or a file (`stderr_logger` or `filesystem_logger` from `fascicle/adapters`), never to stdout.
- If a dependency writes to stdout directly, that's a bug in this context. Wrap it or silence it.
- When something does leak, Zed's `dev: open acp logs` command shows the traffic, and the line that isn't JSON-RPC is the leak.

## Where Credentials Come From

ACP v1 gives the editor no way to hand an agent its model credentials. The agent is a process the editor launches, and it authenticates with whatever that process can already see. So `serve_acp` advertises no ACP auth methods, and a flow works with however you've already authenticated:

- API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) go in the `env` of the editor's agent server entry. That's more reliable than counting on a shell export to reach a process the editor started.
- Bedrock wants `use_credential_chain: true` in its provider config, which picks up `aws sso login`, named profiles, and `~/.aws/credentials` (through the `@aws-sdk/credential-providers` peer). Without it, the Bedrock provider reads only `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, so an SSO login alone isn't enough.
- Ollama needs nothing at all.

A Claude subscription login isn't on the list. Anthropic doesn't allow third-party products to offer claude.ai login, so that path stays with Claude Code itself, which Zed already runs as an ACP agent of its own.

## MCP Servers Are Ignored for Now

Zed sends the MCP servers you've configured with every new session, and the protocol expects an agent to connect to them. `serve_acp` accepts that list and ignores it for now, so a flow sees none of those servers' tools. A flow that needs an MCP server's tools can connect to it itself with `mcp_client` from `fascicle/mcp`.

## Routing a Model Call's Text

By default, every model call's text streams into the reply as it arrives. That's right for a flow with one model call, and wrong for two common shapes:

- A model call with a `schema` streams raw JSON tokens. And since text did stream, the flow's real answer from `to_text` is never sent.
- A flow with several model calls (a draft and a revision, or a critic and a fix) streams every draft into the reply, one after another.

`stream` routes each call's text by its `step_id`. It returns `'message'` to send the text to the reply, `'thought'` to send it to the thought block that Zed shows collapsed above the reply, or `'none'` to drop it. A model's reasoning always goes to the thought block.

<!-- snippet: check -->
```ts
import { create_engine, model_step, sequence } from 'fascicle'
import { serve_acp } from 'fascicle/acp'

const engine = create_engine({
  providers: { openrouter: { api_key: process.env['OPENROUTER_API_KEY'] ?? '', transport: 'native' } },
  defaults: { model: 'anthropic/claude-sonnet-5.5' },
})

const draft = model_step({ engine, id: 'draft', system: 'Draft an answer to the question.' })
const revise = model_step({ engine, id: 'revise', system: 'Tighten this draft into a final answer.' })

await serve_acp({
  name: 'draft-and-revise',
  flow: sequence([draft, revise]),
  stream: (step_id) => (step_id === 'draft' ? 'thought' : 'message'),
  engine,
})
```

The draft stays visible but folded away, and only the revision reads as the reply. When a turn ends without sending any message text at all, because every call went to `'thought'` or `'none'` or the flow made no model call, the adapter sends `to_text(output)` as the reply before the turn ends. It counts the updates it actually sends, so the rule holds under a custom `to_updates` too.

## Structured Output and `to_text`

A `define_agent` step calls the engine without streaming, so none of its text reaches the reply while it runs, and the reply is `to_text(output)`. By default `to_text` sends a string as it is and anything else as JSON, which leaves a structured output in the user's thread as a JSON blob. Give it a `to_text` that renders the output as something a person reads:

<!-- snippet: check -->
```ts
import { z } from 'zod'
import { create_engine } from 'fascicle'
import { serve_acp } from 'fascicle/acp'
import { define_agent } from 'fascicle/agents'

const engine = create_engine({
  providers: { openrouter: { api_key: process.env['OPENROUTER_API_KEY'] ?? '', transport: 'native' } },
  defaults: { model: 'anthropic/claude-sonnet-5.5' },
})

const reviewer = define_agent({
  md_path: new URL('./prompts/reviewer.md', import.meta.url),
  schema: z.object({ findings: z.array(z.string()), summary: z.string() }),
  engine,
  build_prompt: (text: string) => text,
})

await serve_acp({
  name: 'reviewer',
  flow: reviewer,
  to_text: (review) => [review.summary, ...review.findings.map((finding) => `- ${finding}`)].join('\n'),
  engine,
})
```

With `build_prompt`, the markdown body becomes the system prompt and the turn's text becomes the user message, which is the shape a chat turn wants.

## Running It in Zed

[`examples/acp-agent/`](../examples/acp-agent/) is the reference agent. It's keyless by default, so you can check the wiring between Zed and your agent before you spend a token, and `--model` switches it to a real engine. Its README has the `agent_servers` entry for Zed's `settings.json`, and the steps that check each part of the wiring.

## Checklist

Everything in the [writing-a-harness checklist](./writing-a-harness.md#checklist) still applies. On top of it:

- [ ] Nothing writes to stdout, and the trajectory logger (if any) writes to stderr or a file.
- [ ] Every key that a provider needs is in the `env` of the editor's agent server entry.
- [ ] A flow with more than one model call routes its intermediate calls away from the reply with `stream`.
- [ ] A flow whose output isn't a string has a `to_text`.
- [ ] The engine (if any) is passed to `serve_acp`, so it's disposed when the editor disconnects.

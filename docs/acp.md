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
- `flow` (required) is the step each turn runs, or a function that builds one per session. The function is called once for each new session with an `AcpSession`, which holds the session's `id`, its `cwd` and additional directories, the capabilities the client announced, its mode, and the `approve` that asks the user, so a flow whose tools close over the session can be built for it (see [Coding Sessions](#coding-sessions)).
- `default_mode` is the mode each session starts in until the client picks another (default `'manual'`, see [Modes](#modes)).
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
| `history` | the earlier turns, oldest first, as `{ role, text }` with a role of `'user'` or `'agent'`, and `cancelled: true` on the last entry of a turn that was cancelled |

The agent tells the editor it accepts embedded context, so a file the user @-mentions in Zed arrives with its text, rather than as a bare URI the flow has no way to read.

`history` is a copy, so a flow can't change the session's own, and it holds what the user actually saw. Reply text on either side of a tool call is recorded as two paragraphs with a blank line between them, because the client shows it as two messages and a flow that reads the history shouldn't see the sentences run together. A cancelled turn still records the prompt, along with any reply text that had already streamed before the stop, so the next turn's "as I said above" points at something. Its last entry carries `cancelled: true`, which a flow should pass on to its model. A model that reads a stopped request with nothing to mark it takes the request as still waiting, and carries it out at the next prompt. Sessions live in the process's memory, and the agent doesn't offer `session/load`, so a session ends when the process does.

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

## Coding Sessions

A flow that only answers needs nothing beyond the sections above. A coding agent has to read the user's repository, change it, and run its tests, and it can't count on the editor for any of that. ACP lets a client offer its own file system and terminal, but Claude Agent stopped using them in v0.18.0, the ACP v2 draft drops them, and the hosts that run agents beyond Zed don't offer them. So the agent owns its tools. `workspace_tools(session)` gives a flow six of them, which work on the files on disk in the session's workspace, and the editor does the two things that only it can do. It shows the work, and it asks the user before anything changes.

<!-- snippet: check -->
```ts
import { create_engine, model_step } from 'fascicle'
import { serve_acp, workspace_tools } from 'fascicle/acp'

const engine = create_engine({
  providers: { openrouter: { api_key: process.env['OPENROUTER_API_KEY'] ?? '', transport: 'native' } },
  defaults: { model: 'anthropic/claude-sonnet-5.5' },
})

await serve_acp({
  name: 'coder',
  flow: (session) =>
    model_step({
      engine,
      id: 'coder',
      system: 'You are a coding agent. Read the code before you change it, and run the tests after.',
      tools: workspace_tools(session),
      max_steps: 100,
      on_tool_approval: session.approve,
    }),
  engine,
})
```

The flow is a function of the session, because the tools and `session.approve` belong to it. `session.approve` goes in as the model call's `on_tool_approval`, and it's what asks in the editor before an edit or a command runs. [`examples/acp-coder/`](../examples/acp-coder/) is this agent with a system prompt worth starting from, and its README has a test that walks through every part of this section in Zed.

### The Workspace Tools

| Tool | Input | What it does |
| --- | --- | --- |
| `read_file` | `path`, `offset?`, `limit?` | returns the file with numbered lines, at most `read_limit_lines` of them, and says how to read the rest. A line past 2000 characters is cut with a marker, and a binary file is refused |
| `list_files` | `pattern?`, `path?` | lists the files under a directory that match a glob, in sorted order, and stops at 1,000 with a note that gives the total |
| `search` | `pattern`, `path?`, `glob?` | searches file contents with a JavaScript regular expression and returns up to 100 matches as `path:line: text`, skipping binary files |
| `write_file` | `path`, `content` | creates or overwrites a file, along with any directories missing on the way to it |
| `edit_file` | `path`, `old_text`, `new_text`, `replace_all?` | replaces an exact match, and fails when `old_text` isn't there, or when it matches more than once without `replace_all` |
| `run_command` | `command`, `timeout_ms?` | runs the command with `/bin/sh -c` in `cwd` and returns what it printed and its exit code (see [Commands](#commands)) |

They're plain `Tool` values, so a flow can filter them, set its own beside them, or wrap them. A read-only critic, say, takes `read_file`, `list_files`, and `search`, and leaves the writes and the shell alone.

`workspace_tools` takes its options as a second argument:

- `read_limit_lines` is the most lines one `read_file` call returns (default 2000).
- `ignore` names the files and directories that `list_files` and `search` skip wherever they turn up in a path (default `['.git', 'node_modules']`). Neither tool reads `.gitignore`, so a `dist/` or a `coverage/` folder is fair game unless `ignore` names it.
- `search_timeout_ms` is how long one search may run before it's stopped (default 30 seconds). Raise it for a repository that's too large to search in that time.
- `command_timeout_ms` is how long a command may run before it's killed, unless the call sets its own `timeout_ms` (default two minutes).
- `output_limit_bytes` is the most output one command returns before it's cut, with a note that says so (default 32,000 bytes).
- `command_env` replaces the environment that commands run with (see [Commands](#commands)).

A search runs in a worker thread, inside the budget that `search_timeout_ms` sets. JavaScript's regular expressions backtrack, so a pattern such as `(a+)+$` can run for minutes against one long line, and the worker is what lets a cancel or the budget stop it mid-match. The model gets back a tool error that tells it to simplify the pattern or narrow the search.

A write or an edit reads the whole file it changes, so the change can be shown as a diff, and it refuses a file over 1,000,000 bytes before it opens it. A diff carries the file's whole text twice, once as it was and once as it will be, and the card's closing update carries it again, so the refusal tells the model to change a file that size with `run_command` instead.

### What the File Tools Can Reach

A path can be absolute or relative to `cwd`. The file tools accept it only when its real path, with every symlink resolved, lands under `cwd` or under one of the additional directories that the client sent with `session/new`. The agent advertises `sessionCapabilities.additionalDirectories`, which is how a client widens the workspace beyond `cwd`. The roots themselves are resolved the same way, once, when the session starts, so a project that sits behind a symlink still works (on macOS, everything under `/tmp` and `/var` does). A path that doesn't exist yet, such as the file a `write_file` is about to create, is checked through the nearest directory on its way that does exist, so a new file under a symlink that points out of the workspace is refused as well. A refusal is an ordinary tool error that names the allowed roots, and the model reads it and tries a path that fits.

Containment binds the file tools only. A command runs through `/bin/sh`, and a shell reaches anything you can, your SSH keys and every other repository included. That's why Manual asks before every command. [SECURITY.md](../SECURITY.md#workspace-tools-fascicleacp) says what each tool can touch.

### Modes

Each session runs in one of three modes, which set how often the agent asks before it acts. Reads and searches never ask.

| Mode | Asks before an edit | Asks before a command |
| --- | --- | --- |
| Manual (`manual`), the default | yes | yes |
| Accept edits (`accept_edits`) | no | yes |
| Auto (`auto`) | no | no |

The user picks one in Zed's mode picker and can switch at any point, mid-turn included, since each tool reads the mode when it's called. `default_mode` in the config sets the mode that a session starts in, and Zed's `default_mode` setting on the agent server entry picks another one for that editor. ACP reports a mode two ways, as the session's `modes` and as a config option in the `mode` category. A client reads one or the other, so the agent keeps the two in step and tells the client both ways whenever either one changes.

Auto runs commands with nobody watching, so it belongs in a container or a throwaway worktree. Don't point it at a checkout you'd mind losing, or run it anywhere a command could read credentials you'd mind it sending somewhere.

### Permission Requests

When the mode says to ask, `session.approve` sends `session/request_permission` with the call's card, so the prompt sits on the card that the user is already looking at. For an edit, the agent works out the change on disk first and the prompt shows that diff, so the user approves the change itself rather than a summary of it. When the change can't be worked out, as for a file over that size limit, the prompt shows why in place of the diff, and that's the error the call fails with if it's allowed. A prompt offers these options:

- **Allow** runs this one call.
- **Allow all edits this session**, offered for an edit, switches the session to Accept edits, the way Claude Agent's does. The agent tells the client, so Zed's mode picker follows.
- **Always allow `pnpm test` this session**, offered for a command, covers the command's program and its first argument that isn't a flag. That grant covers a later `pnpm test --watch=false` but not `pnpm publish`, and `ls -la` gets a grant for plain `ls`.
- **Reject** refuses the call.

A command that holds shell control syntax (`;`, `&`, `|`, `>`, `<`, a backtick, `$(`, or a newline) is never offered "always", and no grant ever covers it, since anything can follow a `;` or a `|`. So `pnpm test && curl … | sh` asks every time, whatever the user has allowed before. A grant lives in the agent's memory and ends with the session.

The check never fails open. A rejection, a prompt the client cancels, an answer the prompt never offered, and a request that fails for any reason all deny the call. The tool doesn't run, and the model is told that the call was refused, so it can say so or try another way. Cancelling the turn while a prompt is open withdraws the prompt.

### Commands

`run_command` hands its string to `/bin/sh -c` in `cwd`, as the leader of a process group of its own. A cancelled turn, a timeout, and the shell's own exit each kill that whole group, so a test runner's workers and a server started with `&` die along with it. A command that moves work into a group of its own, as a daemon does, takes that work out of reach, the way it would from Ctrl-C in a terminal. `run_command` is POSIX-only for now. On Windows it refuses with a message that says so, and the file tools still work.

`/bin/sh -c` reads no shell profile, so a `node` or a `pnpm` that nvm, fnm, volta, or asdf puts on your terminal's path can still come back as `command not found`. That's why [acp-coder's Zed snippet](../examples/acp-coder/README.md#run-in-zed) sets `PATH` in the agent server's `env`. Put the directories that hold your tools at the front of it.

A command inherits the agent's environment by default, provider keys included, so any command the model runs can read the key that the model itself runs on. `command_env` replaces that environment whole, with nothing merged in, so it needs the `PATH` the commands use as well. acp-coder builds its `command_env` from `process.env` minus the keys its providers read.

When the editor ends the agent, `serve_acp` aborts every run before it exits, so the commands die first, whether the editor closes stdin or sends SIGTERM or SIGINT. SIGKILL is the one case that leaves commands running. No process can catch it, so the agent never gets the chance to kill their groups.

### How Calls Look in Zed

Each workspace tool's card looks the way Claude Agent's do, with a kind that picks its icon and a title that reads like the call, its paths relative to `cwd`:

| Tool | Kind | Title | The card also shows |
| --- | --- | --- | --- |
| `read_file` | `read` | `Read src/a.ts (1 - 40)` | a location at the first line it read |
| `list_files` | `search` | `Find` with the directory and the glob | nothing more |
| `search` | `search` | the grep command line that does the same search, such as `grep --include="*.ts" "todo" src` | nothing more |
| `write_file` | `edit` | `Write src/a.ts` | the diff, with no old text for a new file |
| `edit_file` | `edit` | `Edit src/a.ts` | the diff, and a location at the first line it changed |
| `run_command` | `execute` | the command line | what it printed and how it ended |

A write's or an edit's diff is worked out before the call runs, so the card keeps it in every mode, not only when a prompt asks. A command's output goes to a terminal on the card when the client advertises Zed's terminal extension (`_meta.terminal_output`), and into the card as a `console` code block otherwise.

Location lines count from 1, as Claude Agent's do. Zed reads them as counting from 0, so following the agent lands one line below the line it read or edited, exactly as it does with Claude Agent. Matching Claude Agent means a user who switches between the two lands on the same line, and a fix on Zed's side fixes both at once.

Zed's Review Changes panel stays empty, because Zed fills it only from writes that go through the client's `fs/write_text_file`, and these tools write to disk themselves. A file with unsaved changes in Zed conflicts once the agent writes it. Claude Agent has both gaps too.

Each card's id carries the turn, the model call's `step_id`, and how many times that step has started in the turn. So a model call under `loop` or `retry` opens fresh cards on every run, even on Ollama, which numbers its tool calls from zero on every call. Only calls that run at the same time can still cross. Two Ollama model calls under `parallel`, or one model call run twice at once under `map`, can hand a card the other call's diff or output. A coding agent whose model calls run one after another never meets either case.

## Running It in Zed

[`examples/acp-agent/`](../examples/acp-agent/) is the reference agent. It's keyless by default, so you can check the wiring between Zed and your agent before you spend a token, and `--model` switches it to a real engine. Its README has the `agent_servers` entry for Zed's `settings.json`, and the steps that check each part of the wiring.

[`examples/acp-coder/`](../examples/acp-coder/) is the coding agent from [Coding Sessions](#coding-sessions). Its README has the entry with `PATH` set, and an eight-step test that covers the cards, the prompts, the modes, a cancel, and a model from another vendor.

## Checklist

Everything in the [writing-a-harness checklist](./writing-a-harness.md#checklist) still applies. On top of it:

- [ ] Nothing writes to stdout, and the trajectory logger (if any) writes to stderr or a file.
- [ ] Every key that a provider needs is in the `env` of the editor's agent server entry.
- [ ] A flow with more than one model call routes its intermediate calls away from the reply with `stream`.
- [ ] A flow whose output isn't a string has a `to_text`.
- [ ] The engine (if any) is passed to `serve_acp`, so it's disposed when the editor disconnects.
- [ ] A coding agent builds its flow per session, with `workspace_tools(session)` and `on_tool_approval: session.approve`.
- [ ] Commands run with a `command_env` that leaves out the provider keys, and the agent server's `env` sets a `PATH` that finds your tools.
- [ ] Auto runs only in a container or a throwaway worktree.

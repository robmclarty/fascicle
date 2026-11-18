# Model Context Protocol

The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is how a program offers tools and data to somebody else's agent. `fascicle/mcp` is a bridge to it that goes both ways. `mcp_client` connects to an MCP server and hands you its tools as plain `Tool` values, so a model in your flow can call them the way it calls a tool you wrote. `serve_flow` goes the other way and registers a flow of yours as a tool on an MCP server, so somebody else's agent can call it.

Neither one is a framework. `mcp_client` returns values that you pass to `model_step` or `generate` yourself, and `serve_flow` registers onto a server that you built and still own. `@modelcontextprotocol/sdk` does the protocol work. It's an optional peer that loads when you first connect, and a missing one throws `mcp_sdk_missing_error` with the install command in it.

An MCP tool is code that you didn't write, running with whatever rights its server has, and what it returns is text that the model reads. Read [Asking Before a Tool Runs](#asking-before-a-tool-runs) before you hand one to an agent that holds anything you care about.

## Tools from a Server

<!-- snippet: check -->
```ts
import { create_engine, model_step, run } from 'fascicle'
import { mcp_client } from 'fascicle/mcp'

const engine = create_engine({
  providers: { openrouter: { api_key: process.env['OPENROUTER_API_KEY'] ?? '', transport: 'native' } },
  defaults: { model: 'anthropic/claude-sonnet-5.5' },
})

const files = await mcp_client(
  { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()] },
  { name_prefix: 'fs_', needs_approval: (tool) => tool.name.startsWith('write') },
)

const agent = model_step({
  engine,
  tools: [...files.tools],
  on_tool_approval: (request) => {
    console.error(`allowing ${request.tool_name}`, request.input)
    return true
  },
})

try {
  console.log(await run(agent, 'What is in this directory?'))
} finally {
  await files.close()
}
```

`mcp_client(config, options?)` resolves to a handle with three members. `tools` holds one `Tool` for each tool the server advertised. `close` ends the connection, which for a stdio server also stops the process. `resources` reads what the server publishes besides tools, and [Resources](#resources) covers it.

Each tool carries the server's own JSON Schema as its `input_schema`, so the loop validates a call against it and the provider is sent it unchanged. A call goes to the server with the run's abort signal, so cancelling the run cancels the call. A result with `structuredContent` comes back as that object, and any other result comes back as its text parts joined by newlines. A result that the server marked `isError` throws `mcp_error`, which the engine's default `tool_error_policy` feeds back to the model as the call's error.

## Transports

The first argument says how to reach the server, and it takes one of three shapes.

| `transport` | Fields | What it does |
| --- | --- | --- |
| `'stdio'` | `command`, `args?`, `env?`, `cwd?` | starts the server as a child process and talks to it over its stdin and stdout |
| `'http'` | `url`, `headers?`, `auth_provider?`, `fetch?`, `session_id?`, `reconnection?` | connects to a remote server over Streamable HTTP |
| `'client'` | `client` | uses an SDK `Client` that you already connected, and leaves its lifecycle with you, so the handle's `close` does nothing |

A stdio server gets the variables in `env` on top of the SDK's short default list, and not your process's environment. That keeps your provider keys away from it unless you pass them yourself.

The `http` fields beyond `url` each reach the SDK's transport only when you set them:

- `headers` go on every request. A fixed `Authorization` header is the whole of auth for a server that takes an API key.
- `auth_provider` is the SDK's `OAuthClientProvider`, for a token that expires. See [Servers That Want Credentials](#servers-that-want-credentials).
- `fetch` replaces the global `fetch` for every request the transport makes, its OAuth requests included. Use it for a proxy, for a recorder, or for a double in a test.
- `session_id` rejoins a session that the server already knows. The SDK skips the handshake on a rejoin, so this connection never learns the server's capabilities, and the capability checks that `resources` makes are skipped with it.
- `reconnection` is the backoff for reopening a dropped event stream, as `{ max_retries, initial_delay_ms, max_delay_ms, delay_grow_factor }`. All four are required once you set it. Left unset, the SDK retries twice, starting at one second.

The `'client'` shape is the way out for anything the other two don't build. You construct the transport and the `Client`, connect them, and pass the client in.

## Options

`mcp_client` takes a second, optional record. Every field can be left out.

| Option | Default | What it does |
| --- | --- | --- |
| `client_info` | `{ name: 'fascicle', version: '0.0.0' }` | the identity sent in the handshake |
| `include` | unset, so every tool | the names of the tools to surface, by the server's own names |
| `default_description` | `MCP tool <name>` | a function from a tool's name to the description it gets when the server sent none |
| `name_prefix` | none | written in front of each tool's name, so two servers' tools can share one call. The server is still called by its own name |
| `needs_approval` | unset, so nothing asks | which tools ask before they run. See the next section |
| `sampling` | unset, so the capability isn't declared | lets the server ask your engine for completions. See [Sampling](#sampling) |

## Asking Before a Tool Runs

A tool that you write opts into approval with one field, `needs_approval`, and the engine does the rest. It asks the `on_tool_approval` handler that you passed to the call before it runs the tool, it records the request and the answer in the trajectory, and it refuses the call when you passed no handler. `needs_approval` on `mcp_client` puts that same field on the tools a server gave you.

`needs_approval: true` gates every tool from the server. That's the setting to start from for a server that you don't run.

A function is a policy. It's called once for each tool while the handle is built, with the server's own name for the tool (no `name_prefix`) and the annotations the server advertised, and it answers for that tool. A boolean answer gates the tool or doesn't. A function answer becomes the tool's own `needs_approval`, which the engine calls with each call's input:

```ts
const handle = await mcp_client(config, {
  needs_approval: (tool) => {
    if (tool.name === 'read_file') return false
    if (tool.name === 'run_query') return (input) => !String((input as { sql: string }).sql).startsWith('SELECT')
    return true
  },
})
```

MCP servers can annotate a tool with hints such as `readOnlyHint` and `destructiveHint`, and the policy sees them as `tool.annotations`. Fascicle never reads them. A hint is the server describing itself, and a server that means you harm will describe itself as harmless. If you trust a server enough to believe its hints, that's three lines in your own code, where the next reader can see that you made the choice:

```ts
needs_approval: (tool) => tool.annotations?.['readOnlyHint'] !== true
```

By default nothing asks. Turning the gate on for everybody would break every app that calls `generate` with MCP tools and no `on_tool_approval`, because a gated tool with no handler is refused. So the choice is yours to make, and for a server that you didn't write you should make it.

Approval covers what a tool does. It doesn't cover what a tool says, and a tool that fetches a page or an issue returns text that somebody else wrote. [web.md](./web.md#untrusted-text-and-a-way-out) covers what that text can talk a model into.

## Servers That Want Credentials

A server that takes an API key needs nothing more than `headers`. OAuth is the harder case, because a token expires and something has to fetch the next one. That something is `auth_provider`, an object with the SDK's `OAuthClientProvider` interface. The transport asks it for a token on every request and uses it to refresh one that has expired.

**A flow with nobody in it works through the config.** A provider that returns stored tokens, refreshes them, or runs a `client_credentials` grant never needs a browser. The SDK ships providers for the machine-to-machine grants:

```ts
import { ClientCredentialsProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js'
import { mcp_client } from 'fascicle/mcp'

const handle = await mcp_client({
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  auth_provider: new ClientCredentialsProvider({
    clientId: process.env['MCP_CLIENT_ID'] ?? '',
    clientSecret: process.env['MCP_CLIENT_SECRET'] ?? '',
    expectedIssuer: 'https://auth.example.com',
  }),
})
```

`expectedIssuer` belongs to newer releases of the SDK than 1.29, so leave it out on an older one. The credentials are arguments here as they are everywhere in Fascicle. Nothing in `fascicle/mcp` reads the environment.

**A flow that sends the user to a browser stays in your app.** The authorization-code flow needs a page to redirect to and somebody to receive the callback, and a library that's glue has neither. Build the transport yourself, call its `finishAuth(code)` when the callback arrives, connect a `Client` over it, and pass that client with `transport: 'client'`.

When an HTTP server answers that you aren't authorized, `mcp_client` throws `mcp_auth_required_error`. Its `url` is the server's address with the query string and any username or password taken off, and its `cause` is the SDK's own error. You get it from the connect, and you get the same error from a tool call or a `resources` call later on, when a token expired in the middle of a session and couldn't be refreshed. It covers both of the ways the SDK reports a 401: its `UnauthorizedError`, when a provider's flow ended short of a token, and a `StreamableHTTPError` with the code 401, when no provider was set or the server refused a fresh token.

A client that you passed with `transport: 'client'` keeps the SDK's errors as they are. You built its transport, so you already hold the classes to check them against.

## Resources

A resource is something a server publishes for reading (a file, a row, a log), named by a URI. `handle.resources` reads them:

```ts
const resources = handle.resources

for (const resource of await resources.list()) {
  console.log(resource.uri, resource.name, resource.mime_type)
}

const [first] = await resources.read('file:///project/README.md')
if (first !== undefined && 'text' in first) console.log(first.text)

await resources.subscribe('file:///project/README.md', async (uri) => {
  console.log('changed', await resources.read(uri))
})
```

| Method | What it does |
| --- | --- |
| `list()` | every resource the server lists, as `{ uri, name, description?, mime_type? }`, across all of its pages |
| `templates()` | every resource template, as `{ uri_template, name, description?, mime_type? }` |
| `read(uri)` | the resource's content, as parts that each hold `uri`, `mime_type?`, and either `text` or a base64 `blob` |
| `subscribe(uri, on_update)` | calls `on_update(uri)` each time the server says the resource changed |
| `unsubscribe(uri)` | drops every callback on the URI and ends the server's subscription |
| `on_list_changed(on_change)` | calls `on_change()` each time the server says its list of resources changed |

An update carries the URI and nothing else. Fascicle doesn't read the resource again for you, because whether to read at once, wait for the changes to settle, or ignore the update is your call. No content is cached either, so two reads make two requests.

Several callbacks on one URI share a single subscription on the server. When a callback throws, the others are still called, and the first failure goes to the client's `onerror`.

Nothing is registered on the connection until the first `subscribe` or `on_list_changed`, so an app that only wants tools pays nothing for this. On a client that you passed in, that registration replaces any handler of your own for the same two notifications.

A server says in its handshake what it supports, and a call it has ruled out throws `mcp_error` before any request is sent. `list`, `templates`, and `read` need the `resources` capability. `subscribe` needs `resources.subscribe`, and `on_list_changed` needs `resources.listChanged`. A server that publishes resources and no tools connects fine, with an empty `tools`.

## Sampling

Sampling is the one part of MCP where the server asks the questions. It sends a `sampling/createMessage` request and the client runs the completion, which means the client pays for it. The `sampling` option answers those requests from your engine:

```ts
const handle = await mcp_client(config, {
  sampling: {
    engine,
    model: 'anthropic/claude-sonnet-5.5',
    max_tokens: 1024,
    on_request: (request) => {
      console.error('server asked for a completion', request.messages.length, request.max_tokens)
      return true
    },
  },
})
```

| Field | What it does |
| --- | --- |
| `engine` | the engine that runs the completion |
| `model` | the model, sent to the engine as written. Required |
| `provider` | the provider, when the engine has more than one |
| `max_tokens` | the most output tokens one request may ask for, 4,096 when unset. A request that asks for more is answered within the cap |
| `on_request` | called before each completion with `{ messages, system?, max_tokens, model_preferences? }`. Required. Anything but `true` refuses the request before the engine is called |
| `trajectory` | passed to the engine's `generate` call |

Setting `sampling` is what declares the capability to the server. Leave it out and the server is told nothing, and a request it sends anyway is answered "Method not found".

**What goes to the engine.** The request's messages, with text and images mapped to the engine's shapes, and its `systemPrompt`, `maxTokens` (after your cap), and `temperature`. The request's abort signal goes too, so a server that cancels its request cancels your completion.

**What comes back.** One text block, the model id the engine resolved, and a `stopReason`. The engine's `stop` becomes `endTurn`, its `length` becomes `maxTokens`, and any other finish reason goes back as the engine spelled it.

**What's dropped.** `stopSequences`, `includeContext`, and `metadata` aren't mapped, so a server that depends on a stop sequence won't get one. Audio content is refused, and so is an image in an assistant message.

**The model is yours.** A request can carry `modelPreferences`, the server's hints about cost, speed, and which model it would like. They reach `on_request` as `model_preferences`, exactly as sent, and they choose nothing. Fascicle sends a model name to a provider as you wrote it, and a table that turned a server's hint into a model would be an alias by another road.

**No tools.** A sampling request can ask for tools of its own. This client doesn't advertise that and refuses a request that carries `tools` or `toolChoice`. A remote server that picked which of your tools ran would be making the decision that approval exists to keep with you.

**You answer every request.** `on_request` is required, so a server never spends your tokens on a default. It's called before each completion, and anything but `true` refuses the request before the engine is called. The MCP specification asks a client to let a person see a sampling request before it runs, and this is where you do that. An app that trusts its server passes `() => true`. `max_tokens` bounds what one request can cost, and a request is held to 4,096 output tokens when you don't set it.

When the engine fails, the server is answered with the error's message, so a server that you don't trust reads whatever that message says.

For a client that you passed with `transport: 'client'`, capabilities were fixed when you built it. Construct it with `capabilities: { sampling: {} }` and `mcp_client` registers the handler. Without that, the call throws an `mcp_error` that says so.

## Serving a Flow

`serve_flow` registers a flow as one tool on an `McpServer` that you constructed. You own the server, its transport, and its lifetime, and you can register as many flows on it as you like.

<!-- snippet: check -->
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { step } from 'fascicle'
import { serve_flow } from 'fascicle/mcp'
import { z } from 'zod'

const shout = step('shout', (input: { text: string }) => ({ shout: input.text.toUpperCase() }))

const server = new McpServer({ name: 'shouter', version: '1.0.0' })
serve_flow({
  server,
  flow: shout,
  name: 'shout',
  description: 'Uppercase the input text.',
  input_schema: z.object({ text: z.string() }),
})

await server.connect(new StdioServerTransport())
```

Each call runs the flow once with the call's arguments as its input. The request's abort signal is the run's, so a client that cancels the call stops the flow. An object result goes back as JSON text and as `structuredContent`, and anything else goes back as text. `to_result` replaces that mapping, and `trajectory` receives the run's events.

`input_schema` is a zod schema here, where the rest of Fascicle takes any Standard Schema. The SDK's `registerTool` accepts nothing else, and since the SDK depends on zod itself, you already have it.

A flow that throws comes back as a result marked `isError` with the error's message, and not as a protocol error, so the calling model reads what went wrong.

**A flow that suspends can't be served yet.** A flow with a `suspend` gate throws `suspended_error` when it reaches the gate, and `serve_flow` turns that into the same `isError` result as any other throw. The gate's id and payload are lost, and the caller has no way to resume. MCP's elicitation is the protocol's answer to this, and bridging the two is planned. Until then, a flow that asks a person a question can be served through [`serve_a2a`](./a2a.md), whose tasks carry the pause.

[`examples/mcp-server/`](../examples/mcp-server/) is a served flow and a client for it that you can run.

## Errors

| Error | When |
| --- | --- |
| `mcp_sdk_missing_error` | `@modelcontextprotocol/sdk` isn't installed. The message holds the install command |
| `mcp_auth_required_error` | an HTTP server answered 401, at connect or later. Carries `url` and `cause` |
| `mcp_error` | a tool returned `isError` (with `tool_name` set), a `resources` call needs a capability the server didn't advertise, or `sampling` was set for a client that didn't declare it |

Each has a `kind` field that holds its own name, for code that would sooner compare a string than import a class. Any other failure (a refused connection, a server that crashed, a JSON-RPC error) is the SDK's own error, passed through.

## What It Leaves Out

- **The browser half of OAuth.** A redirect and a callback need a UI, and that's your app. See [Servers That Want Credentials](#servers-that-want-credentials).
- **Prompts, roots, and elicitation.** The client bridges tools, resources, and sampling. For the rest, connect an SDK `Client` yourself and use it beside the handle.
- **The SDK client on the handle.** The handle doesn't expose it. When you need it, build it and pass it with `transport: 'client'`, and then you hold it already.
- **A cache.** Tools are listed once, when the handle is built, and a resource is read every time you ask.
- **Resources as tools.** A resource is a value that your code reads. To let a model read one, wrap `resources.read` in a tool or a `step` of your own.
- **A preset that trusts hints.** No setting of `needs_approval` believes `readOnlyHint` for you. The policy function lets you believe it yourself.

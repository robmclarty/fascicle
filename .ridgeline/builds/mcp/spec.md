# MCP Integration — Specification

**Document:** `spec.md`
**Project-wide documents (authoritative):** `../../constraints.md` (hard non-negotiables — §3 boundaries, §4 runtime deps, §5.10 subprocess lifecycle, §5.11 dispose contract, §7 invariants), `../../taste.md` (design philosophy, principles 6, 8, 10, 11, 12, 15)
**Status:** implementation-ready
**Scope:** adds a new workspace package `@repo/mcp` that lets agent-kit consumers (a) wrap MCP-exposed tools as plain `Tool` objects usable by `engine.generate({ tools })`, and (b) expose composition-layer flows as MCP tools over stdio or HTTP. Surfaces through the umbrella (`@robmclarty/agent-kit`). No change to `@repo/core` or `@repo/engine` public types. Closes the "MCP integration" backlog item from `NOTES.md` and the open question in `.ridgeline/builds/ai/spec.md` §13.6.

---

## §1 — Problem Statement

Agent-kit has no first-class way to talk to the MCP ecosystem. Three concrete gaps:

1. **No client-side bridge.** Model Context Protocol servers (filesystem, browser, database, memory, Zapier, Linear, etc.) expose tools over a well-defined wire format, but agent-kit users cannot pass those tools into `engine.generate({ tools })` without hand-writing a wrapper per server. Every wrapper repeats the same plumbing: spawn or connect, list tools, convert each tool's JSON-schema input to something the engine can validate, forward `execute` to the server, handle abort, close the connection on dispose.
2. **No server-side exposure.** A flow composed with `sequence`, `adversarial`, etc. is a `Step<i, o>` value — but there's no way to surface it to an external MCP client (Claude Desktop, Cursor, an upstream agent-kit instance, any MCP-capable host). Every deployment that wants "expose this flow as a tool" re-implements transport, JSON-schema advertisement, and request dispatch.
3. **The Claude CLI tool-bridge gap.** `.ridgeline/builds/claude-cli/spec.md` §8.2 defines `tool_bridge: 'allowlist_only' | 'forbid'` but leaves the obvious third mode — `'mcp_bridge'`, which would launch user `execute` closures as an ephemeral MCP server and point the CLI at them — as §14.1 deferred "requires MCP server machinery not yet in-package." This spec produces exactly that machinery. Wiring it into the Claude CLI adapter is a follow-on build (see §10).

All three are covered by one new workspace package with two small entry points. The engine does not change. The composition layer does not change. MCP machinery is additive adapter code.

---

## §2 — Solution Overview

### Core invariant

**No change to `@repo/core` or `@repo/engine`.** Tools produced by the client helper satisfy the engine's existing `Tool<i, o>` shape verbatim; the server helper takes an existing `Step<i, o>` and drives it through the existing `run` function. No new tool kind, no new step kind, no new runtime primitive — MCP is pure glue.

### New package

`packages/mcp/` publishes internally as `@repo/mcp`. Per the publish spec (Principle 15), it never reaches npm on its own. It's inlined into the bundle that ships as `@robmclarty/agent-kit`. Symbols added to the umbrella:

- `mcp_client(source)` — connect to an MCP server, return `{ tools, resources?, dispose }`.
- `serve_flow({ flows, transport })` — expose flows as MCP tools over stdio or HTTP, return `{ start, stop }`.
- Supporting types: `McpSource`, `McpClient`, `McpServer`, `McpTransport`, `ServeFlowOptions`.
- Typed errors: `mcp_connection_error`, `mcp_protocol_error`, `mcp_tool_call_error`, `mcp_transport_error`.

That's the entire public surface. Everything else is internal.

### Transports

Both client and server speak **stdio** (subprocess) and **streamable HTTP** (the MCP 2025-06 transport; SSE is not separately supported — consumers that only do SSE continue to work through HTTP with event-stream content-type). Client connects to either; server hosts either. WebSocket is out of scope.

### Dependency

`@modelcontextprotocol/sdk` ^1.0.0 is the only external runtime dependency. It owns framing, capability negotiation, and JSON-RPC serialization. `@repo/mcp` wraps its surfaces into the agent-kit shape and hides them. Workspace siblings (`@repo/core` at runtime for `run`, `@repo/engine` as types) are separate — see §6.1 for the full `package.json` shape. The umbrella declares the MCP SDK as an **optional peer** so consumers that never call `mcp_client` or `serve_flow` don't install it; MCP-using consumers get a pointed error at first call (§6.3).

### Boundary position

`@repo/mcp` sits as a sibling adapter package next to `@repo/observability` and `@repo/stores`. It imports:

- `Tool`, `ToolExecContext` from `@repo/engine` — **`import type` only**
- `Step`, `RunContext`, `TrajectoryLogger` from `@repo/core` — **`import type` only**
- `run` from `@repo/core` — **value import** (only `serve_flow.ts` needs it, to drive a flow on an incoming tool call)
- `@modelcontextprotocol/sdk` — runtime dep

It never imports `@repo/engine` values. The engine is type-only from here; MCP client tools do not use any engine runtime, they produce values the engine will consume.

### Lifecycle

Subprocess-backed MCP servers (stdio transport) follow the existing subprocess lifecycle rules (`constraints.md` §5.10): `spawn(..., { detached: true })`, per-client live registry, SIGTERM-then-SIGKILL escalation on dispose, `process.on('exit')` synchronous reap. `mcp_client` returns a `dispose()` that is callable in a `finally` block. The engine's `dispose()` does **not** auto-dispose MCP clients: they're caller-owned, not engine-owned.

### Surface shape (preview)

```typescript
import { create_engine, mcp_client, run, sequence, step } from '@robmclarty/agent-kit';

const engine = create_engine({ providers: { anthropic: { api_key } } });
const fs_mcp = await mcp_client({
  kind: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
});

try {
  const result = await engine.generate({
    model: 'claude-sonnet',
    prompt: 'read /tmp/notes.md and summarize',
    tools: fs_mcp.tools, // drop-in Tool[]
    abort,
  });
} finally {
  await fs_mcp.dispose();
  await engine.dispose();
}
```

```typescript
import { serve_flow, sequence, step } from '@robmclarty/agent-kit';

const plan_flow = sequence([step('parse', parse_fn), step('plan', plan_fn)]);

const handle = await serve_flow({
  flows: { plan: plan_flow },
  transport: { kind: 'stdio' }, // Claude Desktop-style
});

// handle.stop() to shut down; for stdio this is process-scoped.
```

---

## §3 — Client Surface (`mcp_client`)

### §3.1 File and module

- `packages/mcp/src/client.ts` — `mcp_client` factory, connection management, tool adaptation.
- `packages/mcp/src/schema.ts` — JSON Schema → zod conversion (narrow, see §3.6).
- `packages/mcp/src/types.ts` — public types.
- `packages/mcp/src/errors.ts` — typed errors.
- `packages/mcp/src/index.ts` — barrel; re-exported by the umbrella.

### §3.2 Signature

```typescript
export type McpStdioSource = {
  readonly kind: 'stdio';
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly startup_timeout_ms?: number;  // default 10_000
};

export type McpHttpSource = {
  readonly kind: 'http';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly request_timeout_ms?: number;  // default 30_000
};

export type McpSource = McpStdioSource | McpHttpSource;

export type McpClientOptions = {
  readonly abort?: AbortSignal;
  readonly trajectory?: TrajectoryLogger;
  readonly client_info?: { readonly name: string; readonly version: string };
  readonly tool_name_prefix?: string;
};

export type McpResource = {
  readonly uri: string;
  readonly name?: string;
  readonly mime_type?: string;
  readonly description?: string;
};

export type McpClient = {
  readonly tools: ReadonlyArray<Tool>;
  readonly resources: {
    readonly list: () => Promise<ReadonlyArray<McpResource>>;
    readonly read: (uri: string) => Promise<{ readonly mime_type?: string; readonly text?: string; readonly bytes?: Uint8Array }>;
  };
  readonly dispose: () => Promise<void>;
};

export function mcp_client(source: McpSource, options?: McpClientOptions): Promise<McpClient>;
```

### §3.3 Behavior — stdio

1. `spawn(command, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env })`. Per §5.10: explicit `env` (never implicit inherit), array argv (never `shell: true`), `cwd` passed through when supplied.
2. Wire the child's stdin/stdout into the MCP SDK's `StdioClientTransport`. Stderr is captured and emitted as `{ kind: 'mcp_stderr', line }` trajectory events, one per line, rate-limited to 200 lines per connection to avoid trajectory flooding on chatty servers.
3. Start the MCP handshake; fail with `mcp_connection_error` if no `initialize` response within `startup_timeout_ms`.
4. After `initialize` returns, call `tools/list` and (if the server advertises `resources`) enumerate via `resources/list` lazily — not at connect time.
5. Register the child in a per-client live `Set<ChildProcess>` (closed over by the factory). Remove on `close`.
6. On `dispose()`: SIGTERM the process group, escalate to SIGKILL after 2s, await `close`. Idempotent; second call returns the same resolved promise.
7. `process.on('exit')` handler synchronously `process.kill(-pid, 'SIGKILL')` every still-live child. Same as `claude_cli`'s handler — this is a shared pattern and the helper lives in `packages/mcp/src/lifecycle.ts`. Extraction to a shared internal location is deferred until a third subprocess consumer appears (see §10 open question 8); the child-process-scope ast-grep rule gets renamed today to stop baking "claude_cli" into rule identity (§5).

### §3.4 Behavior — HTTP

1. Construct a `StreamableHTTPClientTransport` pointed at `url` with the supplied `headers` attached to every request.
2. Handshake identically. Connection errors surface as `mcp_connection_error`.
3. `dispose()` closes the transport; no child to reap.

### §3.5 Tool adaptation

For each entry returned by `tools/list`:

1. **Name.** `<prefix><server_name>` if `tool_name_prefix` is set, else the server's name unchanged. Conflicts (two MCP servers exposing `fetch`) are the caller's problem: resolve via prefixes.
2. **Description.** Server's `description`, verbatim. Trimmed to 4096 chars (MCP servers occasionally ship novellas; the engine forwards these straight to provider SDKs that have length caps).
3. **Input schema.** Convert the server's `inputSchema` (JSON Schema) to `z.ZodType<unknown>` via the narrow converter in `packages/mcp/src/schema.ts` (see §3.6). Schemas that the converter can't handle fall back to `z.record(z.string(), z.unknown())` and emit a `{ kind: 'mcp_schema_fallback', tool, reason }` trajectory record at connect time.
4. **`execute`.** Calls `client.callTool({ name, arguments: input })`. The server's response is coerced as follows:
   - text-only → return the concatenated `.text` fields as a string
   - structured content → return the typed object
   - mixed → return `{ text, blocks }` where `blocks` preserves the raw content array
   - error result (`isError: true`) → throw `mcp_tool_call_error({ tool_name, server_error: <text> })`
5. **`needs_approval`.** Not set by default; callers wrap the returned `Tool` in a new object to add `needs_approval` if they want per-server approval gating. Rationale: MCP servers don't model this; imposing a default would be an opinion.
6. **Abort wiring.** `execute(input, ctx)` forwards `ctx.abort` to the MCP SDK's `callTool({ signal: ctx.abort })`. Abort propagates: the in-flight JSON-RPC request gets cancelled, the server receives an MCP `CancelledNotification`, `execute` rejects with the existing engine `aborted_error` class — **not** a new MCP-specific abort error. (Engine tool-loop semantics apply: a thrown `aborted_error` in tool.execute already aborts the whole `generate` call per `constraints.md` §5.1.)

### §3.6 JSON Schema → zod conversion

Scope is deliberately narrow. The converter handles what appears in ≥95% of real MCP tool schemas:

| JSON Schema | zod |
|---|---|
| `{ type: 'string' }` | `z.string()` |
| `{ type: 'string', enum: [...] }` | `z.enum([...])` |
| `{ type: 'number' \| 'integer' }` | `z.number()` (with `.int()` for `integer`) |
| `{ type: 'boolean' }` | `z.boolean()` |
| `{ type: 'array', items }` | `z.array(convert(items))` |
| `{ type: 'object', properties, required }` | `z.object({...}).partial()` with `.required()` pinning `required` members |
| `{ type: 'null' }` | `z.null()` |
| `oneOf`, `anyOf` | `z.union([...])` |
| `const` | `z.literal(...)` |

Anything else (deep `$ref`, `allOf`, complex `patternProperties`, `dependentSchemas`, `if`/`then`/`else`) → fall back to `z.record(z.string(), z.unknown())` + `mcp_schema_fallback` trajectory record. Rationale: the engine's own tool-input validation runs before `execute` per engine `constraints.md` §5.6; we want the common case strictly validated and the exotic case permissive, not both strict (which would error on legitimate tools) or both loose (which would miss catching simple typos).

No new dependency. The converter is ~100 lines, in-package. Adding a general JSON-schema-to-zod library (e.g. `json-schema-to-zod`) is rejected: it's a large surface we don't control, fixing edge cases requires upstream PRs, and 100 lines of straightforward code beats a 3000-line dependency for this job.

### §3.7 Trajectory events

`mcp_client` emits (via the optional `trajectory` on `McpClientOptions`):

- `{ kind: 'mcp_connect', source: { kind, command?, url? } }` — on start
- `{ kind: 'mcp_handshake', server_info, protocol_version, capabilities }` — after `initialize`
- `{ kind: 'mcp_tools_listed', count, names }` — after `tools/list`
- `{ kind: 'mcp_schema_fallback', tool, reason }` — per fallback (§3.6)
- `{ kind: 'mcp_tool_call_start', tool, call_id }` / `{ kind: 'mcp_tool_call_end', tool, call_id, duration_ms, error? }`
- `{ kind: 'mcp_stderr', line }` — stdio only, rate-limited
- `{ kind: 'mcp_dispose', signal_sent, escalated_to_kill }` — on dispose

No per-byte wire-level events. The MCP SDK's own debug logging stays off by default.

### §3.8 Errors

New error classes in `packages/mcp/src/errors.ts`, all extending `Error` per the `constraints.md` §2 exception-list (the list grows to three files: `packages/core/src/errors.ts`, `packages/engine/src/errors.ts`, `packages/mcp/src/errors.ts` — mechanically enforced via the existing `rules/no-class.yml` `ignores:` list):

- `mcp_connection_error({ source, cause })` — handshake failed, subprocess exited early, HTTP 4xx/5xx.
- `mcp_protocol_error({ message, server_info })` — server spoke malformed JSON-RPC or a capability we can't honor.
- `mcp_tool_call_error({ tool_name, server_error })` — server returned `isError: true`.
- `mcp_transport_error({ kind: 'stdio_stall' | 'http_network' | 'timeout', detail })` — transport-level failure that's not covered above.

All carry stable names for `instanceof` branching, consistent with existing error classes.

---

## §4 — Server Surface (`serve_flow`)

### §4.1 File and module

- `packages/mcp/src/server.ts` — `serve_flow`, request dispatch, transport binding.
- `packages/mcp/src/flow_to_tool.ts` — flow-to-MCP-tool adaptation (schemas, naming).

### §4.2 Signature

```typescript
export type FlowEntry<i = unknown, o = unknown> = {
  readonly flow: Step<i, o>;
  readonly description?: string;
  readonly input_schema?: z.ZodType<i>;
};

export type ServeFlowStdioTransport = { readonly kind: 'stdio' };
export type ServeFlowHttpTransport = {
  readonly kind: 'http';
  readonly port: number;
  readonly host?: string;   // default '127.0.0.1'
  readonly path?: string;   // default '/mcp'
};
export type ServeFlowTransport = ServeFlowStdioTransport | ServeFlowHttpTransport;

export type ServeFlowOptions = {
  readonly flows: Readonly<Record<string, Step<unknown, unknown> | FlowEntry>>;
  readonly transport: ServeFlowTransport;
  readonly server_info?: { readonly name: string; readonly version: string };
  readonly trajectory?: TrajectoryLogger;
  readonly on_cleanup?: () => Promise<void> | void;
};

export type McpServer = {
  readonly stop: () => Promise<void>;
  readonly address?: { readonly host: string; readonly port: number };
};

export function serve_flow(options: ServeFlowOptions): Promise<McpServer>;
```

### §4.3 Flow-to-tool mapping

For each `[name, entry]` in `flows`:

1. The MCP tool name is `name` verbatim. Collisions across entries throw `mcp_protocol_error` at `serve_flow` start (before listening).
2. Description: `entry.description` if present, else `describe(step)`'s single-line summary (the first line of the text renderer output), else an empty string.
3. Input schema. If `entry.input_schema` is present, convert it to JSON Schema via `z.toJSONSchema(schema)` (zod v4 built-in) and advertise that as the MCP tool's `inputSchema`. If absent, advertise the permissive fallback `{ type: 'object', additionalProperties: true }` — no `properties`, no `required`. At runtime, absent-schema calls skip input validation and hand the raw decoded JSON-RPC `arguments` object (a `Record<string, unknown>`) directly to `run(flow, input, ...)`; the flow is responsible for any shape-checking it needs. Rationale: the composition layer's `Step<i, o>` type has no runtime input schema today — that's an open gap flagged in the composition `spec.md`, not in scope here. The permissive fallback is deliberate: a strict-but-guessed schema would reject legitimate calls; the empty-object fallback would reject everything. `additionalProperties: true` with no `required` list matches what most MCP hosts render as "freeform arguments."
4. On MCP `tools/call`:
   - Parse input against `input_schema` (if supplied). Failure → return MCP error result `{ isError: true, content: [{ type: 'text', text: <validation message> }] }`. Do not throw.
   - Construct a fresh `run_context` per invocation: new `run_id`, a no-op `trajectory` unless `options.trajectory` is set (in which case spans nest under an `mcp_invocation` span), fresh `AbortController` linked to the MCP `CancelledNotification`.
   - Invoke `run(flow, input, { trajectory, abort })`.
   - Serialize the result: primitives JSON-encoded, objects as JSON, buffers as base64 blobs. Full shape matches MCP's content-block schema.
   - On throw: return `{ isError: true, content: [{ type: 'text', text: <error message + class name> }] }`. Never leak internal stack traces unless `options.include_stack_in_errors` is set — not in v1.

### §4.4 Transport binding

- **stdio.** Attach `StdioServerTransport` bound to `process.stdin`/`process.stdout`. `stop()` closes stdin. Only one stdio server can run per Node process — starting a second throws `mcp_transport_error({ kind: 'stdio_already_bound' })`.
- **http.** Start a Node `http.Server` (no Express, no Fastify — standard lib only) on the supplied host/port, mounted at `path`. Attach `StreamableHTTPServerTransport`. `stop()` closes the server and awaits in-flight connections (bounded 5s; after that, force-close).

### §4.5 Concurrency

Each MCP `tools/call` runs a fresh `run(...)` invocation, so concurrent calls interleave naturally — the composition layer already has no ambient state. There's no server-side request queue; HTTP transport's concurrency is bounded by the Node socket pool and the host OS, not by `@repo/mcp`. If a future consumer needs explicit per-server concurrency capping, add `max_concurrency` to `ServeFlowOptions`; defer.

### §4.6 Abort propagation

MCP's `CancelledNotification` arrives on the transport as a JSON-RPC notification referencing the original request id. The server maps `request_id → AbortController`, calls `.abort()` on the matching controller, and removes the entry when the run resolves. Aborts not matching any live request are dropped silently (the notification could race against completion).

### §4.7 Shutdown

`stop()`:

1. Close the transport (no new requests accepted).
2. Fire every live AbortController.
3. Await in-flight runs for up to 5s; after the timeout, resolve anyway and record `{ kind: 'mcp_shutdown_forced', in_flight_at_timeout: <count> }`.
4. Call `options.on_cleanup` if supplied.
5. Resolve.

Idempotent like `mcp_client.dispose()`.

---

## §5 — Architectural Invariants

Added to `constraints.md` §7 (mechanically enforced in `pnpm check`):

### New ast-grep rules

- `rules/no-mcp-sdk-outside-mcp.yml` — `@modelcontextprotocol/sdk` may only be imported under `packages/mcp/src/**`. No engine file, no core file, no umbrella file imports the SDK directly. Prevents leaking MCP types into layers that should stay MCP-agnostic.
- `rules/no-core-value-import-in-mcp.yml` — MCP may only import `run` from `@repo/core` via plain import; every other identifier from core is `import type`-only. Scope: `packages/mcp/src/**`.
- `rules/no-engine-value-import-in-mcp.yml` — MCP imports from `@repo/engine` are `import type`-only (full block on value imports). Scope: `packages/mcp/src/**`.
- `rules/no-process-env-in-core.yml` — scope extended to include `packages/mcp/src/**` (the engine already had this added; MCP follows the project-wide rule).

### Extended existing rules

- `rules/no-class.yml` — `ignores:` list grows to include `packages/mcp/src/errors.ts` (same carve-out as core and engine errors).
- `scripts/check-deps.mjs` — add a `check_mcp()` check beside the existing `check_core()` / `check_engine()` functions. Pattern: a hardcoded allow-set `MCP_ALLOWED = new Set(['@modelcontextprotocol/sdk', '@repo/core'])` enforced identically to `ENGINE_ALLOWED`. Additionally assert `peerDependencies` is absent or empty (peer declarations live only on the published root manifest; see §6.3). The engine type-import goes in `devDependencies` and is not asserted — `devDependencies` is intentionally unchecked by `check-deps.mjs` today, consistent with how the engine's empty `devDependencies` object is treated.
- `scripts/check-deps.mjs` — lockstep version invariant already covers the new `packages/mcp/package.json` once it's added (the lockstep set enumeration in `scripts/lib/lockstep.mjs` picks up `packages/*` via glob; no script change needed beyond the implicit inclusion).

### Subprocess lifecycle compliance

`packages/mcp/src/client.ts` is a subprocess consumer (for stdio transport) and observes every rule in `constraints.md` §5.10. The existing subprocess invariants (§7.16–§7.25) extend to it:

- `node:child_process` imports confined to `packages/mcp/src/client.ts`, `packages/mcp/src/lifecycle.ts`, and the existing `claude_cli` adapter files. **Rename** (not add) the existing `rules/no-child-process-outside-claude-cli.yml` → `rules/no-child-process-outside-subprocess-consumers.yml`. The rename drops the claude-cli-specific vocabulary from the rule `id` and `message`; the YAML `files:` scope extends to include `packages/mcp/src/**/*.ts`; the `ignores:` list extends to include `packages/mcp/src/client.ts` and `packages/mcp/src/lifecycle.ts` alongside the existing `packages/engine/src/providers/claude_cli/**/*.ts`. No second rule — one rule, broader scope. Updated `message`: "node:child_process may only be imported from designated subprocess-consumer adapters (claude_cli provider, mcp client). All other code talks to external processes through their adapter boundary."
- No provider-SDK imports (`ai`, `@ai-sdk/*`, etc.) under `packages/mcp/src/**` (new ast-grep rule: `rules/no-provider-sdk-in-mcp.yml`). MCP and provider SDKs don't interact.
- Every `spawn` passes `detached: true`, explicit `env`, explicit `stdio`, array argv, no `shell`.
- Live registry is closed-over in `mcp_client`; never module-level.

---

## §6 — Packaging and Distribution

### §6.1 New workspace package

```
packages/mcp/
├── package.json              # "@repo/mcp", "private": true, version 0.1.5 (lockstep)
├── README.md
├── src/
│   ├── client.ts
│   ├── server.ts
│   ├── flow_to_tool.ts
│   ├── lifecycle.ts
│   ├── schema.ts
│   ├── errors.ts
│   ├── types.ts
│   ├── index.ts
│   ├── client.test.ts
│   ├── server.test.ts
│   ├── schema.test.ts
│   └── integration.test.ts
└── test/
    └── fixtures/
        ├── mock_mcp_server.ts     # in-process MCP server used by client tests
        └── mock_mcp_client.ts     # in-process MCP client used by server tests
```

`package.json` shape (mirrors `packages/engine/package.json` — `exports` map, `scripts.test`, empty `devDependencies` object when unused):

```json
{
  "name": "@repo/mcp",
  "version": "0.1.5",
  "description": "MCP adapter for agent-kit. Client helper to consume MCP-exposed tools; server helper to expose flows as MCP tools.",
  "type": "module",
  "private": true,
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@repo/core": "workspace:*"
  },
  "devDependencies": {
    "@repo/engine": "workspace:*"
  }
}
```

Rationale for each entry:

- `@modelcontextprotocol/sdk` — external runtime dep (client + server transports).
- `@repo/core` — runtime value import (`run` is used by `serve_flow.ts`). Workspace sibling, not an external dep.
- `@repo/engine` — type-only import (`Tool`, `ToolExecContext`). Lives in `devDependencies` so the production-dep shape stays honest; workspace resolution still pulls it in for `import type` resolution at source.

No `peerDependencies` on `@repo/mcp` itself. The MCP-SDK-as-optional-peer declaration lives on the root (published) `package.json` — see §6.3. Workspace-internal packages never carry peer declarations; peers are a published-package concept.

### §6.2 Umbrella re-exports

`packages/fascicle/src/index.ts` adds:

```typescript
export { mcp_client, serve_flow } from '@repo/mcp';
export type {
  FlowEntry,
  McpClient,
  McpClientOptions,
  McpHttpSource,
  McpResource,
  McpServer,
  McpSource,
  McpStdioSource,
  ServeFlowHttpTransport,
  ServeFlowOptions,
  ServeFlowStdioTransport,
  ServeFlowTransport,
} from '@repo/mcp';
export {
  mcp_connection_error,
  mcp_protocol_error,
  mcp_tool_call_error,
  mcp_transport_error,
} from '@repo/mcp';
```

### §6.3 Bundle behavior (root `tsdown.config.ts`)

The root `tsdown.config.ts` already inlines `/^@repo\//` via `noExternal`. `@repo/mcp` is therefore inlined into the published `@robmclarty/agent-kit` bundle automatically — no change to `tsdown.config.ts`.

`@modelcontextprotocol/sdk` gets added to the root `package.json`'s `external` list and declared as an optional peer dependency:

```jsonc
// tsdown.config.ts
external: [
  'ai',
  'zod',
  /^@ai-sdk\//,
  'ai-sdk-ollama',
  '@openrouter/ai-sdk-provider',
  '@modelcontextprotocol/sdk',   // NEW
],
```

```jsonc
// root package.json
"peerDependencies": {
  "ai": "^6.0.0",
  "zod": "^4.0.0",
  "@modelcontextprotocol/sdk": "^1.0.0",   // NEW
  // ...ai-sdk providers...
},
"peerDependenciesMeta": {
  "@modelcontextprotocol/sdk": { "optional": true },   // NEW
  // ...provider opts...
}
```

Users who don't call `mcp_client` or `serve_flow` never install the MCP SDK. Users who do get a clear peer-missing error at first call; `mcp_client` performs a dynamic `import('@modelcontextprotocol/sdk/client/index.js')` that fails with `mcp_connection_error({ cause: <ERR_MODULE_NOT_FOUND> })` and a message pointing at `pnpm add @modelcontextprotocol/sdk`.

### §6.4 `scripts/check-publish.mjs`

One new assertion: the published bundle's `dist/index.js` must contain `mcp_client` and `serve_flow` as top-level exports. The existing smoke-import check (publish spec §3.4 step 4) is extended:

```javascript
const expected = [
  ...EXISTING_EXPORTS,
  'mcp_client', 'serve_flow',
  'mcp_connection_error', 'mcp_protocol_error',
  'mcp_tool_call_error', 'mcp_transport_error',
];
for (const name of expected) {
  if (!(name in mod)) throw new Error(`missing export: ${name}`);
}
```

---

## §7 — Success Criteria

### Automated tests

**Client — in-process MCP server fixture**

1. **Handshake happy path.** Start `mock_mcp_server` in-process, `mcp_client` returns non-empty `tools`, `client_info` and `protocol_version` recorded in trajectory.
2. **Tools list conversion.** Fixture server exposes five tools (string input, number input, enum, object, array); assert five matching `Tool` entries with correct zod schemas that `.parse()` representative inputs successfully.
3. **Tool call happy path.** Invoke `tool.execute({ foo: 'bar' }, ctx)` on a fixture tool; assert the server received the correct JSON-RPC request and the engine-side return matches.
4. **Tool call error.** Fixture tool returns `{ isError: true, content: [{ text: 'bad thing' }] }`; assert `execute` throws `mcp_tool_call_error` with `server_error: 'bad thing'`.
5. **Abort mid-call.** Fire `ctx.abort` while tool call is pending; assert the server received `CancelledNotification`, `execute` rejects with `aborted_error`.
6. **Resource listing.** Fixture server exposes two resources; `client.resources.list()` returns both with correct `uri` and `mime_type`. `client.resources.read(uri)` returns the expected payload.
7. **Schema fallback.** Fixture tool advertises a schema with `allOf`; `mcp_client` uses `z.record(z.string(), z.unknown())` and emits `mcp_schema_fallback` trajectory record.
8. **Dispose idempotent.** Two sequential `dispose()` calls resolve without error; second is a no-op.
9. **Stdio subprocess leak.** Spawn five stdio clients, abort them mid-handshake, `dispose()` each; assert all children exited (`proc.killed === true`), live registry empty.
10. **Connection timeout.** Mock subprocess that never sends `initialize` response; assert `mcp_connection_error` after `startup_timeout_ms`, subprocess killed.
11. **HTTP transport.** Mock MCP HTTP server on `127.0.0.1:0`; connect, list tools, call, dispose; assert parity with stdio path.
12. **Peer missing.** Unresolve `@modelcontextprotocol/sdk` (vi.mock with throw); assert `mcp_connection_error` with pointer to `pnpm add @modelcontextprotocol/sdk`.

**Server — in-process MCP client fixture**

13. **Serve single flow, stdio.** `serve_flow({ flows: { plan: plan_flow }, transport: { kind: 'stdio' } })`; connect `mock_mcp_client` to the bound stdio; `tools/list` returns `plan`; `tools/call` with valid input returns the flow output.
14. **Serve multiple flows.** Three flows registered; each appears in `tools/list`; name collisions throw at `serve_flow` start.
15. **Input validation rejects.** Register flow with `input_schema`; invalid input arrives; assert MCP response is `isError: true` with validation-message text (not a runtime throw).
16. **Flow throws.** Registered flow throws mid-run; assert MCP response `isError: true` carries the error message (no stack trace).
17. **Abort via CancelledNotification.** Long-running flow; client sends `CancelledNotification`; flow's `ctx.abort` fires; flow's cleanup handlers run; MCP response is `aborted_error` text.
18. **HTTP transport binds.** `transport: { kind: 'http', port: 0 }`; `handle.address.port` is a non-zero number; client connects and calls tools; `stop()` closes.
19. **Stop drains in-flight.** Start flow with 2s sleep; call `stop()` 500ms in; assert flow's abort fires and `stop()` resolves within 5.5s.
20. **Stop forced.** Flow that ignores abort and sleeps 10s; `stop()` resolves within 5.5s with `mcp_shutdown_forced` trajectory record.
21. **Concurrent tool calls.** Three concurrent `tools/call` against the same server; assert three independent `run_id`s; results uncorrelated.
22. **Two stdio servers on same process.** Second `serve_flow({ transport: { kind: 'stdio' } })` throws `mcp_transport_error({ kind: 'stdio_already_bound' })`.

**Schema conversion unit**

23. **Converter covers all table entries in §3.6.** One test per row; round-trips valid and rejects invalid.
24. **Fallback trigger.** `allOf`, `if/then/else`, `$ref`, `patternProperties` each yield `z.record(z.string(), z.unknown())`.

**Integration — cross-layer**

25. **End-to-end: engine.generate with mcp_client tools.** Fake provider returns a `tool_use` turn invoking a tool sourced from `mock_mcp_server`; engine's tool loop runs; result contains tool output; `client.dispose()` in `finally`; assert clean shutdown.
26. **End-to-end: serve_flow wrapping an engine-backed flow.** Flow uses `model_call` to hit a fake provider; MCP client calls `plan` tool; response contains the generated content; abort via `CancelledNotification` cancels the HTTP call to the fake provider.

### Manual validation

- `pnpm check` exits 0 including every new rule.
- `pnpm build` produces a bundle that imports `mcp_client` and `serve_flow`; `npm pack --dry-run` lists them; `arethetypeswrong` passes.
- Install the tarball in a scratch project, run `node -e "import('@robmclarty/agent-kit').then(m => console.log(typeof m.mcp_client, typeof m.serve_flow))"` → prints `function function`.
- A real MCP server (`npx @modelcontextprotocol/server-filesystem /tmp`) responds to `mcp_client({ kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] })`; `tools` is non-empty; a sample tool call succeeds and `dispose()` reaps the subprocess.
- A `serve_flow({ transport: { kind: 'stdio' } })` invocation appears in Claude Desktop's MCP config (`~/.config/claude/claude_desktop_config.json` entry pointing at a one-file Node script); Claude Desktop lists the registered flow as a tool and invokes it.

### Architectural validation (mechanically checked)

- No value import of `@repo/engine` anywhere under `packages/mcp/src/**`.
- `@modelcontextprotocol/sdk` imported only under `packages/mcp/src/**`.
- `node:child_process` imported only in `packages/mcp/src/client.ts` and `packages/mcp/src/lifecycle.ts`.
- No `process.env` reads anywhere under `packages/mcp/src/**`.
- Every `spawn` in `packages/mcp/src/**` passes `detached: true`, explicit `env`, array argv, no `shell`.
- `packages/mcp/package.json` is the only place declaring `@modelcontextprotocol/sdk` as a dependency.
- `version` in `packages/mcp/package.json` matches the root + every other `packages/*/package.json` + both `version.ts` constants (lockstep invariant extends automatically).

---

## §8 — File Structure

```
agent-kit/
├── packages/
│   ├── mcp/                                   # NEW
│   │   ├── package.json
│   │   ├── README.md
│   │   └── src/
│   │       ├── client.ts
│   │       ├── server.ts
│   │       ├── flow_to_tool.ts
│   │       ├── lifecycle.ts
│   │       ├── schema.ts
│   │       ├── errors.ts
│   │       ├── types.ts
│   │       ├── index.ts
│   │       ├── client.test.ts
│   │       ├── server.test.ts
│   │       ├── schema.test.ts
│   │       └── integration.test.ts
│   └── agent-kit/
│       └── src/
│           └── index.ts                       # EDIT: re-export mcp_client, serve_flow, types, errors
├── rules/                                     # NEW rules
│   ├── no-mcp-sdk-outside-mcp.yml
│   ├── no-core-value-import-in-mcp.yml
│   ├── no-engine-value-import-in-mcp.yml
│   └── no-provider-sdk-in-mcp.yml
├── rules/                                     # RENAMED rule
│   └── no-child-process-outside-claude-cli.yml    # git-mv → no-child-process-outside-subprocess-consumers.yml; extend files/ignores (see §5)
├── rules/                                     # EDITED rules
│   ├── no-class.yml                           # EDIT: add packages/mcp/src/errors.ts to ignores
│   └── no-process-env-in-core.yml             # EDIT: extend scope to packages/mcp/src/**
├── scripts/
│   ├── check-deps.mjs                         # EDIT: assert @repo/mcp deps shape; lockstep picks up automatically
│   └── check-publish.mjs                      # EDIT: extend smoke-import expected-exports list
├── tsdown.config.ts                           # EDIT: add @modelcontextprotocol/sdk to external
├── package.json                               # EDIT: add @modelcontextprotocol/sdk peer + meta
└── pnpm-workspace.yaml                        # no change (already globs packages/*)
```

Public surface additions published through the umbrella:

- `mcp_client`, `serve_flow`
- `McpSource`, `McpStdioSource`, `McpHttpSource`, `McpClient`, `McpClientOptions`, `McpResource`
- `ServeFlowOptions`, `ServeFlowTransport`, `ServeFlowStdioTransport`, `ServeFlowHttpTransport`, `McpServer`, `FlowEntry`
- `mcp_connection_error`, `mcp_protocol_error`, `mcp_tool_call_error`, `mcp_transport_error`

Published package surface for consumers: `import { mcp_client, serve_flow } from '@robmclarty/agent-kit'`.

---

## §9 — `taste.md` Additions

One new principle, numbered to continue the existing list in `.ridgeline/taste.md`:

**Principle 17 — MCP is glue, not a new primitive.** MCP integration adds no new tool kind, no new step kind, no new runtime abstraction. `mcp_client` produces `Tool[]` values that satisfy the engine's existing `Tool<i, o>` contract exactly; `serve_flow` consumes existing `Step<i, o>` values and drives them through existing `run`. The boundary holds in both directions: the engine does not know MCP exists, and composition-layer flows do not know they might be served over MCP. This lets MCP land, evolve, and potentially be replaced without the core and engine layers paying any coupling tax. If a future "MCP 2" appears (streamable-first, auth-native, something else), the replacement is a sibling package; the rest of the workspace is unaffected. Adapter packages exist exactly so major protocol bets can be changed without rewriting the composition surface.

---

## §10 — Open Questions

1. **Claude CLI `tool_bridge: 'mcp_bridge'`.** The machinery this spec builds is what the Claude CLI spec needs to upgrade `tool_bridge` from `'allowlist_only' | 'forbid'` to `'allowlist_only' | 'forbid' | 'mcp_bridge'`. Wiring: the adapter calls an internal `bridge_tools_as_mcp(tools)` helper (new, in `packages/mcp/src/bridge.ts`) that launches an ephemeral `serve_flow`-style MCP server over stdio with those tools as proxy MCP tools, then passes `--mcp-config <path>` to the CLI argv. Out of scope for this build; follow-on under the existing `claude-cli` ridgeline. Nothing in this spec forecloses it.
2. **Tool-level approval gating.** `mcp_client` returns `Tool` objects with no `needs_approval`. An `mcp_client({ ..., default_needs_approval: true })` convenience or per-tool override (`{ approval: { my_tool: true } }`) may land later. Wait for a caller asking.
3. **MCP `sampling` capability.** MCP servers can ask clients to sample from the model. `mcp_client` ignores `sampling/createMessage` requests in v1 (returns `method not supported`). Enabling it would have the client synthesize a call through a supplied `Engine`; the wiring is mechanical but introduces a model-provisioning concern into `mcp_client` that isn't free. Defer.
4. **`resources` subscriptions.** `resources/subscribe` and update notifications are not surfaced in v1. `client.resources` is list/read only. Subscription is naturally streaming — either `AsyncIterable` or `ctx.emit` — and that shape is one to decide carefully under a concrete use case.
5. **Server-side auth.** `serve_flow({ transport: { kind: 'http' } })` listens on `127.0.0.1` by default and has no auth. Putting it on a non-loopback interface without fronting it with an auth proxy is a bad idea; spec documents this in the README. First-class auth (token, mTLS, OAuth) deferred.
6. **JSON-schema conversion completeness.** §3.6's narrow converter covers ≥95% of real-world MCP tool schemas but drops `allOf`/`$ref`/etc. to permissive. If a named user hits this, evaluate adding a maintained library (`json-schema-to-zod`) versus widening the in-package converter. Measure first.
7. **Trajectory event naming.** The `mcp_*` event kinds (`mcp_connect`, `mcp_tool_call_start`, etc.) are the initial shape; they're additive-minor per `constraints.md` §8 semver (new `kind` strings are non-breaking). Rename candidates if a cleaner namespace emerges: `mcp.client.connect`, etc. Keep the flat kind for v1.
8. **Shared subprocess lifecycle helper.** `packages/mcp/src/lifecycle.ts` duplicates small amounts of the process-group signal-delivery logic in `packages/engine/src/providers/claude_cli/lifecycle.ts` (or wherever `claude_cli` keeps it). After a third subprocess consumer appears, extract to a shared internal module (e.g. `packages/core/src/_subprocess.ts` — underscore-prefixed internal export). Premature abstraction with only two call sites.

---

## Bootstrap / required reading for the builder

Read in order. Items 1–3 are the contract; 4–6 are source orientation; 7 is prior art.

1. `../../constraints.md` — project-wide non-negotiables, especially §3 (boundaries), §5.10 (subprocess lifecycle), §5.11 (dispose contract), §7 (invariants).
2. `../../taste.md` — principles 6 (no ambient state), 8 (small public surface), 10 (subprocess lifecycle first-class), 11 (dispose universal), 12 (asymmetry loud), 15 (umbrella-is-the-seam). Principle 17 (new, from §9 of this spec).
3. `./spec.md` — this file.
4. Current engine surface:
   - `../../../packages/engine/src/types.ts` — `Tool`, `ToolExecContext`, `GenerateOptions.on_tool_approval`
   - `../../../packages/engine/src/generate.ts` — how tools are consumed
5. Current composition surface:
   - `../../../packages/core/src/types.ts` — `Step`, `RunContext`, `TrajectoryLogger`
   - `../../../packages/core/src/runner.ts` — `run()` signature
6. Umbrella integration:
   - `../../../packages/fascicle/src/index.ts` — where new re-exports land
   - `../../../tsdown.config.ts` — external list
7. Prior subprocess lifecycle patterns:
   - `../../../packages/engine/src/providers/claude_cli/` — the existing subprocess consumer. Copy its lifecycle discipline, not its code.

### Build order

1. **`packages/mcp/` scaffolding.** `package.json`, `README.md`, empty `src/index.ts`, add to `pnpm-workspace.yaml` (no change needed — it globs). Run `pnpm install` and confirm the package appears under `@repo/mcp` via `pnpm -r list`.
2. **Types and errors.** `packages/mcp/src/types.ts`, `packages/mcp/src/errors.ts`. No runtime logic; compiles against `@repo/core` and `@repo/engine` type imports.
3. **Schema converter.** `packages/mcp/src/schema.ts` plus `schema.test.ts`. Self-contained; can ship standalone.
4. **Subprocess lifecycle helper.** `packages/mcp/src/lifecycle.ts` — process-group signal, live-registry, synchronous exit reap. Mirrors claude_cli's patterns.
5. **Client happy path.** `packages/mcp/src/client.ts` stdio + fixture server in `test/fixtures/mock_mcp_server.ts`. Tests 1–4, 8, 9.
6. **Client HTTP and error paths.** Test 10, 11, 12. Fixture HTTP server.
7. **Resources.** Test 6.
8. **Server happy path.** `packages/mcp/src/server.ts`, `packages/mcp/src/flow_to_tool.ts`, fixture client. Tests 13, 14.
9. **Server error paths + abort.** Tests 15–22.
10. **Integration tests.** Tests 25, 26.
11. **ast-grep rules.** Add `rules/no-mcp-sdk-outside-mcp.yml`, `rules/no-core-value-import-in-mcp.yml`, `rules/no-engine-value-import-in-mcp.yml`, `rules/no-provider-sdk-in-mcp.yml`. Rename `rules/no-child-process-outside-claude-cli.yml` → `rules/no-child-process-outside-subprocess-consumers.yml` and extend its `files`/`ignores` scope (§5). Extend `rules/no-class.yml` (add `packages/mcp/src/errors.ts` to `ignores`) and `rules/no-process-env-in-core.yml` (extend `files` scope to `packages/mcp/src/**`).
12. **`scripts/check-deps.mjs` updates.** Add a `check_mcp()` function mirroring `check_engine()`: hardcoded `MCP_ALLOWED = new Set(['@modelcontextprotocol/sdk', '@repo/core'])`, assert empty/absent `peerDependencies`. Wire into `main()` alongside `check_core()` and `check_engine()`.
13. **Umbrella re-exports.** Edit `packages/fascicle/src/index.ts`.
14. **`tsdown.config.ts` + root `package.json`.** Add `@modelcontextprotocol/sdk` as external and as optional peer.
15. **`scripts/check-publish.mjs`.** Extend smoke-import list.
16. **Documentation.** `packages/mcp/README.md`; one paragraph in the root README under a new "MCP" subsection of Concepts (or extend the existing Concepts doc); new `docs/mcp.md` covering both `mcp_client` and `serve_flow` with runnable examples.
17. **`taste.md` principle 17.** Add to `.ridgeline/taste.md`.
18. **`CHANGELOG.md` entry** via `/version` on next release.

### Invariants to enforce during implementation

- `@repo/mcp` never imports `@repo/engine` values; type-only all the way.
- `@repo/mcp` imports exactly one value from `@repo/core`: `run`. Every other core-sourced identifier is `import type`.
- Every `spawn` inside `packages/mcp/src/**` obeys constraints §5.10 (detached, explicit env, explicit stdio, array argv, no shell, live-registry insert, close-handler remove).
- `mcp_client.dispose()` and `serve_flow(...).stop()` are both idempotent and both LIFO-safe — a `finally`-block call after an abort must not hang or throw.
- The engine's `Engine.dispose()` does not automatically dispose `mcp_client` instances. MCP connection lifecycle is caller-owned. Document this prominently in `packages/mcp/README.md`.
- `mcp_client` uses only `import type` from `@repo/engine`; it produces values satisfying that shape but never calls engine runtime code.
- `serve_flow` uses only `run` from `@repo/core` at runtime; all other core interactions are at the type level.
- No `process.env` reads anywhere in `packages/mcp/src/**`.
- Tools produced by `mcp_client` must round-trip through the engine's existing tool-input validation (constraints §5.6) — invalid inputs never reach the MCP server.

When in doubt, the spec wins over intuition. Implement the simpler interpretation; mark any divergence with a `TODO` citing the relevant section.

# AI Engine Layer — `claude_cli` Provider — Specification

**Document:** `spec.md`
**Project-wide documents (authoritative):** `../../constraints.md` (hard non-negotiables — subprocess-provider rules live in §3, §4, §5.10, §5.11, §7, §9), `../../taste.md` (design philosophy — principles 9–14 cover the discriminated-union adapter, subprocess lifecycle, universal dispose, tool-model asymmetry, cost source, and unknown-event tolerance).
**Status:** implementation-ready
**Scope:** adds a single built-in provider (`claude_cli`) to `@robmclarty/engine` that dispatches model calls to the locally-installed `claude` CLI binary instead of an HTTPS API.

---

## §1 — Problem Statement

`@robmclarty/engine` dispatches Anthropic calls through `@ai-sdk/anthropic`, which uses the `x-api-key`-authenticated messages API. For a user holding a Claude Max or Pro subscription, that path is wrong in two ways:

1. **Billing leakage.** Every call bills API credits at list price; the Max/Pro quota is unused. Heavy iteration against that setup costs thousands of dollars per quarter of avoidable spend on work the subscription already covers.
2. **Capability gap.** The `claude` CLI carries features the raw messages API does not: session resumption, skill discovery from `.claude/` directories, subagent routing, sandboxed tool execution (bwrap / greywall), plugin directories, and a curated built-in tool catalogue with a shell-allowlist grammar. An engine that pretends the CLI does not exist forces application code to choose between calling `claude` directly (bypassing the engine) or losing those capabilities.

The `claude_cli` provider closes both gaps. It treats the `claude` binary as a transport: a different wire between the engine's `generate` call and Anthropic's models, with OAuth-subscription authentication and a richer built-in toolset. The engine's public surface (`generate`, `GenerateOptions`, `GenerateResult`) is unchanged; one new provider slot is added to the alias resolver and one new provider adapter ships under `packages/engine/src/providers/claude_cli/`.

**Strategic motivation.** Bringing the CLI behind the `generate` seam unlocks provider substitutability: a step written as `generate({ model: 'cli-sonnet', prompt })` runs under the user's subscription today and can switch to `'claude-sonnet'` (HTTPS, API-billed) tomorrow by editing one alias line. No step file changes. The engine remains the single choke point for model calls; the transport underneath moves.

---

## §2 — Solution Overview

### Core invariant

**`generate` is unchanged.** The signature, options, result shape, streaming contract, cancellation contract, and cost-breakdown contract all match the engine's existing contract exactly. A caller who writes

```typescript
import type { GenerateResult, StreamChunk } from '@robmclarty/engine';

const { content }: GenerateResult = await engine.generate({
  model: 'cli-sonnet',
  prompt: 'draft the migration plan',
  abort: ctx.abort,
  trajectory: ctx.trajectory,
  on_chunk: (chunk: StreamChunk): void => {
    if (chunk.kind === 'text') ctx.emit({ kind: 'token', text: chunk.text });
  },
});
```

gets a `GenerateResult` whose `content`, `usage`, `cost`, `finish_reason`, `steps`, and `tool_calls` fields look identical to the same call against `'claude-sonnet'`. The only observable differences are in `model_resolved.provider === 'claude_cli'`, in the trajectory (cost events carry `source: 'provider_reported'`), and in how tools behave (see §8).

### Provider slot

A new provider name, `claude_cli`, joins the built-in set:

```
anthropic, openai, google, ollama, lmstudio, openrouter, claude_cli
```

It is addressable three ways:

1. **Alias.** `DEFAULT_ALIASES` gains `cli-opus`, `cli-sonnet`, `cli-haiku` (see §9).
2. **Colon-bypass.** `generate({ model: 'claude_cli:claude-opus-4-7' })` routes without a registered alias, via the `KNOWN_PROVIDERS` set in `packages/engine/src/aliases.ts`.
3. **User alias.** `engine.register_alias('my_cli', { provider: 'claude_cli', model_id: 'claude-sonnet-4-6' })`.

Resolution follows the existing algorithm in `packages/engine/src/aliases.ts` (`resolve_model`) unchanged. The first-colon split keeps the prefix form safe: `claude_cli` has no `/` in its id grammar, and colons inside the model id do not occur.

### Transport model

Every `generate` call routed to `claude_cli` spawns one `claude` subprocess via `node:child_process` `spawn`. stdin carries the user prompt; CLI arguments carry system prompt, model id, tool allowlist, session id, agents, plugin dirs, and JSON schema; stdout delivers a `stream-json` event stream; stderr is captured for diagnostic reporting. On the terminal `result` event the engine maps to `GenerateResult`.

No HTTP client runs in-process. `AbortSignal` maps to SIGTERM on the subprocess's process group, with a SIGKILL escalator. Stall and startup timeouts are distinct from abort.

### Layer boundary

```
┌─────────────────────────────────────────────────────────────┐
│  Application code (your harnesses, workflows, agents)      │
├─────────────────────────────────────────────────────────────┤
│  @robmclarty/core (composition layer)                       │
├─────────────────────────────────────────────────────────────┤
│  @robmclarty/engine (generate, create_engine, aliases)      │
├─────────────────────────────────────────────────────────────┤
│  Provider adapters                                          │
│    anthropic / openai / google / ollama /                   │
│    lmstudio / openrouter  → Vercel AI SDK → HTTPS           │
│    claude_cli             → spawn('claude', ...) → stdin/out│
├─────────────────────────────────────────────────────────────┤
│  claude CLI binary (separate install; OAuth via             │
│  `claude login` or api_key passed via provider config)      │
├─────────────────────────────────────────────────────────────┤
│  Anthropic API (hit by the CLI, not by the engine)          │
└─────────────────────────────────────────────────────────────┘
```

`claude_cli` is the first adapter in the set that does not depend on Vercel AI SDK. Its adapter value is shaped as the `SubprocessProviderAdapter` branch of the discriminated union defined in `packages/engine/src/providers/types.ts`. The engine's `generate.ts` already branches on `adapter.kind === 'subprocess'` and delegates to `adapter.generate(opts, resolved)`.

### Data-flow model

`generate` remains single-shot. Tool loops, when they occur, happen **inside the `claude` subprocess**, not in the engine. The engine sees one CLI invocation and one terminal `result` event. Intermediate `text` and `tool_use` events translate to `StreamChunk`s and per-step `StepRecord`s for observability, but the engine is not driving a loop.

---

## §3 — Integration with the Engine's Existing Surface

### What changes

| Area | Change |
|------|--------|
| `ProviderConfigMap` | Adds a `claude_cli?: ClaudeCliProviderConfig` entry. See §5.1. |
| `DEFAULT_ALIASES` | Adds `cli-opus`, `cli-sonnet`, `cli-haiku`. See §9. |
| `KNOWN_PROVIDERS` | Adds `'claude_cli'`. |
| `DEFAULT_PRICING` | No additions. `claude_cli` cost comes from the CLI's `total_cost_usd` field. See §10. |
| `GenerateOptions.provider_options` | Already typed as `Record<string, unknown>` at the engine's generic surface. The `claude_cli` namespace's value type is `ClaudeCliCallOptions` (§5.3), exported from the engine type barrel. |
| `GenerateResult.provider_reported` | Already typed as `Record<string, unknown>`. The `claude_cli` namespace surfaces `{ session_id, duration_ms }` (§5.4). |
| `finish_reason` | No new values. Transport failures surface as `claude_cli_error`, not as a finish reason. |
| Tool-call loop | The engine's loop is **not** used for `claude_cli`. The CLI runs its own. Engine synthesizes `steps` and `tool_calls` from the stream. See §8. |
| Retry policy | Applies only to the subprocess failing to spawn or exiting with a transient-signal non-zero code. Mid-stream interruptions cannot be retried (same asymmetry HTTPS streaming already has). |
| Cost computation | Bypasses the engine pricing table. `StepRecord.cost` and aggregated `GenerateResult.cost` come from the CLI's per-turn output-token-weighted allocation of `total_cost_usd`. See §10. |
| Trajectory spans | `engine.generate.step` spans map to CLI-reported turns. Cost events carry `source: 'provider_reported'`. |

### What does not change

- `generate`'s signature, return type, and behavioral guarantees.
- The abort invariant: `aborted_error` is raised; partial result is not returned.
- The streaming invariant: `on_chunk` is purely observational; the final `GenerateResult` is identical with or without `on_chunk`.
- The no-`class`, no-`this`, no-mutation, snake_case-values / PascalCase-types rules (see project constraints).
- The engine's public API surface. `create_engine`, `register_alias`, `register_price`, `list_*`, `dispose` are unchanged.

---

## §4 — Authentication Model

The `claude` CLI resolves credentials itself. The engine does not read OAuth tokens, does not touch the keychain, does not parse `~/.claude/` files, does not invoke `claude login`. The adapter's job is to (a) verify a `claude` binary is reachable, (b) enforce which auth source the CLI will use, and (c) surface clear errors when none is available.

### Credential flow

Credentials flow in through **construction-time config**, never via ambient environment reads inside engine source.

```typescript
import { create_engine } from '@robmclarty/engine';
import { get_anthropic_api_key } from '@robmclarty/config';

const engine = create_engine({
  providers: {
    claude_cli: {
      auth_mode: 'api_key',
      api_key: get_anthropic_api_key(),
    },
  },
});
```

`packages/engine/src/providers/claude_cli/auth.ts` does **not** read `process.env`. Every value it needs arrives via `ClaudeCliProviderConfig` (§5.1). Applications (ridgeline, internal workflows) call `@robmclarty/config`'s `get_anthropic_api_key()` or an equivalent resolver and pass the value into `create_engine`.

### `auth_mode` semantics

| `auth_mode` | Behavior |
|-------------|----------|
| `'auto'` (default) | Adapter builds the subprocess env from scratch (it never inherits `process.env`), copying `api_key` in as `ANTHROPIC_API_KEY` when supplied. If `api_key` is absent, the CLI falls back to whatever OAuth token it has locally. |
| `'oauth'` | Adapter builds the subprocess env **without** `ANTHROPIC_API_KEY`, even if `api_key` is set in config. Forces the CLI onto its OAuth token. If the CLI has no valid token, first call throws `provider_auth_error` (§11 F19). |
| `'api_key'` | `api_key` must be non-empty in `ClaudeCliProviderConfig`. Enforced synchronously inside the adapter factory; missing or empty → `engine_config_error` at `create_engine` time with `provider: 'claude_cli'`. |

`'oauth'` is the recommended mode for subscription-backed harnesses: it guarantees API credits are not silently spent when a user leaves an `ANTHROPIC_API_KEY` in their shell.

### Auth-failure detection

The CLI reports auth failures through non-zero exit plus stderr containing one of `authentication`, `unauthorized`, `forbidden`, `oauth token has expired`, `invalid_api_key` (case-insensitive). The adapter matches against a frozen `CLI_AUTH_ERROR_PATTERNS` array and throws `provider_auth_error` with a `refresh_command: 'claude login'` hint.

### `engine_config_error` vs async probe

Construction-time validation is synchronous. `create_engine` stays synchronous (§5.5). The adapter factory validates only what it can from config alone (binary path presence, `auth_mode: 'api_key'` needs `api_key`, sandbox kind is recognized). The CLI `--version` probe, when `ClaudeCliProviderConfig.skip_probe !== true`, runs lazily on the first `generate` call for that provider — failures surface as `claude_cli_error` there, not at construction.

---

## §5 — Interface Definitions

### §5.1 Provider config

```typescript
import type { ProviderConfigMap } from '@robmclarty/engine';

export type AuthMode = 'auto' | 'oauth' | 'api_key';

export type ToolBridgeMode = 'allowlist_only' | 'forbid';

export type SandboxProviderConfig =
  | {
      kind: 'bwrap';
      network_allowlist?: ReadonlyArray<string>;
      additional_write_paths?: ReadonlyArray<string>;
    }
  | {
      kind: 'greywall';
      network_allowlist?: ReadonlyArray<string>;
      additional_write_paths?: ReadonlyArray<string>;
    };

export type ClaudeCliProviderConfig = {
  readonly binary?: string;
  readonly auth_mode?: AuthMode;
  readonly api_key?: string;
  readonly default_cwd?: string;
  readonly startup_timeout_ms?: number;
  readonly stall_timeout_ms?: number;
  readonly setting_sources?: ReadonlyArray<'user' | 'project' | 'local'>;
  readonly plugin_dirs?: ReadonlyArray<string>;
  readonly sandbox?: SandboxProviderConfig;
  readonly skip_probe?: boolean;
};
```

The `ProviderConfigMap` in `packages/engine/src/types.ts` is extended so `claude_cli?: ClaudeCliProviderConfig` is permitted. Field defaults:

- `binary`: `'claude'`
- `auth_mode`: `'auto'`
- `default_cwd`: neither `process.env` nor `process.cwd()` is read from inside the adapter; when `default_cwd` is omitted, the spawn call passes `cwd: undefined` and the subprocess inherits the cwd of the Node process. This preserves the "no `process.env` / no `process.cwd()` inside engine source" boundary for the non-default case. The existing `rules/no-process-env-in-core.yml` ast-grep rule does not currently catch `process.cwd()`; the adapter PR must either extend its `regex` to `^process\.(env|cwd)$` or add a sibling `rules/no-process-cwd-in-engine.yml` scoped to `packages/engine/src/**` (the cheaper option is fine; both close the gap).
- `startup_timeout_ms`: `120_000`
- `stall_timeout_ms`: `300_000`
- `setting_sources`: `['project', 'local']`
- `plugin_dirs`: `[]`
- `skip_probe`: `false`

### §5.2 No changes to `GenerateOptions`'s required shape

`generate({ model: 'cli-sonnet', prompt })` works like `generate({ model: 'claude-sonnet', prompt })`. Provider-specific extensions ride on the existing generic `provider_options?: Record<string, unknown>` field (§5.3). The top-level `GenerateOptions` type stays provider-agnostic.

### §5.3 Provider-scoped options

```typescript
export type AgentDef = {
  readonly description: string;
  readonly prompt: string;
  readonly model?: string;
};

export type ClaudeCliCallOptions = {
  readonly allowed_tools?: ReadonlyArray<string>;
  readonly agents?: Record<string, AgentDef>;
  readonly session_id?: string;
  readonly append_system_prompt?: string;
  readonly output_json_schema?: string;
  readonly tool_bridge?: ToolBridgeMode;
  readonly extra_args?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
};
```

Caller usage:

```typescript
import type { ClaudeCliCallOptions, GenerateOptions } from '@robmclarty/engine';

const call_opts: ClaudeCliCallOptions = {
  allowed_tools: ['Read', 'Edit', 'Bash(git:*)'],
  tool_bridge: 'forbid',
};

const opts: GenerateOptions = {
  model: 'cli-sonnet',
  prompt: 'inspect the repo',
  provider_options: { claude_cli: call_opts },
};
```

**Semantics:**

- The engine's generic surface holds `provider_options: Record<string, unknown>`. Provider-scoped value types live under each provider's directory and are re-exported from the engine's type barrel. Namespace keys unknown to the resolved provider are **silently ignored**: writing `provider_options: { claude_cli: { ... }, openai: { ... } }` is safe regardless of which provider resolves.
- `allowed_tools` and `opts.tools` are orthogonal. `allowed_tools` restricts the CLI's built-in toolset; `opts.tools` is the engine-level `Tool[]` whose handling is governed by `tool_bridge` (§8).
- `append_system_prompt` stacks on top of `opts.system`. The CLI receives both. Duplication is the caller's problem; the engine does not deduplicate prose.
- `extra_args` is the unsafety hatch. Anyone who passes `['--dangerously-skip-permissions']` owns the consequences.
- `env` is merged into the subprocess env **after** the auth-mode scrub (§6.1). It cannot re-introduce `ANTHROPIC_API_KEY` when `auth_mode: 'oauth'`; `env.ANTHROPIC_API_KEY` is filtered out under that mode.

### §5.4 `GenerateResult` — unchanged surface, changed sourcing

`model_resolved.provider === 'claude_cli'` is the only typed marker. `cost` is populated from the CLI's `total_cost_usd` field (proportionally allocated across turns; see §10). `usage.cached_input_tokens` and `usage.cache_write_tokens` are populated from the CLI's `cache_read_input_tokens` and `cache_creation_input_tokens` fields (§7.3).

```typescript
export type ClaudeCliProviderReported = {
  readonly session_id: string;
  readonly duration_ms: number;
};
```

The adapter places this value under `provider_reported.claude_cli`. Callers narrow at the use site:

```typescript
import type { ClaudeCliProviderReported, GenerateResult } from '@robmclarty/engine';

const result: GenerateResult = await engine.generate({ model: 'cli-sonnet', prompt });
const reported = result.provider_reported?.['claude_cli'] as ClaudeCliProviderReported | undefined;
const session_id = reported?.session_id;
```

### §5.5 Engine factory signature

`create_engine(config: EngineConfig): Engine` remains synchronous. `Engine.dispose(): Promise<void>` is already in the public surface (`packages/engine/src/types.ts`). The `claude_cli` adapter contributes `dispose` that awaits every live subprocess; HTTPS adapters contribute nothing (their branch of the `ProviderAdapter` union does not expose `dispose`). The engine's aggregated dispose iterates adapters whose `kind === 'subprocess'` and calls their `dispose`.

Subprocess adapters' `dispose` is responsible for rejecting their own in-flight `generate` promises with `aborted_error({ reason: 'engine_disposed' })`. The engine-level `create_engine.ts` dispose aggregator awaits each adapter's dispose but does not reach into live promises directly; that coordination lives inside the adapter (see §6.3, §11 F29).

After `engine.dispose()`, further `engine.generate(...)` calls throw `engine_disposed_error` **synchronously** (matches the existing `create_engine` behavior).

---

## §6 — Subprocess Lifecycle

### §6.1 Spawn

Argv construction (in `argv.ts`):

```
args = [
  '-p',
  '--output-format', 'stream-json',
  '--model', resolved.model_id,
  '--verbose',
  '--setting-sources', setting_sources.join(','),
]

for each tool in allowed_tools:            args.push('--allowedTools', tool)
if call_opts.session_id:                    args.push('--resume', call_opts.session_id)
if call_opts.agents:                        args.push('--agents', JSON.stringify(call_opts.agents))
for each dir in plugin_dirs:                args.push('--plugin-dir', dir)
if compiled_schema:                         args.push('--json-schema', compiled_schema)
if opts.system or append_system_prompt:    args.push('--append-system-prompt', merged_system)
for each s in call_opts.extra_args:        args.push(s)

spawn_cmd = sandbox?.command ?? binary
spawn_args = sandbox ? [...sandbox.build_args(binary), ...args] : args
env = build_env(provider_config, call_opts.env, auth_mode)

auth_mode === 'oauth':   delete env.ANTHROPIC_API_KEY
auth_mode === 'api_key': require api_key present and set env.ANTHROPIC_API_KEY = api_key
auth_mode === 'auto':    if provider_config.api_key, set env.ANTHROPIC_API_KEY = api_key; else leave unset

spawn(spawn_cmd, spawn_args, {
  cwd: default_cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: true,
  env,
});
```

`detached: true` puts the child in its own process group, making SIGTERM / SIGKILL reach any subchildren (sandbox helpers, tool processes the CLI spawns).

`env` is constructed by `build_env` inside `auth.ts`: the function accepts explicit inputs (config `api_key`, `auth_mode`, caller `env`) and returns a fresh `Record<string, string>`. It does not read `process.env`. Subprocesses therefore run without PATH, HOME, etc., unless those are explicitly threaded through `ClaudeCliCallOptions.env`. If a harness needs the inherited environment for the CLI to find auxiliaries, the harness builds that map in application code and passes it through.

### §6.2 Input / output

- **stdin:** `opts.prompt` (rendered as a single user turn when `prompt` is a `Message[]`; see §6.5 for multi-turn).
- **stdout:** `stream-json` line-delimited JSON. Each line is one event. Parse per §7.
- **stderr:** captured in full; attached to any non-zero-exit error. Not streamed to trajectory by default.

### §6.3 Cleanup and cancellation

On `opts.abort?.aborted === true` at any point:

1. `process.kill(-proc.pid, 'SIGTERM')` — signal the whole process group.
2. Wait up to `SIGKILL_ESCALATION_MS` (default 2000ms) for the `close` event.
3. `process.kill(-proc.pid, 'SIGKILL')` if still alive.
4. Reject `generate` with `aborted_error` carrying `{ step_index, tool_call_in_flight? }`. Partial `text` events already delivered to `on_chunk` are **not** folded into a returned result; the promise rejects.

A per-adapter live-process registry (`Set<ChildProcess>`, captured inside the adapter factory) makes `engine.dispose()` coordinated. Two engines have two registries (constraints §2, no module-level mutable state).

### §6.4 Startup and stall detection

- **Startup timer.** Starts at `spawn`, clears on first stdout byte. Default 120s. Fires → SIGTERM → SIGKILL; reject with `claude_cli_error('startup_timeout', ...)`.
- **Stall timer.** Resets on every stdout chunk. Default 300s. Fires → SIGTERM → SIGKILL; reject with `claude_cli_error('stall_timeout', ...)`.
- Both are distinct from `generate`'s `abort`. Composition-layer `timeout(...)` still fires `abort`; the adapter's stall timers are an additional safety net for hung CLIs.

### §6.5 Session resumption

Multi-turn conversations in the CLI model are keyed by `session_id`. The engine does not reconstruct a full `Message[]` history; it delegates to `--resume`:

```typescript
import type { ClaudeCliProviderReported, GenerateOptions } from '@robmclarty/engine';

const turn1 = await engine.generate({ model: 'cli-sonnet', prompt: 'start a plan' });
const session_id =
  (turn1.provider_reported?.['claude_cli'] as ClaudeCliProviderReported | undefined)?.session_id;

const turn2_opts: GenerateOptions = {
  model: 'cli-sonnet',
  prompt: 'refine it',
  provider_options: session_id !== undefined ? { claude_cli: { session_id } } : {},
};
const turn2 = await engine.generate(turn2_opts);
```

If the caller passes a `prompt: Message[]` containing more than one `user` message, the adapter throws `provider_capability_error('claude_cli', 'multi_turn_history', 'use provider_options.claude_cli.session_id instead')`.

### §6.6 Process-exit safety net

A `process.on('exit')` handler synchronously issues `process.kill(-pid, 'SIGKILL')` for every live registry member. No `await`, no SIGTERM dance — Node's exit window is synchronous. This is a last-resort reap; the primary path is still per-call cleanup and `engine.dispose()`.

---

## §7 — Stream Parsing

### §7.1 CLI event shape

Each stdout line parses as one of:

```jsonc
{ "type": "system",     "subtype": "init", "session_id": "...", "model": "..." }
{ "type": "assistant",  "message": { "content": [{ "type": "text", "text": "..." }] } }
{ "type": "assistant",  "message": { "content": [{ "type": "tool_use", "id": "...", "name": "...", "input": { /* ... */ } }] } }
{ "type": "user",       "message": { "content": [{ "type": "tool_result", "tool_use_id": "...", "content": "..." }] } }
{ "type": "result",     "subtype": "success", "session_id": "...", "total_cost_usd": 0.012,
                        "duration_ms": 4123, "is_error": false,
                        "usage": { "input_tokens": 0, "output_tokens": 0,
                                   "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
                        "result": "..." }
```

Unknown `type` values are tolerated: record `{ kind: 'cli_unknown_event', raw }` to trajectory and continue. A future CLI event kind does not break parsing.

### §7.2 Mapping to `StreamChunk`

| CLI event | `StreamChunk` |
|-----------|---------------|
| `system / init` | none (trajectory record `cli_session_started { session_id, model }`) |
| `assistant` / content `text` | `{ kind: 'text', text, step_index }` |
| `assistant` / content `tool_use` | `{ kind: 'tool_call_start', id, name, step_index }` followed by `{ kind: 'tool_call_end', id, input, step_index }` (CLI emits full input atomically; no `tool_call_input_delta`) |
| `user` / content `tool_result` | `{ kind: 'tool_result', id, output, error?, step_index }` |
| new `assistant` after a `tool_result` | `{ kind: 'step_finish', step_index, finish_reason, usage }` for the completed step |
| `result` | `{ kind: 'finish', finish_reason, usage }` |

`step_index` increments each time a new `assistant` event is preceded by a `user / tool_result` event — i.e., a new turn in the CLI's own tool loop. The first `assistant` event is step `0`.

The adapter never emits `tool_call_input_delta`; consumers reading a `claude_cli`-sourced stream should not expect delta chunks for tool inputs.

### §7.3 Usage field mapping

| `UsageTotals` | CLI `usage` field |
|---------------|-------------------|
| `input_tokens` | `input_tokens` |
| `output_tokens` | `output_tokens` |
| `cached_input_tokens` | `cache_read_input_tokens` |
| `cache_write_tokens` | `cache_creation_input_tokens` |
| `reasoning_tokens` | absent (CLI does not separate) |

### §7.4 Buffering

stdout is line-buffered. Partial lines accumulate until `\n` arrives, then parse. A malformed JSON line records `{ kind: 'cli_parse_error', line }` to trajectory and is skipped; it does not reject `generate` unless the terminal `result` event never arrives (`claude_cli_error('no_result_event', ...)`).

### §7.5 Non-streaming calls

When `on_chunk` is absent, the adapter still consumes the stream — there is no alternate "blocking" CLI mode. It accumulates events silently and returns the full `GenerateResult` at the end. The engine's streaming-parity invariant holds.

---

## §8 — Tool Model

### §8.1 Engine tool loop is disabled for `claude_cli`

When the resolved adapter's `kind === 'subprocess'`, `generate.ts` already delegates to `adapter.generate` and bypasses the in-engine tool loop. Consequences:

1. `max_steps` is **ignored**. Trajectory records `{ kind: 'option_ignored', option: 'max_steps', provider: 'claude_cli' }` once per call (per project constraints §5.3). `finish_reason: 'max_steps'` cannot occur.
2. `tool_error_policy` is **ignored**. Same trajectory treatment.
3. `schema_repair_attempts` is **partially honored**: the CLI enforces the schema via `--json-schema`; if the terminal `result.result` still fails the zod parse, the adapter makes a fresh `--resume` call with a repair prompt (see §8.4).
4. `tool.needs_approval` and `generate_options.on_tool_approval` are **ignored**. Under `tool_bridge: 'allowlist_only'` the `needs_approval` field is dropped alongside the `execute` closure. Under `tool_bridge: 'forbid'`, any tool carrying `execute` still throws. Trajectory records `{ kind: 'option_ignored', option: 'on_tool_approval', provider: 'claude_cli' }` once when the handler is supplied.

### §8.2 `tools: Tool[]` — two supported modes

User-defined `Tool` objects with `execute` callbacks are not natively runnable by the CLI (it runs its own tool processes). Two behaviors, selected by `provider_options.claude_cli.tool_bridge`:

1. **`'allowlist_only'` (default).** Extract `tool.name` from each entry; merge with `provider_options.claude_cli.allowed_tools`; pass to `--allowedTools`. `execute` closures are ignored. Trajectory records `{ kind: 'cli_tool_bridge_allowlist_only', dropped: [name1, name2] }` once per call. Safe when named tools are CLI built-ins (`Read`, `Edit`, `Bash(...)`) with matching semantics.
2. **`'forbid'`.** Any `Tool` carrying `execute` throws `provider_capability_error(provider: 'claude_cli', capability: 'tool_execute')` at call time. Strictest mode; recommended when code mixes `claude_cli` and HTTPS providers via aliases and wants a loud failure on non-portable steps.

An `'mcp_bridge'` mode that launches user-defined tools as MCP servers is out of scope for v1 (§14).

### §8.3 CLI-native tool surface

`allowed_tools` accepts the CLI's allowlist grammar directly:

```
'Read'              // all Read invocations
'Edit'              // all Edit invocations
'Bash(git:*)'       // Bash only for git subcommands
'Write(/tmp/**)'    // Write only under /tmp
```

The adapter does not parse or validate this grammar; it forwards strings. The CLI owns the semantics.

### §8.4 Schema handling

`opts.schema: z.ZodType<t>` is supported. The adapter compiles the schema to a JSON Schema string via `z.toJSONSchema(opts.schema)` and passes it to the CLI as `--json-schema`. If the terminal `result.result` does not parse against the schema (rare, since the CLI enforces), the adapter issues one repair attempt (default `schema_repair_attempts: 1`): a fresh `generate` call with `--resume <session_id>` plus a repair prompt.

### §8.5 Agents and subagents

`provider_options.claude_cli.agents: Record<string, AgentDef>` carries the CLI's native subagent config. Passed verbatim as `--agents <json>`. Agents are not tools and do not mirror into `GenerateResult.tool_calls`; they are internal to the CLI's planning.

---

## §9 — Alias Table Additions

Added to `DEFAULT_ALIASES` in `packages/engine/src/aliases.ts`:

```typescript
// Claude via the claude CLI (OAuth subscription or api_key fallback)
'cli-opus':   { provider: 'claude_cli', model_id: 'claude-opus-4-7' },
'cli-sonnet': { provider: 'claude_cli', model_id: 'claude-sonnet-4-6' },
'cli-haiku':  { provider: 'claude_cli', model_id: 'claude-haiku-4-5' },
```

Added to the `KNOWN_PROVIDERS` set in the same file: `'claude_cli'`.

No overlap with existing aliases. `'claude-sonnet'` still routes to the HTTPS Anthropic adapter; `'cli-sonnet'` is the opt-in subscription path. Users who want the CLI to be the default `'sonnet'` override in `create_engine`:

```typescript
const engine = create_engine({
  providers: { claude_cli: { auth_mode: 'oauth' } },
  aliases: {
    sonnet: { provider: 'claude_cli', model_id: 'claude-sonnet-4-6' },
    'claude-sonnet': { provider: 'claude_cli', model_id: 'claude-sonnet-4-6' },
  },
});
```

---

## §10 — Cost Reporting

### §10.1 Source of truth

The CLI reports cost itself in the terminal `result` event:

```jsonc
{ "total_cost_usd": 0.0127, "usage": { "input_tokens": 1234, "output_tokens": 456 /* ... */ } }
```

The adapter uses this value directly. The engine pricing table (`DEFAULT_PRICING`, `register_price`) is **not consulted** for `claude_cli`. Rationale in project-wide `taste.md` principle 13 ("cost source is explicit").

### §10.2 `CostBreakdown` shape

`claude_cli` has no per-component prices. The adapter synthesizes a breakdown using token proportions against the effective per-million rate implied by `total_cost_usd`, weighted by `CACHE_READ_MULTIPLIER` (`0.1`) and `CACHE_WRITE_MULTIPLIER` (`1.25`) declared in `constants.ts`; source: Anthropic prompt-caching pricing page as of 2026-04. Resulting `input_usd`, `output_usd`, `cached_input_usd`, `cache_write_usd` sum to `total_usd` within floating-point tolerance.

Trajectory cost events carry the project-wide `source` discriminant (§5.3 of project constraints):

```typescript
{ kind: 'cost', step_index, source: 'provider_reported', total_usd, input_usd, output_usd /* ... */ }
```

Harnesses filtering on `source === 'provider_reported'` vs `source === 'engine_derived'` can distinguish CLI-sourced costs from pricing-table-derived costs.

### §10.3 `is_estimate`

`cost.is_estimate` remains `true` for `claude_cli`. The CLI reports list-price estimates from Anthropic's internal tokenizer; subscription quota consumption is separate and not surfaced. Promoting to `false` would overstate what the number represents.

### §10.4 Per-turn allocation

When the CLI emits multiple assistant turns, the adapter allocates `total_cost_usd` across turns in proportion to each turn's output tokens. Approximate; the CLI does not emit per-turn cost.

### §10.5 No `pricing_missing` event

`claude_cli` never emits `pricing_missing` regardless of engine pricing-table state. It is not in `FREE_PROVIDERS`, but cost always arrives from the CLI itself.

---

## §11 — Failure Modes

New and modified failure modes specific to this provider. Parent `generate` rules (aborted, rate_limit, provider_error) apply where transport-agnostic.

### F18: `claude` binary not found

**Scenario:** `binary` path (default `'claude'`) does not resolve on the PATH as provided via `call_opts.env.PATH`, or no PATH was threaded.
**Behavior:** first `generate` call throws `claude_cli_error('binary_not_found', ...)`. Construction succeeds without probing (probe is lazy; §4).
**Test:** set `binary: '/nonexistent/claude'`; construct (succeeds); call → assert `claude_cli_error` with `reason: 'binary_not_found'`.

### F19: Binary found but auth missing / expired

**Scenario:** `auth_mode: 'oauth'` and no valid OAuth token; or CLI exits with auth-related stderr under any mode.
**Behavior:** CLI exits non-zero with stderr containing one of `CLI_AUTH_ERROR_PATTERNS`. Adapter throws `provider_auth_error(provider: 'claude_cli', refresh_command: 'claude login')`.
**Test:** mock stderr containing each pattern; assert error shape.

### F20: `auth_mode: 'api_key'` with no `api_key`

**Scenario:** caller forces API-key mode but `ClaudeCliProviderConfig.api_key` is missing / empty.
**Behavior:** `create_engine` throws `engine_config_error('api_key is required for auth_mode: api_key', 'claude_cli')` at construction.
**Test:** `auth_mode: 'api_key'` without `api_key`; construct → assert `engine_config_error`.

### F21: Subprocess startup timeout

**Scenario:** `claude` spawns but never writes stdout within `startup_timeout_ms`.
**Behavior:** SIGTERM → SIGKILL; reject with `claude_cli_error('startup_timeout', ...)`. Not retried.
**Test:** mock stdout to delay 200ms; `startup_timeout_ms: 100`; assert rejection and SIGTERM observed.

### F22: Subprocess stall

**Scenario:** `claude` writes stdout, then goes silent for `stall_timeout_ms`.
**Behavior:** same as F21 but `reason: 'stall_timeout'`.
**Test:** mock stdout to write once then go silent; assert rejection after configured stall.

### F23: Subprocess exits non-zero

**Scenario:** CLI exits with code `!== 0` for a non-auth reason.
**Behavior:** reject with `claude_cli_error('subprocess_exit', status, stderr_snippet)`. Retried under `retry_policy` for transient causes (not SIGTERM from the engine, not auth).
**Test:** mock exit 1 with benign stderr; assert retry then eventual `claude_cli_error`.

### F24: Malformed `stream-json` line

**Scenario:** CLI emits a line that does not parse as JSON.
**Behavior:** record `{ kind: 'cli_parse_error', line }` to trajectory; skip the line; continue. If terminal `result` event never arrives before close, reject with `claude_cli_error('no_result_event', ...)`.
**Test:** inject garbage line in mock stream; assert trajectory record and completion.

### F25: `tools` with `execute` under `'allowlist_only'` mode

**Scenario:** caller passes `Tool[]` with real `execute` callbacks, default bridge mode.
**Behavior:** `execute` closures dropped; names forwarded via `--allowedTools`. Single trajectory record per call: `{ kind: 'cli_tool_bridge_allowlist_only', dropped: ['name1', 'name2'] }`.
**Test:** pass two tools; assert closures never invoked; assert allowlist received names; assert trajectory record.

### F26: `tools` with `execute` under `'forbid'` mode

**Scenario:** same caller, `tool_bridge: 'forbid'`.
**Behavior:** throw `provider_capability_error('claude_cli', 'tool_execute', detail)` before spawn.
**Test:** pass tool with `execute`; assert error.

### F27: Multi-turn `Message[]` without session_id

**Scenario:** caller passes `prompt: Message[]` with two or more `user` messages.
**Behavior:** throw `provider_capability_error('claude_cli', 'multi_turn_history', 'use provider_options.claude_cli.session_id instead')`.
**Test:** pass three-user-message history; assert error with pointer.

### F28: Abort during subprocess run

**Scenario:** `abort` fires mid-stream.
**Behavior:** SIGTERM → 2s → SIGKILL; reject with `aborted_error({ step_index, tool_call_in_flight? })`. No partial result.
**Test:** fire abort at 50ms into a mock stream; assert SIGTERM observed, SIGKILL not needed; assert rejection.

### F29: Engine `dispose` during in-flight calls

**Scenario:** `await engine.dispose()` while a `generate` call is running.
**Behavior:** all live subprocesses receive SIGTERM → SIGKILL; all in-flight `generate` calls reject with `aborted_error({ reason: 'engine_disposed' })`. `dispose()` resolves when the last child has exited. Subsequent `engine.generate(...)` throws `engine_disposed_error` synchronously.
**Test:** fire `dispose` mid-run; assert `generate` rejects and `dispose` resolves; post-dispose `generate` throws synchronously.

### F30: Sandbox binary missing

**Scenario:** `sandbox: { kind: 'bwrap' }` configured but the `bwrap` binary is missing.
**Behavior:** first call reports `claude_cli_error('sandbox_unavailable', ..., { stderr_snippet })`. Probe is lazy to preserve synchronous construction.
**Test:** configure bwrap with an unresolvable path; first call → error.

---

## §12 — Success Criteria

### Automated tests (mock the `claude` binary via a fixture shell script or a `node:child_process.spawn` harness)

1. **Plain string completion.** `generate({ model: 'cli-sonnet', prompt: 'hi' })` with mocked single-`result`-event output; assert `content`, `finish_reason: 'stop'`, `model_resolved.provider === 'claude_cli'`.
2. **Multi-turn via session_id.** Two sequential calls; second with `session_id` from the first; assert `--resume` appeared in argv of the second spawn.
3. **Multi-user `Message[]` rejected.** Pass two-user history; assert `provider_capability_error`.
4. **Streaming chunks.** Supply `on_chunk`; mock four text deltas + `result`; assert five-plus chunk events in expected order; assert concatenated text matches.
5. **Streaming parity.** Same fixture with and without `on_chunk`; assert identical `GenerateResult`.
6. **Schema pass-through.** Zod schema supplied; assert `--json-schema` in argv with the compiled JSON; mock valid JSON result; assert parsed `content` typed.
7. **Schema repair via resume.** Mock invalid JSON then valid on repair; assert second spawn used `--resume` with the first session id.
8. **Allowlist-only tool bridge.** Pass two `Tool` objects with `execute`; default mode; assert `--allowedTools` argv includes both names; assert `execute` never invoked; assert single trajectory `cli_tool_bridge_allowlist_only` record.
9. **Forbid tool bridge.** Pass `Tool` with `execute`, `tool_bridge: 'forbid'`; assert `provider_capability_error` pre-spawn.
10. **Agents forwarded.** Pass `agents` map; assert `--agents` argv contains serialized map.
11. **Plugin dirs forwarded.** Pass two plugin dirs; assert two `--plugin-dir` flags.
12. **Sandbox wiring (bwrap).** Configure bwrap; assert spawn cmd is `bwrap`, `claude` appears in argv after sandbox args.
13. **Abort mid-stream.** SIGTERM observed, SIGKILL not needed within 2s, `aborted_error` thrown.
14. **Abort escalation.** Mock child that ignores SIGTERM; assert SIGKILL fires after `SIGKILL_ESCALATION_MS`.
15. **Startup timeout.** Child writes nothing; assert `claude_cli_error('startup_timeout', ...)` after configured ms.
16. **Stall timeout.** Child writes one chunk then goes silent; assert `claude_cli_error('stall_timeout', ...)`.
17. **Exit non-zero with auth stderr.** Assert `provider_auth_error` with refresh hint.
18. **Exit non-zero with transient stderr.** Assert retry per `retry_policy`.
19. **Binary missing on first call.** Assert `claude_cli_error('binary_not_found', ...)`.
20. **`auth_mode: 'oauth'` strips `ANTHROPIC_API_KEY`.** Configure `api_key` + `auth_mode: 'oauth'`; spawn env observed via fixture echo; assert var absent.
21. **`auth_mode: 'api_key'` requires `api_key`.** Construct without `api_key`; assert `engine_config_error`.
22. **Cost from CLI.** Mock `total_cost_usd: 0.0127`; assert `cost.total_usd === 0.0127`, `cost.is_estimate: true`, trajectory `cost` event carries `source: 'provider_reported'`.
23. **Cost decomposition sums.** Assert `input_usd + output_usd + cached_input_usd + cache_write_usd ≈ total_usd` within `1e-9`.
24. **Per-turn cost allocation.** Three-turn mock; assert `sum(steps[i].cost.total_usd) === total_usd`.
25. **No `pricing_missing` for claude_cli.** Custom alias with no pricing; assert no `pricing_missing` event.
26. **`provider_reported.claude_cli.session_id` surfaced.** Assert field present on result.
27. **`engine.dispose()` kills live children.** Spawn, in-flight; call dispose; assert SIGTERM/SIGKILL observed and `generate` rejected with `aborted_error { reason: 'engine_disposed' }`.
28. **Independent engines don't cross-kill.** Two engines, one dispose; other's in-flight call unaffected.
29. **Post-dispose `generate` throws synchronously.** Call `engine.generate(...)` after `dispose`; assert synchronous throw of `engine_disposed_error`.
30. **`extra_args` passthrough.** Pass `extra_args: ['--foo', 'bar']`; assert argv contains both.
31. **`max_steps` / `tool_error_policy` / `on_tool_approval` trigger `option_ignored`.** Supply each; assert one trajectory `option_ignored` event per option per call.

### Architectural validation (mechanically checked)

- `packages/engine/src/providers/claude_cli/**` is the only place `node:child_process` is imported (enforced by `rules/no-child-process-outside-claude-cli.yml`).
- No `ai` / `@ai-sdk/*` / `ai-sdk-ollama` / `@openrouter/ai-sdk-provider` imports inside `packages/engine/src/providers/claude_cli/**` (enforced by `rules/no-provider-sdk-in-claude-cli.yml`).
- `Engine.dispose()` exists on every engine. HTTPS-only engines resolve their dispose promise immediately with no subprocess work.

### End-to-end (gated)

Tests that shell out to a real `claude` binary are gated behind `RUN_E2E=1` and skipped otherwise.

### Learning outcomes (post-ship)

- How often does `auth_mode: 'oauth'` prevent accidental API billing in practice?
- Are CLI `allowed_tools` strings stable enough across CLI versions to commit as a public option shape?
- Does the `'allowlist_only'` default surprise callers (silent drop of `execute`)? Should the default flip to `'forbid'`?
- Is the cost decomposition accurate enough for harnesses to trust, or does everyone read only `total_usd`?
- Do users thread `session_id` manually, or is a user-land wrapper (`conversation(...)`) inevitable at the composition layer?
- Does the `stall_timeout_ms` default fire on legitimate long-running reasoning tasks?

---

## §13 — File Structure

```
packages/engine/
├── src/
│   ├── types.ts                    # + ClaudeCliProviderConfig wired into ProviderConfigMap
│   │                               # + re-exports from ./providers/claude_cli/types
│   ├── errors.ts                   # already contains claude_cli_error, provider_auth_error, engine_disposed_error
│   ├── aliases.ts                  # + cli-opus/cli-sonnet/cli-haiku; + 'claude_cli' in KNOWN_PROVIDERS
│   ├── create_engine.ts            # already aggregates dispose across subprocess adapters
│   ├── generate.ts                 # already dispatches on adapter.kind === 'subprocess'
│   └── providers/
│       ├── types.ts                # already defines SubprocessProviderAdapter
│       ├── registry.ts             # + create_claude_cli_adapter
│       └── claude_cli/             # NEW
│           ├── index.ts            # adapter factory, returns SubprocessProviderAdapter
│           ├── spawn.ts            # spawn wiring, live registry, SIGTERM/SIGKILL escalation
│           ├── argv.ts             # build CLI argv from merged options
│           ├── stream_parse.ts     # JSON-lines parser, CLI event → StreamChunk
│           ├── stream_result.ts    # terminal result event → GenerateResult
│           ├── auth.ts             # auth_mode enforcement, build_env, stderr pattern match
│           ├── sandbox.ts          # bwrap / greywall wrappers
│           ├── cost.ts             # CLI cost → CostBreakdown decomposition
│           ├── constants.ts        # DEFAULT_STARTUP_TIMEOUT_MS, SIGKILL_ESCALATION_MS,
│           │                       # CLI_AUTH_ERROR_PATTERNS, CLI_BINARY_DEFAULT,
│           │                       # CACHE_READ_MULTIPLIER (0.1), CACHE_WRITE_MULTIPLIER (1.25),
│           │                       # etc.
│           └── types.ts            # ClaudeCliProviderConfig, ClaudeCliCallOptions,
│                                   # AgentDef, SandboxProviderConfig, AuthMode, ToolBridgeMode
└── test/
    └── providers/
        └── claude_cli/
            ├── spawn.test.ts
            ├── stream_parse.test.ts
            ├── argv.test.ts
            ├── auth.test.ts
            ├── cancellation.test.ts
            ├── cost.test.ts
            └── integration.test.ts
```

Public surface additions via `packages/engine/src/index.ts`: the types from `claude_cli/types.ts` (`ClaudeCliProviderConfig`, `ClaudeCliCallOptions`, `AgentDef`, `SandboxProviderConfig`, `AuthMode`, `ToolBridgeMode`, `ClaudeCliProviderReported`).

---

## §14 — Open Questions

1. **MCP bridge for user-defined tools.** `'mcp_bridge'` mode launches `execute` callbacks as ephemeral MCP servers and points the CLI at them. Requires MCP server machinery not yet in-package. Defer.
2. **Streaming reasoning tokens.** The CLI does not currently emit reasoning as a distinct event type, so `effort` is silently dropped. Map to `StreamChunk { kind: 'reasoning' }` when a future CLI version adds them. No API change, just parser extension.
3. **Session garbage collection.** Long-running harnesses accumulating `session_id`s never signal release. Defer until a caller asks.
4. **Multiple concurrent calls per engine.** Spawning N subprocesses in parallel works but scales memory. No rate-limit in v1; rely on composition-layer `parallel({ max_concurrency })`.
5. **`claude` on Windows.** Node.js 24 is the target; CLI support varies. If the binary runs, the adapter runs; no explicit Windows paths.
6. **Subagent per-cost visibility.** Subagent tokens roll into top-level `total_cost_usd`. No per-subagent breakdown. Defer.
7. **`--dangerously-skip-permissions` policy.** Available via `extra_args`; no named bucket in v1.
8. **Binary version pinning.** No check beyond "ran". Future minimum-version gate deferred until a CLI bump breaks argv.
9. **Parallel `--model` routing.** One CLI invocation per model. Fine in v1.
10. **Trajectory for CLI-internal tool events.** CLI tool calls become `ToolCallRecord`s on the result. Some harnesses may want planning text (assistant text between tool calls) routed to a distinct chunk kind; today it goes to `text`. Revisit if a downstream consumer needs the distinction.
11. **Cost component accuracy.** §10.2's decomposition is approximate. If harnesses complain, either restore the pricing table and use CLI `total_cost_usd` only when the model is unknown, or omit components entirely when `source === 'provider_reported'`. Defer pending feedback.
12. **`provider_reported` for other providers.** The namespace is `claude_cli`-only in v1. Anthropic HTTPS could populate `provider_reported.anthropic.request_id` without widening the public surface. Additive; defer.

---

## Bootstrap / required reading for the builder

Read these in order before writing code. Items 1–3 are the contract; 4–5 are source orientation; 6 is prior art.

1. `../../constraints.md` (project-wide; authoritative — subprocess rules in §3, §4, §5.10, §5.11, §7, §9)
2. `../../taste.md` (project-wide — principles 9–14 cover the subprocess-transport design decisions)
3. `./spec.md` (this file; provider-specific behavior)
4. Engine source orientation:
   - `../../../packages/engine/src/types.ts`
   - `../../../packages/engine/src/errors.ts`
   - `../../../packages/engine/src/aliases.ts`
   - `../../../packages/engine/src/create_engine.ts`
   - `../../../packages/engine/src/generate.ts`
   - `../../../packages/engine/src/providers/types.ts`
   - `../../../packages/engine/src/providers/registry.ts`
   - `../../../packages/engine/src/providers/anthropic.ts`
5. How apps supply credentials:
   - `../../../packages/config/src/index.ts`
6. Prior art for pattern reference only (not prescriptive — do not copy code verbatim):
   - `../../../../../../ridgeline/code/ridgeline/src/engine/claude/claude.exec.ts`
   - `../../../../../../ridgeline/code/ridgeline/src/engine/claude/stream.parse.ts`
   - `../../../../../../ridgeline/code/ridgeline/src/engine/claude/stream.types.ts`
   - `../../../../../../ridgeline/code/ridgeline/src/engine/claude/stream.result.ts`
   - `../../../../../../ridgeline/code/ridgeline/src/engine/claude/sandbox.ts`
   - `../../../../../../ridgeline/code/ridgeline/src/engine/claude/sandbox.bwrap.ts`
   - `../../../../../../ridgeline/code/ridgeline/src/engine/claude/sandbox.greywall.ts`

### Build order

1. Types. Add `packages/engine/src/providers/claude_cli/types.ts`; extend `packages/engine/src/types.ts` so `ProviderConfigMap.claude_cli?: ClaudeCliProviderConfig` is permitted; re-export the new public types from the engine's index barrel.
2. Constants. Add `packages/engine/src/providers/claude_cli/constants.ts`.
3. Aliases. Add `cli-opus`, `cli-sonnet`, `cli-haiku` to `DEFAULT_ALIASES`; add `'claude_cli'` to the `KNOWN_PROVIDERS` set.
4. Adapter internals under `packages/engine/src/providers/claude_cli/`:
   - `spawn.ts`: live registry (per-adapter `Set<ChildProcess>`), spawn wiring, SIGTERM/SIGKILL escalation, process-exit handler.
   - `argv.ts`: merge provider config + call options into argv.
   - `stream_parse.ts`: JSON-lines parser, CLI event → `StreamChunk`.
   - `stream_result.ts`: terminal `result` event → `GenerateResult` using the engine's `UsageTotals` mapping.
   - `auth.ts`: `auth_mode` enforcement, `build_env`, `CLI_AUTH_ERROR_PATTERNS` match.
   - `sandbox.ts`: bwrap / greywall wrappers (port patterns, not code, from ridgeline).
   - `cost.ts`: CLI cost → `CostBreakdown` decomposition.
   - `index.ts`: factory returning `SubprocessProviderAdapter { kind: 'subprocess', name: 'claude_cli', generate, dispose, supports }`.
5. Registry. Add the factory to `packages/engine/src/providers/registry.ts`.
6. `generate.ts` already dispatches on `adapter.kind === 'subprocess'`; verify no changes needed beyond imports.
7. Tests per §12; fixtures as a mock `claude` shell script plus a `spawn`-wrapping harness for finer control.

### Invariants to enforce during implementation

- No `class`, no `this`, no `extends` anywhere in the adapter source (typed errors go to `packages/engine/src/errors.ts`).
- `node:child_process` imports only under `packages/engine/src/providers/claude_cli/**` (mechanically checked).
- `ai`, `@ai-sdk/*`, `ai-sdk-ollama`, `@openrouter/ai-sdk-provider` never imported under `packages/engine/src/providers/claude_cli/**` (mechanically checked).
- No `process.env` reads anywhere in the adapter (or the rest of `packages/engine/src/`); credentials flow through `ClaudeCliProviderConfig`.
- Every subprocess is inserted into the per-adapter live set at spawn and removed on `close`.
- `abort.aborted` is checked at argv build, at spawn, and before every parse iteration.
- snake_case for values; PascalCase for type aliases and interfaces.
- Schema compilation from zod uses Zod 4's `z.toJSONSchema()`; no separate `zod-to-json-schema` dependency.
- `SubprocessProviderAdapter.dispose` signals every live child, waits for every `close`, and resolves.

When in doubt, the spec wins over intuition. Implement the simpler interpretation; mark any divergence with a `TODO` citing the relevant section.

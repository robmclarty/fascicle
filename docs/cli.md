# The `claude_cli` Provider

A subprocess provider that spawns the `claude` binary and parses its streaming JSON output. It lets you run Fascicle against a `claude` session you're already authenticated into (no API key required), or against an Anthropic API key while you still get the CLI's agentic features (sub-agents, `--allowedTools`, `--setting-sources`, plugin directories).

## Why It Exists

Three good reasons, and they're all about what you already have:

1. **Piggyback on your CLI login.** Run `claude login` once, and every Fascicle harness you write uses that session.
2. **Use CLI-only features.** Sub-agents via `--agents`, per-invocation tool allowlisting, setting source control, plugin dirs, schema-constrained output via `--json-schema`.
3. **Sandboxable.** `bwrap` and `greywall` wrappers let you confine the subprocess to an allowlist.

It does **not** replace the `anthropic` AI SDK adapter. Use `anthropic` for direct API traffic, and reach for `claude_cli` when the CLI's features or your existing CLI login is the reason.

## Prerequisites

- `claude` on PATH. Install from [claude.com/claude-code](https://claude.com/claude-code).
- A session (`claude login`) or an `ANTHROPIC_API_KEY`.

## Minimal Setup

```ts
import { create_engine, model_step, run } from 'fascicle';

const engine = create_engine({
  providers: { claude_cli: { auth_mode: 'oauth' } },
  defaults: {
    provider: 'claude_cli',
    model: 'sonnet',          // the CLI resolves 'sonnet' to the latest itself
    system: 'Reply in one short sentence.',
  },
});

const ask = model_step({ engine });

try {
  const out = await run(ask, 'say hi');
  console.log(out);
} finally {
  await engine.dispose();
}
```

See [`examples/hello-claude-cli/main.ts`](../examples/hello-claude-cli/main.ts) and [`examples/hello-claude-cli-lisp/main.ts`](../examples/hello-claude-cli-lisp/main.ts) for full harnesses.

## Provider Config

```ts
type ClaudeCliProviderConfig = {
  binary?: string;                  // default 'claude' (resolved on PATH)
  auth_mode?: 'auto' | 'oauth' | 'api_key';  // default 'auto'
  api_key?: string;                 // required when auth_mode === 'api_key'
  inherit_env?: boolean;            // default true; oauth seeds full process.env, other modes seed the 7 standard keys
  default_cwd?: string;             // subprocess cwd
  startup_timeout_ms?: number;      // default 120_000
  stall_timeout_ms?: number;        // default 300_000
  setting_sources?: ReadonlyArray<'user' | 'project' | 'local'>;   // default ['project', 'local']
  plugin_dirs?: ReadonlyArray<string>;
  sandbox?: SandboxProviderConfig;
  skip_probe?: boolean;
};
```

### Auth Modes

| Mode       | Behaviour                                                                          |
| ---------- | ---------------------------------------------------------------------------------- |
| `auto`     | If `api_key` is set, use it; else fall back to the CLI's stored session.           |
| `oauth`    | Use the CLI's stored session. `ANTHROPIC_API_KEY` is scrubbed from the subprocess env.  |
| `api_key`  | Use the provided `api_key`. Throws `engine_config_error` synchronously if missing. |

### Env Inheritance

Under `oauth`, the subprocess env seeds from the full `process.env` so the `claude` binary can reach `HOME`, `PATH`, and other things it needs to find its session files. Under `api_key` and `auto`, it seeds only the 7 standard keys (`PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `LANG`, `TMPDIR`) from `process.env`, plus caller-supplied keys. Set `inherit_env: false` under any mode to start from an empty env.

If you need a minimal-but-functional env under `api_key`, use the helper:

```ts
import { forward_standard_env, create_engine } from 'fascicle';

const engine = create_engine({
  providers: {
    claude_cli: { auth_mode: 'api_key', api_key: process.env.ANTHROPIC_API_KEY! },
  },
});

await engine.generate({
  prompt: 'hi',
  provider_options: {
    claude_cli: { env: forward_standard_env() },  // PATH, HOME, SHELL, USER, LOGNAME, LANG, TMPDIR
  },
});
```

### Auth Failures

If stderr matches any of the frozen `CLI_AUTH_ERROR_PATTERNS` (`authentication`, `unauthorized`, `forbidden`, `oauth token has expired`, `invalid_api_key`), the adapter throws `provider_auth_error` with `refresh_command: 'claude login'` so your harness can tell the operator what to do.

## Per-Call Options

```ts
type ClaudeCliCallOptions = {
  allowed_tools?: ReadonlyArray<string>;      // passed as --allowedTools (one per value)
  agents?: Record<string, AgentDef>;          // passed as --agents <json>
  session_id?: string;                        // passed as --resume <id>
  append_system_prompt?: string;              // merged with opts.system
  output_json_schema?: string;                // passed as --json-schema <string>; opts.schema wins
  tool_bridge?: 'allowlist_only' | 'forbid';  // default 'allowlist_only'
  extra_args?: ReadonlyArray<string>;         // appended verbatim to CLI argv
  env?: Record<string, string>;               // overlaid on top of the base env
};
```

Supplied via `provider_options.claude_cli`:

```ts
await engine.generate({
  prompt: 'refactor foo',
  provider_options: {
    claude_cli: {
      allowed_tools: ['Read', 'Grep'],
      agents: {
        reviewer: {
          description: 'Second-opinion reviewer',
          prompt: 'You are a terse reviewer. Flag only high-confidence issues.',
          model: 'haiku',
        },
      },
      session_id: 'claude-session-abc',
      append_system_prompt: 'Prefer explicit types.',
    },
  },
});
```

## What Gets Forwarded

Fascicle invokes `claude` with at minimum:

```text
claude -p \
  --output-format stream-json \
  --model <resolved-model-id> \
  --verbose \
  --setting-sources project,local
```

Plus, conditionally:

- `--allowedTools <name>` — repeated, one per allowlisted tool (union of `provider_options.claude_cli.allowed_tools` and `opts.tools[].name`).
- `--resume <session_id>` — when `provider_options.claude_cli.session_id` is set.
- `--agents <json>` — when `provider_options.claude_cli.agents` is set.
- `--plugin-dir <path>` — repeated, one per `provider_config.plugin_dirs` entry.
- `--json-schema <json>` — when either `opts.schema` is a zod schema (compiled to JSON Schema) or `provider_options.claude_cli.output_json_schema` is a string; the zod schema wins.
- `--append-system-prompt <text>` — the merged system prompt (`opts.system` + `append_system_prompt`, joined by `\n\n`).
- Any `extra_args` appended verbatim to the tail.
- `CLAUDE_CODE_EFFORT_LEVEL=<level>` — set in the subprocess env when `opts.effort` is anything but `'none'`; the level (`low` … `max`) is forwarded verbatim.

The prompt goes to stdin, either as the first user message's text or as the whole string when `opts.prompt` is a string.

## Multi-Turn Is via `session_id`

The CLI is a one-shot invocation. Multi-turn chat is represented by `session_id`, not by a `Message[]` history. Calling `generate({ prompt: [...] })` with two or more user messages throws `provider_capability_error('multi_turn_history', 'use provider_options.claude_cli.session_id instead')`.

The idiomatic pattern is to capture `result.provider_reported.claude_cli.session_id` on the first call, then pass it as `session_id` on follow-ups. `provider_reported` is keyed by provider name (see [Provider-reported detail](./providers.md#provider-reported-detail)), and this adapter reports `session_id` and `duration_ms` under `claude_cli`.

## Tool Bridging

Fascicle tools (`Tool<i, o>` with a zod `input_schema` and an `execute` closure) can't run under the CLI subprocess — there's no RPC for invoking your in-process executor from inside the child's tool loop. Two modes handle that for you:

| `tool_bridge`       | Behaviour                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `allowlist_only`    | Default. Adds each tool's `name` to `--allowedTools` so the CLI may use its own built-in tools of that name. Tools with an `execute` closure are silently dropped; a `cli_tool_bridge_allowlist_only` trajectory event lists them. |
| `forbid`            | Reject at call time — if any tool has an `execute` closure, throws `provider_capability_error('tool_execute')`. |

Use `allowlist_only` when you want the CLI to use its built-in tools and you declared them in `tools` for documentation. Use `forbid` when you want a hard guarantee that no `execute` closure of yours silently becomes a no-op.

## Schema-Constrained Output

Pass any Standard Schema (zod, ArkType, Valibot, ...) as `schema` to `generate({ schema })` and the adapter compiles it to JSON Schema, forwards `--json-schema`, and parses the final CLI text against the schema.

If the CLI returns text that fails schema validation, the adapter makes one repair attempt. It resumes the same session, using the `session_id` that it captured from the first response, and sends a repair prompt. The second failure throws `schema_validation_error` with the schema issues and raw text.

## Streaming

Under `run.stream` (or any call with `on_chunk`), the adapter parses the CLI's `stream-json` output line by line and forwards `StreamChunk` events. From where you sit, nothing distinguishes it from an SDK provider.

## Timeouts

Two deadlines, both reset on forward progress:

- `startup_timeout_ms` (default 120s) — time from spawn to the first parseable chunk.
- `stall_timeout_ms` (default 300s) — time between chunks.

Whichever one fires kills the subprocess and throws `claude_cli_error` with `reason: 'startup_timeout' | 'stall_timeout'`.

## Sandboxing

Opt in with `sandbox: { kind: 'bwrap' | 'greywall', network_allowlist?, additional_write_paths? }`.

```ts
const engine = create_engine({
  providers: {
    claude_cli: {
      auth_mode: 'oauth',
      sandbox: {
        kind: 'bwrap',
        network_allowlist: ['api.anthropic.com'],
        additional_write_paths: ['/tmp/claude-workdir'],
      },
    },
  },
});
```

The `bwrap` wrapper read-only binds `/usr`, `/bin`, `/lib`, `/lib64`, `/etc/resolv.conf`, mounts `/proc`, `/dev`, and a tmpfs at `/tmp`, unshares user/pid/ipc/uts/cgroup namespaces, and dies with the parent. `greywall` uses host allowlisting and `--rw` paths. Either way, `network_allowlist` drops you to only those hosts, and an empty array means the network is off.

A missing sandbox binary triggers `claude_cli_error` with `reason: 'sandbox_unavailable'`.

## Errors You May Hit

| Error                    | Cause                                                                       |
| ------------------------ | --------------------------------------------------------------------------- |
| `engine_config_error`    | `api_key` missing under `auth_mode: 'api_key'`.                             |
| `provider_auth_error`    | Stderr matched an auth-failure pattern, so surface `refresh_command` to whoever is running this. |
| `claude_cli_error`       | Subprocess failure. Check `.reason` for `binary_not_found`, `startup_timeout`, `stall_timeout`, `no_result_event`, `result_error`, `subprocess_exit`, `sandbox_unavailable`, `parse_error`, `auth_missing`, `auth_expired`, `api_key_missing`, `engine_disposed`. |
| `provider_capability_error` | Multi-turn `prompt: Message[]` with two or more user messages, or `tool_bridge: 'forbid'` with a tool that has an `execute` closure. |
| `schema_validation_error` | Zod parse failed after one repair attempt.                                 |

## Dispose Behaviour

`engine.dispose()` aborts every in-flight subprocess with SIGTERM (escalating to SIGKILL after 2s) and rejects any outstanding `generate` promises with `engine_disposed_error`. Call it in a `finally`, or on process exit.

## Debugging

- Set `trajectory` and watch for `cli_tool_bridge_allowlist_only` events — those list every tool that got dropped.
- Read the `stderr_snippet` field on any `claude_cli_error`, because the adapter captures the first 512 bytes of stderr for you.
- Turn on `skip_probe: true` to bypass the binary existence check if you have a custom PATH situation.
- `--verbose` is always on in the CLI invocation; combine with a filesystem trajectory logger to see the full back-and-forth.

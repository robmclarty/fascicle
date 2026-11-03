# The `claude_cli` Provider

A subprocess provider that spawns the `claude` binary and parses its streaming JSON output. It lets you run Fascicle against a `claude` session you're already authenticated into (no API key required), or against an Anthropic API key while you still get the CLI's agentic features (sub-agents, `--allowedTools`, `--setting-sources`, plugin directories).

## Why It Exists

Three good reasons, and they're all about what you already have:

1. **Piggyback on your CLI login.** Run `claude auth login` once, and every Fascicle harness you write uses that session.
2. **Use CLI-only features.** Sub-agents via `--agents`, per-invocation tool allowlisting, setting source control, plugin dirs, schema-constrained output via `--json-schema`.
3. **Sandboxable.** Claude Code's own sandbox lets you hold the commands that the CLI runs to a list of domains and the working directory, and its file tools to the working directory too.

It does **not** replace the `anthropic` AI SDK adapter. Use `anthropic` for direct API traffic, and reach for `claude_cli` when the CLI's features or your existing CLI login is the reason.

## Prerequisites

- `claude` on PATH. Install from [claude.com/claude-code](https://claude.com/claude-code).
- A session (`claude auth login`) or an `ANTHROPIC_API_KEY`.

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
  omit_env?: ReadonlyArray<string>; // names the subprocess never sees, inherited or caller-set
  default_cwd?: string;             // subprocess cwd
  startup_timeout_ms?: number;      // default 120_000
  stall_timeout_ms?: number;        // default 300_000
  setting_sources?: ReadonlyArray<'user' | 'project' | 'local'>;   // default ['project', 'local']
  plugin_dirs?: ReadonlyArray<string>;
  sandbox?: SandboxProviderConfig;  // see Sandboxing below
};
```

### Auth Modes

| Mode       | Behaviour                                                                          |
| ---------- | ---------------------------------------------------------------------------------- |
| `auto`     | If `api_key` is set, use it; else fall back to the CLI's stored session.           |
| `oauth`    | Use the CLI's stored session. `ANTHROPIC_API_KEY` and `CLAUDE_CODE_SIMPLE` are scrubbed from the subprocess env.  |
| `api_key`  | Use the provided `api_key`. Throws `engine_config_error` synchronously if missing. |

`CLAUDE_CODE_SIMPLE=1` runs the CLI in bare mode, the same as `--bare`, and bare mode never reads the stored session, so an `oauth` call drops that variable along with the key. Claude Code plans to make bare mode the default for `-p` in a future release. Once it does, an `oauth` call, or an `auto` call without a key, can't authenticate until Fascicle passes the flag that opts a run back out, and the [roadmap](./roadmap.md#known-issues) tracks that.

### Env Inheritance

Under `oauth`, the subprocess env seeds from the full `process.env` so the `claude` binary can reach `HOME`, `PATH`, and other things it needs to find its session files. Under `api_key` and `auto`, it seeds only the 7 standard keys (`PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `LANG`, `TMPDIR`) from `process.env`, plus caller-supplied keys. Set `inherit_env: false` under any mode to start from an empty env.

Under `oauth`, that full env holds every key your process holds, and the CLI hands its env on to the commands it runs. List the names to keep out in `omit_env`, such as another provider's key, and the CLI never sees them, whether they came from `process.env` or from a call's `env`. The configured `api_key` still reaches the CLI under `api_key` and `auto`.

```ts
const engine = create_engine({
  providers: {
    claude_cli: { auth_mode: 'oauth', omit_env: ['OPENROUTER_API_KEY'] },
    openrouter: { api_key: process.env.OPENROUTER_API_KEY! },
  },
});
```

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

If stderr matches any of the frozen `CLI_AUTH_ERROR_PATTERNS` (`authentication`, `unauthorized`, `forbidden`, `oauth token has expired`, `invalid_api_key`), the adapter throws `provider_auth_error` with `refresh_command: 'claude auth login'` so your harness can tell the operator what to do, and the message ends with the same command. If you haven't logged in, the CLI leaves stderr empty and says so in its stream instead, as an assistant message with the `authentication_failed` error code, and you get the same error in the CLI's own words: `claude CLI reported an auth failure: Not logged in · Please run /login: run claude auth login`. When any other run fails with nothing on stderr, you get the text of the CLI's error result in the message.

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

- `--settings <json>` and `--strict-mcp-config`, right after `--setting-sources`, when `sandbox` is a `claude_code` sandbox. The JSON is the policy that [Sandboxing](#sandboxing) describes.
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

The idiomatic pattern is to capture the `session_id` that the first call reports, then pass it as `session_id` on follow-ups. `provider_reported` is keyed by provider name (see [Provider-reported detail](./providers.md#provider-reported-detail)), and this adapter reports `session_id` and `duration_ms` under `claude_cli`, plus `duration_api_ms` when the CLI reports it. `claude_cli_reported(result)` reads that entry back as a typed `ClaudeCliProviderReported`, or `undefined` when the result didn't come from the CLI, so you don't have to declare the shape yourself:

```ts
import { claude_cli_reported } from 'fascicle';

const first = await engine.generate({ provider: 'claude_cli', model: 'claude-sonnet-4-6', prompt: 'Start a plan.' });
const session_id = claude_cli_reported(first)?.session_id;
```

The CLI's `duration_api_ms` also gives each step a blended `timing`, which is what lets `throughput()` report a rate for a `claude_cli` call (see [Timing and Tokens per Second](./api-reference.md#timing-and-tokens-per-second)).

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

Whichever one fires kills the subprocess and throws `claude_cli_error` with `reason: 'startup_timeout' | 'stall_timeout'`, and the message names the option to raise.

## Sandboxing

Set `sandbox: { kind: 'claude_code' }` to run each call under Claude Code's own sandbox. Fascicle passes the policy to the CLI as `--settings`, and the CLI enforces it at the OS level, with Seatbelt on macOS and bubblewrap on Linux and WSL2, where you have to install `bubblewrap` and `socat`. Native Windows has no sandbox, so a call there fails rather than running unconfined. Your login keeps working, because the sandbox holds the commands that the CLI runs and leaves the CLI itself alone.

```ts
const engine = create_engine({
  providers: {
    claude_cli: {
      auth_mode: 'oauth',
      default_cwd: '/work/repo',
      sandbox: {
        kind: 'claude_code',
        network_allowlist: ['registry.npmjs.org', '*.github.com'],
        additional_write_paths: ['~/.cache/pnpm'],
        additional_read_paths: ['~/.npmrc'],
        deny_read_paths: ['~/.ssh', '~/.aws'],
      },
    },
  },
});
```

| Field                    | What it confines                                                                 |
| ------------------------ | -------------------------------------------------------------------------------- |
| `network_allowlist`      | The domains that Bash commands may reach, with `*.example.com` for the subdomains. Empty or absent means no network, and a host off the list is refused rather than asked about. |
| `additional_write_paths` | Where Bash may write, beyond the working directory and the per-user temp directory. |
| `additional_read_paths`  | What Bash may still read outside the working directory. The sandbox shuts Bash out of your home directory, apart from the working directory and git's global config. |
| `deny_read_paths`        | What neither Bash nor the file tools may read, even inside the working directory. |

Give each path as an absolute path or one that starts with `~/`. A relative one throws `engine_config_error` when you build the engine, since Claude Code resolves a relative path differently in each of its lists.

You can't change the rest of the policy:

- Bash can't retry a blocked command outside the sandbox, and a repo's own `.claude/settings.json` can't loosen the sandbox, because a policy that arrives through `--settings` outranks it.
- Bash still runs only when you allow it in `allowed_tools`, as it would without a sandbox.
- The file tools refuse paths outside the working directories in every permission mode, `bypassPermissions` included.
- Hooks are off, and the only MCP servers that start are the ones that you name with `--mcp-config` in `extra_args`. Both run outside the sandbox, and `-p` runs a project's hooks without asking you.
- When the sandbox can't start, the CLI exits, and your call fails with `claude_cli_error` and `reason: 'sandbox_unavailable'`.

Some things run outside the sandbox, where the policy can't reach them:

- **WebFetch and WebSearch.** They run in the CLI's own process, so `network_allowlist` doesn't bind them. Leave them out of `allowed_tools`, or pass `--disallowedTools WebFetch,WebSearch` in `extra_args`.
- **A repo's settings helpers and `env`.** A project's `.claude/settings.json` still loads under the default `setting_sources`, so set `setting_sources: []` for a repo that you don't trust.
- **Node's `fetch`.** It ignores the proxy variables that the sandbox sets unless you set `NODE_USE_ENV_PROXY=1`, and a tool that ignores them can't connect at all, even to a listed host.

A Bash command that names a path outside the working directories is refused before it runs, because the read block would have to ask you first, and `-p` can't. That includes `/dev/null`, so `curl -o /dev/null` fails where `curl -o page.html` works.

The sandbox needs Claude Code 2.1.314 or later. An older release drops the settings that it doesn't know without saying so, which would leave the file tools unconfined. So before its first sandboxed call the adapter runs `claude --version`, and it throws `claude_cli_error` with `reason: 'sandbox_unavailable'` for an older release. If yours is older, run `claude update`.

You can't pass your own `--settings` in a call's `extra_args` under this sandbox, and a call that tries throws `engine_config_error`.

### Deprecated `bwrap` and `greywall` Wrappers

`kind: 'bwrap'` and `kind: 'greywall'` still work, but neither enforces `network_allowlist`, and both go in a later minor release. Switch to `kind: 'claude_code'`, which takes the same `network_allowlist` and `additional_write_paths`.

The `bwrap` wrapper read-only binds `/usr`, `/bin`, `/lib`, `/lib64`, `/etc/resolv.conf`, mounts `/proc`, `/dev`, and a tmpfs at `/tmp`, unshares user/pid/ipc/uts/cgroup namespaces, binds each of `additional_write_paths` read-write, and dies with the parent. An empty or absent `network_allowlist` unshares the network, so the network is off. A non-empty one shares the host network (`--share-net`) and only hands the hosts to the child in the `CLAUDE_CLI_NET_ALLOW` variable, so nothing filters the traffic and every host stays reachable.

`greywall` takes its policy from a JSON settings file that's passed with `--settings`. The adapter writes one for each run, with `network_allowlist` as `network.allowHosts` and `additional_write_paths` as `filesystem.allowWrite`, or forwards your own file untouched when you set `settings_path`. `greywall` honors the write paths directly and ignores `network.allowHosts`, since greyproxy is what enforces host allowlisting, and the adapter writes no greyproxy rules, so nothing filters the hosts unless you add those rules yourself.

A missing sandbox binary triggers `claude_cli_error` with `reason: 'sandbox_unavailable'`. A `claude` binary outside the paths that `bwrap` binds, such as one in your home directory, isn't there inside the sandbox, so `bwrap` can't run it, and the error has `reason: 'binary_not_found'` and names the binary.

## Errors You May Hit

| Error                    | Cause                                                                       |
| ------------------------ | --------------------------------------------------------------------------- |
| `engine_config_error`    | `api_key` missing under `auth_mode: 'api_key'`, a relative path in a `claude_code` sandbox, or `--settings` in a call's `extra_args` under one. |
| `provider_auth_error`    | Stderr matched an auth-failure pattern, so surface `refresh_command` to whoever is running this. |
| `claude_cli_error`       | Subprocess failure. Check `.reason` for `binary_not_found`, `startup_timeout`, `stall_timeout`, `no_result_event`, `result_error`, `subprocess_exit`, or `sandbox_unavailable`. |
| `aborted_error`          | Your `abort` fired, or the engine was disposed while the call ran, in which case `.reason` is `'engine_disposed'`. |
| `engine_disposed_error`  | `generate` was called after `engine.dispose()`.                             |
| `provider_capability_error` | Multi-turn `prompt: Message[]` with two or more user messages, or `tool_bridge: 'forbid'` with a tool that has an `execute` closure. |
| `schema_validation_error` | Zod parse failed after one repair attempt.                                 |

## Dispose Behaviour

`engine.dispose()` aborts every in-flight subprocess with SIGTERM (escalating to SIGKILL after 2s). A `generate` that was still running rejects with `aborted_error`, whose `reason` is `'engine_disposed'`, and a `generate` that starts after `dispose()` throws `engine_disposed_error`. Call it in a `finally`, or on process exit.

## Debugging

- Set `trajectory` and watch for `cli_tool_bridge_allowlist_only` events — those list every tool that got dropped.
- Read the `stderr_snippet` field on any `claude_cli_error`, because the adapter captures the first 512 bytes of stderr for you.
- Set `binary` to an absolute path when `claude` isn't on the subprocess's `PATH`.
- `--verbose` is always on in the CLI invocation; combine with a filesystem trajectory logger to see the full back-and-forth.

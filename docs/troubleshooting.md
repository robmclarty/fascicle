# Troubleshooting

The errors you are most likely to hit on the first run, and what each one means.
fascicle fails loudly with named error types rather than silent fallbacks, so the
error name usually points straight at the cause.

## `Cannot find package '@ai-sdk/...'` — peer not installed

Provider SDKs are optional peers, loaded on the first `generate` against that
provider. The error is descriptive and arrives at call time, not construction:

```text
missing peer dependency '@ai-sdk/anthropic'. Install it with: pnpm add @ai-sdk/anthropic. Cause: …
```

Install the peer for the provider you actually call, or drop that provider from
the config. Constructing an engine with several providers does not require all of
their SDKs. See [providers.md](./providers.md#optional-peer-loading).

## `provider_not_configured_error`

You called a provider that is not present in `create_engine({ providers })`.
Constructing an engine never fails for a missing provider; the failure is deferred
to the first call against it. Add the provider to the config, or set
`defaults.provider` to one you did configure.

## `model_required_error`

No `model` was passed on the call and no `defaults.model` is set. Pass a model id,
or set `defaults: { model: '...' }`. Remember model ids are opaque and sent
verbatim, so use the provider's real id (`claude-sonnet-4-6`, `gpt-4o`, a Bedrock
inference profile, an Ollama tag). The one exception is `claude_cli`, where the
bare tokens `opus`/`sonnet`/`haiku` are resolved by the CLI itself. See
[configuration.md](./configuration.md#model-and-provider-two-axes).

## `require() of ES Module` / syntax errors on startup

fascicle is ESM-only and requires Node >= 24.

- Import it (`import { run } from 'fascicle'`); do not `require()` it.
- Your own package needs `"type": "module"` (or a `.mts` entry).
- Check `node -v`. On an older Node you will see syntax errors from modern
  language features long before anything fascicle-specific.

## Provider auth failures (401 / 403)

A configured provider rejected the credentials. Check the right environment
variable is set and passed into the config:

| Provider     | Credential                                                   |
| ------------ | ------------------------------------------------------------ |
| `anthropic`  | `ANTHROPIC_API_KEY`                                          |
| `openai`     | `OPENAI_API_KEY`                                             |
| `google`     | `GOOGLE_API_KEY`                                             |
| `openrouter` | `OPENROUTER_API_KEY`                                         |
| `bedrock`    | `region` (required) plus an AWS credential path              |
| `ollama` / `lmstudio` | no key; a reachable local `base_url`               |

`bedrock` throws `engine_config_error` if `region` is missing entirely (set it or
`AWS_REGION`); credentials beyond that are optional and fall back to the ambient
AWS credential chain. Per-provider notes: [providers.md](./providers.md).

## `claude_cli` problems

| Symptom                                            | Cause and fix                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `claude_cli_error` with `reason: 'binary_not_found'` | The `claude` binary is not on `PATH`. Install Claude Code, or set `binary`. |
| `provider_auth_error` with `refresh_command: 'claude login'` | The CLI session is missing or expired. Run `claude login`.          |
| `claude_cli_error` with `reason: 'startup_timeout' \| 'stall_timeout'` | No first chunk within 120s, or a 300s gap mid-stream. Check connectivity; raise `startup_timeout_ms` / `stall_timeout_ms`. |
| `claude_cli_error` with `reason: 'sandbox_unavailable'` | A `sandbox` was requested but `bwrap`/`greywall` is not installed.       |
| Your tools silently do nothing                     | Default `tool_bridge: 'allowlist_only'` drops `execute` closures and records a `cli_tool_bridge_allowlist_only` trajectory event. Use `tool_bridge: 'forbid'` to turn that into an error. |

Every `claude_cli_error` carries a `stderr_snippet` (first 512 bytes of stderr).
Full guide: [cli.md](./cli.md).

## Streaming stops retrying / logs look out of order

- Retries do not resume past the first delivered chunk. Once a stream has started,
  a mid-stream failure is not retried; the orchestrator enforces that boundary.
  See [configuration.md](./configuration.md#retry-policy).
- The bundled `filesystem_logger` writes synchronously and its span stacks are not
  async-context-aware, so under heavy `parallel`/`map` concurrency the ordering is
  best-effort. Fine for dev tools and short runs; roll your own `TrajectoryLogger`
  for a long-running server. See [concepts.md](./concepts.md#adapter-limits).

## `GenerateResult.cost` is missing

Cost is populated only when the resolved `provider:model_id` has a row in the
pricing table. Unpriced models return usage without cost — not an error. Add a row
with `engine.register_price(provider, model_id, { ... })` or the `pricing` config
key. `is_estimate` is always `true`; treat the number as a budget signal. See
[configuration.md](./configuration.md#pricing).

## `schema_validation_error`

The model returned text that failed your zod `schema` after the repair passes
(`schema_repair_attempts`, default 1). The error carries the zod error and the raw
text. Loosen the schema, raise the repair budget, or pick a more capable model.

## `engine_disposed_error`

You called `generate` after `engine.dispose()`. `dispose()` is terminal and
idempotent; construct a fresh engine if you need to keep going. Subprocess
providers (`claude_cli`) abort in-flight children on dispose.

## `TypeError: pipe is not variadic`

`pipe(inner, fn)` takes exactly one Step and one plain mapping function. Passing
a Step where `fn` belongs (e.g. `pipe(a, b, c)`) throws this `TypeError` at flow
construction. To chain Steps, use `sequence([a, b, c])`. `sequence` likewise
rejects non-Step children at construction — wrap plain functions with `step(fn)`.

## Still stuck

Attach a `trajectory` logger and re-run — the event stream usually shows exactly
where a flow diverged. Then open a bug report with the trajectory excerpt and your
Node and fascicle versions.

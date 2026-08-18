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

Two triggers share this error name; the timing tells them apart.

- **At construction:** a key in `create_engine({ providers })` matches no
  built-in provider and no `custom_providers` entry, so the engine cannot
  build an adapter for that name at all. Fix the spelling, or register the
  custom provider factory under `custom_providers`.
- **At call time:** the resolved `provider` for a `generate` call names an
  adapter the engine was not configured with. Constructing an engine never
  fails for a *missing* provider; that failure is deferred to the first call
  against it. Add the provider to the config, or point `defaults.provider`
  (or the per-call `provider`) at one you did configure.

## `provider_required_error`

The engine could not pick a provider: the call named none, no
`defaults.provider` is set, and more than one provider is configured, so
there is no sole candidate. The message is:

```text
no provider specified: pass `provider` to generate() or set `defaults.provider` (configured: anthropic, ollama)
```

There is no fallback provider. Pass `provider` on the call, or set
`defaults: { provider: '...' }` on the engine. An engine with exactly one
configured provider never throws this; the sole provider is used. The error
carries the configured provider names on `.configured`.

## `model_required_error`

No `model` was passed on the call and no `defaults.model` is set. Pass a model id,
or set `defaults: { model: '...' }`. Remember model ids are opaque and sent
verbatim, so use the provider's real id (`claude-sonnet-4-6`, `gpt-4o`, a Bedrock
inference profile, an Ollama tag). The one exception is `claude_cli`, where the
bare tokens `opus`/`sonnet`/`haiku` are resolved by the CLI itself. See
[configuration.md](./configuration.md#model-and-provider-two-axes).

## `ERR_PACKAGE_PATH_NOT_EXPORTED` — `require()` from CommonJS

fascicle ships ESM only, but its `exports` map carries a `default` condition,
so a CommonJS consumer on Node >= 24 (the supported floor) can
`require('fascicle')` directly: Node loads the ESM build through native
`require(esm)`. No CJS artifacts exist; the same files serve both.

Seeing this error:

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in .../node_modules/fascicle/package.json
```

means an older fascicle (<= 0.12), whose exports map was import-only. Upgrade,
or import it (`import { run } from 'fascicle'`) from an ES module.

- Check `node -v`. fascicle requires Node >= 24; on an older Node you will
  see syntax errors from modern language features long before anything
  fascicle-specific.

## `not assignable to parameter of type 'never'` at `run()`

An unannotated `chain()` types its input as `never`, so the first
`run(flow, input)` fails with TS2345: `Argument of type '...' is not
assignable to parameter of type 'never'`. State the input type when opening
the chain: `chain<Input>()`, or `chain('name').input<Input>()` when the
input binding is renamed.

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
`AWS_REGION`). Beyond that, supply an `api_key`, explicit SigV4 keys, or
`use_credential_chain: true`. Omitting all three does *not* reach the AWS
credential chain: `@ai-sdk/amazon-bedrock` reads `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` from the environment only and never opens
`~/.aws/credentials`, so a working `aws` CLI profile still fails with a SigV4
credentials error that looks like a missing IAM grant. Set
`use_credential_chain: true` (and install `@aws-sdk/credential-providers`) to
use the profile. Per-provider notes: [providers.md](./providers.md).

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

## A cancelled run keeps consuming tokens or holding resources

Cancellation is cooperative, not preemptive: `timeout(inner, ms)` and a SIGINT/SIGTERM
abort both signal `ctx.abort`, but neither can force a step that ignores that signal to
stop. `run(...)` returns (or throws `timeout_error`/`aborted_error`) on schedule, while
the abandoned step — a `model_call` whose transport never saw the signal, a tight loop
that never checks `ctx.abort.aborted`, a subprocess started without it — keeps running in
the background. For a model call this means the provider keeps generating, and billing,
tokens for a response nothing will read.

There is no fix on fascicle's side: JavaScript has no way to preempt a promise it does
not control. The fix is in the step: pass `ctx.abort` to every `fetch`, `child_process`,
or other abortable call the step makes, and check `ctx.abort.aborted` between iterations
of any loop that does not otherwise await something abortable. See
[concepts.md](./concepts.md#cancellation-is-cooperative).

## Streaming stops retrying / logs look out of order

- Retries do not resume past the first delivered chunk. Once a stream has started,
  a mid-stream failure is not retried; the orchestrator enforces that boundary.
  See [configuration.md](./configuration.md#retry-policy).
- The bundled `filesystem_logger` writes synchronously, so it is meant for dev
  tools and short runs; roll your own `TrajectoryLogger` for a long-running
  server. Span parentage is threaded by the runner (`parent_span_id`), so span
  trees are correct under `parallel`/`map` concurrency; only spans emitted
  without a parent (a logger driven directly, outside a run) fall back to a
  best-effort in-memory stack. See [concepts.md](./concepts.md#adapter-limits).

## `GenerateResult.cost` is missing

Cost is populated only when the resolved `provider:model_id` has a row in the
pricing table. Unpriced models return usage without cost — not an error. Add a row
with `engine.register_price(provider, model_id, { ... })` or the `pricing` config
key. `is_estimate` is always `true`; treat the number as a budget signal. See
[configuration.md](./configuration.md#pricing).

## `GenerateResult.provider_reported` is missing

The field is present only when the provider volunteered detail on that call, and
it is keyed by provider name: read `provider_reported.bedrock`, not
`provider_reported.trace`. For Bedrock guardrails the assessment arrives only
with `trace: 'enabled'` in `guardrailConfig`; without it AWS sends no trace and
the field carries the rest of the metadata or nothing at all. A guardrail whose
PII action is `NONE` rewrites nothing, so the trace is the only in-process
evidence it ran. See
[providers.md](./providers.md#provider-reported-detail).

## A Bedrock guardrail seems ignored and the output is unchanged

Check what the guardrail is configured to *do* before suspecting the wiring. A
PII action of `NONE` detects and reports without rewriting, so unchanged output
is the expected result rather than a dropped config. A benign prompt cannot
distinguish "attached and detecting" from "not attached" at all: with
`trace: 'enabled'`, `provider_reported.bedrock.trace` is the only in-process
difference between the two.

To test the wiring rather than the policy, pass a deliberately invalid
`guardrailIdentifier`. AWS answers `The provided guardrail identifier is
invalid.` only if the config actually reached the Converse command, whereas a
silently dropped `provider_options.bedrock.guardrailConfig` produces a call that
*succeeds*. Success is the failure signal. The probe needs no guardrail to
exist, so it works before one is provisioned.

To test enforcement instead, trip the policy: on a call without a `schema`,
expect `finish_reason: 'content_filter'` and the guardrail's own block message as
the content. With a `schema` set the same block throws
`incomplete_generation_error` instead, carrying that message on `raw_text` and
the trace on `provider_reported`. See [providers.md](./providers.md#bedrock).

## `schema_validation_error`

The model returned text that failed your `schema` after the repair passes
(`schema_repair_attempts`, default 1). The error carries `.schema_issues` (the
vendor-neutral issue list) and the raw text. Loosen the schema, raise the
repair budget, or pick a more capable model.

## `incomplete_generation_error`

A call with a `schema` finished for a reason other than `stop` — a content
filter fired, the token limit truncated the response, or the step cap ended the
loop — so no schema-valid value exists. No repair is attempted: re-prompting a
model that was blocked or cut off does not produce the missing value.

Read `finish_reason` to tell the cases apart, `raw_text` for whatever text did
arrive (a half-written JSON object on `length`, a block message on
`content_filter`), and `provider_reported` for the provider's own account,
including a Bedrock guardrail trace. Raise `max_tokens` for `length`, raise
`max_steps` for `max_steps`, and treat `content_filter` as a policy outcome to
report rather than a failure to retry.

Without a `schema`, these finish reasons still return normally with the partial
text as `content` — the throw exists because the alternative is returning an
unvalidated string typed as your schema, which reads downstream as a valid
low-risk answer.

## `engine_disposed_error`

You called `generate` after `engine.dispose()`. `dispose()` is terminal and
idempotent; construct a fresh engine if you need to keep going. Subprocess
providers (`claude_cli`) abort in-flight children on dispose.

## My run threw `suspended_error`

A `suspend` gate fired during a plain `run(...)`, which has no way to represent
a pause and so signals it as a throw. Drive suspend-bearing flows with
`run.until_suspended` instead: a pause resolves as
`{ kind: 'suspended', id, resume }`, and calling the returned `resume(data)`
closure re-runs the flow with the decision. Completion is
`{ kind: 'done', output }`; real errors still throw. See
[human-in-the-loop.md](./human-in-the-loop.md).

## A `sequence` type error disappeared after a refactor

Literal `sequence` tuples are joint-checked at compile time: each child must
accept its predecessor's output, and a mismatch errors on the offending
element. Arrays built at runtime (a `.map(...)`, a spread, a variable of plain
array type) cannot be joint-checked and degrade to unknown boundaries. So a
flow that stopped type-erroring after a refactor to a runtime-built array did
not become correct; it became unchecked. Annotate the outer `Step<In, Out>` to
restore the check at the flow's boundary.

## `TypeError: pipe is not variadic`

`pipe(inner, fn)` takes exactly one Step and one plain mapping function. Passing
a Step where `fn` belongs (e.g. `pipe(a, b, c)`) throws this `TypeError` at flow
construction. To chain Steps, use `sequence([a, b, c])`. `sequence` likewise
rejects non-Step children at construction — wrap plain functions with `step(fn)`.

## Locating a failure: reading `.path`

Errors thrown from inside a run carry a `path` array naming the chain of step
ids that led to the failure, outermost first:

```ts
import { error_path } from 'fascicle';

try {
  await run(flow, input);
} catch (err) {
  console.error(error_path(err)); // e.g. ['chain_1', 'enrich']
  throw err;
}
```

`error_path` narrows any thrown value; the fascicle error classes also
declare `path`, so after an `instanceof` check `err.path` typechecks with no
cast.

The last element is the failing leaf. Auto-derived ids (a `model_call` without
an explicit id gets one like `model_call:a1b2c3:2`) make a path hard to read
when a flow holds several model calls; set `id:` on each `model_call` /
`model_step` so the path names the role (`['review', 'critic']` instead of
`['review', 'model_call:a1b2c3:2']`).

## Still stuck

Attach a `trajectory` logger and re-run — the event stream usually shows exactly
where a flow diverged. Then open a bug report with the trajectory excerpt and your
Node and fascicle versions.

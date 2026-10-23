# Troubleshooting

The errors you're most likely to hit on your first run, and what each one means.
Fascicle fails loudly with named error types instead of silent fallbacks, so the
error name usually points you straight at the cause.

## `Cannot find package '@ai-sdk/...'` — Peer Not Installed

Provider SDKs are optional peers that load on the first `generate` against that
provider. The error is descriptive and arrives at call time, not construction:

```text
missing peer dependency '@ai-sdk/anthropic'. Install it with your package manager, e.g., `pnpm add @ai-sdk/anthropic` or `npm install @ai-sdk/anthropic`. Cause: …
```

Install the peer for the provider you actually call, or drop that provider from
the config. Constructing an engine with several providers doesn't require all of
their SDKs. See [providers.md](./providers.md#optional-peer-loading).

## `provider_not_configured_error`

The error itself fires at call time. A misspelled provider fails earlier with
a different error, and the timing tells the two apart.

- **At construction**, a key in your `create_engine({ providers })` matches no
  built-in provider and no `custom_providers` entry, so the engine can't
  build an adapter for that name at all. That throws `engine_config_error`
  (`unknown provider '<name>'; built-in providers are: ...`) rather than this
  error. Fix the spelling, or register the custom provider factory under
  `custom_providers`.
- **At call time**, the resolved `provider` for a `generate` call names an
  adapter that the engine wasn't configured with. Constructing an engine never
  fails for a *missing* provider; that failure is deferred to the first call
  against it. Add the provider to the config, or point `defaults.provider`
  (or the per-call `provider`) at one you did configure.

## `provider_required_error`

The engine couldn't pick a provider, because the call named none, no
`defaults.provider` is set, and more than one provider is configured, so
there's no sole candidate. The message is:

```text
no provider specified: pass `provider` to generate() or set `defaults.provider` (configured: anthropic, ollama)
```

No fallback provider exists. Pass `provider` on the call, or set
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

## Duplicate Tool Names (`engine_config_error`)

A call passed two or more tools under one name, and the engine threw
`engine_config_error` before it sent anything. The message names each
duplicate and how many times it appears:

```text
duplicate tool names: search (2), read_file (3); give each tool its own name, or pass `name_prefix` to mcp_client for one server's tools
```

The loop and every transport look a tool up by its name, so a second tool
under the same name used to replace the first without a word, and the model
could never call the one that disappeared. Give one of them a name of its own.
Two MCP servers that advertise the same tool are the usual cause, and
`mcp_client(config, { name_prefix: 'gh_' })` puts a prefix on one server's
tools, exactly as you write it, so the model sees `gh_search` while the server
is still called with `search`. In an ACP session, a tool of your own under a
workspace tool's name throws the same way when both sit in one call (see
[acp.md](./acp.md#the-workspace-tools)).

## `ERR_PACKAGE_PATH_NOT_EXPORTED` — `require()` from CommonJS

Fascicle ships ESM only, but its `exports` map carries a `default` condition,
so a CommonJS consumer on Node >= 24 (the supported floor) can
`require('fascicle')` directly, since Node loads the ESM build through native
`require(esm)`. No CJS artifacts exist; the same files serve both.

Seeing this error:

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in .../node_modules/fascicle/package.json
```

means an older Fascicle (0.12.0 or earlier), whose exports map was
import-only. Upgrade, or import it (`import { run } from 'fascicle'`) from an
ES module.

- Check `node -v`. Fascicle requires Node >= 24; on an older Node you'll
  see syntax errors from modern language features long before anything
  Fascicle-specific.

## `not assignable to parameter of type 'never'` at `run()`

An unannotated `chain()` can't know its input type, so your first
`run(flow, input)` fails. Through 0.16.3 the type is `never`, and the error is
TS2345: `Argument of type '...' is not assignable to parameter of type 'never'`.
Later releases type it as `ChainInputUndeclared<"call .input<T>() on the chain to say what it takes">`, so the error says what to do. Either way,
state the input type when opening the chain, with `chain<Input>()`, or
`chain('name').input<Input>()` when the input binding is renamed.

## Provider Auth Failures (401 / 403)

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

`bedrock` throws `engine_config_error` if `region` is missing entirely. The
adapter never reads `AWS_REGION` itself, so pass it in from your config
(`region: process.env.AWS_REGION`) if that's where it lives. Beyond that,
supply an `api_key`, explicit SigV4 keys, or `use_credential_chain: true`.
Omitting all three does *not* reach the AWS credential chain.
`@ai-sdk/amazon-bedrock` reads `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` from the environment only and never opens
`~/.aws/credentials`, so a working `aws` CLI profile still fails with a SigV4
credentials error that looks like a missing IAM grant. Set
`use_credential_chain: true` (and install `@aws-sdk/credential-providers`) to
use the profile. For the per-provider notes, read [providers.md](./providers.md).

## `claude_cli` Problems

| Symptom                                            | Cause and fix                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `claude_cli_error` with `reason: 'binary_not_found'` | The `claude` binary isn't on `PATH`. Install Claude Code, or set `binary`. |
| `binary_not_found` whose message says `bwrap` found no binary | The `claude` binary sits outside the paths that the `bwrap` sandbox binds, such as in your home directory. The [roadmap](./roadmap.md#known-issues) tracks this. |
| `provider_auth_error` with `refresh_command: 'claude auth login'` | The CLI session is missing or expired. Run `claude auth login`. |
| `claude_cli_error` with `reason: 'startup_timeout' \| 'stall_timeout'` | No first chunk within 120s, or a 300s gap mid-stream. Check connectivity; raise `startup_timeout_ms` / `stall_timeout_ms`. |
| `claude_cli_error` with `reason: 'sandbox_unavailable'` | A `sandbox` was requested but `bwrap`/`greywall` isn't installed.       |
| Your tools silently do nothing                     | Default `tool_bridge: 'allowlist_only'` drops `execute` closures and records a `cli_tool_bridge_allowlist_only` trajectory event. Use `tool_bridge: 'forbid'` to turn that into an error. |

Every `claude_cli_error` carries a `stderr_snippet` (first 512 bytes of stderr).
The full guide is [cli.md](./cli.md).

## A Cancelled Run Keeps Consuming Tokens or Holding Resources

Cancellation is cooperative and not preemptive, so `timeout(inner, ms)` and a SIGINT/SIGTERM
abort both signal `ctx.abort`, but neither can force a step that ignores that signal to
stop. `run(...)` returns (or throws `timeout_error`/`aborted_error`) on schedule, while
the abandoned step — a `model_call` whose transport never saw the signal, a tight loop
that never checks `ctx.abort.aborted`, a subprocess started without it — keeps running in
the background. For a model call this means the provider keeps generating, and billing,
tokens for a response nothing will read.

No fix exists on Fascicle's side, because JavaScript has no way to preempt a promise it
does not control. The fix is in the step, so pass `ctx.abort` to every `fetch`, `child_process`,
or other abortable call that the step makes, and check `ctx.abort.aborted` between iterations
of any loop that doesn't otherwise await something abortable. See
[concepts.md](./concepts.md#cancellation-is-cooperative).

## Streaming Stops Retrying / Logs Look out of Order

- Retries don't resume past the first chunk that reached your `on_chunk`. Once
  you've seen part of a stream, a failure partway through it isn't retried,
  since a retry would hand you that part again; the orchestrator enforces that
  boundary. With no `on_chunk`, nothing reached you, so a turn that fails
  mid-stream retries the whole turn. See
  [configuration.md](./configuration.md#retry-policy).
- The bundled `filesystem_logger` writes synchronously, so it's meant for dev
  tools and short runs; roll your own `TrajectoryLogger` for a long-running
  server. Span parentage is threaded by the runner (`parent_span_id`), so span
  trees are correct under `parallel`/`map` concurrency; only the spans that are
  emitted without a parent (a logger driven directly, outside a run) fall back
  to a best-effort in-memory stack. See
  [concepts.md](./concepts.md#adapter-limits).

## `GenerateResult.cost` Is Missing

Cost is populated when the resolved `provider:model_id` has a row in the pricing
table, or when the provider reports what the call cost, as OpenRouter does on
`transport: 'native'`. An unpriced model returns usage without cost, which isn't
an error. Add a row with `engine.register_price(provider, model_id, { ... })` or
the `pricing` config key. The `ai_sdk` transport's `openrouter` reads no reported
cost, so it needs a row like any other provider. `is_estimate` is always `true`,
a reported total included. That total is what OpenRouter charged, but Fascicle
splits it across input, output, and cache tokens by their weight, and the split
is an estimate. Treat a number that a pricing row produced as a budget signal.
See [configuration.md](./configuration.md#pricing).

## `GenerateResult.provider_reported` Is Missing

The field is present only when the provider volunteered detail on that call, and
it's keyed by provider name, so read `provider_reported.bedrock`, not
`provider_reported.trace`. For Bedrock guardrails the assessment arrives only
with `trace: 'enabled'` in `guardrailConfig`; without it AWS sends no trace and
the field carries the rest of the metadata or nothing at all. A guardrail whose
PII action is `NONE` rewrites nothing, so the trace is the only in-process
evidence it ran. See
[providers.md](./providers.md#provider-reported-detail).

## A Bedrock Guardrail Seems Ignored and the Output Is Unchanged

Check what the guardrail is configured to *do* before suspecting the wiring. A
PII action of `NONE` detects and reports without rewriting, so unchanged output
is the expected result rather than a dropped config. A benign prompt can't
distinguish "attached and detecting" from "not attached" at all, because with
`trace: 'enabled'`, `provider_reported.bedrock.trace` is the only in-process
difference between the two.

To test the wiring rather than the policy, pass a deliberately invalid
`guardrailIdentifier`. AWS answers `The provided guardrail identifier is
invalid.` only if the config actually reached the Converse command, whereas a
silently dropped `provider_options.bedrock.guardrailConfig` produces a call that
*succeeds*. Success is the failure signal. The probe needs no guardrail to
exist, so it works before one is provisioned.

To test enforcement instead, trip the policy. On a call without a `schema`,
expect `finish_reason: 'content_filter'` and the guardrail's own block message as
the content. With a `schema` set the same block throws
`incomplete_generation_error` instead, carrying that message on `raw_text` and
the trace on `provider_reported`. See [providers.md](./providers.md#bedrock).

## A Bedrock Turn Fails with a 403 That Names `InvokeModelWithResponseStream`

Every turn streams, so the Bedrock peer calls ConverseStream, and AWS checks
the IAM action `bedrock:InvokeModelWithResponseStream` for that, not the
`bedrock:InvokeModel` that Converse takes. A least-privilege role that a
whole-body turn ran under answers every turn with a 403 `AccessDeniedException`
that says the caller isn't authorized to perform
`bedrock:InvokeModelWithResponseStream` on the model's resource. Add that
action to the role's policy for the same models, beside `bedrock:InvokeModel`.
A 403 is never retried, so the first turn fails at once. If the model works
until you hand it tools, check AWS's list of which models support tool use
while streaming. See [providers.md](./providers.md#bedrock).

## A Turn Cost Far More Than the One Before

In a cached tool loop, every turn after the first should read most of its
input back from the provider's cache. A turn whose cost jumps back up to the
full input price read nothing, and the trajectory says so with a
`cache_miss` event, whose `previous_cached_tokens` is the size of the prefix
that the turn expected to find. The usual reasons:

- **The cache expired.** A five-minute entry counts its lifetime from the
  start of the request that last read or wrote it, so a long generation
  shortens the time that the next request has to start in, and so does a slow
  tool or a person who takes a while to reply. `cache: '1h'` gives a slow
  loop an hour.
- **Something changed the top of the array.** The cache matches by prefix,
  so a system prompt that changed, a tool list that changed, or an earlier
  message that was rewritten sends everything after it at the full price.
  When `after_prepare_step` is `true`, look at your `prepare_step` first: a
  sliding window rewrites the prefix on every turn once it engages.
  `assert_prefix_stable` in `fascicle/testing` catches this in a test.
- **The prefix fell out of the window that the cache checks.** Anthropic checks at most 20
  positions back from the breakpoint. Only the Claude API promises to count a
  run of tool calls, or of tool results, as one position, so on Vertex AI or
  Bedrock a wide parallel turn can push the cached prefix out of reach.

See [providers.md](./providers.md#prompt-caching).

## A 400 That Names `cache_control`

An Anthropic tool loop caches by default on either transport, so its request
carries a top-level `cache_control`, and a few setups refuse that field with a
400 whose message names it:

- **The legacy Amazon Bedrock integration.** A gateway that routes the request
  to Bedrock's older integration of Claude (Opus 4.6 and earlier) rejects the
  top-level field outright.
- **Four explicit breakpoints.** Automatic caching takes one of the four
  breakpoint slots that a request has, so a request whose blocks you already
  marked four times through `provider_options.anthropic` has none left for it.
- **A one-hour entry after a five-minute one.** A block that you marked with
  `ttl: '1h'` can't come after one marked with the five-minute default.
- **A lifetime that disagrees.** When the last block that the request can cache
  carries an explicit `cache_control` of its own, its lifetime has to match the
  top-level one.

Set `cache: 'off'` on the call, or as the engine default, and the engine sends
no `cache_control` of its own. A raw top-level `cache_control` that you put
under `provider_options.anthropic` still goes out, because an explicit wire key
always wins over the setting, so drop that key too. See
[providers.md](./providers.md#prompt-caching).

## `schema_validation_error`

The model returned text that failed your `schema` after the repair passes
(`schema_repair_attempts`, default 1). The error carries `.schema_issues` (the
vendor-neutral issue list) and the raw text. Loosen the schema, raise the
repair budget, or pick a more capable model.

## `incomplete_generation_error`

A call with a `schema` finished for a reason other than `stop` — a content
filter fired, the token limit truncated the response, or the step cap ended the
loop — so no schema-valid value exists. No repair is attempted, because re-prompting a
model that was blocked or cut off doesn't produce the missing value.

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

## My Run Threw `suspended_error`

A `suspend` gate fired during a plain `run(...)`, which has no way to represent
a pause and so signals it as a throw. Drive suspend-bearing flows with
`run.until_suspended` instead, where a pause resolves as
`{ kind: 'suspended', id, resume }`, and calling the returned `resume(data)`
closure re-runs the flow with the decision. Completion is
`{ kind: 'done', output }`; real errors still throw. See
[human-in-the-loop.md](./human-in-the-loop.md).

## A `sequence` Type Error Disappeared after a Refactor

Literal `sequence` tuples are joint-checked at compile time, so each child must
accept its predecessor's output, and a mismatch errors on the offending
element. Arrays built at runtime (a `.map(...)`, a spread, a variable of plain
array type) can't be joint-checked and degrade to unknown boundaries. So a
flow that stopped type-erroring after a refactor to a runtime-built array did
not become correct; it became unchecked. Annotate the outer `Step<In, Out>` to
restore the check at the flow's boundary.

## `TypeError: pipe is not variadic`

`pipe(inner, fn)` takes exactly one Step and one plain mapping function. Passing
a Step where `fn` belongs (for example, `pipe(a, b, c)`) throws this `TypeError`
at flow construction. To chain Steps, use `sequence([a, b, c])`. `sequence` likewise
rejects non-Step children at construction — wrap plain functions with `step(fn)`.

## `TypeError: ... is not a valid identifier`

Every id in a flow has to be readable back as a property name, because ids are
keys: a `chain` binding merges its result into the growing record under its
name, and a name you cannot destructure is a name the record cannot offer. So
`step`, `chain.step`, `chain`'s input name, `define_agent`, `suspend`, and
`gate` all hold ids to the same rule, and all six throw at construction when it
is broken. A `suspend` or `gate` id is a key as well, since that's the name its
resume data arrives under, and its label goes in `name`.

```text
step id "fetch the manifest" is not a valid identifier: ids are read back as
property names, so use fetch_the_manifest and put the label in meta.name
```

Nothing rewrites the id for you. Normalizing would quietly map `my-id`, `my.id`,
and `my id` onto one key, so the failure names the spelling it would have picked
and leaves the choice with you.

The prose has its own home, and it is unconstrained:

```ts
step('fetch_manifest', fetch_it, { name: 'Fetch the package manifest' })

chain('email').input<string>()
  .step('user_id', ({ email }) => find_user(email), { name: 'Look up the user' })

define_agent({ md_path, schema, engine, id: 'change_triage', name: 'Change Triage' })
```

Display labels on composers (`sequence`, `loop`, `compose`, and the rest) were
never ids and stay free-form.

## Locating a Failure: Reading `.path`

Errors thrown from inside a run carry a `path` array that names the chain of
step ids that led to the failure, outermost first:

```ts
import { error_path } from 'fascicle';

try {
  await run(flow, input);
} catch (err) {
  console.error(error_path(err)); // e.g. ['chain_1', 'enrich']
  throw err;
}
```

`error_path` narrows any thrown value; the Fascicle error classes also
declare `path`, so after an `instanceof` check `err.path` typechecks with no
cast.

The last element is the failing leaf. Auto-derived ids (a `model_call` without
an explicit id gets one like `model_call_a1b2c3_2`) make a path hard to read
when a flow holds several model calls; set `id:` on each `model_call` /
`model_step` so the path names the role (`['review', 'critic']` instead of
`['review', 'model_call_a1b2c3_2']`).

## Still Stuck

Attach a `trajectory` logger and re-run — the event stream usually shows exactly
where a flow diverged. Then open a bug report with the trajectory excerpt and your
Node and Fascicle versions.

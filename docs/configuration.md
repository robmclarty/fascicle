# Configuration

Configuring the engine layer: `create_engine(config)`, pricing, defaults, retry policy, and how per-call options merge over engine defaults.

## The config shape

```ts
type EngineConfig = {
  providers: ProviderConfigMap;
  custom_providers?: Record<string, ProviderFactory>;
  pricing?: PricingTable;
  defaults?: EngineDefaults;

  // Legacy top-level defaults; prefer `defaults: { ... }`.
  default_retry?: RetryPolicy;
  default_effort?: EffortLevel;
  default_max_steps?: number;
};
```

Only `providers` is required.

## Providers

`providers` is a name-keyed map of provider inits. The eight built-in names:

```ts
type ProviderConfigMap = {
  anthropic?:   { api_key: string; base_url?: string; transport?: 'ai_sdk' | 'native' };
  openai?:      { api_key: string; base_url?: string; organization?: string; transport?: 'ai_sdk' | 'native' };
  google?:      { api_key: string; base_url?: string };
  ollama?:      { base_url: string; transport?: 'ai_sdk' | 'native' };
  lmstudio?:    { base_url: string; transport?: 'ai_sdk' | 'native' };
  openrouter?:  { api_key: string; base_url?: string; http_referer?: string; x_title?: string; transport?: 'ai_sdk' | 'native' };
  bedrock?:     { region: string; api_key?: string; access_key_id?: string; secret_access_key?: string; session_token?: string; base_url?: string };
  claude_cli?:  ClaudeCliProviderConfig;
};
```

A provider absent from `providers` throws `provider_not_configured_error` at call time — constructing an engine without a provider does not fail; the failure is deferred to the first `generate` against it.

Five providers take an optional `transport` selector: `'ai_sdk'` (the default) wraps that provider's AI SDK peer, `'native'` talks to the provider's own API directly over `fetch` with no peer to install. `anthropic` native targets the Messages API; `openai`, `openrouter`, and `lmstudio` native ride a shared OpenAI Chat Completions core; `ollama` native targets its own `/api/chat` endpoint. The provider name, pricing keys, and effort mapping are identical across transports. See [providers.md](./providers.md#transport-picking-a-depth-1-backend).

Every provider's SDK is an optional peer dependency, loaded on first `generate`. Install only the ones you use.

```bash
# install peers as needed
pnpm add @ai-sdk/anthropic
pnpm add @ai-sdk/openai
pnpm add @ai-sdk/google
pnpm add @ai-sdk/openai-compatible  # openrouter
pnpm add ai-sdk-ollama
pnpm add @ai-sdk/openai-compatible  # lmstudio
pnpm add @ai-sdk/amazon-bedrock     # bedrock
# claude_cli has no peer; it spawns the `claude` binary
```

Full per-provider notes live in [providers.md](./providers.md). The `claude_cli` adapter has its own guide: [cli.md](./cli.md).

## Custom providers

`custom_providers` registers provider factories beyond the built-in set at construction time. Keys are provider names; each factory receives the same-named entry from `providers` as its init and may return an adapter of any kind: `ai_sdk` (wrap an AI SDK provider), `native` (raw HTTP implementing one model turn), or `external` (a backend that runs its own loop). The kinds and their contracts are documented in [providers.md](./providers.md#three-integration-depths); the example below returns an `ai_sdk` adapter, with `native` and `external` sketches under [Writing your own](./providers.md#writing-your-own).

```ts
import {
  create_engine,
  default_normalize_usage,
  type ProviderFactory,
} from 'fascicle';

const create_acme_adapter: ProviderFactory = (init) => {
  if (typeof init.api_key !== 'string' || init.api_key.length === 0) {
    throw new Error('acme requires api_key');
  }
  return {
    kind: 'ai_sdk',
    name: 'acme',
    build_model: async (model_id) => {
      const { createAcme } = await import('@acme/ai-sdk-provider');
      return createAcme({ apiKey: init.api_key })(model_id);
    },
    translate_effort: () => ({ provider_options: {}, effort_ignored: true }),
    normalize_usage: default_normalize_usage,
    supports: (capability) =>
      capability === 'text' || capability === 'tools' || capability === 'streaming',
  };
};

const engine = create_engine({
  providers: { acme: { api_key: process.env.ACME_API_KEY ?? '' } },
  custom_providers: { acme: create_acme_adapter },
});
```

Rules:

- **Custom-first resolution.** A `providers` key is resolved against `custom_providers` first, then the built-ins.
- **Shadowing a built-in throws.** A `custom_providers` key that matches a built-in name (`anthropic`, `openai`, ...) throws `engine_config_error` at construction; there is no silent override.
- **Construction-time only.** There is no runtime registration; the config object is the whole registry extension.
- **Validated like built-ins.** Factories run synchronously at `create_engine`; throw from the factory on bad init. Defer SDK or resource loading to the first call (`build_model` for `ai_sdk`-kind, `invoke_turn` for `native`-kind, `generate` for `external`-kind).

The factory and adapter types (`ProviderFactory`, `ProviderAdapter`, `AiSdkProviderAdapter`, `NativeProviderAdapter`, `ExternalAgentAdapter`, `ProviderCapability`, `ProviderTransport`) are exported from `fascicle`, alongside the neutral turn types (`TurnRequest`, `TurnResult`) and the `default_normalize_usage` helper, so a `kind: 'native'` adapter can be typed explicitly as `NativeProviderAdapter` rather than checked contextually through `ProviderFactory`. Because registration is plain config, a proprietary or workplace-private provider lives entirely in the consuming repo and never needs to enter the fascicle tree.

## Registering a provider after construction: `with_providers`

There is no mutable runtime registry. When a provider only becomes known *after* the engine is built — a plugin that loads late, a tenant-supplied backend, a credential resolved by an async bootstrap — derive a new engine instead of mutating the old one:

```ts
const base = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY ?? '' } },
});

// ...later, once the plugin's config is known:
const extended = base.with_providers(
  { acme: { api_key: pluginConfig.acmeKey } },
  { acme: create_acme_adapter },
);
```

`with_providers(providers, custom_providers?)` returns a **new** engine whose config is the base engine's config with `providers` and `custom_providers` shallow-merged by name over the originals (a same-named entry overrides). This keeps engines value-like: a mutable registry would make an engine's behavior depend on *when* you call it and blur which engine owns which adapters, so derivation is the answer instead.

- **The original engine is untouched.** `base` keeps exactly the providers, adapters, and pricing it had; only `extended` sees the additions.
- **Everything else carries forward.** Construction-time pricing, `defaults`, and retry policy are inherited unchanged. (Runtime `register_price` mutations are *not* — derivation is a pure function of the construction config, so re-register on the derived engine if you need them.)
- **Same rules re-run.** The merged config is re-validated with the same custom-first resolution and the same built-in shadow-throw; adding `{ openai: … }` to `custom_providers` still throws `engine_config_error`.
- **Fresh adapters, independent disposal.** Every adapter in the derived engine is constructed fresh from the merged config, including the ones the base already had. `extended.dispose()` tears down only the derived engine's adapters; `base` stays live, and vice versa. Dispose each engine you build.

## Reading credentials from env

The engine does not read `process.env`. Reading credentials from the environment is the harness's job, done once at its boundary and passed in as an explicit config object. The idiomatic pattern is a plain read of `process.env`:

```ts
import { create_engine } from 'fascicle';

const anthropic_key = process.env.ANTHROPIC_API_KEY;
const openai_key    = process.env.OPENAI_API_KEY;
const ollama_url    = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

const engine = create_engine({
  providers: {
    ...(anthropic_key ? { anthropic: { api_key: anthropic_key } } : {}),
    ...(openai_key    ? { openai:    { api_key: openai_key    } } : {}),
    ollama: { base_url: ollama_url },
  },
});
```

The published library stays free of ambient env reads (the `no-process-env-in-core` rule enforces that inside `src/`), but your own harness is under no such constraint. The rule exists to keep `fascicle` itself env-free, not to dictate how you wire your program.

## Model and provider: two axes

A model call has two orthogonal inputs, and they are the *only* inputs — there is no name resolution, alias table, or family catalog in between:

- **`model`** — *which* model, as an **opaque string** passed verbatim to the provider as its `model_id`. Use whatever id the provider expects (`claude-opus-4-8`, `gpt-4o`, `us.anthropic.claude-sonnet-4-20250514-v1:0`, `qwen3-coder:30b`). fascicle does not interpret, rewrite, or maintain model names; a bad id surfaces as the provider's own "not found" error.
- **`provider`** — *how* to reach it (the transport): `anthropic`, `openai`, `google`, `ollama`, `lmstudio`, `openrouter`, `bedrock`, `claude_cli`.

Both are accepted per-call on `generate(opts)` / `model_call({ ... })` and as engine defaults (`defaults.model`, `defaults.provider`).

### Resolution

There is no resolution step. `model` is sent straight through as the provider's `model_id`; `provider` selects the adapter. The provider axis is resolved first: per-call `provider`, else `defaults.provider`, else the sole configured provider, else `anthropic`. If `model` is omitted and no `defaults.model` is set, `generate` throws `model_required_error`. A `provider` with no adapter configured on the engine throws `provider_not_configured_error`.

There is no `provider:model` colon shorthand and no `opus`/`sonnet` family shorthand — pass the provider's real id (look it up in the provider's own docs). One exception: the `claude_cli` transport forwards the bare token to the CLI, which resolves `opus`/`sonnet`/`haiku` to the latest itself, so those still work for that provider.

If you want short names of your own, keep a plain map in your harness and look the id up before calling `generate` — fascicle deliberately owns no such table.

## Pricing

Cost accounting is estimated per-call using a `PricingTable` keyed by `provider:model_id`:

```ts
type Pricing = {
  input_per_million: number;
  output_per_million: number;
  cached_input_per_million?: number;
  cache_write_per_million?: number;
  reasoning_per_million?: number;
};
```

Default pricing ships for a set of common concrete ids (current Claude, GPT, and Gemini models). Override and extend:

```ts
const engine = create_engine({
  providers: { ... },
  pricing: {
    'anthropic:claude-opus-4-8': {
      input_per_million: 15,
      output_per_million: 75,
      cache_write_per_million: 18.75,
      cached_input_per_million: 1.5,
    },
  },
});

engine.register_price('openai', 'gpt-4o', {
  input_per_million: 2.5,
  output_per_million: 10,
});
```

Unpriced models return usage without cost. The `is_estimate: true` flag is always set — pricing tables drift; your accounting is the source of truth.

## Engine defaults

`defaults` pre-fills per-call options so your `generate(...)` sites stay terse:

```ts
type EngineDefaults = {
  model?: string;
  provider?: string;
  system?: string;
  effort?: EffortLevel;
  max_steps?: number;
  turn_timeout_ms?: number;
  retry_policy?: RetryPolicy;
  tool_error_policy?: 'feed_back' | 'throw';
  schema_repair_attempts?: number;
  tool_call_repair_attempts?: number;
  max_tool_calls_per_step?: number;
  provider_options?: Record<string, Record<string, unknown>>;
  ai_sdk_telemetry?: AiSdkTelemetrySettings;   // opt-in OTel for the ai_sdk transport; see "OpenTelemetry" below
};
```

Example:

```ts
const engine = create_engine({
  providers: { claude_cli: { auth_mode: 'oauth' } },
  defaults: {
    provider: 'claude_cli',
    model: 'sonnet',
    system: 'Reply in one short sentence. No preamble.',
    max_steps: 8,
    provider_options: {
      claude_cli: { tool_bridge: 'allowlist_only' },
    },
  },
});

// model and system are optional now:
const result = await engine.generate({ prompt: 'hello' });
```

### How per-call options win over defaults

| Field                                                                              | Rule                                            |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| `model`                                                                            | per-call wins; else default; else throws `model_required_error` |
| `provider`                                                                         | per-call wins; else default; else sole provider; else `anthropic` |
| `system`, `effort`, `max_steps`, `turn_timeout_ms`, `tool_error_policy`, `schema_repair_attempts`, `tool_call_repair_attempts`, `max_tool_calls_per_step` | per-call wins via nullish coalesce |
| `retry`                                                                            | per-call replaces wholesale                     |
| `provider_options`                                                                 | two-level: per-provider key, shallow-merged     |
| `prepare_step`, `prompt`, `tools`, `schema`, `abort`, `trajectory`, `on_chunk`     | not defaultable; always call-supplied           |

Two-level merge for `provider_options` means the outer key is the provider name and each inner record is shallow-merged. Deeper structures replace wholesale.

```ts
// defaults:    { anthropic: { thinking: { type: 'enabled', budget_tokens: 5000 } } }
// per-call:    { anthropic: { extra_header: 'x' } }
// effective:   { anthropic: { thinking: { type: 'enabled', budget_tokens: 5000 }, extra_header: 'x' } }

// per-call replacing an inner key:
// defaults:    { anthropic: { thinking: { ... budget_tokens: 5000 } } }
// per-call:    { anthropic: { thinking: { type: 'enabled', budget_tokens: 20000 } } }
// effective:   { anthropic: { thinking: { type: 'enabled', budget_tokens: 20000 } } }  // wholesale replace of `thinking`
```

The legacy top-level `default_retry`, `default_effort`, and `default_max_steps` still work. Prefer `defaults: { ... }` for new code.

## Retry policy

Retries apply only to provider-side failures — 429 rate limits, 5xx errors, and network failures. The default:

```ts
const DEFAULT_RETRY: RetryPolicy = {
  max_attempts: 3,
  initial_delay_ms: 500,
  max_delay_ms: 30_000,
  retry_on: ['rate_limit', 'provider_5xx', 'network'],
};
```

Override per-engine or per-call:

```ts
const engine = create_engine({
  providers: { anthropic: { api_key } },
  defaults: {
    retry_policy: {
      max_attempts: 5,
      initial_delay_ms: 250,
      max_delay_ms: 10_000,
      retry_on: ['rate_limit'],
    },
  },
});

await engine.generate({
  prompt: '...',
  retry: { max_attempts: 1, initial_delay_ms: 0, max_delay_ms: 0, retry_on: [] },
});
```

Rules:

- Backoff is exponential with jitter (`initial_delay_ms * 2^attempt + jitter`), capped at `max_delay_ms` — except when the server returns `Retry-After`, which always wins.
- Abort interrupts backoff waits and throws `aborted_error`.
- Streaming calls do **not** retry past the first delivered chunk. The orchestrator enforces that boundary.
- Exhaustion throws `rate_limit_error` (for 429s) or `provider_error` (for 5xx / network). Both include `.attempts`.

## Turn timeout budgets

`turn_timeout_ms` puts a per-turn wall-clock budget on every depth-1 model turn. The engine composes a timeout signal with your `abort` around each `invoke_turn`, so it protects both the `ai_sdk` and `native` transports (and local runtimes that hang), without any adapter owning the deadline:

```ts
const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY! } },
  defaults: { turn_timeout_ms: 60_000 },   // engine-wide default
});

await engine.generate({
  prompt: '...',
  turn_timeout_ms: 15_000,                 // per-call override (wins over the default)
});
```

- **Scope is one turn, not the whole call.** A multi-step tool loop resets the budget for each turn; the option bounds any single model round-trip, not the aggregate run. Wrap the whole call in your own `AbortSignal` (or the `timeout` composer) if you need a call-level ceiling.
- **Expiry is a typed, retryable timeout.** Before any chunk streams, expiry throws a timeout the shared classifier treats as retryable, so the retry policy re-attempts it exactly like a 5xx.
- **Mid-stream expiry does not retry.** Once chunks have flowed, a timeout becomes a non-retryable stream interruption, matching the same first-chunk boundary the retry policy enforces.
- **Must be `> 0`.** `undefined` (the default) leaves turns unbounded; `defaults.turn_timeout_ms` sets the baseline and the per-call value wins via nullish coalesce.

## Reshaping each turn: `prepare_step`

`prepare_step` is a per-turn hook the tool loop calls before each model turn, on both depth-1 transports. It receives the step index and the would-be request messages (the full accumulated transcript at that point) and may return replacement messages to prune, summarize, or window what is sent to the model for that turn only:

```ts
await engine.generate({
  prompt: '...',
  tools,
  max_steps: 20,
  prepare_step: ({ step_index, messages }) => {
    // Keep the system/first message plus a sliding window of the last 10.
    if (messages.length <= 12) return undefined;   // no-op
    return { messages: [messages[0], ...messages.slice(-10)] };
  },
});
```

- **The canonical transcript is untouched.** Returned messages reshape only what that one turn sends to the model; the history the loop appends to (and the trajectory) keeps the real transcript, so salvage, approval, `Tool.ends_turn`, and schema-repair keep operating on the true history.
- **Return `undefined` for a no-op.** Returning `undefined`, or an object without `messages`, leaves the turn's request unchanged.
- **Every replaced turn is legible.** A `step_prepared` trajectory event records each turn the hook modified, so mid-loop pruning stays visible in the trajectory.
- **Sync or async.** The hook may return a promise; the loop awaits it before dispatching the turn.
- **Not defaultable.** `prepare_step` is call-supplied only (it is not on `EngineDefaults`). Per-step model/effort switching is deliberately out of scope for now.

## `generate` options

The full per-call surface:

```ts
type GenerateOptions<t = string> = {
  model?: string;
  provider?: string;
  prompt: string | Message[];
  system?: string;
  schema?: z.ZodType<t>;
  tools?: Tool[];
  effort?: EffortLevel;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  max_steps?: number;
  turn_timeout_ms?: number;
  abort?: AbortSignal;
  trajectory?: TrajectoryLogger;
  on_chunk?: (chunk: StreamChunk) => void | Promise<void>;
  retry?: RetryPolicy;
  tool_error_policy?: 'feed_back' | 'throw';
  schema_repair_attempts?: number;
  tool_call_repair_attempts?: number;
  max_tool_calls_per_step?: number;
  on_tool_approval?: ToolApprovalHandler;
  prepare_step?: PrepareStepHook;
  provider_options?: Record<string, unknown>;
};
```

A few highlights:

- `effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'` is translated per-provider. See [providers.md](./providers.md) for the per-provider mapping. Providers that do not support reasoning effort (e.g. Ollama) silently drop it and record `effort_ignored` on the trajectory.
- `schema` is a zod schema. On failure, the engine attempts `schema_repair_attempts` repair passes (default 1) before throwing `schema_validation_error`.
- `tools` is the agentic tool-use surface; tools have zod `input_schema` and an `execute` closure. See the cookbook for tool loops.
- `turn_timeout_ms` bounds each model turn's wall-clock; expiry throws a retryable timeout. See [Turn timeout budgets](#turn-timeout-budgets).
- `prepare_step` reshapes the messages sent to the model before each turn without mutating the transcript. See [Reshaping each turn: `prepare_step`](#reshaping-each-turn-prepare_step).
- `provider_options` is a two-level record keyed by provider name, merged over `defaults.provider_options`.

### Local-runtime tool reliability

Local runtimes (Ollama's native API, LM Studio's `/v1`) frequently mis-serialize tool definitions, so the model writes its tool call into the assistant text instead of the structured `tool_calls` array. Two opt-in options make agentic tool loops survivable there. Both are provider-agnostic and default to off, so they never change behavior unless you set them.

- `tool_call_repair_attempts` (default `0`) budgets salvage passes. When a step returns text but no structured calls, the engine scans the text for a call in Hermes (`<tool_call>{...}</tool_call>`), bare/`json`-fenced (`{"name":..., "arguments":{...}}`), or Qwen3-Coder XML form. A candidate runs only if its name resolves in that call's tools **and** its arguments validate against the tool's `input_schema`, so an ordinary answer that merely contains JSON never triggers it. A salvaged call runs the normal execute path and is marked `salvaged` on its `ToolCallRecord` (with `salvaged_format`) and via a `tool_call_salvaged` trajectory event. The budget is shared across the whole `generate` call, including schema-repair passes.
- `max_tool_calls_per_step` (default unlimited, must be `>= 1`) executes only the first N calls of a step and drops the rest for that turn; the model can re-issue them next turn. Dropped calls surface as `ToolCallRecord`s with `error.message: 'dropped_max_tool_calls_per_step'` and a `tool_calls_dropped` event. Set it to `1` for runtimes that mishandle parallel tool calls.

A third lever lives on the tool itself rather than in `generate` options: flag a designated `finish` tool `ends_turn: true` and a successful call to it ends the loop deterministically instead of feeding the result back for another model turn. This turns a soft `finish` convention into a hard stop, which matters most for weak local models that otherwise waste a turn (or fail to stop). A denied, invalid, dropped, or throwing terminal call does not end the loop; only a successful one does, and it wins over a coincident `max_steps` cap. See the [cookbook](./cookbook.md#tool-loops).

Recommended local preset:

```ts
await engine.generate({
  prompt: '...',
  tools,
  tool_call_repair_attempts: 2,
  max_tool_calls_per_step: 1,
});
```

External-kind providers (`claude_cli`) do not run the shared tool loop, so they ignore both options and record `option_ignored` for each.

## OpenTelemetry

fascicle exposes OpenTelemetry in two independent layers with a clean seam between them. Both are opt-in and neither pulls an OTel package into a program that does not use it.

### Layer 1: the `fascicle/otel` trajectory bridge (transport-neutral)

`fascicle/otel` turns the engine's own trajectory (spans + events) into OpenTelemetry spans. Because it rides the events the engine already emits, it produces traces for **every** transport — `ai_sdk`, `native`, and `external` alike — with no AI SDK involvement. It takes `@opentelemetry/api` as an optional peer, and it lives on its own subpath so importing `fascicle` pulls in zero OTel packages; only `import 'fascicle/otel'` does.

```bash
pnpm add @opentelemetry/api
```

```ts
import { create_otel_trajectory_logger } from 'fascicle/otel';

// A plain TrajectoryLogger — pass it wherever a trajectory is accepted.
const trajectory = create_otel_trajectory_logger();
// resolves against whatever global TracerProvider your host has registered;
// pass { tracer } to target a specific one, or { attribute_prefix } to change
// the default `fascicle.` attribute namespace.

await engine.generate({ prompt: '...', trajectory });
```

The bridge maps the `engine.generate` span to an OTel root span, each step to a child span, and every recorded event (tool_call, tool_result, cost, ...) to a span event on the open span. `dispose()` is not required; spans end as the trajectory closes them.

### Layer 2: `ai_sdk` transport telemetry (turn-internal)

For turn-internal detail on the `ai_sdk` transport only, opt into `@ai-sdk/otel` via `defaults.ai_sdk_telemetry`. This instruments the single `generateText` / `streamText` call below the turn seam; native transports ignore it (their loop-level story is Layer 1).

```bash
pnpm add @ai-sdk/otel
```

```ts
const engine = create_engine({
  providers: { openai: { api_key: process.env.OPENAI_API_KEY! } },
  defaults: {
    ai_sdk_telemetry: {
      enabled: true,
      function_id: 'my-agent',      // optional label
      record_inputs: false,         // default true; turn off to keep prompts out of spans
      record_outputs: false,
    },
  },
});
```

The two layers compose: run Layer 1 for a transport-neutral trace of the whole loop, and enable Layer 2 for extra spans inside `ai_sdk` turns. `AiSdkTelemetrySettings` is exported from `fascicle` for typing the settings object; `create_otel_trajectory_logger` and `OtelTrajectoryLoggerOptions` are exported from `fascicle/otel`. The full rationale for why `@ai-sdk/otel` is adopted only below the seam is in the [agent-layer boundary ADR](../research/explorations/2026-07-ai-sdk-agent-layer-boundary.md).

## Lifecycle

```ts
const engine = create_engine(config);
try {
  const out = await engine.generate({ ... });
} finally {
  await engine.dispose();
}
```

- Construct once per process (or per HTTP request for server harnesses with per-request providers).
- `dispose()` is idempotent; calling it twice returns the same promise.
- After `dispose()`, every `generate` throws `engine_disposed_error`.
- `dispose()` is awaited on every adapter that defines one: `claude_cli` aborts its in-flight subprocesses; a custom native adapter can tear down connection pools the same way. Adapters without a `dispose` need no extra teardown.

## Examples

Minimal Anthropic:

```ts
import { create_engine } from 'fascicle';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY! } },
});
```

Multi-provider with defaults:

```ts
const engine = create_engine({
  providers: {
    anthropic: { api_key: process.env.ANTHROPIC_API_KEY! },
    openai:    { api_key: process.env.OPENAI_API_KEY! },
    ollama:    { base_url: 'http://localhost:11434' },
  },
  defaults: {
    model: 'sonnet',
    effort: 'low',
    max_steps: 8,
    retry_policy: { max_attempts: 5, initial_delay_ms: 250, max_delay_ms: 10_000, retry_on: ['rate_limit', 'provider_5xx'] },
  },
});
```

Local-only, no network:

```ts
const engine = create_engine({
  providers: {
    ollama:   { base_url: 'http://localhost:11434' },
    lmstudio: { base_url: 'http://localhost:1234' },
  },
  defaults: { provider: 'ollama', model: 'llama3.2:3b' },
});
```

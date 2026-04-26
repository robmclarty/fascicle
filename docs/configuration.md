# Configuration

Configuring the engine layer: `create_engine(config)`, aliases, pricing, defaults, retry policy, and how per-call options merge over engine defaults.

## The config shape

```ts
type EngineConfig = {
  providers: ProviderConfigMap;
  aliases?: AliasTable;
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

`providers` is a name-keyed map of provider inits. The seven built-in names:

```ts
type ProviderConfigMap = {
  anthropic?:   { api_key: string; base_url?: string };
  openai?:      { api_key: string; base_url?: string; organization?: string };
  google?:      { api_key: string; base_url?: string };
  ollama?:      { base_url: string };
  lmstudio?:    { base_url: string };
  openrouter?:  { api_key: string; base_url?: string; http_referer?: string; x_title?: string };
  claude_cli?:  ClaudeCliProviderConfig;
};
```

A provider absent from `providers` throws `provider_not_configured_error` at call time — constructing an engine without a provider does not fail; the failure is deferred to the first `generate` against it.

Every provider's SDK is an optional peer dependency, loaded on first `generate`. Install only the ones you use.

```bash
# install peers as needed
pnpm add @ai-sdk/anthropic
pnpm add @ai-sdk/openai
pnpm add @ai-sdk/google
pnpm add @ai-sdk/openai-compatible  # openrouter
pnpm add ai-sdk-ollama
pnpm add @ai-sdk/openai-compatible  # lmstudio
# claude_cli has no peer; it spawns the `claude` binary
```

Full per-provider notes live in [providers.md](./providers.md). The `claude_cli` adapter has its own guide: [cli.md](./cli.md).

## Reading credentials from env

The engine does not read `process.env`. That is the job of `@repo/config`, the one workspace package allowed to touch the environment. The idiomatic pattern is to build the config from config-layer getters at the boundary of your harness:

```ts
import {
  get_anthropic_api_key,
  get_openai_api_key,
  get_ollama_base_url,
} from '@repo/config';
import { create_engine } from 'fascicle';

const anthropic_key = get_anthropic_api_key();
const openai_key    = get_openai_api_key();
const ollama_url    = get_ollama_base_url() ?? 'http://localhost:11434';

const engine = create_engine({
  providers: {
    ...(anthropic_key ? { anthropic: { api_key: anthropic_key } } : {}),
    ...(openai_key    ? { openai:    { api_key: openai_key    } } : {}),
    ollama: { base_url: ollama_url },
  },
});
```

Consumers of `fascicle` can replicate the pattern directly against `process.env`; they are not bound by the workspace's `no-process-env` rule. The rule exists to keep the published library free of ambient env reads, not to dictate how you wire your own harness.

## Aliases

An alias maps a short name to a concrete `{ provider, model_id }`. `DEFAULT_ALIASES` ship with the engine:

```text
claude-opus   -> anthropic:claude-opus-4-7
opus          -> anthropic:claude-opus-4-7
claude-sonnet -> anthropic:claude-sonnet-4-6
sonnet        -> anthropic:claude-sonnet-4-6
claude-haiku  -> anthropic:claude-haiku-4-5
haiku         -> anthropic:claude-haiku-4-5

cli-opus      -> claude_cli:claude-opus-4-7
cli-sonnet    -> claude_cli:claude-sonnet-4-6
cli-haiku     -> claude_cli:claude-haiku-4-5

gpt-4o        -> openai:gpt-4o
gpt-4o-mini   -> openai:gpt-4o-mini

gemini-2.5-pro   -> google:gemini-2.5-pro
gemini-2.5-flash -> google:gemini-2.5-flash
gemini-pro       -> google:gemini-2.5-pro
gemini-flash     -> google:gemini-2.5-flash

or:sonnet        -> openrouter:anthropic/claude-sonnet-4.5
or:opus          -> openrouter:anthropic/claude-opus-4.1
or:gpt-4o        -> openrouter:openai/gpt-4o
or:gemini-pro    -> openrouter:google/gemini-2.5-pro
or:llama-3.3-70b -> openrouter:meta-llama/llama-3.3-70b-instruct
```

Override or extend at construction, or per-engine at runtime:

```ts
const engine = create_engine({
  providers: { anthropic: { api_key } },
  aliases: {
    'fast':     { provider: 'anthropic', model_id: 'claude-haiku-4-5' },
    'thinker':  { provider: 'anthropic', model_id: 'claude-opus-4-7', defaults: { effort: 'high' } },
  },
});

engine.register_alias('codegen', { provider: 'openai', model_id: 'gpt-4o' });
engine.unregister_alias('codegen');
```

### Resolution rules

`resolve_model(table, model)` runs on every `generate`:

1. If `model` contains a colon and the prefix matches a known provider name, split on the first colon: `openrouter:anthropic/claude-sonnet-4.5` resolves to `{ provider: 'openrouter', model_id: 'anthropic/claude-sonnet-4.5' }`. This preserves the upstream `provider/model` separator for OpenRouter.
2. Otherwise look up `model` in the alias table.
3. Otherwise throw `model_not_found_error` with the list of registered aliases.

Known provider prefixes: `anthropic`, `openai`, `google`, `ollama`, `lmstudio`, `openrouter`, `claude_cli`.

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

Default pricing ships for the models referenced by `DEFAULT_ALIASES`. Override and extend:

```ts
const engine = create_engine({
  providers: { ... },
  pricing: {
    'anthropic:claude-opus-4-7': {
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
  system?: string;
  effort?: EffortLevel;
  max_steps?: number;
  retry_policy?: RetryPolicy;
  tool_error_policy?: 'feed_back' | 'throw';
  schema_repair_attempts?: number;
  provider_options?: Record<string, Record<string, unknown>>;
};
```

Example:

```ts
const engine = create_engine({
  providers: { claude_cli: { auth_mode: 'oauth' } },
  defaults: {
    model: 'cli-sonnet',
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
| `model`                                                                            | per-call wins; else default; else throw         |
| `system`, `effort`, `max_steps`, `tool_error_policy`, `schema_repair_attempts`     | per-call wins via nullish coalesce              |
| `retry`                                                                            | per-call replaces wholesale                     |
| `provider_options`                                                                 | two-level: per-provider key, shallow-merged     |
| `prompt`, `tools`, `schema`, `abort`, `trajectory`, `on_chunk`                     | not defaultable; always call-supplied           |

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

## `generate` options

The full per-call surface:

```ts
type GenerateOptions<t = string> = {
  model?: string;
  prompt: string | Message[];
  system?: string;
  schema?: z.ZodType<t>;
  tools?: Tool[];
  effort?: EffortLevel;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  max_steps?: number;
  abort?: AbortSignal;
  trajectory?: TrajectoryLogger;
  on_chunk?: (chunk: StreamChunk) => void | Promise<void>;
  retry?: RetryPolicy;
  tool_error_policy?: 'feed_back' | 'throw';
  schema_repair_attempts?: number;
  on_tool_approval?: ToolApprovalHandler;
  provider_options?: Record<string, unknown>;
};
```

A few highlights:

- `effort: 'none' | 'low' | 'medium' | 'high'` is translated per-provider. See [providers.md](./providers.md) for the per-provider mapping. Providers that do not support reasoning effort (e.g. Ollama) silently drop it and record `effort_ignored` on the trajectory.
- `schema` is a zod schema. On failure, the engine attempts `schema_repair_attempts` repair passes (default 1) before throwing `schema_validation_error`.
- `tools` is the agentic tool-use surface; tools have zod `input_schema` and an `execute` closure. See the cookbook for tool loops.
- `provider_options` is a two-level record keyed by provider name, merged over `defaults.provider_options`.

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
- Subprocess providers (`claude_cli`) abort every in-flight subprocess on dispose. SDK providers have no extra teardown.

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
  defaults: { model: 'ollama:llama3.2:3b' },
});
```

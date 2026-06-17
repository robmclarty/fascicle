# Providers

Per-provider adapter notes: installation, capabilities, credentials, effort mapping, and gotchas.

Eight adapters ship with the engine layer:

| Name          | Kind        | Peer dep                      | Credentials required     |
| ------------- | ----------- | ----------------------------- | ------------------------ |
| `anthropic`   | AI SDK      | `@ai-sdk/anthropic`           | `api_key`                |
| `openai`      | AI SDK      | `@ai-sdk/openai`              | `api_key`                |
| `google`      | AI SDK      | `@ai-sdk/google`              | `api_key`                |
| `openrouter`  | AI SDK      | `@openrouter/ai-sdk-provider` | `api_key`                |
| `bedrock`     | AI SDK      | `@ai-sdk/amazon-bedrock`      | `region` + AWS creds     |
| `ollama`      | AI SDK      | `ai-sdk-ollama`               | none, `base_url` only    |
| `lmstudio`    | AI SDK      | `@ai-sdk/openai-compatible`   | none, `base_url` only    |
| `claude_cli`  | subprocess  | none (spawns `claude`)        | `oauth` session or key   |

The seven AI SDK adapters wrap Vercel's AI SDK. The eighth, `claude_cli`, spawns the `claude` binary and parses its `--output-format stream-json` stream. See [cli.md](./cli.md) for the full `claude_cli` guide.

## Capability matrix

| Provider     | text | tools | schema | streaming | image_input | reasoning |
| ------------ | ---- | ----- | ------ | --------- | ----------- | --------- |
| anthropic    | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| openai       | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| google       | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| openrouter   | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| bedrock      | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| ollama       | ✅   | ✅    | ✅     | ✅        | —           | —         |
| lmstudio     | ✅   | ✅    | ✅     | ✅        | —           | —         |
| claude_cli   | ✅   | ✅    | ✅     | ✅        | —           | —         |

`supports(capability)` on any adapter reflects this table.

## Effort translation

`effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'` is a provider-neutral knob for reasoning depth. The table shows `low`/`medium`/`high`; `xhigh` and `max` extend the same axis (see the note below). The engine translates it per provider:

| Provider     | `low`     | `medium`  | `high`    | When unsupported                     |
| ------------ | --------- | --------- | --------- | ------------------------------------ |
| anthropic    | `budgetTokens: 1024`  | `budgetTokens: 5000`  | `budgetTokens: 20000` | —                                    |
| openai       | `reasoningEffort: low` | `reasoningEffort: medium` | `reasoningEffort: high` | non-reasoning models silently drop it |
| google       | `thinkingBudget: 1024`  | `thinkingBudget: 8192`  | `thinkingBudget: 24576` | —                                  |
| openrouter   | `reasoning.effort: low` | `reasoning.effort: medium` | `reasoning.effort: high` | upstream model drops it             |
| bedrock      | `budgetTokens: 1024`  | `budgetTokens: 5000`  | `budgetTokens: 20000` | non-reasoning models drop it         |
| ollama       | dropped   | dropped   | dropped   | records `effort_ignored` on trajectory |
| lmstudio     | dropped   | dropped   | dropped   | records `effort_ignored` on trajectory |
| claude_cli   | dropped   | dropped   | dropped   | not forwarded to the CLI             |

`xhigh` and `max` raise the ceiling: anthropic and bedrock use `budgetTokens: 32000` and `64000`; google maps both to `thinkingBudget: 32768` (the Gemini 2.5 Pro ceiling); openai clamps both to `reasoningEffort: high`; openrouter forwards the level verbatim.

`effort: 'none'` forwards nothing: anthropic emits no thinking block and google omits `thinkingConfig` entirely.

## anthropic

```bash
pnpm add @ai-sdk/anthropic
```

```ts
import { create_engine } from 'fascicle';

const engine = create_engine({
  providers: {
    anthropic: {
      api_key: process.env.ANTHROPIC_API_KEY!,
      base_url: process.env.ANTHROPIC_BASE_URL, // optional
    },
  },
});

await engine.generate({
  model: 'claude-sonnet-4-6',     // or 'claude-opus-4-8', 'claude-haiku-4-5', ...
  system: 'Be terse.',
  prompt: 'say hi',
  effort: 'medium',               // thinking budget 5000 tokens
});
```

Effort maps to extended-thinking `budgetTokens` (the `@ai-sdk/anthropic` option name, which the SDK forwards to the API's `budget_tokens`). `none →` no thinking block, `low → 1024`, `medium → 5000`, `high → 20000`, `xhigh → 32000`, `max → 64000`.

Pass a concrete model id (`claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`, …). fascicle does not expand `opus`/`sonnet` shorthands on this transport — the `model` string is sent to the API verbatim.

## openai

```bash
pnpm add @ai-sdk/openai
```

```ts
const engine = create_engine({
  providers: {
    openai: {
      api_key: process.env.OPENAI_API_KEY!,
      base_url: process.env.OPENAI_BASE_URL,     // optional (e.g. Azure proxy)
      organization: process.env.OPENAI_ORGANIZATION,
    },
  },
});
```

Effort maps to OpenAI's `reasoningEffort: 'low' | 'medium' | 'high'`. Non-reasoning models silently drop it.

Pass a concrete model id like `gpt-4o` or `gpt-4o-mini`. The `model` string is sent to the API verbatim.

## google

```bash
pnpm add @ai-sdk/google
```

```ts
const engine = create_engine({
  providers: {
    google: {
      api_key: process.env.GOOGLE_API_KEY!,
      base_url: process.env.GOOGLE_BASE_URL,
    },
  },
});
```

Effort maps to Gemini's `thinkingConfig.thinkingBudget`, a token count: `low → 1024`, `medium → 8192`, `high → 24576`, `xhigh`/`max → 32768`. Google does not report cache-write tokens; the adapter strips `cache_write_tokens` when absent.

Pass a concrete model id like `gemini-2.5-pro` or `gemini-2.5-flash`. The `model` string is sent to the API verbatim.

## openrouter

```bash
pnpm add @openrouter/ai-sdk-provider
```

```ts
const engine = create_engine({
  providers: {
    openrouter: {
      api_key: process.env.OPENROUTER_API_KEY!,
      base_url: process.env.OPENROUTER_BASE_URL,
      http_referer: 'https://your-app.example.com', // sent as HTTP-Referer
      x_title: 'your-app',                           // sent as X-Title
    },
  },
});

await engine.generate({
  provider: 'openrouter',
  model: 'anthropic/claude-sonnet-4.5',
  prompt: 'hi',
});
```

Model ids use the `provider/model` slug OpenRouter expects (e.g. `anthropic/claude-sonnet-4.5`); pass it as `model` with `provider: 'openrouter'`. Effort maps to the OpenRouter `reasoning.effort` field; whether the upstream honours it depends on the model.

Pass the full OpenRouter slug as `model` with `provider: 'openrouter'` — e.g. `{ provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct' }`.

## bedrock

```bash
pnpm add @ai-sdk/amazon-bedrock
```

Reaches Anthropic, Llama, Nova, and other models hosted on AWS Bedrock through the official AI SDK provider.

```ts
const engine = create_engine({
  providers: {
    bedrock: {
      region: process.env.BEDROCK_REGION ?? process.env.AWS_REGION!,
      // pick ONE auth path, or omit all of them for the ambient AWS credential chain:
      api_key: process.env.AWS_BEARER_TOKEN_BEDROCK,        // Bedrock API key (bearer); wins over SigV4
      access_key_id: process.env.AWS_ACCESS_KEY_ID,         // SigV4
      secret_access_key: process.env.AWS_SECRET_ACCESS_KEY,
      session_token: process.env.AWS_SESSION_TOKEN,         // optional, for temporary creds
    },
  },
});

await engine.generate({
  provider: 'bedrock',
  model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',  // region-prefixed inference profile
  prompt: 'say hi',
  effort: 'low',
});
```

`region` is required (set it explicitly or via `BEDROCK_REGION` / `AWS_REGION`); the adapter throws `engine_config_error` without one. Credentials are optional: supply an `api_key` (Bedrock bearer token, which takes precedence), SigV4 keys (`access_key_id` + `secret_access_key`, plus an optional `session_token`), or omit all of them to use the ambient AWS credential chain (env vars, shared config, instance/role providers).

Model ids are AWS Bedrock ids passed verbatim — on-demand ids like `anthropic.claude-3-5-sonnet-20241022-v2:0` or cross-region inference profiles like `us.anthropic.claude-sonnet-4-20250514-v1:0`. The trailing `:0` version suffix rides through untouched. Effort maps to the Bedrock `reasoningConfig.budgetTokens` field for Claude models (the same budgets as the `anthropic` adapter); models without reasoning drop it.

No default pricing ships for Bedrock (ids are region- and profile-specific). Add your own with `engine.register_price('bedrock', '<model-id>', { ... })`; until then cost is omitted, not an error.

## ollama

```bash
pnpm add ai-sdk-ollama
```

Local only. Requires Ollama running and the model pulled.

```ts
const engine = create_engine({
  providers: {
    ollama: { base_url: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434' },
  },
});

await engine.generate({
  provider: 'ollama',
  model: 'llama3.2:3b',          // the exact tag you pulled, colons and all
  prompt: 'write a haiku',
});
```

No API key; `base_url` is required (the adapter throws `engine_config_error` otherwise). No reasoning support — `effort` is silently dropped and the trajectory records `effort_ignored`. No image input in v1. Cache tokens are stripped from usage — local models do not report them.

## lmstudio

```bash
pnpm add @ai-sdk/openai-compatible
```

LM Studio exposes an OpenAI-compatible server on a local port.

```ts
const engine = create_engine({
  providers: {
    lmstudio: { base_url: 'http://localhost:1234' },
  },
});

await engine.generate({
  provider: 'lmstudio',
  model: 'qwen2.5-coder-7b-instruct',
  prompt: 'refactor this function',
});
```

Same constraints as Ollama: no API key, `base_url` required, no reasoning, no image input, cache tokens stripped.

## claude_cli

Spawns the `claude` binary and piggybacks on your local authenticated session.

```ts
const engine = create_engine({
  providers: {
    claude_cli: { auth_mode: 'oauth' },   // default is 'auto'; explicit is clearer
  },
  defaults: { provider: 'claude_cli', model: 'sonnet' },
});

await engine.generate({ prompt: 'say hi' });
```

Full guide: [cli.md](./cli.md).

The CLI resolves the bare tokens `opus`/`sonnet`/`haiku` to the latest itself, so passing one as `model` works for this transport — the single place a short name is honored. Concrete ids pass through too.

## Model and provider resolution

`model` is an opaque string sent to the provider verbatim as its `model_id`; `provider` names the transport. Both can be set per call and as engine `defaults`. There is no resolution step — no colon shorthand, no family expansion, no alias table:

- `provider` resolves to: per-call `provider`, else `defaults.provider`, else the sole configured provider, else `anthropic`.
- `model` resolves to: per-call `model`, else `defaults.model`, else a thrown `model_required_error`.

The provider receives `model` as-is and rejects an unknown id itself (a 404 or validation error). A `provider` with no adapter registered on the engine throws `provider_not_configured_error`. (Exception: the `claude_cli` transport forwards `opus`/`sonnet`/`haiku` to the CLI, which resolves them to the latest.)

Need short names? Keep a plain `Record<string, string>` in your own code and resolve it before calling `generate` — fascicle owns no model-name catalog.

## Optional peer loading

Every peer is loaded lazily on first `generate` against that provider. Missing peers throw a descriptive error at call time, not at construction:

```text
Error: optional peer '@ai-sdk/anthropic' is not installed. Install it with
  `pnpm add @ai-sdk/anthropic`
or exclude the anthropic provider from create_engine(config).providers.
```

This means constructing an engine with seven providers does not force you to install seven SDKs — only the ones you actually call.

## Usage normalization

Every adapter normalizes its provider's raw usage into a consistent `UsageTotals`:

```ts
type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
};
```

Fields that a provider cannot report are absent from the result (not zero). `GenerateResult.usage` is the sum across all steps; per-step totals live in `steps[i].usage`.

## Cost estimation

`GenerateResult.cost` is populated when the resolved `provider:model_id` has a pricing row in the engine's `PricingTable`. Missing rows simply omit `cost` — the run does not fail. `is_estimate: true` is always set; pricing tables drift, treat the number as a budget signal, not an invoice.

## Writing your own

The adapter contract is small. To add a custom AI SDK provider:

1. Implement the `AiSdkProviderAdapter` shape (see `src/engine/providers/types.ts`).
2. Register a factory in the local registry of your fork, or add one to `BUILTIN_PROVIDERS` if contributing upstream.
3. Add capability flags (`SUPPORTED`) and an `effort` translation.
4. Export an `engine_config_error` on missing credentials.

Runtime provider registration beyond the built-in set is deferred per spec §5.9 — if you need it, open an issue.

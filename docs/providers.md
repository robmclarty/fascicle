# Providers

Per-provider adapter notes: installation, capabilities, credentials, effort mapping, and gotchas.

Seven adapters ship with the engine layer:

| Name          | Kind        | Peer dep                      | Credentials required     |
| ------------- | ----------- | ----------------------------- | ------------------------ |
| `anthropic`   | AI SDK      | `@ai-sdk/anthropic`           | `api_key`                |
| `openai`      | AI SDK      | `@ai-sdk/openai`              | `api_key`                |
| `google`      | AI SDK      | `@ai-sdk/google`              | `api_key`                |
| `openrouter`  | AI SDK      | `@openrouter/ai-sdk-provider` | `api_key`                |
| `ollama`      | AI SDK      | `ai-sdk-ollama`               | none, `base_url` only    |
| `lmstudio`    | AI SDK      | `@ai-sdk/openai-compatible`   | none, `base_url` only    |
| `claude_cli`  | subprocess  | none (spawns `claude`)        | `oauth` session or key   |

The six AI SDK adapters wrap Vercel's AI SDK. The seventh, `claude_cli`, spawns the `claude` binary and parses its `--output-format stream-json` stream. See [cli.md](./cli.md) for the full `claude_cli` guide.

## Capability matrix

| Provider     | text | tools | schema | streaming | image_input | reasoning |
| ------------ | ---- | ----- | ------ | --------- | ----------- | --------- |
| anthropic    | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| openai       | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| google       | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| openrouter   | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| ollama       | ✅   | ✅    | ✅     | ✅        | —           | —         |
| lmstudio     | ✅   | ✅    | ✅     | ✅        | —           | —         |
| claude_cli   | ✅   | ✅    | ✅     | ✅        | —           | —         |

`supports(capability)` on any adapter reflects this table.

## Effort translation

`effort: 'none' | 'low' | 'medium' | 'high'` is a provider-neutral knob for reasoning depth. The engine translates it per provider:

| Provider     | `low`     | `medium`  | `high`    | When unsupported                     |
| ------------ | --------- | --------- | --------- | ------------------------------------ |
| anthropic    | `budget_tokens: 1024`  | `budget_tokens: 5000`  | `budget_tokens: 20000` | —                                    |
| openai       | `reasoningEffort: low` | `reasoningEffort: medium` | `reasoningEffort: high` | non-reasoning models silently drop it |
| google       | `thinkingBudget: low`  | `thinkingBudget: medium`  | `thinkingBudget: high`  | —                                    |
| openrouter   | `reasoning.effort: low` | `reasoning.effort: medium` | `reasoning.effort: high` | upstream model drops it             |
| ollama       | dropped   | dropped   | dropped   | records `effort_ignored` on trajectory |
| lmstudio     | dropped   | dropped   | dropped   | records `effort_ignored` on trajectory |
| claude_cli   | dropped   | dropped   | dropped   | not forwarded to the CLI             |

`effort: 'none'` forwards nothing. Anthropic's `budget_tokens: 0` also short-circuits to no thinking block.

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
  model: 'sonnet',                // or 'opus', 'claude-sonnet-4-6', 'claude-opus-4-8', ...
  system: 'Be terse.',
  prompt: 'say hi',
  effort: 'medium',               // thinking budget 5000 tokens
});
```

Effort maps to extended-thinking `budget_tokens`. `none → 0`, `low → 1024`, `medium → 5000`, `high → 20000`.

Aliases: `opus`, `claude-opus`, `sonnet`, `claude-sonnet`, `haiku`, `claude-haiku`.

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

Aliases: `gpt-4o`, `gpt-4o-mini`.

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

Effort maps to Gemini's `thinkingConfig.thinkingBudget: 'low' | 'medium' | 'high'`. Google does not report cache-write tokens; the adapter strips `cache_write_tokens` when absent.

Aliases: `gemini-pro` (= `gemini-2.5-pro`), `gemini-flash` (= `gemini-2.5-flash`), and their fully-qualified forms.

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
  model: 'openrouter:anthropic/claude-sonnet-4.5',
  prompt: 'hi',
});
```

Model ids use the `provider/model` separator OpenRouter expects. The engine splits only on the first colon so the inner slash round-trips. Effort maps to the OpenRouter `reasoning.effort` field; whether the upstream honours it depends on the model.

Families on OpenRouter: `{ model: 'opus' | 'sonnet' | 'haiku' | 'gpt' | 'gemini', provider: 'openrouter' }` resolve to the corresponding `provider/model` slug. For anything else, pass the full slug via the colon form (`openrouter:meta-llama/llama-3.3-70b-instruct`).

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
  model: 'ollama:llama3.2:3b',   // use the explicit provider prefix
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
  model: 'lmstudio:qwen2.5-coder-7b-instruct',
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

Families: `opus`, `sonnet`, `haiku` — the CLI receives the bare token and resolves the latest itself.

## Model and provider resolution

`model` names a model (a **family** like `sonnet`/`opus`/`gpt`, or a **specific id** like `claude-opus-4-8`); `provider` names the transport. Both default from `defaults` (and `provider` falls back to the sole configured provider, else `anthropic`). Per call, four shapes work:

1. **Family.** `sonnet`, `opus`, `gpt`, `gemini` → the latest id for the chosen provider. Throws `model_family_unavailable_error` if the family isn't offered by that provider.
2. **Specific id.** `claude-opus-4-8`, `gpt-4o-mini` → passed straight through to the chosen provider.
3. **Explicit `provider:model_id`.** `openai:gpt-4o-mini`, `ollama:llama3.2:3b`, `openrouter:anthropic/claude-sonnet-4.5` — sets both axes at once (split on the first colon only).
4. **Custom alias.** Any key you registered via `aliases` / `register_alias`, pinning both axes.

Unknown providers (no adapter registered on the engine) throw `provider_not_configured_error`.

## Optional peer loading

Every peer is loaded lazily on first `generate` against that provider. Missing peers throw a descriptive error at call time, not at construction:

```text
Error: optional peer '@ai-sdk/anthropic' is not installed. Install it with
  `pnpm add @ai-sdk/anthropic`
or exclude the anthropic provider from create_engine(config).providers.
```

This means constructing an engine with six providers does not force you to install six SDKs — only the ones you actually call.

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

1. Implement the `AiSdkProviderAdapter` shape (see `packages/engine/src/providers/types.ts`).
2. Register a factory in the local registry of your fork, or add one to `BUILTIN_PROVIDERS` if contributing upstream.
3. Add capability flags (`SUPPORTED`) and an `effort` translation.
4. Export an `engine_config_error` on missing credentials.

Runtime provider registration beyond the built-in set is deferred per spec §5.9 — if you need it, open an issue.

# Providers

Per-provider adapter notes: installation, capabilities, credentials, effort mapping, and gotchas.

Eight adapters ship with the engine layer:

| Name          | Kind                 | Peer dep                      | Credentials required     |
| ------------- | -------------------- | ----------------------------- | ------------------------ |
| `anthropic`   | `ai_sdk` or `native` | `@ai-sdk/anthropic` (ai_sdk only) | `api_key`            |
| `openai`      | `ai_sdk`             | `@ai-sdk/openai`              | `api_key`                |
| `google`      | `ai_sdk`             | `@ai-sdk/google`              | `api_key`                |
| `openrouter`  | `ai_sdk`             | `@openrouter/ai-sdk-provider` | `api_key`                |
| `bedrock`     | `ai_sdk`             | `@ai-sdk/amazon-bedrock`      | `region` + AWS creds     |
| `ollama`      | `ai_sdk`             | `ai-sdk-ollama`               | none, `base_url` only    |
| `lmstudio`    | `ai_sdk`             | `@ai-sdk/openai-compatible`   | none, `base_url` only    |
| `claude_cli`  | `external`           | none (spawns `claude`)        | `oauth` session or key   |

The `ai_sdk` adapters wrap Vercel's AI SDK. `anthropic` can instead run `transport: 'native'`, raw HTTP against the Messages API with no AI SDK in the path (see [`transport`](#transport-picking-a-depth-1-backend)). `claude_cli` spawns the `claude` binary and parses its `--output-format stream-json` stream; see [cli.md](./cli.md) for the full guide.

## Three integration depths

Every provider plugs into `generate` at one of three depths. The engine dispatches on the adapter's `kind`; everything above the seam (multi-step tool loop, approval, salvage, `Tool.ends_turn`, retry, cost, trajectory) is shared and identical across kinds, so a provider inherits the whole fascicle loop by implementing only its depth's contract.

| Kind       | Depth | Contract                                        | You own                          | The engine owns                                    |
| ---------- | ----- | ----------------------------------------------- | -------------------------------- | -------------------------------------------------- |
| `ai_sdk`   | 1     | `build_model`, `translate_effort`, `normalize_usage` | model construction + parameter translation | the SDK call, plus everything below |
| `native`   | 1     | `invoke_turn(TurnRequest) -> TurnResult`        | request/response mapping over raw HTTP | retry, error classification, abort, plus everything below |
| `external` | 2     | `generate(opts, resolved) -> GenerateResult`    | the entire loop                  | nothing below the call                              |

- **Depth 1, `ai_sdk` kind.** The adapter builds an AI SDK model object and translates fascicle parameters; the actual `generateText` / `streamText` call lives in one engine-internal module (`src/engine/providers/ai_sdk/invoke.ts`), the only place in the tree allowed to import from `ai` (rule-enforced). `generate.ts` itself is SDK-agnostic.
- **Depth 1, `native` kind.** The adapter implements a single model turn against the provider's own API using global `fetch` and hand-rolled streaming, with zero `ai` / `@ai-sdk/*` imports (also rule-enforced). The engine wraps `invoke_turn` in retry, shared error classification, and abort; a native adapter must never retry internally. It may override classification via an optional `classify_error`, and may define `dispose` for connection teardown.
- **Depth 2, `external` kind.** The adapter owns the whole generate call, including any looping. This is for backends that are themselves agents (the `claude_cli` subprocess today; an HTTP/A2A agent is the same shape). The engine's shared tool loop does not run, so loop-level options like `tool_call_repair_attempts` are ignored and recorded as `option_ignored`.

Both depth-1 kinds produce the same neutral `TurnResult`, which is what lets one loop serve every transport.

## `transport`: picking a depth-1 backend

Providers that implement more than one depth-1 backend expose a `transport` field on their init. Today that is `anthropic`:

```ts
const engine = create_engine({
  providers: {
    anthropic: {
      api_key: process.env.ANTHROPIC_API_KEY!,
      transport: 'native',   // 'ai_sdk' (default) | 'native'
    },
  },
});
```

The provider name stays `anthropic` across transports, so pricing keys (`anthropic:<model-id>`), usage fields, and effort mapping carry over unchanged; only the wire implementation swaps. The default is `'ai_sdk'` and any other value throws `engine_config_error` at construction. Differences that do exist on the native transport are listed under [anthropic](#anthropic) below.

## The agent-layer boundary

fascicle uses the AI SDK strictly as a single-turn provider layer: every AI SDK call is `generateText` / `streamText` pinned to one step, issued from the one `ai_sdk` transport module, and the loop above it (multi-step execution, tool approval, salvage, `ends_turn`, cost, retry, trajectory) is fascicle's own. The SDK's agent layer (`ToolLoopAgent`, `WorkflowAgent`, `HarnessAgent`, `toolApproval`, scoped tool context, `@ai-sdk/otel`) is declined by a written decision record; the litmus test is that a framework must let you call one turn below its own loop. Before reaching for any of those APIs, read the [agent-layer boundary ADR](../research/explorations/2026-07-ai-sdk-agent-layer-boundary.md).

## Capability matrix

| Provider            | text | tools | schema | streaming | image_input | reasoning |
| ------------------- | ---- | ----- | ------ | --------- | ----------- | --------- |
| anthropic           | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| anthropic (native)  | ✅   | ✅    | ✅     | ✅        | —           | ✅        |
| openai              | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| google              | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| openrouter          | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| bedrock             | ✅   | ✅    | ✅     | ✅        | ✅          | ✅        |
| ollama              | ✅   | ✅    | ✅     | ✅        | —           | —         |
| lmstudio            | ✅   | ✅    | ✅     | ✅        | —           | —         |
| claude_cli          | ✅   | ✅    | ✅     | ✅        | —           | —         |

`supports(capability)` on any adapter reflects this table. There is one more capability the table omits: `structured_output`, meaning the provider constrains decoding to the schema natively. Every provider satisfies `schema` (via the engine's prompt + parse + repair loop when the provider cannot constrain the decode); native anthropic deliberately does not claim `structured_output`, so schema requests there always ride the repair loop.

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

`xhigh` and `max` raise the ceiling: anthropic and bedrock use `budgetTokens: 32000` and `64000`; google maps both to `thinkingBudget: 32768` (the Gemini 2.5 Pro ceiling); openai clamps both to `reasoningEffort: high`; openrouter forwards the level verbatim. The anthropic budgets are shared by both transports; on `native` they are sent as the API's `thinking.budget_tokens` directly.

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

### `transport: 'native'`

Set `transport: 'native'` on the init to talk to the Messages API directly over global `fetch`, with no `@ai-sdk/anthropic` peer to install and zero AI SDK code in the path:

```ts
const engine = create_engine({
  providers: {
    anthropic: {
      api_key: process.env.ANTHROPIC_API_KEY!,
      transport: 'native',
      base_url: process.env.ANTHROPIC_BASE_URL, // optional; defaults to https://api.anthropic.com/v1
    },
  },
});
```

Everything call-facing carries over: same provider name, same pricing keys, same effort-to-budget mapping, same usage fields, and streamed results equal non-streamed results for the same input. Differences to know about:

- **No image input.** `image_input` is unsupported on the native transport in v1.
- **Schema always rides the repair loop.** The native adapter does not claim `structured_output`; `schema` requests are satisfied by the engine's prompt + parse + repair path, which is provider-neutral and usually sufficient.
- **`max_tokens` defaults to 4096.** The Messages API requires `max_tokens` on every request. When extended thinking is enabled, the default rides on top of the thinking budget rather than being swallowed by it; pass `max_tokens` explicitly to override.
- **Auth headers are `x-api-key` plus `anthropic-version`.** OAuth is not supported here; that is `claude_cli` territory.
- **Retry belongs to the engine.** 429 (honoring `retry-after`), 5xx, and network failures are classified by the shared classifier and retried by the engine's retry policy, exactly as on the `ai_sdk` transport.

The default transport stays `'ai_sdk'` until the native path has accumulated production mileage.

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

A custom provider is a `ProviderFactory`: a synchronous function that takes the init object from `providers` and returns an adapter of any kind. Register it under `custom_providers` at construction; no fork or upstream change is needed, and a private provider lives entirely in your own repo. The registration mechanics (custom-first resolution, shadow-throws, construction-time only) are documented in [configuration.md](./configuration.md#custom-providers).

Pick the kind by how much of the loop you want to inherit (see [Three integration depths](#three-integration-depths)); whichever you pick, the adapter plugs into the same `generate`, tool loop, cost accounting, and trajectory.

### `kind: 'ai_sdk'`: wrap an AI SDK community provider

Implement `build_model` (return the SDK's model object, loading the SDK lazily inside it), `translate_effort`, `normalize_usage` (the exported `default_normalize_usage` covers the standard v7 usage shape), and `supports`. A complete worked example lives in [configuration.md](./configuration.md#custom-providers).

### `kind: 'native'`: raw HTTP against a provider's own API

Implement a single model turn; the engine supplies retry, error classification, abort, streaming dispatch, and the whole tool loop above it.

```ts
import { create_engine, type ProviderFactory } from 'fascicle';

const create_acme_native: ProviderFactory = (init) => ({
  kind: 'native',
  name: 'acme',
  async invoke_turn(req) {
    // req: one resolved turn (messages, tools, model_id, system, effort,
    // sampling params, abort signal). Map it to your wire format:
    const response = await fetch('https://api.acme.dev/v1/chat', {
      method: 'POST',
      headers: { authorization: `Bearer ${init.api_key}` },
      body: JSON.stringify(to_acme_body(req)),
      signal: req.abort,
    });
    if (!response.ok) throw await to_classifiable_error(response);
    // When req.stream is true, emit StreamChunks through req.dispatch_chunk
    // as they arrive AND return the fully aggregated result.
    return from_acme_response(await response.json()); // -> { text, tool_calls, finish_reason, usage }
  },
  supports: (c) => c === 'text' || c === 'tools' || c === 'schema' || c === 'streaming',
});

const engine = create_engine({
  providers: { acme: { api_key: process.env.ACME_API_KEY ?? '' } },
  custom_providers: { acme: create_acme_native },
});
```

Rules of the road for native adapters:

- **Never retry internally.** Throw failures in classifiable shapes (`status` and `responseHeaders` for HTTP errors) and let the engine's retry policy own attempts; hidden retries are exactly the illegibility the engine refuses. An optional `classify_error(err)` overrides the shared classifier when your provider's error shapes need it.
- **Streaming means both.** When `req.stream` is true, push chunks through `req.dispatch_chunk` and still return the aggregated `TurnResult`; streamed and non-streamed results for the same input must be equal.
- **Skip `structured_output` unless you truly constrain decoding.** Claiming `schema` is enough; the engine's repair loop does the rest.
- `NativeProviderAdapter`, `TurnRequest`, and `TurnResult` are exported from `fascicle`, so you can type the adapter and its mapping helpers explicitly instead of relying on `ProviderFactory`'s contextual check.

### `kind: 'external'`: delegate to something that is already an agent

Implement `generate(opts, resolved)` returning a full `GenerateResult`, plus `dispose` and `supports` (see the exported `ExternalAgentAdapter` type). The engine hands over the entire call: your adapter owns any looping, and loop-level options like `tool_call_repair_attempts` do not apply. The in-tree reference is the `claude_cli` adapter.

Runtime (post-construction) provider registration stays deferred — if you need it, open an issue.

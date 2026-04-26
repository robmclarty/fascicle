# AI Engine Layer — Specification

**Status:** Draft, implementation pending
**Package:** `@robmclarty/engine` (workspace package in the `@robmclarty/agent-kit` pnpm workspace; re-exported by the `@robmclarty/agent-kit` umbrella)
**Sibling documents:** `.ridgeline/constraints.md` (project-wide non-negotiables), `.ridgeline/taste.md` (project-wide design philosophy)
**Scope:** the AI engine layer only. Composition primitives are specified in `docs/agent-kit-composition-layer-spec.md`. MCP server integration, response caching, and local-only batching are flagged in §13 and deferred.

---

## §1 — Problem Statement

The composition layer provides orchestration primitives (`step`, `sequence`, `parallel`, `adversarial`, etc.) that know nothing about LLMs. Application steps need to call models. The question is: what do they call?

Two failure modes:

1. **Direct Vercel AI SDK use from every step.** Every step imports `@ai-sdk/anthropic` (or whatever), constructs a provider instance, wires tools, handles streaming, manages retries. The provider choice leaks into every step. Swapping `claude-opus` for `gemini-2.5-pro` is an edit across every file. Tool definitions, schema handling, and cancellation plumbing are re-invented per step. The composition layer's promise of substitutable units is undermined by call-site divergence.

2. **A batteries-included AI framework.** Mastra, LangChain, Vercel's own `Agent` wrappers: each imposes a new vocabulary (agents, runs, memories, traces) that competes with the composition layer's own vocabulary (steps, runs, trajectories, scopes). Two overlapping mental models is one too many.

The engine layer is the narrow middle path. It exposes one function, `generate`, that every LLM-backed step calls. It resolves model aliases, wires tools, handles structured output, streams tokens, honors cancellation, reports usage, and estimates cost. It is a thin shim over Vercel AI SDK with a public surface small enough that swapping the backing implementation (to a hand-rolled HTTP client, to LangChain, to a different multi-provider abstraction) is feasible without touching application code.

**Strategic motivation.** The composition layer powers harnesses, workflows, and agents that all need to call models, switch models frequently (local for cheap iterations, cloud for high-quality runs), and rely on tool use, streaming, and reliable cancellation. The engine layer is where that shared machinery lives. It is not a framework. It is an adapter with opinions about what steps should not have to know.

---

## §2 — Solution Overview

### Core invariant

**One function: `generate(opts)`.** Every LLM call — plain completion, structured object extraction, tool-using agent loop, streaming chat — is a call to `generate`. Every feature is an optional field on the options object with a sensible default. Omitting `tools` means no tools. Omitting `schema` means string content. Omitting `on_chunk` means non-streaming. The same function covers every case.

This invariant is load-bearing. Splitting into `generate`, `generate_object`, `generate_with_tools`, `generate_stream` forces consumers to pick which API to call before they know what they need. Adding `schema` to an existing call would require migrating to a different function. Parallel vocabularies for the same concept accumulate, and LLM-authored steps (a first-class audience for this library) have to learn the split. One function avoids all of that.

### Layer boundary

```
┌─────────────────────────────────────────────────────────────┐
│  Application code (your harnesses, workflows, agents)      │
├─────────────────────────────────────────────────────────────┤
│  Composition layer (separate spec)                          │
│    step, sequence, parallel, adversarial, ...               │
│    run(flow, input) / run.stream(flow, input)               │
├─────────────────────────────────────────────────────────────┤
│  AI engine layer (this spec)                                │
│    create_engine(config) → { generate, register_alias, ... }│
│    generate(opts): one function, all features optional      │
├─────────────────────────────────────────────────────────────┤
│  Vercel AI SDK v6 (ai, @ai-sdk/*)                           │
│    generateText, streamText, tool, zodSchema, ...           │
│    (Agent / ToolLoopAgent present in SDK but not used)      │
└─────────────────────────────────────────────────────────────┘
```

The engine depends downward on Vercel AI SDK. The composition layer does not import from the engine. Application steps import both. If a future engine implementation swaps Vercel AI SDK for a different backing library, application code is untouched as long as the engine's public surface is preserved.

### Engine as explicit instance

No ambient singleton. Users call `create_engine(config)` once at application startup and get back an engine object with a `generate` function bound to that configuration. Credentials, alias overrides, retry policy, and pricing overrides are all owned by the engine instance.

```typescript
const engine = create_engine({
  providers: {
    anthropic:  { api_key: process.env.ANTHROPIC_API_KEY! },
    openai:     { api_key: process.env.OPENAI_API_KEY! },
    google:     { api_key: process.env.GOOGLE_API_KEY! },
    ollama:     { base_url: 'http://localhost:11434' },
    openrouter: { api_key: process.env.OPENROUTER_API_KEY! },
  },
  aliases: { my_cheap: { provider: 'ollama', model_id: 'gemma3:4b' } },
})

export const { generate } = engine
```

Callers who prefer terse imports can re-export `generate` from a user-land module. The library does not ship a default engine.

### Data flow model

`generate` is single-shot from the composition layer's point of view: it takes options, does its work (possibly a multi-turn tool loop internally), and returns one `GenerateResult`. Streaming is purely observational via `on_chunk`; the final result is identical whether streaming was used or not. This matches the composition layer invariant that every step returns exactly once.

### Primitive inventory

One public function: `generate`.

Four alias functions on the engine instance: `register_alias`, `unregister_alias`, `resolve_alias`, `list_aliases`. Three pricing functions: `register_price`, `resolve_price`, `list_prices`.

One factory: `create_engine`.

No others are part of v1. Additions are deferred (§13).

---

## §5 — Interface Definitions

### §5.1 `generate` — the single entry point

```typescript
generate<t = string>(opts: GenerateOptions<t>): Promise<GenerateResult<t>>
```

The `generate` function is obtained from an engine instance (`engine.generate`) or destructured at construction. It is a plain async function with no bound `this`.

### §5.2 `GenerateOptions`

```typescript
type GenerateOptions<t = string> = {
  // required
  model: string                               // alias or 'provider:model_id'
  prompt: string | Message[]                  // string becomes a single user message

  // prompt shaping
  system?: string                             // merged as first system message if provided
  schema?: z.ZodSchema<t>                     // structured output; default: free-form string
  tools?: Tool[]                              // default: []

  // generation control
  effort?: EffortLevel                        // default: 'none'
  temperature?: number                        // provider-default if omitted
  max_tokens?: number                         // output token cap
  top_p?: number
  max_steps?: number                          // tool-loop turn cap; default: 10

  // runtime integration
  abort?: AbortSignal                         // wired from composition ctx.abort
  trajectory?: TrajectoryLogger               // wired from composition ctx.trajectory
  on_chunk?: (chunk: StreamChunk) => void     // opt-in streaming

  // policy overrides (otherwise uses engine defaults)
  retry?: RetryPolicy
  tool_error_policy?: 'feed_back' | 'throw'   // default: 'feed_back'
  schema_repair_attempts?: number             // default: 1

  // human-in-the-loop tool approval (AI SDK v6 HITL)
  on_tool_approval?: ToolApprovalHandler      // engine-wide approval gate; per-tool
                                              //   `needs_approval` still applies
}

type ToolApprovalHandler = (
  request: ToolApprovalRequest
) => boolean | Promise<boolean>

type ToolApprovalRequest = {
  tool_name: string
  input: unknown
  step_index: number
  abort: AbortSignal                // same signal as GenerateOptions.abort; firing while
                                    //   awaiting approval rejects generate with aborted_error
}

type EffortLevel = 'none' | 'low' | 'medium' | 'high'

type RetryPolicy = {
  max_attempts: number          // default: 3
  initial_delay_ms: number      // default: 500
  max_delay_ms: number          // default: 30_000
  retry_on: Array<'rate_limit' | 'provider_5xx' | 'network' | 'timeout'>
}
```

**Semantics:**

- `model` accepts any alias known to the engine's resolver. Colon-prefixed forms (`'ollama:gemma3:27b'`, `'anthropic:claude-opus-4-7'`, `'openrouter:anthropic/claude-sonnet-4.5'`) bypass the alias table. See §5.7.
- `prompt: string` is sugar for `[{ role: 'user', content: prompt }]`. A full `Message[]` is required for multi-turn conversations.
- `schema` constrains the final assistant content (after the tool loop terminates). With `schema`, `content` on the result is typed as `t`. Without, `content` is `string`.
- `effort: 'none'` disables reasoning tokens. Non-reasoning models ignore the field entirely. See §6.3 for provider mapping.
- `max_steps` bounds the number of assistant turns (one plus the number of tool-call rounds). A pure completion runs in one step. Exceeding `max_steps` returns with `finish_reason: 'max_steps'`. See §6.4.

### §5.3 `GenerateResult`

```typescript
type GenerateResult<t = string> = {
  content: t                              // string if no schema, else parsed schema type
  tool_calls: ToolCallRecord[]            // flat list across all turns
  steps: StepRecord[]                     // one per assistant turn
  usage: UsageTotals
  cost?: CostBreakdown                    // present when pricing is known for the resolved model
  finish_reason: FinishReason
  model_resolved: { provider: string; model_id: string }
}

type UsageTotals = {
  input_tokens: number
  output_tokens: number
  reasoning_tokens?: number
  cached_input_tokens?: number            // Anthropic-style cache reads, billed at reduced rate
  cache_write_tokens?: number             // Anthropic-style cache writes, billed at premium rate
}

type CostBreakdown = {
  total_usd: number                       // rounded to 6 decimal places (micro-USD)
  input_usd: number
  output_usd: number
  cached_input_usd?: number
  cache_write_usd?: number
  reasoning_usd?: number                  // present only when reasoning is billed at a separate rate
  currency: 'USD'                         // reserved; always 'USD' in v1
  is_estimate: true                       // permanent; engine reports list-price estimates, not invoice values
}

type FinishReason =
  | 'stop'            // model finished naturally
  | 'tool_calls'      // model requested tool calls as its final action (rare; usually resolved inside the loop)
  | 'length'          // max_tokens reached
  | 'content_filter'  // provider refused
  | 'aborted'         // abort signal fired
  | 'max_steps'       // tool loop hit max_steps

type StepRecord = {
  index: number
  text: string                            // raw assistant text for this turn
  tool_calls: ToolCallRecord[]            // calls issued in this turn
  usage: UsageTotals                      // usage for this turn only
  cost?: CostBreakdown                    // per-turn cost; present when pricing is known
  finish_reason: FinishReason
}

type ToolCallRecord = {
  id: string                              // provider-assigned call id
  name: string
  input: unknown                          // parsed, validated against tool.input_schema
  output?: unknown                        // tool's return value; present on success
  error?: { message: string; stack?: string }
  duration_ms: number
  started_at: number                      // epoch ms
}
```

**Aggregation rules:**

- `usage` is summed across all `steps`. Undefined fields contribute 0. If no step reported a field at all, the top-level field is `undefined`, not `0`.
- `cost` is summed across all `steps` that have a non-null `cost`. If pricing is not known for the resolved model and the provider is not in `FREE_PROVIDERS`, top-level `cost` is `undefined`. Partial usage data (some token classes present, others zero) produces a valid breakdown with zero in the unknown fields. Fully-absent fields are omitted (not zero).
- `tool_calls` is the flat concatenation of `steps[i].tool_calls` in order.
- `finish_reason` is the reason of the final turn, except `'aborted'` and `'max_steps'` take precedence when they apply.

### §5.4 `Message`

```typescript
type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentPart[] }
  | { role: 'assistant'; content: string | AssistantContentPart[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string }

type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: Uint8Array | string; media_type?: string }  // base64 string or bytes

type AssistantContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
```

**Semantics:**

- System messages may appear multiple times; they are concatenated in order before dispatch. The `system` field on `GenerateOptions` is prepended as an additional system message.
- Image parts pass through to Vercel AI SDK's multimodal support. Providers that do not support images throw `provider_capability_error`.
- Tool messages are produced by the engine during the tool loop and passed back to the model; user code rarely constructs them directly. When continuing a multi-turn conversation that used tools, callers must include the assistant's prior `tool_call` parts and the corresponding `tool` messages in their history.

### §5.5 `Tool`

```typescript
type Tool<i = unknown, o = unknown> = {
  name: string
  description: string
  input_schema: z.ZodSchema<i>
  execute: (input: i, ctx: ToolExecContext) => Promise<o> | o
  needs_approval?: boolean | ((input: i) => boolean | Promise<boolean>)
                                          // AI SDK v6 HITL passthrough; see §6.x
                                          //   tool-level gate fires before the engine-wide
                                          //   on_tool_approval handler
}

type ToolExecContext = {
  abort: AbortSignal                      // propagated from generate's abort
  trajectory?: TrajectoryLogger           // propagated from generate's trajectory
  tool_call_id: string
  step_index: number                      // which assistant turn triggered this call
}
```

**Semantics:**

- Tools are plain objects. No class, no `this`. A user-land `make_tool(...)` helper with sensible defaults is trivial to build and is not part of the library.
- `execute` is called with input already validated against `input_schema`. Malformed input never reaches `execute` (see §6.4).
- `execute` must honor `ctx.abort` for any I/O longer than ~50ms. Tools that ignore abort leak on cancellation.
- `ctx.trajectory` is present only if the caller of `generate` supplied one. Tools logging their own events check for presence first.
- `needs_approval`: if truthy (or the predicate returns true for the proposed input), the engine invokes `GenerateOptions.on_tool_approval` (if provided) before `execute` runs. Denial causes the call to resolve as a tool result with `error: { message: 'tool_approval_denied' }` fed back to the model under `tool_error_policy: 'feed_back'`, or throws `tool_approval_denied_error` under `'throw'`. With no `on_tool_approval` handler but `needs_approval` truthy, the engine fails closed: `tool_approval_denied_error` is thrown before `execute`.

### §5.6 `StreamChunk`

```typescript
type StreamChunk =
  | { kind: 'text'; text: string; step_index: number }
  | { kind: 'reasoning'; text: string; step_index: number }
  | { kind: 'tool_call_start'; id: string; name: string; step_index: number }
  | { kind: 'tool_call_input_delta'; id: string; delta: string; step_index: number }
  | { kind: 'tool_call_end'; id: string; input: unknown; step_index: number }
  | { kind: 'tool_result'; id: string; output?: unknown; error?: { message: string }; step_index: number }
  | { kind: 'step_finish'; step_index: number; finish_reason: FinishReason; usage: UsageTotals }
  | { kind: 'finish'; finish_reason: FinishReason; usage: UsageTotals }
```

**Chunk ordering guarantees:**

- Within a step: `text` and `reasoning` deltas interleave; `tool_call_start` precedes its `tool_call_input_delta` and `tool_call_end`; `tool_result` follows the matching `tool_call_end`.
- `step_finish` is the last chunk of a step. `finish` is the last chunk of the whole `generate` call.
- If `schema` is set, `text` chunks still stream raw JSON. Parsing happens once at the end. Callers who display streamed JSON should treat it as in-progress until `step_finish`.

### §5.7 Alias table

```typescript
type AliasTarget = {
  provider: string                        // 'anthropic' | 'openai' | 'google' | 'ollama' | 'lmstudio' | 'openrouter' | <user>
  model_id: string                        // provider-specific id
  defaults?: {
    temperature?: number
    max_tokens?: number
    effort?: EffortLevel
  }
}

type AliasTable = Record<string, AliasTarget>
```

Default table (shipped as `DEFAULT_ALIASES`):

```typescript
const DEFAULT_ALIASES: AliasTable = {
  // Anthropic (Claude 4.x)
  'claude-opus':    { provider: 'anthropic', model_id: 'claude-opus-4-7' },
  'opus':           { provider: 'anthropic', model_id: 'claude-opus-4-7' },
  'claude-sonnet':  { provider: 'anthropic', model_id: 'claude-sonnet-4-6' },
  'sonnet':         { provider: 'anthropic', model_id: 'claude-sonnet-4-6' },
  'claude-haiku':   { provider: 'anthropic', model_id: 'claude-haiku-4-5' },
  'haiku':          { provider: 'anthropic', model_id: 'claude-haiku-4-5' },

  // OpenAI
  'gpt-4o':         { provider: 'openai', model_id: 'gpt-4o' },
  'gpt-4o-mini':    { provider: 'openai', model_id: 'gpt-4o-mini' },

  // Google
  'gemini-2.5-pro':   { provider: 'google', model_id: 'gemini-2.5-pro' },
  'gemini-2.5-flash': { provider: 'google', model_id: 'gemini-2.5-flash' },
  'gemini-pro':       { provider: 'google', model_id: 'gemini-2.5-pro' },
  'gemini-flash':     { provider: 'google', model_id: 'gemini-2.5-flash' },

  // OpenRouter (multiplexer — one key, hundreds of models from dozens of upstream providers).
  // Use 'openrouter:*' colon-bypass for any model id without registering it.
  'or:sonnet':        { provider: 'openrouter', model_id: 'anthropic/claude-sonnet-4.5' },
  'or:opus':          { provider: 'openrouter', model_id: 'anthropic/claude-opus-4.1' },
  'or:gpt-4o':        { provider: 'openrouter', model_id: 'openai/gpt-4o' },
  'or:gemini-pro':    { provider: 'openrouter', model_id: 'google/gemini-2.5-pro' },
  'or:llama-3.3-70b': { provider: 'openrouter', model_id: 'meta-llama/llama-3.3-70b-instruct' },
}
```

**Resolution algorithm:**

1. If `model` contains a colon and the prefix is a known provider name, the prefix is the provider and the remainder is the `model_id`. The alias table is bypassed. The engine splits on the **first** colon only — OpenRouter ids contain an internal `/` namespacing the upstream provider, so `openrouter:anthropic/claude-sonnet-4.5` round-trips correctly.
2. Otherwise, look up `model` in the engine's alias table. If found, use the resolved `AliasTarget`.
3. Otherwise, throw `model_not_found_error` with a message listing available aliases.

The colon-bypass form keeps OpenRouter, Ollama, and LM Studio usable without forcing pre-registration of every model id.

### §5.8 Engine configuration and factory

```typescript
type EngineConfig = {
  providers: ProviderConfigMap
  aliases?: AliasTable                    // merged over DEFAULT_ALIASES
  pricing?: PricingTable                  // merged over DEFAULT_PRICING; see §5.10
  default_retry?: RetryPolicy
  default_effort?: EffortLevel            // applied when GenerateOptions.effort is absent; default 'none'
  default_max_steps?: number              // default: 10
}

type ProviderConfigMap = {
  anthropic?:  { api_key: string; base_url?: string }
  openai?:     { api_key: string; base_url?: string; organization?: string }
  google?:     { api_key: string; base_url?: string }
  ollama?:     { base_url: string }                                // no api_key; local
  lmstudio?:   { base_url: string }
  openrouter?: { api_key: string; base_url?: string; http_referer?: string; x_title?: string }
  [custom: string]: ProviderInit | undefined
}

type ProviderInit =
  | { api_key: string; base_url?: string; [k: string]: unknown }
  | { base_url: string;                   [k: string]: unknown }

type Engine = {
  generate:          <t = string>(opts: GenerateOptions<t>) => Promise<GenerateResult<t>>
  register_alias:    (alias: string, target: AliasTarget) => void
  unregister_alias:  (alias: string) => void
  resolve_alias:     (alias: string) => AliasTarget           // throws model_not_found_error if absent
  list_aliases:      () => AliasTable                         // defensive copy
  register_price:    (provider: string, model_id: string, pricing: Pricing) => void
  resolve_price:     (provider: string, model_id: string) => Pricing | undefined
  list_prices:       () => PricingTable                       // defensive copy
}

create_engine(config: EngineConfig): Engine
```

**Semantics:**

- `create_engine` validates each provider entry against a minimal schema. Missing `api_key` for a provider that requires one throws `engine_config_error` at construction. Fail early.
- Aliases and pricing are mutable on an engine instance via the `register_*` methods. Both tables are scoped to the engine, never global.
- Pricing keys use the resolved `'<provider>:<model_id>'` form, not aliases. Multiple aliases pointing to the same model share one price entry.
- `list_aliases` and `list_prices` return defensive copies; mutating the returned objects does not affect the engine.
- Two engines with different credentials coexist without interference. Useful for multi-tenant apps and for separating dev from production engines.

### §5.9 User-defined providers (deferred surface)

```typescript
register_provider(
  name: string,
  init: (config: ProviderInit) => ProviderAdapter,
): void

type ProviderAdapter = {
  generate: (req: InternalRequest) => Promise<InternalResponse>
  stream:   (req: InternalRequest) => AsyncIterable<InternalChunk>
}
```

Provider extension is an advanced path — for example, a private internal inference service for sovereign deployment. The full shapes of `InternalRequest` / `InternalResponse` / `InternalChunk` are deferred to a future provider-extension spec. **V1 ships only the Vercel-SDK-backed set.**

### §5.10 Pricing table

```typescript
type Pricing = {
  input_per_million: number                   // USD per 1M input tokens
  output_per_million: number                  // USD per 1M output tokens
  cached_input_per_million?: number           // falls back to input_per_million if absent
  cache_write_per_million?: number            // Anthropic-style 1.25x premium; falls back to input_per_million
  reasoning_per_million?: number              // falls back to output_per_million
}

type PricingTable = Record<string, Pricing>   // key format: 'provider:model_id'
```

Default pricing (shipped as `DEFAULT_PRICING`, current as of April 2026):

```typescript
const DEFAULT_PRICING: PricingTable = {
  // Anthropic (USD / MTok)
  'anthropic:claude-opus-4-7':    { input_per_million: 5.00, output_per_million: 25.00, cached_input_per_million: 0.50, cache_write_per_million: 6.25 },
  'anthropic:claude-opus-4-6':    { input_per_million: 5.00, output_per_million: 25.00, cached_input_per_million: 0.50, cache_write_per_million: 6.25 },
  'anthropic:claude-sonnet-4-6':  { input_per_million: 3.00, output_per_million: 15.00, cached_input_per_million: 0.30, cache_write_per_million: 3.75 },
  'anthropic:claude-haiku-4-5':   { input_per_million: 1.00, output_per_million:  5.00, cached_input_per_million: 0.10, cache_write_per_million: 1.25 },

  // OpenAI
  'openai:gpt-4o':                { input_per_million: 2.50, output_per_million: 10.00, cached_input_per_million: 1.25 },
  'openai:gpt-4o-mini':           { input_per_million: 0.15, output_per_million:  0.60, cached_input_per_million: 0.075 },

  // Google
  'google:gemini-2.5-pro':        { input_per_million: 1.25, output_per_million:  5.00 },
  'google:gemini-2.5-flash':      { input_per_million: 0.075, output_per_million: 0.30 },

  // Ollama and LM Studio: no entries. Treated as zero-cost via FREE_PROVIDERS (see §6.10).
  // OpenRouter: no entries. Rates change without notice and the catalog is huge.
  // Missing 'openrouter:*' pricing surfaces cost as undefined and emits 'pricing_missing' (F16).
}
```

**Cost computation.** Given `usage` and `pricing`, per-turn cost is:

```
input_usd        = (input_tokens - cached_input_tokens - cache_write_tokens) * input_per_million / 1e6
cached_input_usd = cached_input_tokens                                        * (cached_input_per_million ?? input_per_million) / 1e6
cache_write_usd  = cache_write_tokens                                         * (cache_write_per_million  ?? input_per_million) / 1e6
reasoning_usd    = reasoning_tokens                                           * (reasoning_per_million    ?? output_per_million) / 1e6
output_usd       = (output_tokens - reasoning_tokens)                         * output_per_million / 1e6
total_usd        = input_usd + cached_input_usd + cache_write_usd + reasoning_usd + output_usd
```

Missing fields in `usage` are treated as 0. If `reasoning_per_million` is absent (the common case), reasoning is billed at the output rate and rolled into `output_usd` rather than surfacing `reasoning_usd` separately. Intermediate arithmetic uses full precision; `total_usd` and each component are rounded to 6 decimal places (micro-USD).

**User-land extension.** Two equivalent paths:

```typescript
// At engine construction:
const engine = create_engine({
  providers: { anthropic: { api_key: '...' } },
  pricing: {
    'anthropic:claude-opus-4-7': { input_per_million: 5.00, output_per_million: 25.00 },
    'ollama:gemma3:27b':         { input_per_million: 0.05, output_per_million: 0.10 }, // imputed cost
  },
})

// At runtime:
engine.register_price('ollama', 'gemma3:27b', { input_per_million: 0.05, output_per_million: 0.10 })
```

User-supplied entries merge over `DEFAULT_PRICING`. Specifying only `input_per_million` and `output_per_million` leaves the cache and reasoning fields falling back as described above.

---

## §6 — Semantics and Runtime Contract

### §6.1 Alias resolution

Resolution is deterministic and runs once per `generate` call, before any network I/O. `model_not_found_error` surfaces synchronously from the start of the promise chain. The resolved `{ provider, model_id }` is recorded in the trajectory as the first engine event and returned on the result as `model_resolved`.

### §6.2 Trajectory events

When `trajectory` is supplied, the engine emits a nested span for the entire `generate` call and per-step child spans for each assistant turn:

```
start_span('engine.generate', { model, provider, model_id, has_tools, has_schema, streaming })
  start_span('engine.generate.step', { index })
    record({ kind: 'request_sent', prompt_tokens_estimated })
    record({ kind: 'response_received', output_tokens, finish_reason })
    record({ kind: 'tool_call', name, input, duration_ms, error? }) *
  end_span('engine.generate.step', { usage, finish_reason })
end_span('engine.generate', { usage, finish_reason, model_resolved })
```

Per-token `text` deltas are **not** recorded (volume concern). Streaming consumers observe tokens via `on_chunk`. A debug flag for per-token recording is deferred (§13).

### §6.3 Effort mapping

| `effort` | Anthropic (extended thinking budget) | OpenAI o-series (`reasoning_effort`) | Google (thinking_budget) |
|---|---|---|---|
| `'none'` | disabled | omitted | disabled |
| `'low'` | 1,024 tokens | `'low'` | low |
| `'medium'` | 5,000 tokens | `'medium'` | medium |
| `'high'` | 20,000 tokens | `'high'` | high |

Providers that do not support reasoning silently ignore `effort` and the engine records `{ kind: 'effort_ignored', model_id }` to trajectory. This makes switching models safe: an app can set `effort: 'medium'` universally and not break when pointed at `'haiku'`.

For providers that do not report reasoning token counts separately, `usage.reasoning_tokens` is absent on the result.

### §6.4 Tool-call loop

**Pseudocode:**

```
step_index = 0
conversation = [system?, ...initial_messages]

loop:
  if step_index >= max_steps: return with finish_reason='max_steps'
  if abort.aborted: throw aborted_error

  response = provider_call(conversation, tools, schema?, on_chunk?, abort)
  step_records.push(build_step_record(response))

  if response.finish_reason != 'tool_calls': break

  for each tool_call in response.tool_calls (sequentially):
    if abort.aborted: throw aborted_error
    validate tool_call.input against tool.input_schema
    if validation fails: push tool_result with error, continue
    if tool.needs_approval is truthy (or predicate(input) returns true):
      if abort.aborted: throw aborted_error
      approved = await on_tool_approval?.(request)   // abort honored during wait
      if on_tool_approval is absent: approved = false (fail-closed)
      if not approved:
        if tool_error_policy == 'throw': throw tool_approval_denied_error
        else: output = { error: 'tool_approval_denied' }; push tool result; continue
    try:
      output = await tool.execute(validated_input, tool_exec_ctx)
    catch err:
      if tool_error_policy == 'throw': throw tool_error
      else: output = { error: err.message }
    push assistant's tool_call to conversation
    push tool result to conversation
    emit on_chunk tool_result event

  step_index += 1

if schema: validate_and_possibly_repair(final_text, schema)
return result
```

**Key decisions:**

- **Tools execute sequentially within a turn.** Parallel tool execution is deferred (§13). Three tool calls in one turn run one after another. Keeps abort semantics simple and matches what most providers support natively.
- **Tool input validation.** The engine parses the model's JSON to `unknown` and calls `tool.input_schema.safeParse`. On failure, the error is stringified and sent back as a tool result with `error: true`. The model is expected to self-correct on the next turn. This consumes a step.
- **Tool execution errors.** Default `tool_error_policy: 'feed_back'` — thrown errors are caught and serialized as tool results with `{ error: <message> }`. Under `'throw'`, the error wraps in `tool_error` and ends `generate`. Feed-back is dramatically more forgiving for agentic loops.
- **Schema interaction with tools.** `schema` constrains only the final assistant turn (the one with `finish_reason != 'tool_calls'`). Intermediate turns may emit text that is not schema-conformant. Tool input schemas are validated separately per tool, not against `schema`.
- **`max_steps` interaction with `finish_reason`.** If the loop exits because `step_index >= max_steps` while the most recent response still had pending tool calls, the top-level `finish_reason` is `'max_steps'`. The result's `tool_calls` includes attempted-but-unexecuted calls from that final turn with `output` unset and `error: { message: 'max_steps_exceeded_before_execution' }` set. Preserves observability.

### §6.5 Structured output and schema repair

With `schema` set:

1. The engine passes the schema to Vercel AI SDK (which handles provider-specific JSON mode / tool-based constraints / response_format).
2. After the tool loop terminates, the engine collects the final assistant text and parses with `schema.safeParse`.
3. On success, the parsed value is returned as `content`.
4. On failure, if `schema_repair_attempts > 0` (default: 1), the engine appends a repair message to the conversation:
   ```
   role: 'user'
   content: "Your previous response did not match the expected schema. Error: <zod error>. Please provide a corrected response that strictly conforms to the schema."
   ```
   and makes one more `provider_call`. The re-parsed result is returned if valid. The repair turn counts against `max_steps`.
5. If all repair attempts are exhausted, the engine throws `schema_validation_error` carrying the zod error and the raw model text.

The engine does not partially repair JSON. Native structured output already reduces failure rates; the single repair attempt covers the long tail. Users who need stricter guarantees compose `retry` from the composition layer.

### §6.6 Streaming semantics

When `on_chunk` is provided:

1. The engine uses the provider's streaming endpoint (Vercel AI SDK's `streamText` / `streamObject`).
2. For every incoming provider event, the engine emits a `StreamChunk` to `on_chunk` synchronously (within the same microtask). Chunks are not buffered.
3. `on_chunk` errors (sync throw or rejected promise) abort the in-flight request, wrap the error in `on_chunk_error`, throw it from `generate`, and stop further `on_chunk` calls.
4. When `on_chunk` is absent, the engine uses the non-streaming endpoint (or a streaming endpoint with internal accumulation). Either way, only the final result is observable externally.

**Threading to composition layer's `ctx.emit`:**

```typescript
step('llm_call', async (input, ctx) => {
  return await generate({
    model: 'claude-opus',
    prompt: input,
    abort: ctx.abort,
    trajectory: ctx.trajectory,
    on_chunk: (chunk) => ctx.emit({ kind: 'llm_chunk', ...chunk }),
  })
})
```

Each chunk threads into the composition layer's trajectory event channel with a uniform event kind, scoped by `span_id` to the originating step.

### §6.7 Cancellation semantics

`abort` is the single cancellation mechanism. There is no separate engine-level timeout; wrap `generate` in `timeout(...)` at the composition layer for a deadline.

**What honors `abort`:**

1. **The HTTP request to the provider** — passed through to Vercel AI SDK's `abortSignal`, then to the underlying `fetch`. TCP closes. No further tokens billed past disconnect.
2. **Between tool loop iterations** — boolean check at the top of each iteration.
3. **Between tool calls within a turn** — boolean check before each `tool.execute` invocation.
4. **Inside tool execution** — tools receive `abort` via `ToolExecContext` and are obligated to honor it for long-running I/O.

**What happens on abort:**

1. The in-flight HTTP request is aborted.
2. All accumulated `StepRecord`s are discarded. `generate` throws `aborted_error`; it does not return a partial result. Partial output is observable via `on_chunk` before the rejection.
3. `aborted_error` carries `{ reason: unknown; step_index: number; tool_call_in_flight?: { id, name } }`.

`aborted_error` vs provider timeouts: provider timeouts and network errors surface as `provider_error` (or are retried per `RetryPolicy`). A composition-layer `timeout(llm_step, 30_000)` that fires sets `ctx.abort` and surfaces inside `generate` as `aborted_error`; the composition layer translates it to `timeout_error` at the `timeout` boundary.

### §6.8 Retry policy

```typescript
const DEFAULT_RETRY: RetryPolicy = {
  max_attempts: 3,
  initial_delay_ms: 500,
  max_delay_ms: 30_000,
  retry_on: ['rate_limit', 'provider_5xx', 'network'],
}
```

- **`rate_limit` (HTTP 429):** respect `Retry-After` if present, otherwise exponential backoff: `min(initial_delay_ms * 2^attempt + jitter, max_delay_ms)`.
- **`provider_5xx`:** exponential backoff, same formula.
- **`network`:** exponential backoff. Covers `ECONNRESET`, `ETIMEDOUT`, DNS failures, sockets closed mid-stream.
- **Not retried:** 4xx other than 429 (user errors), schema validation failures (see §6.5), tool execution errors (handled separately), `aborted_error`.
- **Abort during backoff:** if `abort.aborted` fires while waiting, the delay is interrupted and `aborted_error` is thrown immediately.

Retries cover the failed provider call, not the full tool loop. Successful calls before a failure are not re-made.

**Streaming and retries:** once a streaming response has delivered any tokens, it is not retried. Retrying would require either swallowing the partial output or re-emitting chunks with potentially different content. The engine throws `provider_error` after the first delivered chunk on any provider-side interruption.

### §6.9 Cost computation runtime contract

```
on turn completion:
  1. usage = provider-reported token counts for this turn
  2. pricing_key = '<provider>:<model_id>'        // from model_resolved
  3. pricing = engine.pricing_table[pricing_key]
  4. if pricing is undefined:
       if provider in FREE_PROVIDERS (ollama, lmstudio): cost = all-zero breakdown
       else:
         trajectory.record({ kind: 'pricing_missing', provider, model_id })  // dedup per generate call
         step_record.cost = undefined
         return
  5. compute cost_breakdown per the formula in §5.10
  6. step_record.cost = breakdown

at generate completion:
  if any step has cost: result.cost = sum of step costs (all fields)
  else: result.cost = undefined
```

**Trajectory events:**

- `{ kind: 'cost', step_index, total_usd, input_usd, output_usd, cached_input_usd?, cache_write_usd?, reasoning_usd? }` after each turn that produced a cost.
- `{ kind: 'pricing_missing', provider, model_id }` once per `generate` call.

These events let user-land accumulate totals over a run by consuming trajectory events, without the engine holding aggregate state:

```typescript
let total = 0
trajectory.record = (event) => {
  if (event.kind === 'cost') total += event.total_usd as number
}
```

**Provider reporting inconsistencies.** Vercel AI SDK normalizes most usage fields. `cached_input_tokens` and `cache_write_tokens` are Anthropic-specific; for providers that do not report them, the fields are absent and contribute nothing to cost. OpenAI's cached-input concept maps to `cached_input_tokens` with no separate write cost. Mapping happens inside each provider adapter, not in the cost computation.

---

## §9 — Failure Modes

### F1: Alias not found

**Scenario:** `generate({ model: 'unknown-model', ... })` where `'unknown-model'` is not in the alias table and is not a `provider:model_id` form.
**Behavior:** throw `model_not_found_error` synchronously with a message listing registered aliases. No HTTP call.
**Test:** call `generate` with a bogus model; assert error and that no provider SDK mock was invoked.

### F2: Provider credentials missing

**Scenario:** `create_engine({ providers: { anthropic: { api_key: '' } } })`, or the engine omits a provider entirely and `generate({ model: 'claude-opus' })` is then called.
**Behavior:** `create_engine` validates each entry. Empty `api_key` for a provider that requires one throws `engine_config_error` at construction. A `generate` call that references a provider not configured at all throws `provider_not_configured_error`.
**Test:** (1) construct with empty api_key → assert construction fails. (2) construct without google → call `generate({ model: 'gemini-pro' })` → assert `provider_not_configured_error`.

### F3: Rate limit (HTTP 429)

**Scenario:** provider returns 429.
**Behavior:** retry per `RetryPolicy`. Respect `Retry-After`. After `max_attempts` exhausted, throw `rate_limit_error` with retry count and last `Retry-After`.
**Test:** mock 429 three times then 200. With `max_attempts: 3` assert success on third attempt; with `max_attempts: 2` assert `rate_limit_error`.

### F4: Provider outage (5xx)

**Scenario:** provider returns 500 / 502 / 503 / 504.
**Behavior:** retry with exponential backoff. After exhaustion, throw `provider_error` carrying status code and body snippet.
**Test:** mock 503 persistently; assert `provider_error` after `max_attempts` retries with correct elapsed time.

### F5: Network error mid-request

**Scenario:** TCP reset, DNS failure, or socket close during request.
**Behavior:** retry per policy for non-streaming. For streaming after any chunk delivered: no retry, throw `provider_error` immediately. Asymmetry is documented in §6.8.
**Test:** (1) mock ECONNRESET before any bytes → assert retry and eventual success. (2) mock socket close after partial stream → assert `provider_error` thrown and `on_chunk` not called again.

### F6: Invalid JSON in structured output

**Scenario:** `schema` is set; model returns text that is not valid JSON or does not parse to `schema`.
**Behavior:** engine sends a repair message, retries once (default `schema_repair_attempts: 1`). If repair also fails, throw `schema_validation_error` with the zod error and raw model text.
**Test:** mock unparseable JSON; assert repair sent; mock repair to succeed → success; mock repair to fail → `schema_validation_error`.

### F7: Malformed tool call from model

**Scenario:** model issues a tool call where arguments do not match `input_schema`.
**Behavior:** engine does not call `execute`. The validation error is stringified and fed back as a tool result with `error: true`. The model is expected to self-correct. This consumes a step.
**Test:** mock malformed tool_call in turn 1; assert `execute` not called; assert turn 2 contains the error in conversation; verify `GenerateResult.tool_calls` includes the failed call with `error` set.

### F8: Tool execution throws

**Scenario:** `tool.execute` throws (network failure, bad input handling, internal bug).
**Behavior:** depends on `tool_error_policy`.
- `'feed_back'` (default): error message is serialized and sent to the model as a tool result with `error: true`. Loop continues.
- `'throw'`: wrap the error in `tool_error` with `{ tool_name, tool_call_id, cause }` and throw from `generate`.
**Test:** two tests, one per policy, asserting the documented behavior.

### F9: Tool call loop exceeds `max_steps`

**Scenario:** model keeps calling tools past the `max_steps` cap.
**Behavior:** loop exits, `generate` resolves with `finish_reason: 'max_steps'`. Final turn's attempted-but-unexecuted tool calls are included in `tool_calls` with `error: { message: 'max_steps_exceeded_before_execution' }` and no `output`.
**Test:** tool that always returns more work; `max_steps: 3`; assert `finish_reason: 'max_steps'`, three `steps`, final `tool_calls` entry has the error marker.

### F10: Token limit exceeded mid-stream

**Scenario:** model hits its output `max_tokens` cap mid-completion.
**Behavior:** provider finishes with `'length'`. Engine surfaces `finish_reason: 'length'` with the partial content. No retry, no repair. If `schema` is set, the partial content runs through the repair path; on second failure, `schema_validation_error`.
**Test:** mock `'length'` finish; without schema → assert partial content; with schema → assert repair attempt then `schema_validation_error`.

### F11: `on_chunk` throws

**Scenario:** user-supplied `on_chunk` callback throws or returns a rejected promise.
**Behavior:** abort the in-flight HTTP request, wrap the thrown error in `on_chunk_error`, throw from `generate`. Do not call `on_chunk` again.
**Test:** throwing `on_chunk` on third chunk; assert `on_chunk_error` thrown; assert provider fetch was aborted.

### F12: Abort during tool execution

**Scenario:** `abort` fires while a tool's `execute` is running.
**Behavior:** `execute` receives the aborted signal via `ToolExecContext.abort`. Engine throws `aborted_error` from `generate` with `tool_call_in_flight: { id, name }` in metadata.
**Test:** 500ms `execute`; fire abort at 100ms; assert `aborted_error` with correct metadata; assert tool's `execute` received an aborted signal.

### F13: Content filter

**Scenario:** provider refuses to answer (`finish_reason: 'content_filter'`).
**Behavior:** return normally with `finish_reason: 'content_filter'` and whatever `content` the provider supplied (often empty or a refusal message). No retry. With `schema`, validation runs and likely fails, then the usual repair path.
**Test:** mock content_filter response; assert `finish_reason: 'content_filter'` and no exception.

### F14: Schema set but model does not support structured output

**Scenario:** user supplies `schema` but routes to a model where Vercel AI SDK cannot enforce structure (rare with v1 providers; relevant for local Ollama models).
**Behavior:** engine falls back to free-text generation with a prepended instruction asking the model to respond with JSON matching the schema. Normal schema parse + repair runs on the text. No special error unless the model cannot comply within the repair budget.
**Test:** route to local Ollama without native JSON mode; provide schema; assert success on compliant response and repair-path invocation on non-compliant.

### F15: Cleanup during `generate`

**Scenario:** the composition layer's cleanup fires (SIGINT, etc.) while `generate` is running. The abort signal from `ctx.abort` was passed as `opts.abort`.
**Behavior:** identical to F12. Engine aborts HTTP, cancels in-flight tool, throws `aborted_error`. Enclosing step's `await` rejects; composition runner proceeds with its cleanup chain. The engine does not register handlers on `ctx.on_cleanup`; HTTP abort is sufficient.
**Test:** cross-layer integration test. Build a flow with an LLM step; issue SIGINT during HTTP; assert fetch mock observed abort, runner cleanup handlers fired, `generate`'s promise rejected with `aborted_error`.

### F16: Pricing missing for resolved model

**Scenario:** resolved `{ provider, model_id }` has no entry in the pricing table and the provider is not in `FREE_PROVIDERS`.
**Behavior:** call succeeds normally. `result.cost` is `undefined`. Each `StepRecord.cost` is also `undefined`. A single `{ kind: 'pricing_missing', provider, model_id }` event is recorded once per call. No exception.
**Test:** custom alias `'exotic'` with no pricing; assert valid result, `cost` undefined, exactly one `pricing_missing` event regardless of turn count.

### F17: Pricing present but usage partial

**Scenario:** pricing configured, but provider reports no `cached_input_tokens` or `cache_write_tokens` (common for OpenAI / Google calls that don't hit cache).
**Behavior:** missing usage fields are treated as 0. `CostBreakdown.cached_input_usd` and `cache_write_usd` are **omitted** (not zero) if the corresponding usage was 0 for every turn. `total_usd` reflects only the components with non-zero usage.
**Test:** mock OpenAI response with only `input_tokens` and `output_tokens`; assert `cost` has only `input_usd`, `output_usd`, `total_usd`, `currency`, `is_estimate`; no cache fields.

### F18: Tool approval denied

**Scenario:** tool has `needs_approval: true` (or the predicate returns true for the input). `on_tool_approval` returns `false`.
**Behavior:** `execute` is not invoked. Under default `tool_error_policy: 'feed_back'`, the tool call is fed back to the model with `error: { message: 'tool_approval_denied' }`; the loop continues and the model may recover. Under `'throw'`, engine throws `tool_approval_denied_error` carrying `{ tool_name, step_index, tool_call_id }`. Trajectory records `tool_approval_requested` then `tool_approval_denied`.
**Test:** tool with `needs_approval: true`; `on_tool_approval` returns `false`; assert `execute` not called; under `feed_back`, assert next turn receives the denial; under `throw`, assert `tool_approval_denied_error` with correct metadata.

### F19: Tool approval with abort during await

**Scenario:** `on_tool_approval` returns a pending promise; `abort` fires before it resolves.
**Behavior:** engine stops awaiting, throws `aborted_error`; `execute` is not invoked; the pending approval promise is discarded (the handler is expected to check its `request.abort` signal to avoid lingering UI state).
**Test:** `on_tool_approval` returns a promise that never resolves; fire abort at 100ms; assert `aborted_error` thrown within one event-loop tick of the abort.

### F20: `needs_approval` set without `on_tool_approval`

**Scenario:** tool declares `needs_approval: true` but `GenerateOptions.on_tool_approval` is absent.
**Behavior:** fail-closed — engine throws `tool_approval_denied_error` before calling `execute`. Silent allow would defeat the safety purpose of the field.
**Test:** tool with `needs_approval: true`; no `on_tool_approval`; assert `tool_approval_denied_error` thrown and `execute` not called.

---

## §10 — Success Criteria

### Automated tests (each must pass in CI against a clean install; provider interactions mocked via `msw` or equivalent)

1. **Plain string completion:** `generate({ model: 'claude-opus', prompt: 'hi' })` with mocked `'hello'` resolves with `content: 'hello'`, `tool_calls: []`, `steps.length: 1`, `finish_reason: 'stop'`.
2. **Multi-turn messages:** `prompt` as `Message[]` with system + user passes both through and merges the `system` option correctly.
3. **Structured output:** schema set; mock returns valid JSON; assert `content` is typed and parsed.
4. **Schema repair:** invalid JSON on turn 1, valid on repair; assert success and `steps.length: 2`.
5. **Schema repair exhausted:** invalid on both; assert `schema_validation_error`.
6. **Tool loop (one round):** one tool, model calls it, model returns text; assert `steps.length: 2`, `tool_calls.length: 1`, output matches `execute`'s return.
7. **Tool loop (multiple tools in one turn):** model emits two tool calls; assert sequential execution, both recorded, order preserved.
8. **Tool input validation failure:** model emits malformed input; assert `execute` not called, error fed back, subsequent turn succeeds.
9. **Tool error feed_back:** tool throws; assert error fed back, loop continues, result resolves normally.
10. **Tool error throw:** `tool_error_policy: 'throw'`; tool throws; assert `tool_error` bubbles out.
11. **Max steps reached:** infinite-tool model; `max_steps: 3`; assert `finish_reason: 'max_steps'` and cut-off `tool_call` entries with the error marker.
12. **Effort mapping:** `effort: 'medium'` with claude-opus; assert provider mock receives the medium thinking budget. Switch to gpt-4o-mini; assert field omitted and trajectory records `effort_ignored`.
13. **Streaming chunks:** `on_chunk` captures chunks; mock streams four text deltas plus `finish`; assert five calls in order and concatenated text matches.
14. **Streaming and tools together:** tool-using flow with streaming; assert chunks include `tool_call_start`, `tool_call_input_delta`, `tool_call_end`, `tool_result`, `step_finish` per turn.
15. **Streaming `on_chunk` throws:** callback throws on third chunk; assert `on_chunk_error`, no further chunks, HTTP mock observed abort.
16. **Abort before call:** pre-aborted signal; assert `aborted_error` synchronously or first-microtask, no HTTP call.
17. **Abort mid-request:** abort fires 50ms into 500ms streaming response; assert `aborted_error`, HTTP observed abort, partial content not returned.
18. **Abort during tool execution:** 300ms `execute`; abort at 100ms; assert tool's `ctx.abort` was aborted and `aborted_error` thrown with `tool_call_in_flight`.
19. **Retry rate_limit:** mock 429 twice then 200; assert success on third attempt; trajectory shows two retries.
20. **Retry respects Retry-After:** mock 429 with `Retry-After: 2`; assert wait ≥ 2 seconds before retry.
21. **Retry exhausted:** mock 429 four times, `max_attempts: 3`; assert `rate_limit_error`.
22. **No retry after stream starts:** mock delivers one chunk then ECONNRESET; assert `provider_error` thrown, not retried.
23. **Usage aggregation:** three-turn tool loop with per-turn usage `{20, 30, 10}` input / `{5, 8, 12}` output; assert `usage.input_tokens: 60`, `output_tokens: 25`.
24. **Alias resolution:** `generate({ model: 'sonnet' })` → Anthropic `claude-sonnet-4-6`. Register `my_sonnet`, call → same routing. Unregister, call → `model_not_found_error`.
25. **Provider prefix bypass:** `generate({ model: 'ollama:gemma3:27b' })` routes to ollama regardless of alias table.
26. **Missing credentials:** construct without OpenAI; call with `'gpt-4o'`; assert `provider_not_configured_error`.
27. **Trajectory spans:** wire a recording `TrajectoryLogger`; tool-using call; assert spans include `engine.generate` (parent) with nested `engine.generate.step` per turn, and `request_sent` / `response_received` / `tool_call` records inside.
28. **Two engines are independent:** create two engines with different credentials and alias tables; call concurrently; assert no cross-talk.
29. **Cost computed from default pricing:** `generate({ model: 'sonnet' })` with mocked `input: 1000, output: 500`; assert `result.cost.input_usd === 0.003`, `output_usd === 0.0075`, `total_usd === 0.0105`. Assert a `{ kind: 'cost', ... }` trajectory event with matching totals.
30. **Cost aggregates across turns:** three-turn tool loop, each turn billed separately; assert top-level `cost.total_usd` equals sum of per-step `cost.total_usd` (within 1e-9 tolerance).
31. **Cost with cache hits:** mock Anthropic Sonnet response with `usage: { input_tokens: 1500, cached_input_tokens: 1000, output_tokens: 200 }`; assert `input_usd` covers 500 fresh tokens at $3/MTok, `cached_input_usd` covers 1000 at $0.30/MTok, `output_usd` covers 200 at $15/MTok.
32. **Cost missing for unknown model:** custom alias `'exotic'` pointing to a provider with no pricing; assert `result.cost` undefined and exactly one `pricing_missing` trajectory event.
33. **Cost zero for local providers:** `generate({ model: 'ollama:gemma3:27b' })` with no pricing; assert `result.cost` present with all fields zero (not `undefined` — Ollama is a free provider).
34. **User-overridden pricing applied:** `register_price('anthropic', 'claude-opus-4-7', { input_per_million: 0, output_per_million: 0 })`; call; assert `total_usd === 0` even though `DEFAULT_PRICING` has non-zero rates. Confirms override precedence.
35. **Partial usage fields omit cost components:** mock OpenAI response with only `input_tokens` and `output_tokens`; assert `CostBreakdown` has only `input_usd`, `output_usd`, `total_usd`, `currency`, `is_estimate`; no cache keys.

### Architectural validation (see `constraints.md` §7 for the mechanically-checked list)

- The engine's public surface (`create_engine`, `generate` signature, types in §5) is stable across implementation swaps. An experimental non-Vercel-SDK implementation must pass the test suite with zero changes to test files.
- No file in `packages/engine/src/` contains a value import from `@robmclarty/core`; `import type { ... } from '@robmclarty/core'` is permitted. Enforced by an ast-grep rule.
- No `class` / `extends` / `this` anywhere in `packages/engine/src/`, with one scoped exception: `packages/engine/src/errors.ts` may declare `class <name> extends Error` for the typed errors enumerated in §5.
- `zod` and `ai` are the only production dependencies in `packages/engine/package.json`; all `@ai-sdk/*` and local-provider packages are optional `peerDependencies`.

### Learning outcomes (after shipping v1)

- Which providers get daily use? Which are installed but never invoked?
- Is `effort` used consistently, or do most calls leave it at `'none'`?
- Does `schema_repair_attempts: 1` earn its complexity, or should it be zero (throw on first failure) or higher?
- Does sequential tool execution ever bite in practice (justifying the §13 parallel-tool work)?
- Does `tool_error_policy: 'feed_back'` as default produce better agentic loops than `'throw'`?
- How often does the retry policy save a run vs merely delay an eventual failure?
- Are the shipped default prices stale enough in practice that users override them routinely, or do the defaults hold up for a quarter or more?

---

## §11 — File Structure

```
packages/engine/
├── package.json
├── README.md
└── src/
    ├── index.ts                      # public re-exports: create_engine, types, errors
    ├── types.ts                      # GenerateOptions, GenerateResult, Tool, Message,
    │                                 #   StreamChunk, ToolCallRecord, StepRecord,
    │                                 #   EffortLevel, FinishReason, RetryPolicy,
    │                                 #   AliasTarget, AliasTable, Pricing, PricingTable,
    │                                 #   CostBreakdown, UsageTotals, EngineConfig, Engine
    ├── errors.ts                     # aborted_error, rate_limit_error, provider_error,
    │                                 #   schema_validation_error, tool_error,
    │                                 #   tool_approval_denied_error,
    │                                 #   model_not_found_error, provider_not_configured_error,
    │                                 #   engine_config_error, on_chunk_error,
    │                                 #   provider_capability_error
    ├── create_engine.ts              # factory
    ├── generate.ts                   # main generate() implementation
    ├── tool_loop.ts                  # tool-call loop orchestration
    ├── schema.ts                     # schema handling + repair
    ├── streaming.ts                  # on_chunk dispatch, chunk normalization
    ├── retry.ts                      # retry policy logic
    ├── usage.ts                      # usage aggregation helpers
    ├── pricing.ts                    # DEFAULT_PRICING, FREE_PROVIDERS, compute_cost,
    │                                 #   register_price / resolve_price / list_prices helpers
    ├── trajectory.ts                 # span / record helpers bound to TrajectoryLogger
    ├── aliases.ts                    # DEFAULT_ALIASES, resolution algorithm
    ├── providers/
    │   ├── registry.ts               # provider name → adapter factory map
    │   ├── anthropic.ts              # wraps @ai-sdk/anthropic
    │   ├── openai.ts                 # wraps @ai-sdk/openai
    │   ├── google.ts                 # wraps @ai-sdk/google
    │   ├── ollama.ts                 # wraps ai-sdk-ollama
    │   ├── lmstudio.ts               # wraps openai-compatible adapter
    │   └── openrouter.ts             # wraps @openrouter/ai-sdk-provider
    ├── generate.test.ts              # colocated unit tests (constraints §9)
    ├── tool_loop.test.ts
    ├── schema.test.ts
    ├── streaming.test.ts
    ├── cancellation.test.ts
    ├── retry.test.ts
    ├── aliases.test.ts
    ├── pricing.test.ts
    └── providers/
        ├── anthropic.test.ts
        └── ...
└── test/
    └── integration/
        └── with_composition.test.ts  # cross-layer harness
```

Public surface from `packages/engine/src/index.ts`: `create_engine`, all types from `types.ts`, all errors from `errors.ts`. Provider adapters are internal. Shared runtime types (`TrajectoryLogger`, `TrajectoryEvent`, `RunContext`) live in `packages/core/src/types.ts` and are imported by the engine via `import type { ... } from '@robmclarty/core'`.

The package is consumed as `@robmclarty/engine` directly, or via the `@robmclarty/agent-kit` umbrella's star re-export.

---

## §12 — Configuration Source

The engine reads no environment variables and has no configuration files. All config flows through `create_engine(config)`. Applications that want env-driven configuration read env in their own bootstrap and pass values to `create_engine`. This is a hard rule — see `.ridgeline/constraints.md` §2 Code Style and §7 rule 3 (no `process.env` reads in any `packages/*/src/` file).

By convention, applications read these env vars and pass them into the engine config:

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `GOOGLE_API_KEY` | Google Gemini |
| `OPENROUTER_API_KEY` | OpenRouter |
| (none — base_url only) | Ollama, LM Studio |

The engine itself has no opinion about how these get from the environment to `create_engine`. That layering keeps the engine pure.

---

## §13 — Open Questions

1. **Response caching.** Engine-level cache keyed on `{ provider, model_id, messages, tool schemas, sampling params, schema hash }`. Composition layer's `checkpoint` already covers at-rest deduplication of step outputs; engine cache would help only when the same prompt hits across different steps. Defer until an evaluation harness or similar shows up.
2. **Local-only batching.** Ollama and LM Studio support batched requests. Could cut latency for concurrent calls. Composition `parallel` handles concurrency at a higher level. Revisit when local hardware actually bottlenecks.
3. **Parallel tool execution within a turn.** Cuts tool-heavy turn latency. Complicates abort semantics (partial cancellation) and error ordering. Deferred.
4. **Per-token trajectory recording flag.** Volume concern at v1. A debug flag for short diagnostic runs would be useful.
5. **Streaming reasoning as a separate channel.** Currently `StreamChunk` carries `kind: 'reasoning'`. Some consumers may want `on_reasoning_chunk` distinct from `on_chunk`. Branch on `chunk.kind` for now.
6. **MCP integration.** Tools discovered from an MCP server should be usable in `tools` without manual wrapping. Belongs to a separate MCP spec; the adapter that converts MCP definitions to plain `Tool` objects is out of scope here.
7. **Provider capability negotiation.** Some features (image inputs, native structured output, tool calling) are provider-dependent. V1 throws `provider_capability_error`. A richer `engine.capabilities('gemini-flash')` query is deferred.
8. **Pricing data freshness.** `DEFAULT_PRICING` is baked in at release. A published subpath (`@robmclarty/agent-kit/pricing`) with quarterly-refreshed defaults, or a runtime fetch from a canonical URL, would reduce drift. Promote if the §10 learning outcomes show users routinely overriding.
9. **Non-USD currencies.** `currency` is reserved at `'USD'`. FX is out of scope; users multiply at the consumption layer.
10. **Tokenizer-aware cost pre-estimation.** A `dry_run: true` mode that returns `CostBreakdown` from input-token counting without the call. Pre-estimation reliability suffers when tokenizers change (Opus 4.7's up-to-1.35x increase). Deferred.
11. **Partial result return on abort.** Currently `aborted_error` only. An opt-in `return_partial_on_abort: true` returning `{ content: <so-far>, finish_reason: 'aborted' }` would help save-what-you-have UX. Deferred.
12. **Custom repair prompt template.** V1 uses a canned message. A user-supplied template would allow domain-specific guidance. Deferred.
13. **Cross-provider feature parity shims.** Normalization is v1; an escape-hatch `raw_provider_usage` field on the result is deferred.
14. **Hot-swapping providers mid-call.** Composition `fallback` covers cross-call failover. In-engine model swap overlaps with `fallback`; keep at composition for now.

---

## Prompt for fresh context window — Implement both layers

> You are implementing `@robmclarty/agent-kit`, a TypeScript library for composing agentic workflows. Two specs define the full scope:
>
> - `docs/agent-kit-composition-layer-spec.md` — the composition layer.
> - `.ridgeline/builds/ai/spec.md` (this file) — the AI engine layer.
>
> **Required reading before writing any code, in this order:**
>
> 1. `docs/agent-kit-composition-layer-spec.md` — full composition layer.
> 2. `.ridgeline/constraints.md` — project-wide non-negotiables (covers both layers).
> 3. `.ridgeline/taste.md` — project-wide design philosophy. Consult before any judgment call.
> 4. `.ridgeline/builds/ai/spec.md` — engine layer surface (this file): `create_engine`, `generate`, alias and pricing tables, tool-call loop, streaming, error model, cost computation.
>
> Read all four documents before writing any code. The specs are the contract.
>
> **Reference prior art** (patterns already validated, not code to copy): `../../../../../../ridgeline/code/ridgeline/src/engine/`. Useful for the process-lifecycle / cleanup patterns and the single-options-object shape (`InvokeOptions`). Ridgeline wraps the `claude` CLI binary; agent-kit wraps Vercel AI SDK v6.
>
> **Build order:**
>
> Phase 1: shared foundation already exists.
> - `packages/core/src/types.ts` already defines `TrajectoryLogger`, `TrajectoryEvent`, `RunContext`. The engine imports these via `import type { ... } from '@robmclarty/core'`. No new root-level `src/types.ts` file is created.
>
> Phase 2: engine internals.
> - `packages/engine/src/types.ts` — all engine types per §5
> - `packages/engine/src/errors.ts` — typed errors as `class <name> extends Error` (scoped exception per constraints §2)
> - `packages/engine/src/aliases.ts` — `DEFAULT_ALIASES`, resolution
> - `packages/engine/src/pricing.ts` — `DEFAULT_PRICING`, `FREE_PROVIDERS`, `compute_cost`
> - `packages/engine/src/providers/` — one file per provider; `registry.ts` dispatcher
> - `packages/engine/src/streaming.ts` — chunk dispatch with error containment
> - `packages/engine/src/retry.ts` — retry policy
> - `packages/engine/src/schema.ts` — schema parse + repair
> - `packages/engine/src/tool_loop.ts` — sequential tool dispatch with abort checks
> - `packages/engine/src/generate.ts` — orchestrates loop, schema, cost, trajectory
> - `packages/engine/src/create_engine.ts` — factory; per-engine alias and pricing tables
> - `packages/engine/src/index.ts` — public exports only
> - `packages/engine/src/*.test.ts` — colocated unit tests; mock at AI SDK boundary or via `msw`
>
> Phase 3: composition layer is already built (see `packages/core/`).
>
> Phase 4: integration.
> - `packages/engine/test/integration/engine_in_step.test.ts` — `generate` inside a `step` run via the runner, with `ctx.abort` passed as `abort` and `ctx.emit` called from `on_chunk`. Cost events accumulated from `trajectory`.
>
> **Invariants to enforce** (see `.ridgeline/constraints.md` §7 for the full list):
> - `packages/core/src/` never imports from `@robmclarty/engine`. `packages/engine/src/` never imports values from `@robmclarty/core`; `import type { ... } from '@robmclarty/core'` is permitted.
> - Provider SDK packages imported only inside `packages/engine/src/providers/`.
> - No `class`, `extends`, or `this` anywhere in source except the scoped exception `packages/engine/src/errors.ts` (typed errors extending `Error`).
> - No `process.env` reads anywhere in `packages/engine/src/`.
> - `snake_case` for variables, functions, parameters, files; `PascalCase` for type aliases and interfaces; `SCREAMING_SNAKE_CASE` for module-level constants.
> - Every async function performing I/O accepts or closes over an `AbortSignal`.
> - `generate` is the only callable function exported from `packages/engine/src/index.ts` that performs model calls. `create_engine`, `register_*`, `resolve_*`, `list_*` are also exported.
>
> When in doubt, the spec wins over intuition. Implement the simpler interpretation; mark anywhere you diverge with a `TODO` comment citing the spec section.

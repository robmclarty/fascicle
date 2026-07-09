---
title: The AI SDK, vendor sovereignty, and the provider-integration-depth model
status: draft
date: 2026-07-08
author: rob
tags: [strategy, positioning, providers, engine, ai-sdk, sovereignty]
---

# The AI SDK, vendor sovereignty, and provider integration depth

Background note for [`provider-sovereignty-spec.md`](../provider-sovereignty-spec.md).
It captures the research and the argument behind that spec: what the Vercel AI SDK
actually gives us, what we already own on top of it, where the dependency is load
bearing versus incidental, and a taxonomy of provider integration depth that the
spec turns into code. Sibling reading: [`2026-04-competition.md`](./2026-04-competition.md)
and [`2026-06-strands.md`](./2026-06-strands.md) (the "who drives the loop" axis),
and the `ai` build spec at [`.ridgeline/builds/ai/spec.md`](../../.ridgeline/builds/ai/spec.md).

## The question that started this

If we want to keep fascicle sovereign, what are we giving up by not adopting the AI
SDK's newer agentic features, and is that worth it? The honest first move was to
notice the question is mis-framed. Fascicle is **already** built on the AI SDK: the
peer deps pin `ai ^6.0.0` plus eight `@ai-sdk/*` providers, and seven of the eight
built-in providers are AI-SDK-backed. "Sovereign vs. adopt" was never the choice.
The real choice is **at which layer** we let Vercel own code.

The current boundary is drawn at the *model call*. `tool_loop.ts` is explicit that
the loop does not itself call the AI SDK; it consumes a single-turn `invoke_once`
seam that `generate.ts` builds from `generateText` / `streamText`. Everything above
that seam (the multi-step loop, salvage, approval gating, `ends_turn`, cost,
trajectory, retry) is ours and provider-neutral. Everything below it, for seven of
eight providers, is Vercel's.

## What the AI SDK's agentic layer actually is

AI SDK 6 ships a real agent abstraction (v7 is now GA, 2026-06-25, and extends it
with `WorkflowAgent` and `HarnessAgent`; the tactical v7 accounting lives in
[`2026-07-ai-sdk-v7-upgrade-and-capability-triage.md`](./2026-07-ai-sdk-v7-upgrade-and-capability-triage.md)).
It is worth being precise about it, because
"their new agentic features" is exactly the competing implementation of the layer we
already own:

- **`Agent` interface / `ToolLoopAgent`.** The default production tool loop: call the
  model, run tools, feed results back, stop when the model finishes or a condition
  fires. This is our `run_tool_loop` + `define_agent`.
- **`stopWhen`.** Stopping conditions (`stepCountIs`, `hasToolCall`, and custom
  predicates such as a cost cap). Default is `stepCountIs(20)`. This is our
  `max_steps` + `Tool.ends_turn`.
- **`prepareStep`.** A hook to mutate model / tools / messages *between* steps
  (dynamic model routing, tool gating). **We do not have this.** It is a genuinely
  useful primitive and a clean addition to our own loop, not a reason to adopt theirs.
- **`pruneMessages` / compaction.** Context-window management for long loops.
  **We do not have this either.** Same verdict: borrow the idea as a loop hook.
- **`activeTools`, tool-call repair, MCP client, the UI message stream protocol.**
  We already bridge the last one in `fascicle/ui`; that is a *wire format* worth
  being compatible with, not a control plane worth surrendering.

So the complete list of what we forgo by *not* adopting their agent layer is: free
maintenance of a loop we already have, an ecosystem-familiar API, and two real
primitives (`prepareStep`, `pruneMessages`) that are additive hooks rather than
architecture. The rest would be reimplementing what we already own.

## Where the dependency is load-bearing vs. incidental

The uncomfortable, honest accounting: **the "provider neutrality" benefit is today
realized by exactly one provider.** Seven of eight built-ins are `kind: 'ai_sdk'`.
Only `claude_cli` (`kind: 'subprocess'`) owes nothing to the SDK. If `claude_cli`
did not exist, every model call would already flow through Vercel, and the
sovereign-loop argument would rest entirely on loop *semantics*, not provider
diversity.

But the loop semantics are not incidental, and one of them is decisive for local
models:

- **`tool_call_salvage` is not the same as tool-call repair.** The AI SDK's
  `experimental_repairToolCall` fixes a *structured* tool call whose arguments are
  malformed. Fascicle's salvage recovers a tool call the model emitted as **plain
  prose with zero structured calls** (`finish_reason: 'stop'`, `tool_calls.length
  === 0`, tools present). That is the dominant failure mode of quantized local
  models, and it is precisely the case repair cannot touch. Salvage is a large part
  of why tool loops work at all on Ollama / LM Studio / MLX under fascicle, and it
  lives in our loop, not theirs.
- **Fail-closed approval, deterministic `finish_reason`, per-step clamping,
  `Tool.ends_turn`.** Product-grade control semantics that are ours and are
  mutation-tested.

The rest of what the SDK gives us *is* incidental in the sense that it is
replaceable: message translation, tool-schema mapping, SSE parsing, usage
normalization, and error classification. Replaceable does not mean free (see the
cost section of the spec), but it means the dependency there is a convenience, not a
lock-in.

## The churn tax is real

Depending on the AI SDK's public surface has a running cost we have already paid in
small ways. v5 → v6 renamed `maxSteps` → `stopWhen` and turned `Agent` from a class
into an interface. We had to *disable the SDK's internal retry* (commit `207c2be`,
`maxRetries: 0`) because its default fought our own `retry_with_policy` and inflated
round-trips. The branch this work sits on is even named `ai-sdk-v7` while the peer
dep still says `^6.0.0` — we track their majors closely because we have to.

The lesson is not "drop the SDK." It is "keep the SDK's blast radius contained to a
thin, swappable seam." Owning the loop already does this for the control plane. The
spec extends the same containment to the *model call* so that a breaking change in
`generateText` can no longer reach our most important providers.

## Can the AI SDK run local models? Yes, three ways, and we already ship it

- **Ollama** — community `ai-sdk-ollama` provider (our `ollama.ts`), or Ollama's
  OpenAI-compatible endpoint at `:11434/v1`.
- **LM Studio** — `createOpenAICompatible` pointed at `:1234` (our `lmstudio.ts` is
  exactly this).
- **MLX** — no dedicated provider, but `mlx_lm.server` / `mlx-omni-server` expose an
  OpenAI-compatible endpoint. Our `lmstudio.ts` pattern already covers it; a named
  `mlx` provider would be a near-copy with a different default `base_url`.

Local support is not a gap. What makes it *reliable* under fascicle is salvage, which
is ours regardless of provider. The keywords in `package.json` already advertise
`ollama` and `lmstudio`; MLX is a cheap addition when wanted.

## The core insight: three depths of provider integration

The most useful thing to fall out of this research is a taxonomy. There is not one
way to integrate a provider; there are three, distinguished by *who owns the loop*.
This is the same "who drives the loop" axis as the Strands note, applied inward to
our own provider seam.

1. **Single-turn driver (deepest fascicle value).** The provider does exactly one
   model call and returns a neutral turn result; fascicle owns the loop. Anything
   plugged in here inherits salvage, approval, `ends_turn`, cost, trajectory, and
   retry for free. **Today only the AI SDK fills this slot, and it is hard-wired
   into `generate.ts` rather than pluggable.** That hard-wiring is the thing that
   makes us look like a wrapper.
2. **Self-orchestrating runtime.** The provider owns its own loop; fascicle collects
   the result. Correct for genuine agent runtimes (`claude_cli` today; an A2A / HTTP
   agent endpoint tomorrow). This is `kind: 'subprocess'`, mis-named because nothing
   about it is subprocess-specific.
3. **The AI SDK adapter** — currently privileged as *the* default path for depth 1,
   when it should be one implementation of it.

The whole spec is the consequence of taking this taxonomy seriously: generalize
depth 1 into a pluggable `native` seam, demote the AI SDK to one implementation of
it, open the registry so consumers can add providers at any depth, and prove it with
a raw-HTTP Anthropic provider that imports zero Vercel code and still gets the full
loop.

## A litmus test for depending on any framework

The user's stance is "other frameworks are fine if they themselves offer alternative
paths." The taxonomy gives that a crisp test:

> Depend on a framework only if it lets you call **one turn** below its own loop. If
> it insists on owning the loop (as `ToolLoopAgent` does), it can only ever be a
> depth-2 self-orchestrating provider, and you lose salvage / approval / `ends_turn`.

That single question — *can I get at a per-call primitive, or does it force its loop
on me?* — decides whether a framework keeps us sovereign or captures us. The AI SDK
passes it (`generateText` is below `ToolLoopAgent`). That is exactly why we can keep
using it as a depth-1 backend while refusing its depth-2 agent layer.

## Strategic framing (the part that is not technical)

Two scoreboards, and conflating them is the actual trap:

- **As a bid to win community mindshare against the AI SDK:** a losing battle, and no
  amount of craft changes it. Distribution decides dev-tool adoption, and Vercel has
  distribution we do not. We should stop scoring ourselves this way.
- **As production personal infrastructure** (a dozen agents plus real work projects
  shipping soon): a different and winnable game. It does not need to beat Vercel; it
  needs to make our own apps faster and vendor-portable, insulate them from a
  dependency we have already had to fight, and stay legible a month later. On that
  scoreboard it is arguably already succeeding.

The one honest *community* thesis available, if we ever want it, is to own the niche
the funded players structurally cannot: "the minimal, functional, provider-sovereign
agent toolkit for people who refuse vendor lock-in and want local models to actually
work." Planting that flag is a distribution problem, not an engineering one. The spec
serves the personal-infrastructure scoreboard first; it happens to also be the
strongest possible substantiation of the community thesis if we choose to pursue it.

## Why this is worth doing even though 7/8 providers stay on the SDK

Adding more `ai_sdk`-kind providers *deepens* the Vercel dependency; it does not
reduce it. Only depth-1 `native` providers and depth-2 non-SDK runtimes reduce it.
The spec is therefore deliberately weighted toward: (a) the seam that makes native
providers possible and uniform, and (b) two native providers (Anthropic, OpenAI)
that move our most important paths off the SDK. After that, the AI SDK is a
convenience for the long tail, not the substrate for the core.

The cost is real and named in the spec (each native provider re-implements what the
SDK gave us). The benefit is a codebase where "swap or drop the AI SDK" is a
per-file change behind a stable seam, rather than a rewrite — which, given the churn
tax, has non-trivial expected value.

## Open questions

- **Do we ever flip the default `transport` to `native` for anthropic / openai?** The
  spec keeps `ai_sdk` the default to avoid breakage; the native path has to earn the
  flip with real production mileage and parity tests.
- **`prepareStep` and `pruneMessages` as native loop hooks.** Genuinely useful,
  genuinely additive. Worth their own small spec once the provider work lands; noted
  as out of scope here so this effort stays focused.
- **A2A / HTTP self-orchestrating agents as depth-2 providers.** The rename of
  `subprocess` → a runtime-neutral kind opens this door; whether we walk through it
  depends on whether a real use case shows up.

## Sources

- [AI SDK 6 announcement](https://vercel.com/blog/ai-sdk-6)
- [Agents: Loop Control (`stopWhen`, `prepareStep`)](https://ai-sdk.dev/docs/agents/loop-control)
- [Agents: Overview (`Agent` interface, `ToolLoopAgent`)](https://ai-sdk.dev/docs/agents/overview)
- [Foundations: Providers and Models](https://ai-sdk.dev/docs/foundations/providers-and-models)
- [`ollama-ai-provider`](https://github.com/sgomez/ollama-ai-provider)
- [Ollama OpenAI compatibility](https://ollama.com/blog/openai-compatibility)
- Anthropic Messages API reference (for the native provider): https://docs.anthropic.com/en/api/messages
- OpenAI Chat Completions / Responses API reference (for the native provider): https://platform.openai.com/docs/api-reference

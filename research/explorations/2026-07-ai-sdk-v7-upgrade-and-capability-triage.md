---
title: AI SDK v7 — what shipped, what it costs us, and what to ride vs. decline
status: draft
date: 2026-07-08
author: rob
tags: [engine, ai-sdk, upgrade, sovereignty, providers, tools, research]
---

# AI SDK v7: upgrade research and capability triage

Background note for [`ai-sdk-v7-upgrade-spec.md`](../ai-sdk-v7-upgrade-spec.md). It
records what changed in the v6→v7 major, how much of that reaches fascicle, and a
ride/evaluate/decline verdict on each new capability. It is the tactical companion to
[`2026-07-ai-sdk-and-provider-sovereignty.md`](./2026-07-ai-sdk-and-provider-sovereignty.md)
— that note argues *where* to let Vercel own code; this one applies that argument to a
concrete version bump and reaches the same place from the other direction.

## What started this

Two questions, one session: *are the tools we intend to build on top of, or beside, the
AI SDK's tool capabilities — are we duplicating effort?* and *are we on the latest AI
SDK?* The tools question is answered in the sovereignty note and the code: fascicle's
`Tool` sits **on top of** the SDK's `tool()` helper, using it for schema declaration only
(`to_sdk_tools` passes `description` + `inputSchema`, never `execute`), and owns the loop
that runs tools. Not duplication — a different layer. The version question turned out to
matter more than expected, because checking it surfaced that **v7 is now GA and it is the
SDK moving up into our layer.**

## Where we actually are

`ai` peer dep pins `^6.0.0` (resolved `6.0.168`). npm `latest` is `ai@7.0.18`; even the v6
line has moved on (`6.0.221`). So we are a full major behind on the most load-bearing
dependency in the tree, and ~50 patches behind within v6. The `@ai-sdk/*` providers have
each shipped their v7-compatible majors (anthropic/openai/google on `^4`, bedrock on `^5`,
openai-compatible/openrouter on `^3`, ollama on `^4`). The exact numbers live in the
spec's §3.

## The finding that reframes the upgrade: v7 climbs into our layer

The `2026-04-competition.md` and Strands notes drew a "who drives the loop" axis. v7 is
Vercel deciding it drives the loop. Its marquee features are, almost one-for-one, the
things `tool_loop.ts` and the composites already own:

- **`ToolLoopAgent` (GA)** — the production tool loop. This is our `run_tool_loop` +
  `define_agent`. In v6 this was the `Agent` interface; v7 makes it a headline.
- **`WorkflowAgent` (`@ai-sdk/workflow`)** — durable, resumable, survives-deploys
  orchestration. This is the territory of our `sequence` / `parallel` / `checkpoint`.
- **`HarnessAgent`** — wraps external agent runtimes (Claude Code, Codex, OpenCode…)
  behind the SDK interface. Structurally our depth-2 `external` provider, inverted.
- **`toolApproval`**, **scoped tool context** (`toolsContext` / `contextSchema`), **agent
  runtime context**, **hardened approval replay**, **first-class timeouts** — the control
  plane. We own approval (`needs_approval`), context (`ToolExecContext`), and abort.

The litmus test from the sovereignty note still decides it cleanly:

> Depend on a framework only if it lets you call **one turn** below its own loop. If it
> insists on owning the loop, it can only ever be a depth-2 self-orchestrating provider.

v7 **passes** — `generateText` / `streamText` still sit below `ToolLoopAgent`. So we keep
using the SDK exactly as we do (a hard-wired depth-1 turn driver, single-step pinned), and
we decline the agent layer it is now pushing. The upgrade does not threaten the boundary;
it *sharpens why the boundary exists*. If anything, a release this focused on owning the
loop is the strongest argument yet for keeping our loop ours.

## Why this major costs us almost nothing

The pleasant surprise: the two ugliest v7 breakers do not apply, and most of the rest is
insulated by decisions already made.

- **Node 22+ required** — we are on Node `>=24` (CI on 24). No-op.
- **ESM-only, CommonJS removed** — we are already `"type": "module"`, `tsdown format:
  ['esm']`, NodeNext / ES2024. No-op.
- **`needsApproval`→`toolApproval` move; tool-context reshuffle** — non-issues, because we
  never hand `execute` or approval to the SDK. Sovereignty paid this bill in advance.
- **Multi-step usage/result aggregation changes** (`result.usage` now spans all steps,
  `finalStep.*` for last-step) — non-issues, because we pin `stopWhen: stepCountIs(1)`;
  every call is one step, so the aggregation semantics are identical.
- **UI-stream method→function deprecation** — non-issue; `to_ui_message_stream.ts` already
  uses the function forms (`createUIMessageStream`, `pipeUIMessageStreamToResponse`).
- **Usage token fields moved to nested `inputTokenDetails` / `outputTokenDetails`** —
  largely pre-absorbed; `generate.ts:134-144` already reads the nested shape via
  `Reflect.get`. Only the per-provider `normalize_usage` needs a look.

What is genuinely left is small and mechanical, three files, most of it codemod-driven:
`stepCountIs`→`isStepCount`, `experimental_output`→`output`, `fullStream`→`stream`,
`system`→`instructions`, a `normalize_usage` sweep, and a `map_chunk` review for the new
`reasoning-file` part. The spec's §3 has the anchors.

This is the churn-tax argument from the sovereignty note made concrete and, this time,
*in our favour*: the same "keep the SDK's blast radius contained to a thin, swappable seam"
posture that motivates the native-provider work is why a big v7 release lands as a
three-file diff. The more we owned, the cheaper the major.

## The output-schema clarification (correcting my own first framing)

I initially called the SDK's new `tool.outputSchema` / `toModelOutput` "the one place the
SDK has a capability we're not mirroring." That was imprecise. The SDK's `outputSchema`
only runs when the SDK **executes** the tool — and we never give it `execute`. In our
architecture the SDK never sees tool output at all: `execute` returns `o` →
`build_tool_result_message` (`tool_loop.ts:250`) → `role:'tool'` message → model. That
path is identical for every provider, the AI-SDK-backed ones and the non-SDK ones
(`claude_cli`, and the future `native` providers), because the provider only ever emits
the tool *call*; execution and output are 100% ours.

So there is no "AI-SDK-only" output use-case to handle. If we want output validation, it is
a **fascicle** field (`Tool.output_schema`) validated **once in `tool_loop.ts`**, uniform
across all eight providers — not an adoption of the SDK's feature. That is strictly more
sovereign than mirroring `outputSchema`, and it is Phase 4 of the spec.

## Ride / evaluate / decline

The rule: adopt what lives strictly *below* the turn seam (provider primitives); decline
what sits at or above it (orchestration).

| v7 capability | Verdict | Reason |
|---|---|---|
| Nested usage detail (`inputTokenDetails` / `outputTokenDetails`) | **Ride** | Required field move + richer cost data (cache-read, reasoning). Pure provider-level fact we already consume; probes already in place. |
| Provider-agnostic `reasoning` control | **Evaluate** | Genuinely below our line (maps to provider-native settings). Adopt only if it deletes per-provider effort branching without hiding capability. |
| Structured-output repair (malformed-JSON extraction) | **Evaluate** | Tension with our own schema-repair loop. Could thin it — but the plain-prose *salvage* case (zero structured calls) is ours regardless; measure before deleting. |
| First-class `timeout` budgets | **Evaluate → lean own** | An SDK-owned control. We already own abort; prefer per-tool/per-step budgets in `tool_loop.ts` over adopting the SDK's. |
| `generateSpeech` / `transcribe` (stable) | **Ride if needed** | Clean below-the-line primitives; add only when a flow needs audio. |
| `ToolLoopAgent` | **Decline** | Our loop. Adopting inverts the architecture. |
| `WorkflowAgent` (`@ai-sdk/workflow`) | **Decline (study)** | Our `sequence`/`parallel`/`checkpoint`. Borrow durability *ideas*, not the dependency. |
| `HarnessAgent` | **Decline** | Structurally our depth-2 `external` provider, inverted. |
| `toolApproval`, scoped tool context | **Decline** | We own `needs_approval` + `ToolExecContext`. |
| `@ai-sdk/otel` / `registerTelemetry` | **Decline (default)** | Keep trajectory sovereign; optionally bridge out to OTel later. |
| `DirectChatTransport`, realtime, video, MCP Apps | **Decline / defer** | Different interaction models / experimental; not engine concerns. |

The "decline" column is not conservatism — every one of those is a re-implementation of
something we already own and mutation-test, or a coupling to a wire we would rather bridge
than surrender. The "ride" column is exactly the incidental/replaceable substrate the
sovereignty note flagged as safe to depend on.

## How this relates to the sovereignty spec

Two specs, one dependency, complementary:

- **This one (tactical):** stay current on the SDK we do use, contain its churn, keep the
  agent boundary explicit. Near-term, low-risk, three files.
- **`provider-sovereignty-spec.md` (structural):** make "swap or drop the AI SDK" a
  per-file change behind a stable seam, by adding raw-HTTP `native` providers and opening
  the registry. Larger, durable.

Do the v7 upgrade first: it keeps the seven `ai_sdk`-backed providers current and gives the
native-provider work a clean v7 baseline to build against. The native work then reduces how
much rides on that baseline at all. Neither blocks the other.

## Open questions

- **Hard `ai@^7` floor vs. a v6/v7 compat window?** With pre-1.0 published-surface latitude,
  a hard `^7` floor avoids a dual-major support burden. Recommended.
- **Does v7 structured-output repair cover our failure modes?** The salvage case almost
  certainly stays ours; the *structured-but-malformed* case is what the spike (P5.2)
  measures.
- **Speech/transcribe now or on first need?** Lean "on first need" to avoid speculative
  surface, since they are clean primitives to add later.

## Sources

- [Migrate AI SDK 6.x to 7.0](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0)
- [AI SDK 7 is now available (Vercel changelog)](https://vercel.com/changelog/ai-sdk-7)
- [Foundations: Tools](https://ai-sdk.dev/docs/foundations/tools)
- [Vercel AI SDK 7: The Production Agent Upgrade (Developers Digest)](https://www.developersdigest.tech/blog/vercel-ai-sdk-7-production-agents)
- npm dist-tags for `ai` and `@ai-sdk/*` (checked 2026-07-08): `ai@7.0.18` latest, `ai-v6@6.0.221`.
- Sibling note: [`2026-07-ai-sdk-and-provider-sovereignty.md`](./2026-07-ai-sdk-and-provider-sovereignty.md) and spec [`provider-sovereignty-spec.md`](../provider-sovereignty-spec.md).

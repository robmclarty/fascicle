---
title: "ADR: ride the AI SDK's provider layer, decline its agent layer"
status: accepted
date: 2026-07-10
author: rob
tags: [engine, ai-sdk, sovereignty, boundary, adr, decision-record]
---

# ADR: ride the AI SDK's provider layer, decline its agent layer

Decision record for the fascicle/AI-SDK boundary, written ahead of the v6 to v7 bump
on purpose: an upgrade is the moment a boundary is easiest to blur by accident, when a
contributor reaches for a shiny new API and the engine quietly hollows out. This
record turns every "we don't use that" in the v7 work from an omission into a cited
decision.

It distills two research notes into one citable posture:
[`2026-07-ai-sdk-and-provider-sovereignty.md`](./2026-07-ai-sdk-and-provider-sovereignty.md)
(where the litmus test comes from) and
[`2026-07-ai-sdk-v7-upgrade-and-capability-triage.md`](./2026-07-ai-sdk-v7-upgrade-and-capability-triage.md)
(the full ride/evaluate/decline triage this record's tables are drawn from).

## Context

fascicle owns the agent loop. `run_tool_loop` drives multi-step execution;
`Tool.needs_approval` and fail-closed approval, `Tool.ends_turn`, salvage,
per-step clamping, cost, retry, and trajectory events are all loop policies
implemented in `src/engine/tool_loop.ts` and `src/engine/generate.ts`; the
composites (`sequence`, `parallel`, `checkpoint`) own orchestration above that.
The AI SDK's role is deliberately narrower: a single-turn model-call backend,
pinned to one step per call, with tool `execute` never handed to the SDK.

AI SDK v7 is Vercel climbing into that layer. Its headline features are, almost
one for one, the things fascicle already owns: `ToolLoopAgent` (GA), `WorkflowAgent`
durability, `HarnessAgent`, `toolApproval` with hardened replay, scoped tool context,
and agent runtime context. The upgrade itself is cheap (three coupled files, mostly
codemod); the real long-term risk is a later contributor adopting the agent layer and
inverting the architecture.

## Decision

fascicle rides the AI SDK as a **provider/primitive layer** and declines its
**agent layer** wholesale.

The rule that decides every case, the litmus test from the sovereignty note (D2 of
the build intent):

> Depend on a framework only if it lets you call **one turn** below its own loop. If
> it insists on owning the loop, it can only ever be a depth-2 self-orchestrating
> provider, and you lose salvage / approval / `ends_turn`.

Applied here: `generateText` / `streamText` **pass** the test (they sit below
`ToolLoopAgent`, one turn per call), so the SDK stays a legitimate depth-1 backend.
`ToolLoopAgent` and its siblings **fail** it (they insist on owning the loop), so
they are refused. Adopt v7 capabilities strictly *below* the turn seam (provider
primitives); decline v7 capabilities *at or above* it (orchestration).

## The declined v7 surface

Each declined API, what fascicle owns in its place, and the one-line reason:

| v7 API | fascicle already owns | Why declined |
|---|---|---|
| `ToolLoopAgent` (GA) | `run_tool_loop` + `define_agent` | Our loop; adopting it inverts the architecture and forfeits salvage, approval, and `ends_turn`. |
| `WorkflowAgent` (`@ai-sdk/workflow`) | `sequence` / `parallel` / `checkpoint` composites | Our orchestration; study its durability model for *ideas* toward our own `checkpoint`, never depend on it. |
| `HarnessAgent` | the depth-2 external-runtime provider (`claude_cli` today) | Structurally our depth-2 seam, inverted; external runtimes plug into fascicle, not the other way around. |
| `toolApproval` + hardened approval replay | `Tool.needs_approval` + fail-closed approval in the loop | Approval is a loop policy, and the SDK never executes fascicle tools (`execute` is never handed over), so its approval hook could never fire. |
| Scoped tool context (`toolsContext` / `contextSchema`) + agent runtime context | `ToolExecContext` | Execution context belongs to the layer that executes, and that layer is ours. |
| `@ai-sdk/otel` / `registerTelemetry` | trajectory events | Keep observability sovereign; optionally *bridge* trajectory out to OTel later, never couple the engine to it. |
| `DirectChatTransport`, realtime WebSocket, video generation, MCP Apps | not applicable | Different interaction models or experimental surface; not engine concerns. |

None of this is conservatism. Every row is either a re-implementation of something
fascicle already owns and mutation-tests, or a coupling to a wire we would rather
bridge than surrender.

## What is ridden, what is deferred

For completeness, the other two triage columns (full table in the
[capability triage note](./2026-07-ai-sdk-v7-upgrade-and-capability-triage.md)):

- **Ridden** (below the seam, safe substrate): `generateText` / `streamText` as the
  single-turn depth-1 backend; the `tool()` helper for schema declaration only; the
  nested v7 usage detail (`inputTokenDetails` / `outputTokenDetails`); the
  function-form UI-stream helpers; `generateSpeech` / `transcribe` on first audio
  need.
- **Deferred to spikes** (evaluate, never auto-adopt): provider-agnostic `reasoning`
  control, structured-output repair, first-class `timeout` budgets. Each is kept only
  if it deletes fascicle-owned code without adding coupling; each spike ends in a
  written keep-or-discard verdict.

## Consequences

- The v7 upgrade proceeds as a provider-layer bump: the four `generate.ts` renames,
  the usage-shape sweep, and the `map_chunk` review. No declined API appears in the
  tree; a PR that reaches for one is rejected by citing this record.
- Invariant 13 (`.ridgeline/constraints.md`) keeps `generateText` / `streamText`
  confined to their whitelisted call sites; the provider-sovereignty build later
  narrows that further so only the `ai_sdk` provider module may call them.
- `no-engine-npm-dep-except-ai-zod` holds: `@ai-sdk/workflow` and `@ai-sdk/otel` are
  never added as dependencies.
- Revisit trigger: this record stands while the litmus test keeps deciding the same
  way. If a future SDK major removes the per-turn primitives below its loop, the SDK
  fails the test entirely and the relationship question reopens (by then the native
  provider seam makes that survivable).

## Sources

- [`2026-07-ai-sdk-and-provider-sovereignty.md`](./2026-07-ai-sdk-and-provider-sovereignty.md),
  the depth taxonomy and the litmus test.
- [`2026-07-ai-sdk-v7-upgrade-and-capability-triage.md`](./2026-07-ai-sdk-v7-upgrade-and-capability-triage.md),
  the v7 breaking-change matrix and the full ride/evaluate/decline table.
- [`../ai-sdk-v7-upgrade-spec.md`](../ai-sdk-v7-upgrade-spec.md) §9, the declined
  surface this record makes citable.
- [`../provider-sovereignty-spec.md`](../provider-sovereignty-spec.md), the
  structural companion (native providers, open registry, the seam inversion).

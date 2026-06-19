---
title: Strands Agents — a neighbor the competition note missed
status: draft
date: 2026-06-18
author: rob
tags: [strategy, positioning, competition]
---

# Strands Agents

An addendum to [2026-04-competition.md](./2026-04-competition.md). When I wrote that
map I left out Strands, and it is too close a neighbor to leave off — an AWS-backed,
open-source agent SDK that landed Python in May 2025 and TypeScript in preview in
December 2025. This note places it on the same five axes and is honest about the
one thing I have not done: I have not built a harness on Strands. This is a read of
the docs and the launch posts, which is the bar I'd want before committing years to
fascicle over it, not a lived-experience verdict.

## What it is

Strands is built around a *model-driven* loop. You construct an `Agent` from three
things — a model, a system prompt, and a set of tools — and hand it a task; the
model itself decides what to do, which tools to call, and when it is done. The pitch
is that modern models are good enough at reasoning that you should let the model
drive the agent loop instead of hand-wiring the control flow. Tools are plain
functions (a `@tool` decorator in Python); MCP tools are first-class.

Strands 1.0 (mid-2025) pushed the same idea into multi-agent territory: new
primitives for swarms, graphs, and agents-as-tools, plus support for the
agent-to-agent (A2A) protocol. Context management, execution limits, sessions /
persistence, structured output, streaming, and OpenTelemetry observability are all
built in. It is model-agnostic — Bedrock, Anthropic, Ollama, Meta/Llama, OpenAI,
and the long tail via LiteLLM — though the AWS/Bedrock path is the home turf.
Apache-2.0, with outside contributors (Anthropic, Meta, Accenture, PwC, and others).

## On the five axes

1. **Unit of composition.** An `Agent` (model + prompt + tools). Multi-agent
   structure is expressed with swarm/graph/agents-as-tools primitives. Agent-centric,
   not step-as-value.
2. **Registry vs. values.** Closer to values than Mastra — there is no single
   central object you register everything into — but the composable unit is still an
   `Agent`, not an arbitrary function.
3. **Framework vs. library.** A library/SDK you call, not a lifecycle framework. But
   "model-driven" means the *loop itself* is owned by the model, and a lot of
   machinery (context window management, execution limits, sessions, telemetry) is
   built in. Library-shaped, broad-bodied.
4. **Breadth vs. depth.** Broad. Multi-agent orchestration, A2A, MCP, sessions,
   structured output, observability — batteries included, production-positioned.
5. **Transport awareness.** Many providers plus MCP, but transport is SDK/HTTPS and
   MCP. No subprocess-CLI-as-provider in the way fascicle treats `claude_cli`.

Fascicle's answers, for contrast: `Step` values, no registry, library, narrow,
HTTPS + subprocess first-class.

## Where it overlaps

Both compose LLM work into runnable things. Both are model-agnostic and lean on the
same provider universe. Both now (or soon, for TS) live in TypeScript. Both have
streaming, structured output, and an observability story. On the surface pitch —
"build agents without hand-rolling the plumbing" — we are selling to overlapping
audiences.

## Where it diverges

The divergence is the cleanest of any neighbor in the competition note, because it
is a single, load-bearing disagreement: **who drives the loop.**

- **Model-driven vs. author-composed.** Strands' bet is that the model should plan
  and orchestrate; you supply tools and trust it. Fascicle's bet is the opposite —
  the author composes the control flow explicitly out of `Step` values (`sequence`,
  `branch`, `loop`, `ensemble`, `adversarial`, …), and a model call is one component
  among plain functions. Strands maximizes model autonomy; fascicle maximizes
  author legibility. Neither is "correct"; they are different theories of where the
  reliability comes from.
- **Agent-centric vs. step-as-value.** Same shape as the OpenAI Agents SDK
  divergence, more so. The unit is an `Agent`, not a substitutable `Step`, so the
  "anything that fits a step fits any composition" invariant doesn't hold.
- **Broad vs. narrow.** A2A, swarms, sessions, context management — Strands covers
  the adjacent concerns. Fascicle ships 18 primitives and one `generate`.
- **Python-first vs. TS-native.** Strands' Python is mature; its TypeScript is a
  December-2025 preview. Fascicle is TS-only and treats that as a bet, not a
  compromise.
- **Transport.** Fascicle's first-class subprocess provider (`claude_cli`) has no
  peer in Strands' SDK-plus-MCP model.

## Honest take

Strands is a serious project with AWS distribution behind it, and the model-driven
framing is a real philosophical fork, not a feature checkbox. If you believe the
model should own the loop, fascicle will feel like it is making you do work the model
could do; if you believe the author should own the loop, Strands will feel like it is
hiding the part you most want to see and test. I am firmly on the author-owns-the-loop
side, which is why fascicle exists, but I want to be precise that this is a bet about
*where reliability comes from*, and Strands is betting the other way with real
conviction and real users.

The two are reconcilable in one direction: a model-driven Strands agent is exactly
the kind of thing fascicle would wrap as a single `Step` inside an author-composed
flow — drive a sub-task with Strands, then `retry` / `ensemble` / `checkpoint` it
from the outside. The reverse (composing fascicle steps inside a Strands agent loop)
is the awkward direction, because the model is in charge of when steps run.

This does not change fascicle's standing commitments (no registry, no framework
creep, no Python port). It does sharpen the one-line positioning: **fascicle is the
author-composed answer in a market drifting toward model-driven autonomy.** That is a
narrower bet than Strands is making, and on purpose.

## Open question

Worth a real spike, same as AgentKit: build the same small harness twice — once
model-driven on Strands, once author-composed on fascicle — and see which one I can
*read and predict* a month later. That is the only comparison that settles the bet,
and it is cheap to run.

## Sources

- [Introducing Strands Agents, an open-source AI agents SDK](https://aws.amazon.com/blogs/opensource/introducing-strands-agents-an-open-source-ai-agents-sdk/)
- [Strands Agents and the model-driven approach](https://aws.amazon.com/blogs/opensource/strands-agents-and-the-model-driven-approach/)
- [Introducing Strands Agents 1.0: production-ready multi-agent orchestration](https://aws.amazon.com/blogs/opensource/introducing-strands-agents-1-0-production-ready-multi-agent-orchestration-made-simple/)
- [Strands Agents SDK: a technical deep dive into agent architectures and observability](https://aws.amazon.com/blogs/machine-learning/strands-agents-sdk-a-technical-deep-dive-into-agent-architectures-and-observability/)
- [Announcing TypeScript support in Strands Agents (preview)](https://aws.amazon.com/about-aws/whats-new/2025/12/typescript-strands-agents-preview/)
- [strandsagents.com](https://strandsagents.com/) and the [MCP tools guide](https://strandsagents.com/docs/user-guide/concepts/tools/mcp-tools/)

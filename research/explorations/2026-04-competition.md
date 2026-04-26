---
title: Competition — who else is in the "compose LLM calls" space?
status: draft
date: 2026-04-24
author: rob
tags: [strategy, positioning, competition]
---

# Competition

## The question

Am I reinventing LangChain? Or LangGraph? Or Mastra? Or BAML? Or the Vercel AI SDK? Or AgentKit? Or one of the dozen other libraries that let you glue LLM calls into something that walks and talks like an agent?

I've tried several of these. Building a harness on top of Mastra felt heavy. LangChain's TypeScript side never felt finished and every path I took ran into class-laden inheritance that didn't compose the way I wanted. BAML was the most interesting of the three — but BAML isn't really a composition library, it's a schema/prompt DSL, and the compile-a-DSL loop was the wrong shape for how I like to iterate. In each case the thing I wanted was *smaller* than the thing I was given. Fascicle is what I ended up building after three failed attempts to make someone else's framework feel right.

This note is the map I wish I'd had before I started, and a defense — to future-me if nobody else — of why the shelf has room for another entry.

## How to map the space

"Compose LLM calls" is a blurry category. Before listing competitors I need axes, because the same project can look identical or totally different depending on which axis you squint along.

I think there are five that matter:

1. **Unit of composition.** Is the base type a function-ish value (`Step`, `Runnable`, `Flow`), a class instance (`Agent`, `Workflow`, `Chain`), or a DSL string? This predicts almost everything else about ergonomics.
2. **Registry vs. values.** Do I register my agents / workflows / tools into a central object and then look them up by name, or are they just values I import? This maps 1:1 to how hard testing and rewrites will be.
3. **Framework vs. library.** Does the thing own my process lifecycle (start/stop, init, shutdown), or is it something I call? Frameworks amortize cost across many applications; libraries amortize cost across calls within one application. The two are not interchangeable — and "framework" is not the default good choice.
4. **Breadth vs. depth.** Does the project try to cover every adjacent concern (retrievers, vector stores, memory, evals, playgrounds, tracing UI, hosted SaaS), or does it do one thing? Breadth sells better. Depth composes better.
5. **Transport awareness.** Does the thing know about more than one way to reach a model (HTTPS SDKs, subprocess CLIs, MCP), or does it assume everything is an SDK call?

Fascicle's answers are: (1) `Step<i, o>` values, (2) pure values — no registry, (3) library, (4) narrow — just composition + engine, (5) yes — HTTPS SDKs and subprocess (Claude CLI) are both first-class, with MCP deferred.

The closer a candidate sits to fascicle on these five axes, the more seriously I have to take it as overlap. The further, the more likely it's a complement or a different category entirely.

## Direct neighbors (the honest overlap)

### LangChain + LangGraph

**What it is.** LangChain is the granddaddy: a large, batteries-included framework for LLM-powered applications. LangGraph is the newer state-graph layer for stateful agents with checkpoints, edges, and cycles. Together they are the obvious reference point.

**Where it overlaps with fascicle.** LCEL — LangChain Expression Language — is genuinely similar in spirit to `sequence`: you write `prompt | model | parser` and it reads top-to-bottom. LangGraph's checkpointer maps to my `CheckpointStore`. Both projects abstract over providers. Both emit traces.

**Where it diverges.**
- **Framework, not library.** LangChain has a lifecycle. Chains have `invoke`, `batch`, `stream`, `ainvoke`, `astream`, `astream_events`, `astream_log`. Each of those is a method on a base class. Fascicle has `run(flow, input)` and `run.stream(flow, input)`. One is surface; the other is a surface-expanding machine.
- **Class-centric inheritance.** `Runnable`, `RunnableSerializable`, `BaseChatModel`, `BaseTool`, `BaseOutputParser`, `BaseRetriever`, `BaseMemory`. Fascicle has no base classes except `Error`. This is not snobbery about OOP — it's that inheritance makes substitution hard to reason about, and substitution is the entire point of step-as-value.
- **Breadth.** LangChain ships vector stores, retrievers, memory backends, document loaders, output parsers, prompt templates, agent executors, graph builders, and a long tail of integrations. Fascicle ships 16 primitives and one `generate` function.
- **TypeScript is second-class.** LangChain's Python is where the roadmap lives. The TS port follows, usually incomplete, sometimes divergent. Fascicle is TS-native and there is no Python shadow.
- **LangSmith is a SaaS.** Observability is a separate product you send traces to. Fascicle's `TrajectoryLogger` is an interface with a filesystem JSONL implementation and a noop — anything else is your adapter. You can write a LangSmith adapter if you want; the core knows nothing about it.

**Honest take.** If I were building a customer support bot that needs to talk to a Pinecone index, a Zep memory store, and three SaaS integrations, I'd probably still reach for LangChain. The integrations bin is bigger and someone else maintains it. If I'm building a harness where the surface has to be readable, testable, and replaceable, LangChain is the wrong shape and LangGraph is the wrong shape for the wrong reason.

### Mastra

**What it is.** TypeScript-first AI framework. Has `Agent`, `Workflow`, `Tool`, memory, RAG, evals, observability, all wired into a central `Mastra` object.

**Where it overlaps.** Workflows with step composition. Provider abstraction via Vercel AI SDK (same as fascicle's engine). Tools. Streaming. A CLI.

**Where it diverges.** The central `Mastra` registry is exactly the pattern `.ridgeline/taste.md` principle 6 refuses by name: ambient state, a global registry, a singleton object you configure once and register into. Mastra's workflow builder is closer to a DAG builder than to step-as-value — `createWorkflow().step(...).then(...).branch(...)` returns a workflow, not a step, so the uniform "anywhere a step fits, any composition fits" invariant doesn't hold. It's a real project run by real people and I don't want to be unfair to it, but the thing I tried to build on it couldn't be expressed without pulling the whole framework along, and I kept writing adapter layers to get between Mastra's `Agent` shape and the shape my harness wanted.

**Honest take.** Mastra is closest to fascicle on axis (3) — both are libraries people install, not SaaS — but it lands on the framework end of the library/framework spectrum, and on registry-over-values. My lived experience: the two friction points that made me bail were (a) the Mastra object wanting to be the center of the graph and (b) `Workflow` not being substitutable with `Step`. Both are design choices, not bugs.

### Inngest AgentKit

**What it is.** TypeScript agent framework from the Inngest team. Has `Agent`, `Network`, `Tool`, `State`. Agents can be composed into networks with a router. Built on Inngest's durable execution engine.

**Where it overlaps.** Step-oriented. TS-first. Small surface. Philosophically adjacent.

**Where it diverges.** Durability is baked in via Inngest's runtime (you get retries, queueing, scheduling, horizontal scaling "for free", but you're buying into Inngest as infrastructure). Fascicle is an in-process library with no infrastructure requirement; durability comes from the `CheckpointStore` adapter and the `checkpoint` primitive, which you opt into per-step. Inngest AgentKit's unit of composition is an `Agent` (an LLM-backed thing) rather than a `Step` (any function), which makes "wrap this plain function in durable retries" a slightly different shape.

**Honest take.** AgentKit is the nearest philosophical neighbor I've found — small, TS-first, library-shaped, step-ish. The live-infrastructure coupling is a legitimate fork in the road: if you already run on Inngest, AgentKit is probably a better fit than fascicle. If you don't, fascicle is a zero-infrastructure library that runs in `node script.ts`.

### OpenAI Agents SDK

**What it is.** OpenAI's official agent framework, shipped in Python first and then TS. Primitives: `Agent`, `Runner`, `Tool`, `Handoff`, `Guardrail`. Small surface, strong opinions about multi-agent handoffs and tool loops.

**Where it overlaps.** Small surface area. Explicit about what it is. TS port exists. Tool loop abstraction.

**Where it diverges.** Agent-centric, not step-centric. The unit of composition is an `Agent` with a system prompt and tools; `Runner.run(agent, input)` drives the tool loop. Fascicle's unit is a `Step<i, o>` that might *contain* an LLM call and tool loop, or might be a plain function, or might be a composition of both. The two worldviews are compatible but not identical: an OpenAI-agent is roughly a fascicle step in the same way a C function is roughly a Haskell function — similar in shape, different in the algebra they compose under.

**Honest take.** If my whole product is "an agent with tools that talks to a user", OpenAI Agents SDK is a legitimate answer and probably a simpler path. The moment I want to wrap that agent in retry, or fan it out across an ensemble, or pipe its output into a judge loop with a different model, I'm back in composition-library territory. Which is where fascicle lives.

### Claude Agent SDK

**What it is.** Anthropic's SDK for building agents on top of Claude Code's tool loop. Lower-level than the others: file access, subagents, permissions, hooks. It's the thing Claude Code itself is built on.

**Where it overlaps.** Subprocess-adjacent. TS-native. Sits in the same neighborhood as the `claude_cli` adapter.

**Where it diverges.** It's a *lower layer*. Fascicle's `claude_cli` provider is built on top of the same territory — the Claude CLI binary — but presents it as "one more provider behind `engine.generate`". The Claude Agent SDK is what you'd use to build a harness around Claude's tool loop directly; fascicle is what you'd use to compose many such harnesses (plus non-Claude models) into a flow. I treat it as below fascicle, not beside it. A harness built on fascicle might drop down to the Claude Agent SDK for one step.

**Honest take.** Not competition. Potentially a consumer (if someone wants to run a Claude Agent SDK agent as a step inside a bigger fascicle flow) or a sibling (if someone is building directly on the Agent SDK, they're not in my market yet).

## Different-layer players

These get called "fascicle competitors" but they're actually at a different layer of the stack and I should be precise about why.

### Vercel AI SDK

Fascicle's engine layer uses the Vercel AI SDK under the hood for six of seven providers. It is the provider abstraction. It is not a composition library: it gives you `generateText`, `generateObject`, `streamText`, `streamObject`, and a bunch of hooks for tool loops. There's no `sequence`, no `parallel`, no `checkpoint`. It's the layer fascicle's engine sits *on*.

Competition? No. Ancestry.

### BAML

A DSL. You write `.baml` files describing functions that take typed inputs and return typed outputs, and the compiler generates client code in TS/Python/Ruby/etc. The win is schema-safe structured output with good prompt DX, retries, and tool calling. The cost is a compile step and a parallel vocabulary (`.baml` files) that lives outside your normal code.

BAML is not a composition library. You use it to *describe one LLM call at a time*. You'd still reach for something like fascicle to compose BAML-generated functions into a flow. (In fact, BAML functions are trivially wrappable as fascicle steps — that might be the most honest integration: `step('extract', boundary.Extract)`.)

**My lived experience.** I loved the BAML schema model and I hated the edit loop. Every change to a prompt went through a compile. My prompts are live, iterable text; adding a compiler between me and them felt like going backwards. This is a taste call; other people love it.

Competition? Not really. Potential upstream step author.

### LlamaIndex

RAG-first framework with a workflows system added later. The center of gravity is retrieval pipelines, not agent composition. If my problem is "ingest documents, chunk them, index them, retrieve over them, synthesize", LlamaIndex is the right tool. If my problem is "compose LLM calls, tools, and functions into a traceable flow", it isn't.

Competition? No. Adjacent problem domain.

### DSPy

Stanford-originated, Python-only, optimizer-first. Write a program in DSPy, define a metric, and DSPy compiles prompts by running a data-driven optimization. It is a fundamentally different bet: the value is not in the composition primitives but in the optimization loop.

Competition? No, and not just because it's Python-only. It's solving a different problem — "how do I *produce* good prompts given examples" vs "how do I *compose* LLM calls into a flow". The answers could coexist in the same stack.

### CrewAI / AutoGen

Role-based multi-agent frameworks. `Crew`, `Agent`, `Task`. High-level, opinionated about how agents should collaborate.

Competition? Not directly. Different worldview — "agents with roles" vs "steps that compose". A CrewAI-shaped problem (research crew of four specialist agents coordinating on one deliverable) is expressible in fascicle via `ensemble` or custom steps but not natively modeled. And that's fine — fascicle is not trying to be the framework for role-based agent societies.

### Pydantic AI

Python, Pydantic-schema-first, agent-centric. The Python analog of fascicle-adjacent thinking, with Pydantic's reputation for careful types. But Python, and agent-centric rather than step-centric.

Competition? Only in the sense that anyone writing Python isn't my user.

### PocketFlow

Python, minimalist (~100 LOC), `Node` / `Flow` primitives. Philosophically closest to fascicle's "small surface" ethos that I've seen — same instinct to refuse framework weight.

Competition? In spirit, yes. In practice, Python-only, and the surface is so small that it doesn't cover the things fascicle does cover (streaming as observation, subprocess provider lifecycle, checkpointing, adversarial/ensemble composers).

### Genkit

Google/Firebase's cross-language agent framework. Flows, tools, retrievers. Coupled to the Firebase/GCP ecosystem via hosted tracing and deployment tooling.

Competition? Adjacent, but the coupling to Firebase is a strong filter. If you're on GCP and using Firebase, Genkit is probably the right choice. If you're not, it imports an ecosystem you may not want.

### Motia

Newer, event-driven workflow engine. Step-based across languages (TS, Python). Live-reloading, UI. Crosses the line from "library" to "framework with infrastructure" earlier than fascicle does.

Competition? Weakly. Different fold in the design space (multi-language, hosted-dev-UI).

## Observability stack

This is a category I want to be careful about because "competition" is the wrong word entirely.

**Langfuse, LangSmith, Phoenix (Arize), Helicone, Braintrust, Traceloop / OpenLLMetry.**

These are tracing/eval/playground products (some SaaS, some open-source, some both). They are *not* composition libraries. They are consumers of events emitted by composition libraries.

Fascicle's `TrajectoryLogger` interface (see `packages/observability/`) is explicitly designed so that any of these can be implemented as an adapter. The noop and filesystem-JSONL implementations ship with the repo; Langfuse / LangSmith / Phoenix adapters are natural community add-ons. Competition framing: zero. Integration target framing: all of them.

One nuance worth recording: the existence of this layer is why fascicle does not — and must never — ship a hosted product of its own. The moment you have a SaaS, you have marketing pressure to tie the library to the SaaS, and the library's design starts optimizing for "drive people to the dashboard" rather than "do the one thing well." Fascicle is a library. The dashboards other people build are their business, and my job is to make the event stream good enough that building a dashboard on it is easy.

## Where fascicle is actually distinctive

After walking through all of that, here is what I think is genuinely unique — or at least unusually concentrated:

1. **Step-as-value as the single load-bearing invariant.** Every composable unit is a `Step<i, o>`; every composer takes steps and returns a step. This is not a slogan; it's the only rule I refuse to bend. LangChain violates it (`Runnable` is not a `Chain` is not an `Agent`). Mastra violates it (`Workflow` is not a `Step`). OpenAI Agents violates it softly (an `Agent` is a different type from a `Tool`). Fascicle bends every design decision around preserving it.

2. **Pass adapters per-run, not per-process.** `run(flow, input, { trajectory, checkpoint_store, abort })`. No global config, no `configure()` call, no singleton. Two concurrent tests in the same process don't interfere. The only package allowed to read `process.env` is `@repo/config`, enforced by an ast-grep rule. This is close to a religious position and I am not going to soften it.

3. **Streaming as observation, not a second vocabulary.** `run` and `run.stream` execute the same graph. Steps don't know which runner drives them. Fascicle is the only project I've found where this invariant is the spec.

4. **Subprocess providers are first-class.** The `claude_cli` adapter drives Claude Code itself as a provider, with detached-process-group lifecycle, SIGTERM→SIGKILL escalation, synchronous reap on Node exit. Nothing in the LangChain / Mastra / AI-SDK layer treats subprocess transport as a peer of HTTPS. It's either an afterthought or absent.

5. **Architectural enforcement as shipping gate.** `pnpm check:all` runs ast-grep rules that enforce no classes, no default exports, no `process.env` outside `@repo/config`, no provider SDK imports outside `packages/engine/src/providers`, no `child_process` outside `claude_cli`, plus fallow boundary checks and dead-code. This is the most aggressive linting regime I've seen in this category. The design intent doesn't drift because the linter won't let it.

6. **One npm package, umbrella-bundled.** Install `@robmclarty/fascicle`, get everything. No "pick 4 packages and align their versions" tax. Internal `@repo/*` boundaries stay for architectural hygiene but never reach users.

7. **Sixteen primitives, hand-selected.** `step`, `sequence`, `parallel`, `branch`, `map`, `pipe`, `retry`, `fallback`, `timeout`, `adversarial`, `ensemble`, `tournament`, `consensus`, `checkpoint`, `suspend`, `scope`/`stash`/`use`. Each exists because I could not express a real pattern without it. Nothing exists because it felt incomplete without it.

None of these seven is unprecedented on its own. The combination is what I haven't found elsewhere, and the combination is what makes the DX feel right to me.

## The hard question: is taste a moat?

If the answer to "what's unique?" is "the combination, and the DX feels right to me", am I just describing a vanity project?

Possibly. But I think there's a real argument here, which is that in a crowded market of libraries that all technically solve the same problem, *taste is the product*. Express.js, Redux, tRPC, Zod, Hono — each of these shipped into a crowded category and won because a particular shape felt right to a particular audience. The author's taste, consistently applied, is the product. The primitives can be copied in a weekend; the consistency of applying them across every decision cannot.

Where I'd be lying to myself:

- **This is not a mass-market play.** LangChain has distribution, integrations, mindshare, LangSmith pull-through, and Harrison. Fascicle has none of those and won't. The realistic market is engineers who already tried LangChain / Mastra / BAML and bounced, and who have the taste to recognize why this one is different. That is a small market.
- **"Better DX" is not verifiable from outside.** A potential user can't tell from the README whether the DX is better than Mastra's; they have to try it. So the job of the docs, examples, and the ridgeline build history is to make that trial as short as possible.
- **A small surface is a promise that gets tested.** Every time I add a primitive, I'm either admitting I was wrong about a gap, or bloating the surface I sold people on. The taste.md rules exist partly to make that decision painful every time — which is correct.

Where I think I'm right:

- Composition libraries are durable. The LangChain codebase from 2023 is unrecognizable today; the idea of composition primitives has not changed. Betting on "the primitives" over "the integrations bin" is a longer-horizon bet that doesn't need to win every quarter.
- TS-native matters more over time, not less. Python is the majority today; TS is the majority of the agent-harness work I see being built right now. Being TS-first is not a compromise position; it's a bet.
- Taste-defined libraries age better than feature-defined ones. A library whose identity is "we refused to ship these 12 things" has a clearer North Star than one whose identity is "we have 247 integrations".

## Standing commitments (what I will not do to compete)

Writing these down because it's cheap now and expensive later:

- **No hosted SaaS.** No dashboard, no cloud, no account. If the business model ever requires one, it's a different business.
- **No registry, ever.** The moment `fascicle.register(myAgent)` ships, every guarantee in `.ridgeline/taste.md` stops holding. This is non-negotiable.
- **No integrations arms race.** Six-plus provider adapters is enough. I am not going to chase a 100-integration number because LangChain has one.
- **No framework creep.** If a feature requires a lifecycle hook or a startup handshake, the feature is wrong.
- **No Python port.** I might one day ship a sibling library whose design philosophy is the same, but it will not be called `fascicle-py` and will not share a codebase. Split the bet cleanly or don't split it.
- **No classes.** `Error` subclasses only. If a PR needs a class, the PR is either wrong or the design is wrong.

## Open questions

- **AgentKit.** This is the nearest neighbor and I haven't tried it in anger. If I were going to bail on fascicle for any of these, it would be this one. Worth a real spike before I commit to years on fascicle.
- **OpenAI Agents SDK TS as a substrate.** Could I implement fascicle-style composers on top of the OpenAI Agents TS runner? Probably yes for the LLM-heavy subset, poorly for the non-LLM subset. Not interesting enough to pursue but worth noting as a possible fork in the road.
- **What happens if Anthropic ships a "Claude Agents" layer that competes at this tier?** Probably nothing bad — Anthropic's incentives are to sell Claude tokens, not to own the composition layer. But worth watching.
- **When does it become cheaper to port fascicle to LangGraph / Mastra than to keep maintaining it?** Probably never, because the taste is the product; but I should check in on this every 18 months.

## Summary

Fascicle overlaps with LangChain/LangGraph, Mastra, OpenAI Agents SDK, and Inngest AgentKit on the axis of "compose LLM calls into runnable flows". It diverges on how: step-as-value, no registry, library not framework, narrow not broad, transport-aware. The alternatives are better at different things (LangChain's integrations, Mastra's RAG/memory-in-a-box, OpenAI Agents' handoff model, AgentKit's durability). Fascicle is better at being a thing a careful engineer can read, predict, and replace one piece at a time without pulling the rest along.

That's not a universal win. It's a specific bet about what a specific kind of builder wants. I am that builder, and the three projects I tried before this one all failed that bet in the same direction (too much framework, too much ambient state, too-hard-to-see substitution). Fascicle is my attempt to ship the library I kept failing to find.

I don't think I'm reinventing the wheel. I think the wheel everyone else shipped is a tricycle wheel, and I wanted a road bike.

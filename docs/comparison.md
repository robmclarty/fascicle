# How Fascicle Compares

"Compose LLM calls into something agent-shaped" is a crowded category, and the
same project can look identical or completely different depending on which axis
you compare along. This page lays out the axes, places fascicle on them, and is
honest about when another tool is the better fit.

It reflects fascicle's own design view. The only way to know whether the
ergonomics fit your taste is to try it — start with
[getting-started.md](./getting-started.md).

## Five Axes That Matter

1. **Unit of composition.** Is the base type a function-like value (`Step`,
   `Runnable`, `Flow`), a class instance (`Agent`, `Workflow`, `Chain`), or a DSL
   string? This predicts most of the ergonomics.
2. **Registry vs. values.** Do you register agents/tools into a central object and
   look them up by name, or are they just values you import? This maps directly to
   how hard testing and refactoring will be.
3. **Framework vs. library.** Does it own your process lifecycle (init, start,
   stop), or is it something you call? Frameworks aren't the default good choice;
   they amortize cost across many apps, libraries across calls within one.
4. **Breadth vs. depth.** Does it try to cover every adjacent concern (retrievers,
   vector stores, memory, evals, hosted dashboards), or do one thing well? Breadth
   sells; depth composes.
5. **Transport awareness.** Does it know more than one way to reach a model (HTTPS
   SDKs, raw HTTP, subprocess CLIs, MCP), or assume everything is an SDK call?

**Fascicle's answers:** (1) `Step<i, o>` values, (2) pure values (no registry),
(3) a library you call, (4) narrow (composition plus a model engine), (5) yes.
Providers plug in at one of three depths (an AI SDK model, a raw-HTTP
`transport: 'native'` turn, or an external agent process), all under one loop, and
the `fascicle/mcp` subpath bridges MCP both ways.

## At a Glance

| | Unit | Registry | Shape | Scope | TS-native |
| --- | --- | --- | --- | --- | --- |
| **fascicle** | `Step` value | none | library | narrow | yes |
| LangChain / LangGraph | `Runnable` / graph | partial | framework | broad | port of Python |
| Mastra | `Agent` / `Workflow` | central object | framework-ish | broad | yes |
| Inngest AgentKit | `Agent` | network | library + runtime | narrow | yes |
| OpenAI Agents SDK | `Agent` | none | library | narrow | port of Python |
| Strands Agents | model-driven `Agent` | none | library | broad | GA (Python-first; TS GA Apr 2026) |
| Vercel AI SDK | (provider calls) | n/a | library | provider layer | yes |

## The Honest Overlap

### LangChain + LangGraph

The reference point. A batteries-included framework, with LangGraph adding a
state-graph layer for stateful agents with checkpoints and cycles. LCEL
(`prompt | model | parser`) is genuinely similar in spirit to `sequence`, and
LangGraph's checkpointer maps to fascicle's `CheckpointStore`.

It diverges by being a framework with a lifecycle and a class hierarchy
(`Runnable`, `BaseChatModel`, `BaseTool`, …), by being very broad (vector stores,
retrievers, memory, loaders, parsers, a long integration tail), and by treating
TypeScript as a port of the Python line. Observability is a separate product
(LangSmith) you send traces to.

**Choose it when** you want the biggest integration bin and someone else
maintaining it — for example, a bot wired to a managed vector index, a memory
store, and several SaaS integrations.

### Mastra

A TypeScript-first AI framework with `Agent`, `Workflow`, `Tool`, memory, RAG, and
evals wired into a central `Mastra` object. It overlaps on workflow composition and
shares fascicle's default provider layer (the Vercel AI SDK). It diverges on the
central registry (ambient state fascicle refuses by design) and on its workflow
builder returning a `Workflow` rather than a `Step`, so the "anything that fits a
step fits any composition" invariant doesn't hold.

**Choose it when** you want RAG, memory, and a hosted eval/observability product
batteries-included in one TypeScript framework. The eval overlap is narrower than
it looks, because fascicle ships scoring as composition (`bench` over fixtures, `Judge`
steps, and `regression_compare` against a committed baseline), so the batteries
Mastra adds are the retrieval and memory abstractions and the dashboard, not the
ability to score a run.

### Inngest AgentKit

The nearest philosophical neighbor. Small, TS-first, library-shaped, step-ish,
with `Agent`, `Network`, and a router. Durability is baked in via Inngest's runtime
(retries, queueing, scheduling, scaling), so you buy into Inngest as
infrastructure. fascicle is in-process with no infrastructure requirement;
durability is opt-in per step via the `checkpoint` primitive and a
`CheckpointStore`.

**Choose it when** you already run on Inngest, or you want durable execution as
infrastructure rather than a per-step choice.

### OpenAI Agents SDK

A small, opinionated agent framework (`Agent`, `Runner`, `Tool`, `Handoff`,
`Guardrail`) with strong ideas about multi-agent handoffs and tool loops. It's
agent-centric, so the unit is an `Agent` and `Runner.run(agent, input)` drives the
loop. fascicle's unit is a `Step` that *might* contain an LLM call and tool loop,
or be a plain function, or a composition of both.

**Choose it when** the whole product is "an agent with tools and handoffs" — a
simpler path until you want to wrap that agent in retry, fan it across an
`ensemble_step`, or pipe it into a judge loop with a different model.

### Strands Agents

AWS's open-source agent SDK (Apache-2.0). Its core bet is *model-driven*. You give an `Agent` a model, a system
prompt, and tools, and the model drives its own loop (planning, choosing tools, and adapting at run time) instead
of you wiring the control flow. Python is the mature line; TypeScript shipped in preview in December 2025 and
reached GA (v1.0) in April 2026. It's broad and production-oriented. Multi-agent orchestration (swarms,
graphs, agents-as-tools), the agent-to-agent (A2A) protocol, MCP tools, sessions/persistence, structured output,
and OpenTelemetry observability are all built in, and it stays model-agnostic across Bedrock, Anthropic, Ollama,
LiteLLM, and more.

It diverges from fascicle on exactly that core bet. Strands trusts the *model* to orchestrate; fascicle has *you*
compose the control flow explicitly out of `Step` values, with a model call as one component among plain
functions. It's also agent-centric (the unit is an `Agent`, not a substitutable `Step`), broader in scope, and
Python-first (its TypeScript reached GA only in April 2026), where fascicle is TS-native from the start and
narrow. You can reconcile the two, since a model-driven Strands agent is the kind of thing fascicle would treat
as a single step inside an author-composed flow.

**Choose it when** you want the model to drive the agent loop with minimal
control-flow code, you need production multi-agent orchestration (swarms / graphs /
A2A) batteries-included, or you're in the AWS / Bedrock ecosystem.

## Different Layer, Not Competition

- **Vercel AI SDK** is the provider abstraction fascicle's engine sits *on* by
  default (seven of eight providers out of the box), and `generateText`/`streamText` are
  the single-turn driver below fascicle's loop, not
  `sequence`/`parallel`/`checkpoint`. At *that* layer it's ancestry, not overlap.
  The dependency is per-transport and not structural, so five providers can run
  `transport: 'native'` on raw HTTP with no `@ai-sdk/*` package in the path, and the
  loop above them doesn't change. Note, though, that since v6/v7 the SDK also ships an agent
  layer of its own (`ToolLoopAgent`, `WorkflowAgent`, and `HarnessAgent`, the last
  of which wraps CLI harnesses like Claude Code), and *that* layer is a genuine
  competing implementation of what fascicle owns rather than a substrate for it.
  fascicle's stance is to depend on the turn driver and decline the agent layer;
  see [the agent-layer boundary](./providers.md#the-agent-layer-boundary).
- **Claude Agent SDK** is a *lower* layer — Anthropic's SDK for building directly
  on Claude Code's tool loop. fascicle's `claude_cli` provider sits on the same
  territory but presents it as one more provider behind `generate`. A fascicle step
  could drop down to the Agent SDK.
- **Switchyard** (NVIDIA NeMo) is a wire-level proxy, not a composition layer: a
  Rust server (plus `libsy`, its embeddable routing library) that translates
  between the OpenAI Chat, Anthropic Messages, and OpenAI Responses formats and
  routes traffic across backends with weak/strong tiering algorithms (an
  up-front LLM classifier, signal-driven stage routing, judge-confirmed
  escalation, and random A/B splits). Two of its calls align with fascicle's:
  `libsy` never calls a model itself (an algorithm picks a target and hands the
  call back to you, the same separation as fascicle's adapters passed in per
  run), and routing policy lives outside the model surface (the reason
  fascicle's engine resolves models verbatim instead of aliasing). It differs on
  where routing belongs. Switchyard rewrites traffic for clients you can't
  modify, so Claude Code or Codex speaking their native APIs to vLLM, NIM, or
  Ollama. In a fascicle app you own the call site, so tier routing is better
  written as explicit composition (`branch`, `fallback`, a `Judge` step) where
  the decision and its cost are visible in the trajectory rather than buried in
  a proxy. The two compose instead of competing, since a Switchyard server is one more
  OpenAI-compatible gateway reachable through
  [the compat recipe](./providers.md#openai-compatible-servers-the-compat-recipe).
  As of mid-2026 it's pre-alpha and explicitly not for production use.
- **BAML** is a schema/prompt DSL for describing one call at a time; BAML functions
  wrap trivially as fascicle steps (`step('extract', boundary.Extract)`).
- **LlamaIndex / DSPy / CrewAI / AutoGen / Pydantic AI / Genkit** solve adjacent or
  different problems (RAG-first, prompt optimization, role-based agent societies,
  Python-first, ecosystem-coupled). Adjacent, not the same bet. (LlamaIndex.TS was
  archived in April 2026; the Python line continues.)
- **Langfuse, LangSmith, Phoenix, Helicone, Braintrust** are tracing/eval products
  — they consume the event stream a composition library emits. fascicle's
  `TrajectoryLogger` is designed so any of them can be implemented as an adapter.

## What Fascicle Optimizes For

None of these is unprecedented alone; the concentration is the point.

1. **Step-as-value as the one load-bearing invariant.** Every composable unit is a
   `Step<i, o>`; every composer takes steps and returns a step. Substitution always
   holds.
2. **Adapters per run, not per process.** `run(flow, input, { trajectory,
   checkpoint_store, abort })`. No global config, no `configure()`, no singleton —
   two concurrent runs in one process don't interfere. The library leaves
   `process.env` alone.
3. **Streaming as observation, not a second vocabulary.** `run` and `run.stream`
   execute the same graph, and steps don't know which runner drives them.
4. **Every transport is first-class under one loop.** An AI SDK model, a raw-HTTP
   native turn, and a subprocess agent are three depths behind the same seam, and the
   `claude_cli` adapter drives the Claude CLI with full process-group lifecycle,
   `transport: 'native'` talks to five providers' own wire formats with no SDK in
   the path, and `custom_providers` accepts an adapter fascicle knows nothing about.
   The tool loop, salvage, approval, retry, cost, and trajectory above them are
   identical.
5. **A small, hand-picked surface.** 22 composition primitives and one `generate`
   function, shipped as a single npm package — no "pick four packages and align
   their versions" tax. The primitives are layered instead of flat, and
   [leaf-arm-spine.md](./leaf-arm-spine.md) names the leaf / arm / spine roles
   and the decision rules for choosing at each one.

## When to Choose Something Else

- You want the largest library of pre-built integrations → **LangChain**.
- You want RAG, memory, and a hosted eval product batteries-included → **Mastra**.
- You want durable execution as managed infrastructure → **Inngest AgentKit**.
- Your product is a single agent with tool handoffs → **OpenAI Agents SDK**.
- You want the model to drive the loop, with multi-agent orchestration built in →
  **Strands Agents**.
- You only need provider abstraction, no composition → **Vercel AI SDK** directly.
- You need to route or translate at the wire for a client you don't control
  (Claude Code against vLLM) → **Switchyard** or another gateway.
- You work in Python → fascicle is TypeScript-only by design; look at Pydantic AI,
  DSPy, or the Python frameworks above.

Fascicle is the right call when the surface has to be readable, testable, and
replaceable one piece at a time without pulling the rest of a framework along.

For a structured go/no-go framing (the honest case, the risks of adopting a young
single-maintainer library, and a per-project decision rule), see
[adoption-decision.md](./adoption-decision.md).

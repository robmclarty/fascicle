# Deciding whether to adopt fascicle

This page is for a team weighing fascicle against using the Vercel AI SDK
directly (or Mastra, or Strands). It includes a section on when the answer is
"use something else," and a section on the risks of depending on an early-stage
library. It reflects fascicle's design view; the only way to confirm the
ergonomics fit is to try it.

## The reframe: it is not fascicle versus the AI SDK

The most common framing of this decision is a false one. fascicle is *built on*
the Vercel AI SDK for its default path: `ai` is a required peer, and seven of its
eight providers are AI-SDK-backed out of the box. You are not choosing between
fascicle and the AI SDK. You are choosing *at which layer* a vendor owns your
code.

On the default `ai_sdk` transport the AI SDK owns everything below a single model
call: message translation, tool-schema mapping, streaming, usage normalization.
fascicle owns everything above that seam: the multi-step tool loop, tool-call
salvage, approval gating, deterministic turn-ending, cost, the trajectory, and the
composition layer. The question this page answers is whether that upper layer earns
its place, or whether the AI SDK's own agent layer (`ToolLoopAgent`,
`WorkflowAgent`, `HarnessAgent`) is enough on its own.

That default is no longer the only path, and the difference matters for the
argument below. Providers plug in at one of three depths, and five of the eight
(`anthropic`, `openai`, `openrouter`, `lmstudio`, `ollama`) can be switched to
`transport: 'native'`: raw HTTP, hand-rolled streaming, no `@ai-sdk/*` package in
the path. Only `google` and `bedrock` are AI-SDK-only; `claude_cli` is a
subprocess and never was. The same
tool loop, retry, salvage, cost, and trajectory sit above both depth-1 kinds, so
the transport swaps without the loop changing. The honest residual: `ai` itself is
still a required peer, because the `ai_sdk` transport module is statically imported
by `generate.ts`. Native means "no provider SDK and no AI SDK on the wire," not yet
"uninstall `ai`."

## What you are actually buying

Four goals tend to drive a team toward a layer like this. Map each to what
fascicle does:

- **Portability.** One `generate` surface fronts eight providers, plus
  `custom_providers` for an adapter fascicle has never heard of. `provider` names
  the transport and `model` is an opaque id sent verbatim, so moving a call between
  Anthropic, OpenAI, Bedrock, OpenRouter, or a local runtime is a config change,
  not a rewrite. Portability now goes one level deeper than the provider name:
  `transport: 'native'` swaps the wire implementation underneath a provider without
  changing the pricing key, the usage fields, the effort mapping, or a line of your
  flow. And because the native OpenAI-compatible core is dialect-parameterized, any
  gateway that speaks Chat Completions (vLLM, LiteLLM, Ollama's `/v1`) is reachable
  by pointing `base_url` at it, with no new adapter and no peer to install.
  Crucially, local models are first-class: tool-call *salvage* recovers a tool call
  a model emitted as plain prose with zero structured calls, which is the dominant
  failure mode of quantized local models and the thing that makes tool loops
  actually work on Ollama or LM Studio. This is real code, not glue: salvage is a
  few hundred mutation-tested lines that the AI SDK's structured-only tool-repair
  cannot substitute for.
- **Flexibility.** Agent logic is composed from small values, so changing a
  harness is editing a data structure rather than fighting a vendor's built-in
  loop. You are not beholden to one agent implementation; you assemble the control
  flow you want and iterate on it fast and deliberately.
- **Composition over inheritance.** Every unit is a `Step<i, o>` and every
  composer takes steps and returns a step. There is no class hierarchy, no central
  registry, and no ambient state: adapters are passed per run, so two runs in one
  process share nothing. Substitution always holds, which is what makes the
  surface testable and replaceable one piece at a time.
- **Sovereignty.** The seam is the point. A breaking change in the provider layer,
  or in the AI SDK itself, is contained to one file behind a stable interface
  instead of rippling through your agent code. In a fast-moving environment this is
  the ability to change direction cheaply.

## Where fascicle is genuinely differentiated

By mid-2026 a long list of capabilities is *table stakes*: essentially every
serious framework ships a tool loop, streaming, provider abstraction, MCP support,
and structured output. None of those is a reason to pick fascicle, and pretending
otherwise would be dishonest. What is still differentiated, and hard to copy
quickly:

1. **Salvage-backed local-model tool loops.** Concrete, and not something the
   neighboring frameworks ship. If local or on-prem models matter (data residency,
   cost, latency), this is a real advantage. The native transports compound it: a
   local runtime can be driven over raw HTTP with neither the AI SDK nor a provider
   package in the dependency tree.
2. **A composition algebra of substitutable values.** The AI SDK gives you one
   agent loop. fascicle gives you 21 primitives, each a `Step` that nests inside
   any other: the control-flow set (`sequence`, `parallel`, `branch`, `map`,
   `pipe`, `retry`, `fallback`, `timeout`, `loop`, `compose`), the durability set
   (`checkpoint`, `suspend`, `scope`/`stash`/`use`), the deliberation set
   (`ensemble`, `ensemble_step`, `tournament`, `consensus`, `adversarial`), and the
   self-improvement pair (`improve` for an online propose-score-accept loop,
   `learn` for offline reflection over recorded trajectories). "Fan this across an
   ensemble, pipe it into an adversarial judge loop with a different model, wrap
   the whole thing in retry" is a different product from a single model-driven
   agent.
3. **No ambient state, trajectory as audit trail.** Matters exactly when a
   production system must be legible and auditable a month later. The trajectory is
   not just a log format: `fascicle-viewer` ships in the same package and renders a
   live span tree with cost rollup, and `fascicle/otel` bridges the same events to
   any OTel backend.
4. **Behavior regression testing that is itself tested.** `bench` scores a fixture
   set with `Judge` steps, `regression_compare` diffs the report against a
   committed baseline, and the stock judges are held to the library's own mutation
   bar. That turns "did the prompt change make it worse" into a gate, without a
   hosted eval product (see
   [regression-testing-model-behavior.md](./regression-testing-model-behavior.md)).
5. **Churn insulation.** The provider seam contains vendor breakage. This is no
   longer a hypothetical property: the seam already carries two independent
   depth-1 implementations (`ai_sdk` and `native`) plus a depth-2 external agent,
   with the loop above unchanged across all three, which is the demonstration that
   the abstraction is real rather than a rename of one vendor's API. It is the
   least visible benefit in a demo and often the most valuable in production (see
   the note on the AI SDK's release cadence below).
6. **Supply-chain posture.** One package, no direct runtime dependencies, no
   install scripts, every provider SDK an optional peer (`ai` and `zod` are the
   only required ones), and releases published from CI via npm Trusted Publishing
   with a signed provenance attestation you can verify with `npm audit signatures`.
   A deliberately small surface, which in 2026 is itself a differentiated property
   (see [SECURITY.md](../SECURITY.md)).

## What real agent shapes look like in this model

The composition layer is easiest to judge against concrete agents. Common shapes
and how they decompose:

| Agent shape | fascicle expression |
| --- | --- |
| Adversarial code reviewer (propose, critique, revise until a judge accepts) | `adversarial({ build, critique, accept })` |
| Bug fixer pairing a builder with an independent reviewer | a builder step behind a reviewer `loop`, or `sequence` plus `adversarial` |
| Knowledge-base concierge (retrieval, memory, external tools, chat) | tool loops over `mcp_client` tools, retrieval as plain steps, wired with `sequence`/`branch` |
| Long-horizon overnight builder (runs for hours, survives restarts) | `loop` plus `checkpoint`, with `suspend`/`resume` for durability opted in per step |
| A fleet of simulator variations, then adjudicated | `ensemble` or `consensus` over `parallel`, with a scoring reducer |
| A one-prompt classifier or extractor (markdown prompt, zod output) | `define_agent` from `fascicle/agents`, which folds a prompt file plus a schema into a `Step` |
| A stage that tunes itself against a scored fixture set | `improve` online, or `learn` offline over recorded trajectories |
| A behavior-regression suite in CI | `bench` over fixtures with `Judge` steps, diffed against a baseline by `regression_compare` |

Each is an ordinary composition of the same primitives, and each returns a `Step`,
so it can be wrapped, retried, or nested without special-casing. If you want the
whole app shape rather than a single agent, [blueprint.md](./blueprint.md)
standardizes it (one composition layer, `create_engine` confined to one file,
prompts as markdown, stub-engine tests) and `examples/` carries worked apps built
that way.

## When to use something else

This is the honest part, and it is what makes the rest credible. Reach for another
tool when:

- The whole product is a single agent with tools and a chat UI. Use the **AI SDK
  directly**; fascicle is overhead you will not use.
- You want retrieval, memory, and a hosted eval/observability product
  batteries-included in one framework. Use **Mastra**. (fascicle does ship the eval
  half as composition: `bench`, judges, and baseline diffing. What it does not ship
  is vector stores, retrievers, a memory abstraction, or a dashboard product.)
- You want the model to drive the loop with multi-agent orchestration built in, and
  you live in AWS/Bedrock. Use **Strands** (its TypeScript SDK reached GA in April
  2026).
- You want durable, resumable execution as managed infrastructure. Use the AI SDK's
  **`WorkflowAgent`** or an engine like Inngest.

The decisive test for a given project: *can you name a concrete way fascicle beats
AI-SDK-direct for this specific workload?* If the honest answer is no, use the AI
SDK for that project. If the project needs the seam anyway (provider portability,
composed control flow, churn insulation, local models), then you will build that
seam regardless, and fascicle is the disciplined, versioned, tested version of work
you would otherwise do worse and throw away.

## The risks of depending on an early-stage library

Choosing fascicle for production work carries risks that have nothing to do with
its design quality, and a serious evaluation names them:

- **Key-person risk.** fascicle is a single-maintainer project. Depending on it
  means depending on one person's availability. This is the first objection any
  engineering organization should raise.
- **Pre-1.0.** It ships breaking changes on minor releases. Pin an exact version
  and upgrade deliberately.
- **It is not accepting outside pull requests yet.** If you hit a bug you cannot
  upstream a fix easily; you fork or you wait.

What makes these survivable is the shape of the thing:

- It is Apache-2.0 and public, so a fork is always available as an escape hatch.
- It is small and readable (one package, roughly 18k lines of source with tests
  excluded, and a mutation-tested core), and a *library*, not a framework: because
  every unit is a substitutable `Step`, you can excise it one piece at a time
  instead of being locked into a lifecycle.
- **Consume it as an ordinary published dependency.** Pin a reviewed version from
  the registry and keep anything organization-specific in your own repository,
  built on fascicle's public contracts rather than vendored into the library. That
  keeps the dependency at arm's length and your upgrades boring.

## The bottom line

fascicle is not a thin wrapper: there is real, differentiated code above the
provider seam, and below it now too for the five providers with a native
transport. The honest caveat is that the AI SDK's v6/v7 agent layer narrowed some
specific gaps (it now wraps CLI harnesses and standardizes reasoning), so the case
rests on salvage, the composition algebra, no ambient state, and churn insulation,
not on provider plumbing.

As production infrastructure, adoption is conditionally justified. The
justification is never "better than the AI SDK" (it is built on the AI SDK). It
is: a thin, legible, provider-sovereign seam that lets agent logic outlive both
provider churn and AI-SDK major churn (to the point where five providers can now
bypass the AI SDK entirely without the loop above them noticing), makes local
models actually work, and is adoptable as an ordinary Apache-2.0 dependency with a
fork escape hatch. Adopt it
for the projects that need those specific properties, and consume it as a
published dependency. For projects that do not need the seam, use the AI SDK
directly, and count that honesty as a feature.

## A note on the AI SDK's release cadence

The churn-insulation argument rests on a fact worth stating plainly: the AI SDK
shipped three large breaking majors in twelve months (v5 in July 2025, v6 in
December 2025, v7 in June 2026), including a provider-spec change, a streaming
wire-format change, and a silent `useChat` behavior change. A product built
directly on the SDK's agent layer absorbs each of those. A product built behind
fascicle's seam contains them to a per-file change. Neither is free; the seam is a
bet that containment is cheaper than absorption over time.

## Further reading

- [comparison.md](./comparison.md) - the five axes, and where each neighbor
  (LangChain, Mastra, Strands, OpenAI Agents SDK, Inngest AgentKit) sits on them.
- [concepts.md](./concepts.md) - step-as-value, run context, trajectories.
- [providers.md](./providers.md) - the three integration depths, the `transport`
  switch, and the per-provider capability matrix.
- [blueprint.md](./blueprint.md) - the standard app architecture, once you decide
  to adopt.
- [SECURITY.md](../SECURITY.md) - the supply-chain posture and its honest residual
  risks.

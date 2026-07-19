# docs-concierge

Grounded Q&A over a local directory of markdown docs: retrieve relevant
passages, answer with numbered citations, and prefer abstaining over being
confidently wrong. A worked example of the
[blueprint](../../docs/blueprint.md)'s **model-proposes, code-decides**
pattern, distilled from a production consumer.

## What it shows

- **A one-way abstention gate.** The model proposes `{ abstain, confidence,
  answer, citations }`; a pure function ([`gate.ts`](./src/gate.ts)) has the
  final say and can only narrow toward abstention: model abstained, nothing
  retrieved, confidence too low, no citation resolves, or empty answer. Every
  reason is data, and the whole policy is testable without a model.
- **Citations by passage number.** A small model cannot misspell an index;
  the gate resolves numbers back to real sources deterministically and drops
  the invalid ones.
- **`define_agent` as the stage.** The answerer is a markdown prompt plus a
  zod schema folded through `fascicle/agents`
  ([`stages/answerer.ts`](./src/stages/answerer.ts)); `build_prompt`
  delegates to `messages.ts`, and the step returns the validated assessment
  directly.
- **A ports-and-adapters retriever.** The bundled retriever
  ([`services/retriever.ts`](./src/services/retriever.ts)) is a keyword
  scorer over [`docs/`](./docs/), so the example runs with no external
  services; the `Retriever` port is where a vector store, search API, or MCP
  server plugs in without touching the flow.

## Run it

```sh
# no network: canned model response through the real flow, retriever, and gate
pnpm --filter @repo/example-docs-concierge ask:stub

# real model call (one env var swaps the provider)
ANTHROPIC_API_KEY=... pnpm --filter @repo/example-docs-concierge ask -- "Who can delete a project?"
FASCICLE_PROVIDER=ollama pnpm --filter @repo/example-docs-concierge ask -- "How does the daily digest work?"

# point it at your own docs
tsx src/main.ts --docs ~/my-project/docs --json "How do I configure retries?"
```

An abstention is a successful run (exit 0): "no confident answer" is this
agent's second-best outcome, not a failure.

## Extending it

Delivery to a chat channel or ticket system belongs in the shell (or a
service it calls) after `run` returns, keyed off the typed `Outcome`; the
flow does not change to gain a new destination. To raise or lower the bar,
pass `gate: { min_confidence }` through `FlowEnv`.

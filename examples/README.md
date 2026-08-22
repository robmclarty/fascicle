# Examples

Runnable reference flows. Every example lives in its own folder with a
`README.md` and a `screenshot.png` of what running it looks like. Two kinds
live here: single-file demos, each one a `main.ts` that is one
`pnpm exec tsx examples/<name>/main.ts` away, and seven full example apps,
which are separate workspace members consuming the library via
`fascicle: workspace:*`.

All of them import the published surface (`fascicle`, `fascicle/adapters`,
`fascicle/mcp`, …), so everything here is copy-pasteable into an npm
consumer. The reference agents (reviewer, documenter, researcher) are
themselves demo code under [`agents/`](./agents/), each one a markdown prompt
plus a zod schema folded through `define_agent`; copy the agent directory
alongside the example that uses it.

## The architecture these examples embody

[docs/blueprint.md](../docs/blueprint.md) is the standard app architecture
for building on Fascicle: one composition layer, markdown prompts, normalized
module contracts, stub-engine testing. It is distilled from these reference
apps and from production consumers. If you (or your coding agent) are
constructing a new Fascicle app, start there.

## Example apps

| App | What it shows |
| --- | --- |
| [pr-improve/](./pr-improve/) | the canonical blueprint reference: a 4-stage PR-improvement pipeline with pure-composition `flow.ts`, markdown prompts, and provider-dispatched builder tools |
| [change-triage/](./change-triage/) | deterministic + model hybrid: zero-token detectors, one schema-mode model call, a score floor the model cannot undercut, and a privacy screen on the model's view |
| [docs-concierge/](./docs-concierge/) | model-proposes, code-decides: grounded Q&A with number-based citations, a `define_agent` stage with a markdown prompt, and a one-way gate that prefers abstaining over confidently wrong |
| [amplify/](./amplify/) | online self-improvement over a real codebase: a `loop` whose guard is the budget, `map` fan-out per round, and a `branch` on accept/reject with test-suite gates |
| [red-green-refactor/](./red-green-refactor/) | a bounded TDD loop with the test oracle and file snapshots behind ports, so the whole cycle runs in tests against a stub engine |
| [swebench/](./swebench/) | a SWE-bench harness: per-instance sandboxes, a per-case tool surface, structured verdicts, and the blueprint's escape hatch used deliberately |
| [mcp-server/](./mcp-server/) | serving a composed flow as an MCP tool via `serve_flow` |

Six of the seven carry the blueprint's
[ast-grep rules](./pr-improve/rules/) in their own `rules/` directory, run
for every app by the `examples` slot of `pnpm check`
(`scripts/check-example-rules.mjs`) and runnable per app with
`pnpm --filter ./examples/<app> check:rules`. `mcp-server` is the exception:
it is a three-file demo of one export with no composition layer to police, so
blueprint rules there would be ceremony.

Their tests run in the default suite too (stub engines, no network), so an
example that stops matching the library fails `pnpm check` rather than
rotting quietly.

## Single-file examples

Start with [hello](./hello/), then [release-notes](./release-notes/) for a
whole agent in one file (a `chain` flow, inline prompt and schema, one
`model_step` boundary; the counterpoint to the layered
[blueprint](../docs/blueprint.md) apps above), and
[release-notes-direct](./release-notes-direct/) for the same agent in the
direct style (one named `step` body, `ctx.call` at the model boundary, and a
conditional model call a static chain cannot express). When you want the
whole vocabulary on one page, [newsroom](./newsroom/) is the tour: every
primary primitive in its suggested role (hardened research arm, model-judged
drafting, adversarial revision, checker consensus, a suspend gate resumed
with approval), explicitly a tour rather than a template.

Then browse by topic:

| Topic | Examples |
| --- | --- |
| composition and self-improvement | [improve](./improve/), [learn](./learn/), [ensemble-judge](./ensemble-judge/), [adversarial-build](./adversarial-build/) |
| engine and providers | [hello-claude-cli](./hello-claude-cli/), [hello-claude-cli-lisp](./hello-claude-cli-lisp/), [adversarial-claude-cli](./adversarial-claude-cli/), [ollama-chat](./ollama-chat/), [streaming-chat](./streaming-chat/), [structured-output](./structured-output/) |
| tools | [tool-loop](./tool-loop/) |
| durability | [checkpoint-resume](./checkpoint-resume/), [suspend-resume](./suspend-resume/) |
| human-in-the-loop | [hitl-http](./hitl-http/) |
| observability | [trajectory-logger](./trajectory-logger/), [viewer-demo](./viewer-demo/), [otel-grafana](./otel-grafana/) |
| embedding | [stdio-agent](./stdio-agent/) |
| agents | [reviewer](./reviewer/), [documenter](./documenter/), [researcher](./researcher/), [learn-reviewer](./learn-reviewer/), [bench-reviewer](./bench-reviewer/) |
| live smoke | [live-smoke](./live-smoke/) |

## What each example needs

Most single-file examples are keyless: they run with zero API keys, against
deterministic stub steps or the bundled stub engine from `fascicle/testing`,
so `pnpm exec tsx examples/<name>/main.ts` works right after `pnpm install`.
Each example's README and `main.ts` header comment state its own prereqs; the
legend below is derived from those headers.

| Needs | Examples |
| --- | --- |
| Nothing (keyless: no engine, or a stub engine) | `hello`, `newsroom`, `release-notes`, `release-notes-direct`, `adversarial-build`, `ensemble-judge`, `improve`, `learn`, `streaming-chat`, `suspend-resume`, `checkpoint-resume`, `trajectory-logger`, `viewer-demo`, `hitl-http`, `stdio-agent`, `reviewer`, `documenter`, `researcher`, `learn-reviewer`, `bench-reviewer` |
| Local Docker (no key: the `grafana/otel-lgtm` container listening on localhost) | `otel-grafana` |
| Local Ollama (no key: a running daemon plus a pulled model) | `ollama-chat` |
| Local `claude` session (no key: Claude Code installed and `claude login` run) | `hello-claude-cli`, `hello-claude-cli-lisp`, `adversarial-claude-cli` |
| Provider API key | `structured-output` and `tool-loop` (`OPENROUTER_API_KEY`, exported or in the root `.env`), `live-smoke` (`OPENROUTER_API_KEY`, plus optional local Ollama / LM Studio; missing legs are skipped) |

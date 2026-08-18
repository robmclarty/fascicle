# Examples

Runnable reference flows. Two kinds live here: single-file examples at this root (each is one `pnpm exec tsx examples/<name>.ts` away), and seven full example apps in subdirectories, which are separate workspace members consuming the library via `fascicle: workspace:*`.

All of them import the published surface (`fascicle`, `fascicle/adapters`, `fascicle/mcp`, …), so everything here is copy-pasteable into an npm consumer. The reference agents (reviewer, documenter, researcher) are themselves demo code under [`agents/`](./agents/) — each one a markdown prompt + zod schema folded through `define_agent`; copy the agent directory alongside the example that uses it.

## The architecture these examples embody

[docs/blueprint.md](../docs/blueprint.md) is the standard app architecture for building on fascicle — one composition layer, markdown prompts, normalized module contracts, stub-engine testing — distilled from these reference apps and from production consumers. If you (or your coding agent) are constructing a new fascicle app, start there.

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

Six of the seven carry the blueprint's [ast-grep rules](./pr-improve/rules/) in their own `rules/` directory, run for every app by the `examples` slot of `pnpm check` (`scripts/check-example-rules.mjs`) and runnable per app with `pnpm --filter ./examples/<app> check:rules`. `mcp-server` is the exception: it is a three-file demo of one export with no composition layer to police, so blueprint rules there would be ceremony.

Their tests run in the default suite too (stub engines, no network), so an example that stops matching the library fails `pnpm check` rather than rotting quietly.

## Single-file examples

Start with [`hello.ts`](./hello.ts), then [`release_notes.ts`](./release_notes.ts) for a whole agent in one file (a `chain` flow, inline prompt and schema, one `model_step` boundary; the counterpoint to the layered [blueprint](../docs/blueprint.md) apps below), and [`release_notes_direct.ts`](./release_notes_direct.ts) for the same agent in the direct style (one named `step` body, `ctx.call` at the model boundary, and a conditional model call a static chain cannot express). Then browse by topic: composition (`improve.ts`, `ensemble_judge.ts`, `adversarial_build.ts`), engine and providers (`hello_claude_cli.ts`, `ollama_chat.ts`, `streaming_chat.ts`, `structured_output.ts`), tools (`tool_loop.ts`), durability (`checkpoint_resume.ts`, `suspend_resume.ts`), human-in-the-loop (`hitl_http.ts`), observability (`trajectory_logger.ts`, `viewer_demo.ts`), embedding (`stdio_agent.ts`), agents (`reviewer.ts`, `documenter.ts`, `researcher.ts`, `learn_reviewer.ts`, `bench_reviewer.ts`), and a live smoke (`live_smoke.ts`).

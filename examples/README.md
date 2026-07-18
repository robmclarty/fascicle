# Examples

Runnable reference flows. Two kinds live here: single-file examples at this root (each is one `pnpm exec tsx examples/<name>.ts` away), and five full example apps in subdirectories, which are separate workspace members consuming the library via `fascicle: workspace:*`.

All of them import the published surface (`fascicle`, `fascicle/adapters`, `fascicle/mcp`, …), so everything here is copy-pasteable into an npm consumer. The reference agents (reviewer, documenter, researcher) are themselves demo code under [`agents/`](./agents/) — each one a markdown prompt + zod schema folded through `define_agent`; copy the agent directory alongside the example that uses it.

## The architecture these examples embody

[docs/blueprint.md](../docs/blueprint.md) is the standard app architecture for building on fascicle — one composition layer, markdown prompts, normalized module contracts, stub-engine testing — distilled from these reference apps and from production consumers. If you (or your coding agent) are constructing a new fascicle app, start there.

## Example apps

| App | What it shows |
| --- | --- |
| [pr-improve/](./pr-improve/) | the canonical blueprint reference: a 4-stage PR-improvement pipeline with pure-composition `flow.ts`, provider-dispatched builder tools, and the blueprint's [ast-grep rules](./pr-improve/rules/) enforced in CI |
| [amplify/](./amplify/) | online self-improvement over a real codebase: propose → score → accept/reject with test-suite gates |
| [red-green-refactor/](./red-green-refactor/) | a bounded TDD loop (`loop` at the top, phase modules below) |
| [swebench/](./swebench/) | a SWE-bench harness: per-instance worktrees, fan-out, structured verdicts |
| [mcp-server/](./mcp-server/) | serving a composed flow as an MCP tool via `serve_flow` |

## Single-file examples

Start with [`hello.ts`](./hello.ts), then browse by topic: composition (`improve.ts`, `ensemble_judge.ts`, `adversarial_build.ts`), engine and providers (`hello_claude_cli.ts`, `ollama_chat.ts`, `streaming_chat.ts`, `structured_output.ts`), tools (`tool_loop.ts`), durability (`checkpoint_resume.ts`, `suspend_resume.ts`), human-in-the-loop (`hitl_http.ts`), observability (`trajectory_logger.ts`, `viewer_demo.ts`), embedding (`stdio_agent.ts`), agents (`reviewer.ts`, `documenter.ts`, `researcher.ts`, `learn_reviewer.ts`, `bench_reviewer.ts`), and a live smoke (`live_smoke.ts`).

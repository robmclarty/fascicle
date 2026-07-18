# Fascicle

![A substrate for agents — three mushrooms (model_call, step, tool) fruit from a shared mycelium network; every mushroom is a Step<i, o>, every thread is a composition](./mycelium.svg)

Compose agents out of LLM calls, tool calls, and plain functions. Everything is a `Step<i, o>`. Wire steps together with 21 primitives (`sequence`, `parallel`, `branch`, `retry`, `loop`, `ensemble`, `checkpoint`, …) and run them as plain values. One `generate` surface fronts eight provider adapters: Anthropic, OpenAI, Google, OpenRouter, AWS Bedrock, Ollama, LM Studio, and a `claude_cli` subprocess that drives the Claude Code CLI.

No framework lifecycle. No ambient state. No decorators. Adapters are passed in per run.

## Install

```bash
pnpm add fascicle zod
```

fascicle is ESM-only and requires Node >= 24. Provider SDKs are optional peers — install only the ones you use. See [docs/providers.md](./docs/providers.md).

## A 60-second tour

<!-- snippet: check -->
```typescript
import { run, sequence, step } from 'fascicle';

const flow = sequence([
  step('add', (n: number) => n + 1),
  step('double', (n: number) => n * 2),
]);

await run(flow, 1); // 4
```

Add a model call:

<!-- snippet: check -->
```typescript
import { create_engine, model_call, pipe, run, sequence, step } from 'fascicle';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY! } },
});

const flow = sequence([
  step('brief', (topic: string) => `Write a 2-sentence brief on: ${topic}`),
  pipe(
    model_call({ engine, model: 'sonnet', system: 'No preamble.' }),
    (r) => r.content,
  ),
]);

try {
  console.log(await run(flow, 'Rust ownership'));
} finally {
  await engine.dispose();
}
```

`model_call` is the only sanctioned bridge between composition and the engine. It threads `ctx.abort`, `ctx.trajectory`, and streaming chunks for you.

## What's in the box

**Composition primitives (21).** Every composer takes `Step<i, o>` and returns `Step<i, o>`. Anything that fits a step fits any composition of steps.

| Primitive | Shape |
| --- | --- |
| `step` | lift a plain function into `Step<i, o>` |
| `sequence` | run A then B then C, threading the value |
| `parallel` | run a named map of steps concurrently |
| `branch` | route on a predicate of the input |
| `map` | run a step per array element, optional concurrency cap |
| `pipe` | post-process an inner step's output with a plain function |
| `retry` | re-run on failure with exponential backoff |
| `fallback` | run a backup if the primary throws |
| `timeout` | cancel an inner step after N ms |
| `loop` | bounded iteration with carry-state and an optional convergence guard |
| `compose` | label a composite so it shows up by intent in trajectories |
| `adversarial` | build, critique, repeat until accept or `max_rounds` |
| `ensemble` | run N members, pick the highest-scoring result |
| `ensemble_step` | pick-best where the scorer is itself a `Step` (a model judge with its own span) |
| `tournament` | single-elimination bracket |
| `consensus` | run N concurrently, accept when an `agree` predicate holds |
| `checkpoint` | memoize an inner step by key in a `CheckpointStore` |
| `suspend` | pause for external input; resume later with `resume_data` |
| `scope` / `stash` / `use` | named state across non-adjacent steps |
| `improve` | bounded online propose → score → accept/reject self-improvement loop |
| `learn` | offline reflection over recorded trajectories |

Plus `run`, `run.stream`, and `describe`.

**AI engine.** `create_engine(config)` returns one `generate` surface across eight providers. Two axes: `model` is an opaque id sent to the provider verbatim (`claude-opus-4-8`, `gpt-4o`, `us.anthropic.claude-sonnet-4-20250514-v1:0`), and `provider` names the transport (`anthropic`, `bedrock`, `openrouter`, `claude_cli`, …) — swap `provider` to move a call between transports. Reasoning effort (`'none'` through `'max'`) is translated per provider. Cost estimation uses a pricing table with per-engine overrides.

The engine core is SDK-agnostic: providers plug in behind a neutral single-turn seam, as one of three kinds. Most built-ins wrap Vercel's AI SDK (`ai_sdk`); five providers can instead run `transport: 'native'` (raw HTTP, no AI SDK in the path, no peer to install) — `anthropic` on the Messages API, `openai`/`openrouter`/`lmstudio` on a shared OpenAI Chat Completions core, and `ollama` on its own `/api/chat` endpoint; and `claude_cli` delegates to an external agent. All inherit the same tool loop, retry, cost, and trajectory, and `custom_providers` registers your own adapter of any kind without touching fascicle. See [docs/providers.md](./docs/providers.md).

**Adapters injected per run.** Trajectory loggers and checkpoint stores ship under the `fascicle/adapters` subpath:

```typescript
import { filesystem_logger, filesystem_store } from 'fascicle/adapters';

await run(flow, input, {
  trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }),
  checkpoint_store: filesystem_store({ root_dir: '.checkpoints' }),
});
```

`filesystem_logger` writes synchronously and the bundled span stacks aren't async-context-aware — fine for dev tools and short-lived runs, see [docs/concepts.md](./docs/concepts.md#adapter-limits) before wiring it into a long-running server. The `TrajectoryLogger` and `CheckpointStore` contracts (exported from `fascicle`) are tiny — roll your own to push events to Honeycomb, S3, etc.

`run.stream(flow, input)` returns `{ events, result }` for incremental observation.

**Markdown-defined agents.** When an agent is just a prompt plus an output schema, `define_agent` (the `fascicle/agents` subpath) folds a markdown file — frontmatter `name` / `model` / `temperature`, body as the prompt — and a zod schema into a `Step<i, o>`:

<!-- snippet: check -->
```typescript
import { z } from 'zod';
import { create_engine } from 'fascicle';
import { define_agent } from 'fascicle/agents';

const engine = create_engine({ providers: { claude_cli: { auth_mode: 'oauth' } } });

const reviewer = define_agent({
  md_path: new URL('./prompts/reviewer.md', import.meta.url),
  schema: z.object({ findings: z.array(z.string()), summary: z.string() }),
  engine,
});
```

This is the [blueprint's](./docs/blueprint.md) recommended shape for simple one-prompt agents; reference agents built on it (reviewer, documenter, researcher) live in [examples/agents/](./examples/agents/).

**MCP bridge.** The `fascicle/mcp` subpath connects flows to the Model Context Protocol both ways. `mcp_client` turns an external MCP server's tools into plain `Tool[]`; `serve_flow` exposes a composed flow as an MCP tool to hosts like Claude Desktop or Cursor. It is pure adapter glue over the existing `Tool` and `run` contracts, and `@modelcontextprotocol/sdk` is an optional peer you only install when you use it.

<!-- snippet: check -->
```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { step } from 'fascicle';
import { mcp_client, serve_flow } from 'fascicle/mcp';

// Consume an external MCP server's tools inside a flow.
const remote = await mcp_client({ transport: 'stdio', command: 'my-mcp-server' });
console.log(remote.tools.map((t) => t.name));
await remote.close();

// Expose a composed flow as an MCP tool on your own server.
const server = new McpServer({ name: 'my-app', version: '1.0.0' });
serve_flow({
  server,
  flow: step('greet', (input: { name: string }) => `Hello, ${input.name}!`),
  name: 'greet',
  description: 'Greet a person by name.',
  input_schema: z.object({ name: z.string() }),
});
```

## Provider matrix

| Provider     | Peer dep                      | Auth                |
| ------------ | ----------------------------- | ------------------- |
| `anthropic`  | `@ai-sdk/anthropic`, or none with `transport: 'native'` | API key |
| `openai`     | `@ai-sdk/openai`, or none with `transport: 'native'` | API key      |
| `google`     | `@ai-sdk/google`              | API key             |
| `openrouter` | `@openrouter/ai-sdk-provider`, or none with `transport: 'native'` | API key |
| `bedrock`    | `@ai-sdk/amazon-bedrock`      | `region` + AWS credentials |
| `ollama`     | `ai-sdk-ollama`, or none with `transport: 'native'` | local `base_url` |
| `lmstudio`   | `@ai-sdk/openai-compatible`, or none with `transport: 'native'` | local `base_url` |
| `claude_cli` | none (spawns `claude`)        | OAuth or API key    |

Full details: [docs/providers.md](./docs/providers.md). The `claude_cli` adapter has its own guide: [docs/cli.md](./docs/cli.md).

## Live dev dashboard

![fascicle-viewer running against an amplify trajectory: span tree on the left, event log on the right, $2.55 cost rolled up in the header](./screenshot.png)

The `fascicle-viewer` bin ships with the umbrella package (there is no separate `fascicle-viewer` package). Point it at a trajectory file and it opens a browser tree of spans, errors, and emits as the run executes:

```bash
# installed locally:
pnpm exec fascicle-viewer .trajectory.jsonl
# or one-off via the umbrella package:
pnpm dlx --package=fascicle fascicle-viewer .trajectory.jsonl
```

Or embed it programmatically:

<!-- snippet: check -->
```typescript
import { start_viewer } from 'fascicle';

const handle = await start_viewer({ port: 4242 });
// later
await handle.close();
```

For zero-latency streaming from inside a long-running flow, pair it with `http_logger` from `fascicle/adapters`. See [docs/viewer.md](./docs/viewer.md) for the full transport story.

## Building an app on fascicle

**[docs/blueprint.md](./docs/blueprint.md) is the recommended architecture for apps built on fascicle** — distilled from the reference apps and production consumers. One composition layer (`flow.ts`) that holds the whole topology, `create_engine` confined to one file, prompts as markdown with frontmatter, zod schemas as the stage contracts, stub-engine testing, and [ast-grep rules](./examples/pr-improve/rules/) that turn each boundary into a build failure. If you are a coding agent scaffolding a new fascicle app, follow the blueprint and its checklist.

The canonical worked example is [examples/pr-improve/](./examples/pr-improve/), with its design rationale in [examples/pr-improve/docs/architecture.md](./examples/pr-improve/docs/architecture.md).

## Where to go next

- [docs/blueprint.md](./docs/blueprint.md) — **the agent blueprint**: the standard app architecture (start here when building an app)
- [docs/getting-started.md](./docs/getting-started.md) — install and run your first flow
- [docs/concepts.md](./docs/concepts.md) — step-as-value, trajectories, cancellation
- [docs/composition.md](./docs/composition.md) — full composition surface: the 21 primitives, run/stream, checkpointing
- [docs/api-reference.md](./docs/api-reference.md) — the public surface at a glance
- [docs/configuration.md](./docs/configuration.md) — engine config, defaults, pricing, retries
- [docs/providers.md](./docs/providers.md) — per-provider adapter notes
- [docs/cli.md](./docs/cli.md) — the `claude_cli` subprocess adapter
- [docs/cookbook.md](./docs/cookbook.md) — retries, fan-out, judges, HITL, tool loops
- [docs/human-in-the-loop.md](./docs/human-in-the-loop.md) — suspend/resume approval over HTTP and streaming to a `useChat` UI via `fascicle/ui`
- [docs/writing-a-harness.md](./docs/writing-a-harness.md) — building a runner around fascicle
- [docs/embedding-under-a-harness.md](./docs/embedding-under-a-harness.md) — running a fascicle agent as somebody's child process
- [docs/troubleshooting.md](./docs/troubleshooting.md) — first-run errors and what they mean
- [docs/comparison.md](./docs/comparison.md) — how fascicle compares to LangChain, Mastra, and others
- [docs/adoption-decision.md](./docs/adoption-decision.md) weighs whether to adopt fascicle: the honest case, the risks, and when to reach for something else
- [examples/](./examples/) — runnable reference flows
- [docs/viewer.md](./docs/viewer.md) — viewer details and transport options

## Contributing

Fascicle is early and not accepting outside pull requests yet. Bug reports and feature ideas via GitHub Issues are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Development

This repo is a **single package**. The code is organized as deep modules under `src/` — `src/core`, `src/engine`, `src/composites`, `src/adapters`, `src/viewer`, `src/agents` — each reachable only through its barrel via the `#<module>` import alias. The umbrella surface at the `src/` root is what publishes to npm as `fascicle`. Architectural boundaries (e.g. core cannot import adapters; engine imports core type-only; no `process.env` outside the audited exceptions) are enforced by the ast-grep rules in `rules/` and a directory-level boundary DAG in `fallow.toml`. The 5 apps under `examples/*/` are separate workspace members that consume the library via `fascicle: workspace:*`.

```bash
pnpm install
pnpm check        # types, lint, structural rules, dead-code, tests, docs, spell
pnpm check:all    # adds Stryker mutation testing + the packaging gate (final gate)
```

`pnpm check` is the single source of truth for "is this done?". Output lands in `.check/` (one JSON per check). See [AGENTS.md](./AGENTS.md) for the full contract and [CLAUDE.md](./CLAUDE.md) for Claude-specific notes.

## License

[Apache 2.0](./LICENSE)

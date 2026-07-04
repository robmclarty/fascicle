# Embedding under a harness

[Writing a harness](./writing-a-harness.md) covers fascicle as the *parent*: your program owns argv, wiring, and the run. This guide is the mirror image, fascicle as the *child*: some other program spawns your agent as a single-shot subprocess, writes JSON to its stdin, and reads one JSON result from its stdout. Deterministic parent CLIs, plugin seams, CI steps, and anything else that speaks JSON-over-stdio all have this shape.

The whole contract is one call, `run_stdio` from `fascicle/stdio`.

## Stdout belongs to your caller

When your process is somebody's child, the streams have fixed jobs:

| Channel | Job |
| --- | --- |
| stdin | the input, JSON, read to EOF |
| stdout | the result envelope, exactly one JSON document, nothing else |
| stderr | trajectory, progress, errors (JSONL) |
| exit code | the verdict |

A stray `console.log` inside a step silently corrupts the parent's parse. Route everything a human or a log collector should see to stderr or a file; the result is the only bytes on stdout.

Key rules:

- Never `console.log` from flow code. Use `ctx.emit` for observable progress and let the trajectory logger carry it to stderr.
- Trajectory defaults to `stderr_logger()` under `run_stdio`; you do not have to wire anything to be stream-clean.
- If a dependency prints to stdout, that is a bug in this context. Wrap or silence it.

## run_stdio

Your entry point stays yours; fascicle still ships no generic runner CLI. The author calls `run_stdio` from their own file:

<!-- snippet: check -->

```ts
import { z } from 'zod'
import { step } from 'fascicle'
import { run_stdio } from 'fascicle/stdio'

const input_schema = z.object({ topic: z.string() })
const output_schema = z.object({ headline: z.string() })

const flow = step('headline', ({ topic }: { topic: string }) => ({
  headline: `about ${topic}`,
}))

void run_stdio(flow, { input_schema, output_schema })
```

Behavior, in order: read stdin to EOF, `JSON.parse`, validate against `input_schema` when given, `run(flow, input, ...)`, validate the result against `output_schema` when given, dispose the engine, write the serialized result as the only bytes on stdout, exit.

Options:

- `input_schema` / `output_schema` (optional zod): a mismatch in either direction is a contract violation, exit 2. Schema transforms apply, so the flow receives the parsed input and the parent receives the validated output.
- `engine` (optional, anything with `dispose(): Promise<void>`): disposed on every path before the process exits, success or failure.
- `trajectory` (optional): defaults to `stderr_logger()`.
- `abort` (optional `AbortSignal`): composes with the signal handlers, same as `RunOptions.abort`.

Signal handlers stay installed (the runner's default): a single-shot child must die when the parent forwards SIGINT.

Key rules:

- Do not set `install_signal_handlers: false` here; the parent forwards signals and expects the child to exit.
- The engine is disposed before stdout is written. If teardown fails, the process exits 1 with no stdout rather than handing the parent a result it might trust from a process that could not clean up.
- Need the outcome as a value instead of an exit (tests, embedding one level deeper)? `execute_stdio` is the same contract over injected io.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | the result on stdout is authoritative |
| 1 | flow failure: a step threw, the run was aborted (forwarded SIGINT/SIGTERM), teardown or delivery failed |
| 2 | contract violation: unparseable stdin, schema mismatch in either direction, unserializable result |

The invariant a parent can build on: **exit 0 if and only if stdout carries an authoritative result.** The 0/1/2 split matches the `fascicle-viewer` CLI convention, one scheme across the toolchain.

## Machine-readable failure

On exit 1 or 2, stdout carries nothing and the *last* stderr line is a single JSON object:

```ts
type StdioFailure = {
  error: string
  stage?: 'read' | 'parse' | 'validate_input' | 'run'
    | 'validate_output' | 'serialize' | 'write' | 'dispose'
  cause?: unknown // zod issues for schema failures; { name, message, path? } for thrown errors
}
```

Parents that want detail take the tail line (`tail -n 1` on captured stderr); humans watching the stream just see it as the final log line. Consuming it is optional; the exit code alone is a complete verdict.

## Trajectory on stderr

`stderr_logger` (from `fascicle/adapters`) writes the same JSONL wire format as `filesystem_logger`, so captured stderr *is* a trajectory file:

```bash
echo '{"topic":"flaky tests"}' | pnpm exec tsx examples/stdio_agent.ts 2> events.jsonl
pnpm exec fascicle-viewer events.jsonl
```

To keep a durable copy alongside the live stream, tee:

```ts
import { filesystem_logger, stderr_logger, tee_logger } from 'fascicle/adapters'

const trajectory = tee_logger(stderr_logger(), filesystem_logger({ output_path: 'run.jsonl' }))
```

## Sessions vs single-shot

`serve_flow` (from `fascicle/mcp`) over a stdio transport gives a *session*: JSON-RPC framing, an initialize handshake, tool-shaped calls, a long-lived process. Right when the parent is an MCP host. `run_stdio` is for the other parent, the one that wants Unix-shaped `exec → result → exit` with no protocol state. Both belong; pick by what spawns you.

## Checklist

Everything in the [writing-a-harness checklist](./writing-a-harness.md#checklist) still applies. On top of it:

- [ ] Nothing writes to stdout except `run_stdio` itself.
- [ ] The flow's input and output have zod schemas, passed as `input_schema` / `output_schema`.
- [ ] The engine (if any) is passed to `run_stdio` so it is disposed before exit.
- [ ] The parent's retry logic distinguishes exit 1 (retryable flow failure) from exit 2 (fix the caller or the flow first).

The reference agent is [`examples/stdio_agent.ts`](../examples/stdio_agent.ts): schema in, two candidates in parallel plus a synthesize step, schema out, ~30 lines.

# Writing a harness

A **harness** is the runnable program that wraps fascicle for a specific use case. fascicle itself is a library — not an app, not a framework, not a CLI. Your harness is where you decide:

- what the flow looks like
- how input gets in (CLI args, HTTP, queue, IDE extension, cron)
- where output goes (stdout, file, database, another service)
- which adapters observe and persist the run
- how failures are handled at the program boundary

Every file in [`examples/`](../examples/) is a small harness. This guide pulls them apart to show what goes where.

## Anatomy

A harness is three things:

1. **A flow** — a `Step<i, o>` built from primitives (`step`, `sequence`, `parallel`, …).
2. **A run** — one call to `run(flow, input, options)` or `run.stream(...)`.
3. **A surrounding program** — CLI parsing, HTTP handler, whatever delivers input and disposes of output.

```ts
import { run, sequence, step } from 'fascicle';

// 1. Flow
const flow = sequence([
  step('parse',   (raw: string) => raw.trim().split(/\s+/)),
  step('reverse', (words: string[]) => [...words].reverse()),
  step('emit',    (words: string[]) => words.join(' ')),
]);

// 2. Run (3. inside a tiny CLI)
if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const input = process.argv.slice(2).join(' ');
  run(flow, input)
    .then((out) => { console.log(out); })
    .catch((err: unknown) => { console.error(err); process.exit(1); });
}
```

Save that as `hello.ts`, run with `pnpm exec tsx hello.ts hello world from agent kit`, and you have a harness. Everything else this guide covers is additive.

## Add a model call

When you want the flow to talk to an LLM, use `model_call`. It is the single sanctioned bridge between the composition layer and the engine layer.

```ts
import { create_engine, model_call, sequence, run } from 'fascicle';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY! } },
});

const flow = sequence([
  step('brief', (topic: string) => `Write a 2-sentence brief on: ${topic}`),
  model_call({
    engine,
    model: 'sonnet',
    system: 'Return plain prose. No preamble, no lists.',
  }),
  step('extract', (r) => r.content),
]);

try {
  const output = await run(flow, 'Rust ownership');
  console.log(output);
} finally {
  await engine.dispose();
}
```

Key rules:

- Construct the engine **once** per process (or once per request for server harnesses), then dispose when done.
- `model_call` returns a `GenerateResult<T>`. Extract the field you need (`content`, `tool_calls`, `steps`, `usage`, `cost`) downstream.
- The engine is injected into the step at construction time; the step itself stays a plain `Step<ModelCallInput, GenerateResult>`.

## Wire in adapters

Two seams on `RunOptions` let you observe and persist without touching flow code:

```ts
import { filesystem_logger } from '@repo/observability';
import { filesystem_store }  from '@repo/stores';

await run(flow, input, {
  trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }),
  checkpoint_store: filesystem_store({ root_dir: '.checkpoints' }),
  install_signal_handlers: true, // default; set false when embedding under another runtime
});
```

Both adapter slots accept anything that conforms to `TrajectoryLogger` / `CheckpointStore` from `@repo/core`. Roll your own to push events to Honeycomb, DynamoDB, a tmpfs, whatever fits your deployment.

## Stream to a consumer

When your harness is behind an HTTP endpoint or a TUI, use `run.stream` and forward events incrementally:

```ts
const handle = run.stream(flow, input);

const pump = (async () => {
  for await (const event of handle.events) {
    if (event.kind === 'model_chunk' && event.chunk.kind === 'text') {
      process.stdout.write(event.chunk.text);
    }
  }
})();

const final = await handle.result;
await pump;
```

`run.stream` is observational: the underlying step graph is identical to `run(...)`. Turning streaming on flips `ctx.streaming` inside the run so `model_call` starts forwarding provider chunks into `ctx.emit`.

## Pause and resume

For human-in-the-loop flows, use `suspend`. The first call throws `suspended_error`; the operator supplies `resume_data` on the next invocation:

```ts
import { suspend, suspended_error } from 'fascicle';
import { z } from 'zod';

const flow = suspend({
  id: 'approve',
  on: ({ brief }) => notify_slack(`Approve? ${brief}`),
  resume_schema: z.object({ approved: z.boolean() }),
  combine: (input: { brief: string }, resume) =>
    resume.approved ? `ship:${input.brief}` : `hold:${input.brief}`,
});

try {
  await run(flow, { brief: 'beta feature' }, { checkpoint_store: store });
} catch (err) {
  if (!(err instanceof suspended_error)) throw err;
  // Harness returns control to its surrounding program until input arrives.
}

// ...later, when the operator responds:
const final = await run(flow, { brief: 'beta feature' }, {
  checkpoint_store: store,
  resume_data: { approve: { approved: true } },
});
```

## Cancellation and cleanup

A harness that runs indefinitely (server, long CLI) must handle cancellation cleanly. fascicle installs SIGINT/SIGTERM handlers by default and aborts every active run through `ctx.abort`. Steps cooperate by:

- Checking `ctx.abort.aborted` at loop boundaries.
- Passing `ctx.abort` to `fetch`, `child_process`, or any other abortable API.
- Registering teardown with `ctx.on_cleanup(() => ...)`. Cleanup runs in LIFO order on success, failure, and abort.

For embedded runtimes (tests, Lambda, worker threads), pass `install_signal_handlers: false` so fascicle does not fight the host process for the signal.

## Error handling

All failures inside a run bubble out of `run(...)` as normal promise rejections. Typed errors from fascicle that your harness may want to special-case:

- `aborted_error` — the run was cancelled (SIGINT, timeout, parent abort).
- `timeout_error` — a `timeout(...)` step tripped.
- `suspended_error` — a `suspend(...)` step paused the flow.
- `resume_validation_error` — `resume_data` did not match the suspend's `resume_schema`.
- `provider_error`, `rate_limit_error`, `tool_error`, `schema_validation_error`, `engine_config_error` — originate in the engine layer.

The error path carries a `.path` array with the step ids that led to the failure, so surfacing it to stdout or a log line is usually enough.

## Where to put the harness

In this repo, reference harnesses live at the root under [`examples/`](../examples/). Your own harness lives in your own project — fascicle is a library, not an app scaffold. Import from `fascicle` (or `@repo/fascicle` if you are contributing inside this workspace) and write the harness wherever your program belongs.

The canonical starting point is [`examples/hello.ts`](../examples/hello.ts). Run it:

```bash
pnpm exec tsx examples/hello.ts
pnpm exec tsx examples/hello.ts "your custom input here"
```

> **Monorepo note.** This repo is a single installable package (`fascicle`) split into `@repo/*` workspace packages to enforce architectural boundaries (e.g. core cannot import from adapters, engine cannot reach into providers). Internally you will see `@repo/core`, `@repo/engine`, `@repo/observability`, `@repo/stores`, and `@repo/fascicle`. They are never published separately — the umbrella bundle is the only public surface.

## Checklist

Before calling a harness done:

- [ ] `pnpm check` exits 0.
- [ ] The flow has a clear `Step<i, o>` type at its outermost layer.
- [ ] Every long-running step respects `ctx.abort`.
- [ ] Every resource the harness opens is released via `ctx.on_cleanup` or a `finally`.
- [ ] `engine.dispose()` runs on both success and failure paths.
- [ ] Secrets come from env or a secret manager, never from source.
- [ ] The harness exits with a non-zero code on failure so CI/queues can retry.

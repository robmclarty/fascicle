# Writing a Harness

A **harness** is the runnable program that wraps fascicle for a specific use case. fascicle itself is a library — not an app, not a framework, not a CLI. Your harness is where you decide:

- what the flow looks like
- how input gets in (CLI args, HTTP, queue, IDE extension, cron)
- where output goes (stdout, file, database, another service)
- which adapters observe and persist the run
- how failures are handled at the program boundary

Every file in [`examples/`](../examples/) is a small harness. This guide pulls them apart to show what goes where.

## Anatomy

A harness is three things:

1. **A flow** — a `Step<i, o>` built from primitives (`step`, `sequence`, `parallel`, `chain`, …).
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

## Add a Model Step

When you want the flow to talk to an LLM, use `model_step`, the default model boundary. It returns the answer itself, so the flow stays at the `step, model_step, step` cadence with no extraction step.

```ts
import { create_engine, model_step, sequence, run, step } from 'fascicle';

// A local Ollama model on the zero-peer native transport; swap the provider
// entry (and the model id) to target a hosted provider instead.
const engine = create_engine({
  providers: {
    ollama: { base_url: 'http://localhost:11434', transport: 'native' },
  },
});

const flow = sequence([
  step('brief', (topic: string) => `Write a 2-sentence brief on: ${topic}`),
  model_step({
    engine,
    model: 'llama3.2:3b',
    system: 'Return plain prose. No preamble, no lists.',
  }),
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
- `model_step` returns the content alone: a `string`, or the schema-validated value when `schema` is set. When the harness needs what surrounds the answer (`usage`, `cost`, `tool_calls`, `finish_reason`), swap in `model_call`, the envelope variant with the same config, and read the `GenerateResult<T>` downstream. Underneath, `model_call` is the single sanctioned bridge between the composition and engine layers.
- The engine is injected into the step at construction time; the step itself stays a plain `Step`.

## Wire in Adapters

Two seams on `RunOptions` let you observe and persist without touching flow code:

```ts
import { filesystem_logger, filesystem_store } from 'fascicle/adapters';

await run(flow, input, {
  trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }),
  checkpoint_store: filesystem_store({ root_dir: '.checkpoints' }),
  install_signal_handlers: true, // default; set false when embedding under another runtime
});
```

Both adapter slots accept anything that conforms to `TrajectoryLogger` / `CheckpointStore` (both exported from `fascicle`). Roll your own to push events to Honeycomb, DynamoDB, a tmpfs, whatever fits your deployment. The bundled `filesystem_logger` writes synchronously, which is fine for dev tools and short runs; see [concepts.md](./concepts.md#adapter-limits) before using it in long-running servers. (Span parentage is threaded by the runner, so span trees stay correct under concurrency.)

## Stream to a Consumer

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

## Pause and Resume

For human-in-the-loop flows, use `suspend` and drive the run with `run.until_suspended`, which surfaces the pause as a typed outcome instead of a thrown error:

```ts
import { run, suspend } from 'fascicle';
import { z } from 'zod';

const flow = suspend({
  id: 'approve',
  on: ({ brief }) => notify_slack(`Approve? ${brief}`),
  resume_schema: z.object({ approved: z.boolean() }),
  combine: (input: { brief: string }, resume) =>
    resume.approved ? `ship:${input.brief}` : `hold:${input.brief}`,
});

const outcome = await run.until_suspended(flow, { brief: 'beta feature' }, { checkpoint_store: store });
if (outcome.kind === 'suspended') {
  // Harness returns control to its surrounding program until input arrives,
  // then resumes with the operator's decision:
  const resumed = await outcome.resume({ approved: true });
  // resumed.kind === 'done', resumed.output === 'ship:beta feature'
}
```

The resume closure re-runs the flow from the original input with the decision merged into `resume_data`, so a harness that must survive a restart persists the input and rebuilds the outcome instead of holding the closure. [human-in-the-loop.md](./human-in-the-loop.md) walks the full HTTP version.

## Cancellation and Cleanup

A harness that runs indefinitely (server, long CLI) must handle cancellation cleanly. fascicle installs SIGINT/SIGTERM handlers by default and aborts every active run through `ctx.abort`. Steps cooperate by:

- Checking `ctx.abort.aborted` at loop boundaries.
- Passing `ctx.abort` to `fetch`, `child_process`, or any other abortable API.
- Registering teardown with `ctx.on_cleanup(() => ...)`. Cleanup runs in LIFO order on success, failure, and abort.

For embedded runtimes (tests, Lambda, worker threads), pass `install_signal_handlers: false` so fascicle does not fight the host process for the signal.

## Error Handling

All failures inside a run bubble out of `run(...)` as normal promise rejections. Typed errors from fascicle that your harness may want to special-case:

- `aborted_error` — the run was cancelled (SIGINT, timeout, parent abort).
- `timeout_error` — a `timeout(...)` step tripped.
- `suspended_error` — a `suspend(...)` step paused the flow under plain `run(...)`; drive suspend-bearing flows with `run.until_suspended` to get a typed outcome instead.
- `resume_validation_error` — `resume_data` did not match the suspend's `resume_schema`.
- `provider_error`, `rate_limit_error`, `tool_error`, `schema_validation_error`, `incomplete_generation_error`, `engine_config_error` — originate in the engine layer.

The error path carries a `.path` array with the step ids that led to the failure, so surfacing it to stdout or a log line is usually enough.

## Where to Put the Harness

In this repo, reference harnesses live at the root under [`examples/`](../examples/). Your own harness lives in your own project — fascicle is a library, not an app scaffold. Import from `fascicle` (the published package name, which the root `examples/` use too; inside the library, cross-module imports use the internal `#<module>` aliases) and write the harness wherever your program belongs. For the standard shape of the app *around* the harness (one composition layer, module contracts, markdown prompts), follow [blueprint.md](./blueprint.md).

The canonical starting point is [`examples/hello.ts`](../examples/hello.ts); the full vocabulary at app scale is [`examples/newsroom.ts`](../examples/newsroom.ts), with [leaf-arm-spine.md](./leaf-arm-spine.md) as the guide to its shape. Run the starter:

```bash
pnpm exec tsx examples/hello.ts
pnpm exec tsx examples/hello.ts "your custom input here"
```

> **Layout note.** This repo is a single installable package (`fascicle`). All source lives under `src/` as deep modules (`core`, `engine`, `composites`, `agents`, `adapters`, `mcp`, `stdio`, `ui`, `otel`, `policy`, `schema`, `testing`, `viewer`), each with a barrel `index.ts` reached only through its `#<module>` import alias. The aliases enforce architectural boundaries (for example, core cannot import from adapters, engine cannot reach into providers). The umbrella surface at the `src/` root is what bundles to npm — the published surface is the only public face.

## Checklist

Before calling a harness done:

- [ ] `pnpm check` exits 0.
- [ ] The flow has a clear `Step<i, o>` type at its outermost layer.
- [ ] The flow runs end to end against a stub engine from `fascicle/testing` (`make_stub_engine`), so tests need no network.
- [ ] Every long-running step respects `ctx.abort`.
- [ ] Every resource the harness opens is released via `ctx.on_cleanup` or a `finally`.
- [ ] `engine.dispose()` runs on both success and failure paths.
- [ ] Secrets come from env or a secret manager, never from source.
- [ ] The harness exits with a non-zero code on failure so CI/queues can retry.
- [ ] If your harness might be spawned by another program, speak the child contract with `run_stdio` — see [embedding-under-a-harness.md](./embedding-under-a-harness.md).

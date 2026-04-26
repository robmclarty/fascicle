# Cookbook

Short, worked patterns you can copy into a harness. Each pattern assumes the context in [getting-started.md](./getting-started.md) and [concepts.md](./concepts.md).

- [Retries on flaky work](#retries-on-flaky-work)
- [Timeout then fall back](#timeout-then-fall-back)
- [Fan-out with map and concurrency cap](#fan-out-with-map-and-concurrency-cap)
- [Ensemble of judges](#ensemble-of-judges)
- [Build-and-critique with adversarial](#build-and-critique-with-adversarial)
- [Consensus of N runs](#consensus-of-n-runs)
- [Tournament of candidates](#tournament-of-candidates)
- [Checkpointing an expensive step](#checkpointing-an-expensive-step)
- [Human-in-the-loop approval](#human-in-the-loop-approval)
- [Tool loops](#tool-loops)
- [Structured output with zod](#structured-output-with-zod)
- [Streaming tokens to a consumer](#streaming-tokens-to-a-consumer)
- [Observing a run with a filesystem logger](#observing-a-run-with-a-filesystem-logger)
- [Threading state with scope](#threading-state-with-scope)
- [Multi-provider fallback](#multi-provider-fallback)
- [Using the `claude_cli` provider for one task and `anthropic` for another](#using-the-claude_cli-provider-for-one-task-and-anthropic-for-another)

## Retries on flaky work

`retry(inner, policy)` re-runs on failure with exponential backoff. Use it for composition-level transients (a downstream service being unhealthy, not a 429 — the engine handles 429s itself via its own `RetryPolicy`).

```ts
import { retry, step } from '@robmclarty/fascicle';

const fetch_manifest = retry(
  step('fetch_manifest', async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`manifest ${String(res.status)}`);
    return res.json();
  }),
  { max_attempts: 4, backoff_ms: 500 },
);
```

## Timeout then fall back

Compose `timeout(...)` with `fallback(...)` when the primary must respond within a deadline or the flow must degrade gracefully.

```ts
import { fallback, timeout, step } from '@robmclarty/fascicle';

const primary = step('model-1', async (q: string) => ask_model_a(q));
const backup  = step('model-2', async (q: string) => ask_model_b(q));

const ask = fallback(timeout(primary, 10_000), backup);
```

If `primary` blows past 10s it throws `timeout_error`, `fallback` catches, and `backup` runs.

## Fan-out with map and concurrency cap

`map` runs a step per array element, optionally capped so you don't melt a downstream:

```ts
import { map, step } from '@robmclarty/fascicle';

const summarise = step('summarise', async (doc: string) => ask_model({ prompt: doc }));

const summarise_all = map({
  items: (docs: string[]) => docs,
  do: summarise,
  concurrency: 4,
});
```

## Ensemble of judges

Run N judges, pick the highest scorer. The [`examples/ensemble_judge.ts`](../examples/ensemble_judge.ts) file uses stubs; the real shape with `model_call`:

```ts
import { ensemble, model_call, pipe, step } from '@robmclarty/fascicle';
import { z } from 'zod';

const verdict_schema = z.object({
  label: z.enum(['ship', 'hold']),
  confidence: z.number().min(0).max(1),
  notes: z.string(),
});

const judge = (id: string, model: string) =>
  pipe(
    model_call({ engine, model, id, schema: verdict_schema, system: 'You are a terse judge.' }),
    (result) => result.content,
  );

const jury = ensemble({
  members: {
    opus:   judge('judge_opus',   'opus'),
    sonnet: judge('judge_sonnet', 'sonnet'),
    haiku:  judge('judge_haiku',  'haiku'),
  },
  score: (r) => r.confidence,
});
```

`run(jury, brief)` returns `{ winner, scores }`. The runner invokes all three concurrently.

## Build-and-critique with adversarial

Build a candidate, have a judge critique, loop until the judge accepts or `max_rounds` runs out. See [`examples/adversarial_build.ts`](../examples/adversarial_build.ts).

```ts
import { adversarial, model_call, pipe } from '@robmclarty/fascicle';
import { z } from 'zod';

const critique_schema = z.object({
  verdict: z.enum(['pass', 'fail']),
  notes: z.string(),
});

const build = pipe(
  model_call({ engine, model: 'sonnet', id: 'build',
    system: 'Draft a 2-sentence explainer. Use the critique if provided.' }),
  (r) => r.content,
);

const critique = pipe(
  model_call({ engine, model: 'haiku', id: 'critique', schema: critique_schema,
    system: 'Return {verdict:"pass"|"fail", notes:""}. Be strict.' }),
  (r) => r.content,
);

const explain = adversarial({
  build,
  critique,
  accept: (c) => c.verdict === 'pass',
  max_rounds: 3,
});
```

The build step's `ModelCallInput` receives `{ input, prior, critique }` on rounds 2+ so it can react to the judge.

## Consensus of N runs

Run the same (or different) steps concurrently; accept only when a quorum agrees:

```ts
import { consensus, model_call, pipe } from '@robmclarty/fascicle';

const classify = (id: string, model: string) =>
  pipe(
    model_call({ engine, model, id, system: 'Reply with one word: ship or hold.' }),
    (r) => r.content.trim().toLowerCase(),
  );

const flow = consensus({
  members: {
    a: classify('a', 'sonnet'),
    b: classify('b', 'opus'),
    c: classify('c', 'gpt-4o'),
  },
  agree: (outputs) => outputs[0],   // first that >= quorum agree on
  max_rounds: 2,
});
```

## Tournament of candidates

Single-elimination bracket, comparing pairs until a winner remains:

```ts
import { tournament, step } from '@robmclarty/fascicle';

const compare = step('compare', async ([a, b]: [string, string]) => {
  const r = await engine.generate({
    model: 'sonnet',
    prompt: `Which is better? A: ${a}\nB: ${b}\nReply only "A" or "B".`,
  });
  return r.content.trim().startsWith('A') ? a : b;
});

const bracket = tournament({
  members: { a: candidate_a, b: candidate_b, c: candidate_c, d: candidate_d },
  compare,
});
```

`candidate_*` are each `Step<input, string>`; the tournament feeds them the shared input, then the pairwise compares.

## Checkpointing an expensive step

`checkpoint` memoizes by key. The store is injected via `RunOptions`.

```ts
import { checkpoint, step } from '@robmclarty/fascicle';
import { filesystem_store } from '@repo/stores';

const build_index = checkpoint(
  step('index', async (spec: { hash: string }) => expensive_index(spec)),
  { key: (spec) => `index:${spec.hash}` },
);

await run(build_index, spec, {
  checkpoint_store: filesystem_store({ root_dir: '.checkpoints' }),
});
```

Always prefix your key with a flow name or content hash — the store is shared across every flow that uses it.

## Human-in-the-loop approval

`suspend(...)` pauses the flow. The harness catches `suspended_error`, collects input out-of-band, then resumes.

```ts
import { run, suspend, suspended_error } from '@robmclarty/fascicle';
import { z } from 'zod';
import { filesystem_store } from '@repo/stores';

const approve = suspend({
  id: 'approve',
  on: ({ plan }) => notify_slack(plan),
  resume_schema: z.object({ approved: z.boolean() }),
  combine: (input: { plan: string }, resume) =>
    resume.approved ? `ship:${input.plan}` : `hold:${input.plan}`,
});

const store = filesystem_store({ root_dir: '.checkpoints' });

try {
  await run(approve, { plan: 'deploy v2' }, { checkpoint_store: store });
} catch (err) {
  if (!(err instanceof suspended_error)) throw err;
  // Return control to your surrounding program.
}

// later, once the operator replies:
const final = await run(approve, { plan: 'deploy v2' }, {
  checkpoint_store: store,
  resume_data: { approve: { approved: true } },
});
```

See [`examples/suspend_resume.ts`](../examples/suspend_resume.ts).

## Tool loops

Give the model tools; it calls them; the engine runs the `execute` closures and feeds the output back until the model stops asking or `max_steps` is hit.

```ts
import { model_call, run } from '@robmclarty/fascicle';
import { z } from 'zod';

const get_weather = {
  name: 'get_weather',
  description: 'Look up the current temperature in Celsius for a city.',
  input_schema: z.object({ city: z.string() }),
  execute: async ({ city }: { city: string }, ctx) => {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
      signal: ctx.abort,
    });
    const body = await res.json();
    return { temp_c: Number(body.current_condition[0].temp_C) };
  },
};

const ask = model_call({
  engine,
  model: 'sonnet',
  tools: [get_weather],
  system: 'You have a weather tool. Use it.',
  max_steps: 4,
});

const out = await run(ask, 'What is the temperature in Vancouver right now?');
```

`ctx` inside `execute` is a `ToolExecContext` — it carries `abort`, `trajectory`, `tool_call_id`, and `step_index`. Pass `ctx.abort` to `fetch` so the tool respects run cancellation.

Tools can require approval:

```ts
tools: [{
  ...get_weather,
  needs_approval: (input) => input.city.startsWith('classified'),
}],
on_tool_approval: async (req) => {
  const yes = await ask_operator(req.tool_name, req.input);
  return yes;
},
```

A denied approval throws `tool_approval_denied_error`.

## Structured output with zod

Pass a schema; the engine validates, repairs (up to `schema_repair_attempts`, default 1), or throws.

```ts
import { model_call, run } from '@robmclarty/fascicle';
import { z } from 'zod';

const plan_schema = z.object({
  title: z.string(),
  steps: z.array(z.string()).min(1),
  risk: z.enum(['low', 'med', 'high']),
});

const plan = model_call({
  engine,
  model: 'sonnet',
  schema: plan_schema,
  system: 'Return a plan object. No prose outside JSON.',
});

const out = await run(plan, 'migrate the payments service to pg17');
// out.content is typed as z.infer<typeof plan_schema>
```

`schema_validation_error` carries `.zod_error` and `.raw_text` so your harness can surface both to a human.

## Streaming tokens to a consumer

Plain `run` drops streaming events. `run.stream` delivers them:

```ts
import { model_call, run } from '@robmclarty/fascicle';

const ask = model_call({ engine, model: 'sonnet' });

const handle = run.stream(ask, 'summarize Rust ownership');

for await (const event of handle.events) {
  if (event.kind === 'model_chunk' && event.chunk.kind === 'text') {
    process.stdout.write(event.chunk.text);
  }
}

const final = await handle.result;
process.stdout.write('\n');
```

`model_chunk` events wrap `StreamChunk` values from the engine. Other interesting chunk kinds: `reasoning`, `tool_call_start`, `tool_call_end`, `tool_result`, `step_finish`, `finish`.

## Observing a run with a filesystem logger

```ts
import { filesystem_logger } from '@repo/observability';

await run(flow, input, {
  trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }),
});
```

One JSON object per line. Use `jq` or anything else to inspect.

For custom sinks, write an object that satisfies `TrajectoryLogger`:

```ts
import type { TrajectoryLogger } from '@robmclarty/fascicle';

const console_logger: TrajectoryLogger = {
  record: (event) => console.log(JSON.stringify(event)),
  start_span: (name) => {
    const id = `${name}:${Math.random().toString(36).slice(2, 10)}`;
    console.log(JSON.stringify({ kind: 'start_span', name, id }));
    return id;
  },
  end_span: (id, meta) => {
    console.log(JSON.stringify({ kind: 'end_span', id, ...meta }));
  },
};
```

## Threading state with scope

When a downstream step needs a value produced upstream but the chain does not naturally carry it:

```ts
import { scope, stash, use, step } from '@robmclarty/fascicle';

const flow = scope([
  stash('user', step('lookup', async (email: string) => find_user(email))),
  step('tokenize', (_input, _ctx) => generate_token()),
  use(['user'], async ({ user }, token) => publish({ user, token })),
]);
```

`stash` binds, `use` reads. State is scoped per `scope([...])` block — siblings cannot see each other.

## Multi-provider fallback

Prefer Anthropic; fall back to OpenAI if it fails:

```ts
import { fallback, model_call } from '@robmclarty/fascicle';

const primary  = model_call({ engine, model: 'sonnet',  id: 'primary'  });
const backup   = model_call({ engine, model: 'gpt-4o',  id: 'backup'   });

const ask = fallback(primary, backup);
```

Pair with `retry` if you want retries on the primary before falling back:

```ts
const ask = fallback(retry(primary, { max_attempts: 2, backoff_ms: 500 }), backup);
```

## Using the `claude_cli` provider for one task and `anthropic` for another

One engine, both providers:

```ts
import { create_engine, model_call } from '@robmclarty/fascicle';

const engine = create_engine({
  providers: {
    claude_cli: { auth_mode: 'oauth' },
    anthropic:  { api_key: process.env.ANTHROPIC_API_KEY! },
  },
});

// The CLI has built-in tools — use it when you want them.
const do_research = model_call({
  engine,
  model: 'cli-sonnet',
  id: 'research',
  provider_options: {
    claude_cli: { allowed_tools: ['Read', 'Grep', 'Bash'] },
  },
});

// Direct API for deterministic critique.
const judge = model_call({
  engine,
  model: 'haiku',
  id: 'judge',
  system: 'Be terse. Reply pass or fail.',
});

const flow = sequence([do_research, judge]);
```

More CLI patterns — schema-constrained output, sub-agents, session resume, sandboxing — in [cli.md](./cli.md).

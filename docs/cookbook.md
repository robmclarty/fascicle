# Cookbook

Short, worked patterns you can copy into a harness. Each pattern assumes the context in [getting-started.md](./getting-started.md) and [concepts.md](./concepts.md).

- [Retries on flaky work](#retries-on-flaky-work)
- [Timeout then fall back](#timeout-then-fall-back)
- [Fan-out with map and concurrency cap](#fan-out-with-map-and-concurrency-cap)
- [Pick the best of N with a model judge](#pick-the-best-of-n-with-a-model-judge)
- [Build-and-critique with adversarial](#build-and-critique-with-adversarial)
- [Consensus of N runs](#consensus-of-n-runs)
- [Tournament of candidates (advanced)](#tournament-of-candidates-advanced)
- [Checkpointing an expensive step](#checkpointing-an-expensive-step)
- [Human-in-the-loop approval](#human-in-the-loop-approval)
- [Tool loops](#tool-loops)
- [Structured output with zod](#structured-output-with-zod)
- [Streaming tokens to a consumer](#streaming-tokens-to-a-consumer)
- [Observing a run with a filesystem logger](#observing-a-run-with-a-filesystem-logger)
- [Threading state with chain](#threading-state-with-chain)
- [Multi-provider fallback](#multi-provider-fallback)
- [Escalation tiering with a judge](#escalation-tiering-with-a-judge)
- [Using the `claude_cli` provider for one task and `anthropic` for another](#using-the-claude_cli-provider-for-one-task-and-anthropic-for-another)

## Retries on flaky work

`retry(inner, policy)` re-runs on failure with exponential backoff. Use it for composition-level transients (a downstream service being unhealthy, not a 429 — the engine handles 429s itself via its own `RetryPolicy`).

```ts
import { retry, step } from 'fascicle';

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
import { fallback, timeout, step } from 'fascicle';

const primary = step('model-1', async (q: string) => ask_model_a(q));
const backup  = step('model-2', async (q: string) => ask_model_b(q));

const ask = fallback(timeout(primary, 10_000), backup);
```

If `primary` blows past 10s it throws `timeout_error`, `fallback` catches, and `backup` runs.

## Fan-out with map and concurrency cap

`map` runs a step per array element, optionally capped so you don't melt a downstream:

```ts
import { map, step } from 'fascicle';

const summarise = step('summarise', async (doc: string) => ask_model({ prompt: doc }));

const summarise_all = map({
  items: (docs: string[]) => docs,
  do: summarise,
  concurrency: 4,
});
```

## Pick the best of N with a model judge

Run N drafters concurrently, score each result with a model judge, keep the winner. `ensemble_step` is the primary pick-best: its scorer is itself a `Step`, so the judge gets its own span in the trajectory and returns a structured score. `project` unwraps the winner at the source, so the composite's output is the draft itself, not the pick-best envelope.

```ts
import { ensemble_step, model_step } from 'fascicle';
import { z } from 'zod';

const score_schema = z.object({ score: z.number().min(0).max(1) });

const draft = (id: string, system: string) =>
  model_step({ engine, id, model: 'sonnet', system });

const style_judge = model_step({
  engine, model: 'haiku', id: 'style_judge', schema: score_schema,
  system: 'Score the draft 0..1 for clarity and fit.',
});

const best_draft = ensemble_step({
  members: {
    terse:   draft('draft_terse', 'Write a terse tagline.'),
    playful: draft('draft_playful', 'Write a playful tagline.'),
  },
  score: style_judge,
  rank_by: (s) => s.score,
  project: (e) => e.winner,
});
```

`run(best_draft, brief)` returns the winning draft; omit `project` to get the full `{ winner_id, winner, winner_scored, scored }` envelope. [`examples/ensemble_judge.ts`](../examples/ensemble_judge.ts) is the runnable version. When quality is computable by a plain function (length, pass rate, a heuristic) rather than a model, plain `ensemble` does the same with less machinery — see [advanced-composition.md](./advanced-composition.md#ensemble-and-tournament-the-other-pick-bests).

## Build-and-critique with adversarial

Build a candidate, have a judge critique, loop until the judge accepts or `max_rounds` runs out. See [`examples/adversarial_build.ts`](../examples/adversarial_build.ts).

```ts
import { adversarial, model_step, sequence, step } from 'fascicle';
import type { AdversarialBuildInput } from 'fascicle';
import { z } from 'zod';

const critique_schema = z.object({
  verdict: z.enum(['pass', 'fail']),
  notes: z.string(),
});

const build = sequence([
  step('build_prompt', (b: AdversarialBuildInput<string, string>) =>
    b.critique === undefined ? b.input : `${b.input}\n\nRevise per: ${b.critique}`),
  model_step({ engine, model: 'sonnet', id: 'build',
    system: 'Draft a 2-sentence explainer.' }),
]);

const critique = model_step({ engine, model: 'haiku', id: 'critique', schema: critique_schema,
  system: 'Return {verdict:"pass"|"fail", notes:""}. Be strict.' });

const explain = adversarial({
  build,
  critique,
  accept: (c) => c['verdict'] === 'pass',
  max_rounds: 3,
  project: (r) => r.candidate,
});
```

The build step's input carries `{ input, prior, critique }`, where `critique` is the judge's notes on rounds 2+, so the prompt step can fold the feedback in. `project` unwraps the accepted candidate at the source; omit it to get the `{ candidate, converged, rounds }` envelope.

## Consensus of N runs

Run the same (or different) steps concurrently; accept once an `agree` predicate
over the per-member results holds (here, a strict majority):

<!-- snippet: check -->
```ts
import { consensus, create_engine, model_step, pipe } from 'fascicle';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY! } },
});

const classify = (id: string, model: string) =>
  pipe(
    model_step({ engine, model, id, system: 'Reply with one word: ship or hold.' }),
    (r) => r.trim().toLowerCase(),
  );

const flow = consensus({
  members: {
    a: classify('a', 'sonnet'),
    b: classify('b', 'opus'),
    c: classify('c', 'haiku'),
  },
  // agree receives the per-member results keyed by member name and returns a
  // boolean. Accept once a strict majority return the same verdict.
  agree: (results) => {
    const tally = new Map<string, number>();
    for (const verdict of Object.values(results)) {
      tally.set(verdict, (tally.get(verdict) ?? 0) + 1);
    }
    return Math.max(...tally.values()) > Object.keys(results).length / 2;
  },
  max_rounds: 2,
});
```

The step's output is the `{ result, converged }` envelope; when downstream steps should see a domain value instead of the wrapper, add `project` to map it at the source (`project: (r) => r.converged`, or pick the agreed verdict out of `r.result`).

## Tournament of candidates (advanced)

Single-elimination bracket, comparing pairs until a winner remains. `compare(a, b)`
is a plain function over two member *results* that returns `'a'` or `'b'` — the
result that advances. Reach for this only when quality is pairwise-comparable
and no absolute score exists; when a judge can score candidates,
`ensemble_step` is the primary pick-best
([advanced-composition.md](./advanced-composition.md#ensemble-and-tournament-the-other-pick-bests)).

<!-- snippet: check -->
```ts
import { create_engine, model_step, tournament } from 'fascicle';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY! } },
});

const draft = (id: string, system: string) =>
  model_step({ engine, id, model: 'sonnet', system });

const bracket = tournament({
  members: {
    a: draft('a', 'Write a terse tagline.'),
    b: draft('b', 'Write a playful tagline.'),
    c: draft('c', 'Write a bold tagline.'),
    d: draft('d', 'Write a classic tagline.'),
  },
  compare: async (a, b) => {
    const r = await engine.generate({
      model: 'sonnet',
      prompt: `Which tagline is better?\nA: ${a}\nB: ${b}\nReply only "A" or "B".`,
    });
    return r.content.trim().toUpperCase().startsWith('A') ? 'a' : 'b';
  },
  project: (r) => r.winner,
});
```

Each member is a `Step` producing a candidate; the tournament feeds them the
shared input, then runs the pairwise `compare`s until one result remains.
`project` unwraps the winner at the source; omit it to get the
`{ winner, bracket }` envelope with every match recorded.

## Checkpointing an expensive step

`checkpoint` memoizes by key. The store is injected via `RunOptions`.

```ts
import { checkpoint, step } from 'fascicle';
import { filesystem_store } from 'fascicle/adapters';

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

`suspend(...)` pauses the flow. Drive it with `run.until_suspended`, which returns the pause as a typed outcome with a `resume` closure instead of throwing.

```ts
import { run, suspend } from 'fascicle';
import { z } from 'zod';
import { filesystem_store } from 'fascicle/adapters';

const approve = suspend({
  id: 'approve',
  on: ({ plan }) => notify_slack(plan),
  resume_schema: z.object({ approved: z.boolean() }),
  combine: (input: { plan: string }, resume) =>
    resume.approved ? `ship:${input.plan}` : `hold:${input.plan}`,
});

const store = filesystem_store({ root_dir: '.checkpoints' });

const outcome = await run.until_suspended(approve, { plan: 'deploy v2' }, { checkpoint_store: store });
if (outcome.kind === 'suspended') {
  // Return control to your surrounding program; once the operator replies:
  const resumed = await outcome.resume({ approved: true });
  // resumed.kind === 'done', resumed.output === 'ship:deploy v2'
}
```

The resume closure re-runs the flow from the original input with the decision merged into `resume_data`; a closure cannot outlive the process, so a durable harness persists the input and rebuilds the outcome after a restart.

See [`examples/suspend_resume.ts`](../examples/suspend_resume.ts) for the
mechanical version, [`examples/hitl_http.ts`](../examples/hitl_http.ts) for an
end-to-end suspend/confirm/resume server, and
[docs/human-in-the-loop.md](./human-in-the-loop.md) for the full narrative
(including streaming the outcome to a `useChat` UI with `fascicle/ui`).

## Tool loops

Give the model tools; it calls them; the engine runs the `execute` closures and feeds the output back until the model stops asking or `max_steps` is hit.

```ts
import { model_step, run } from 'fascicle';
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

const ask = model_step({
  engine,
  model: 'sonnet',
  tools: [get_weather],
  system: 'You have a weather tool. Use it.',
  max_steps: 4,
});

const out = await run(ask, 'What is the temperature in Vancouver right now?');
```

`ctx` inside `execute` is a `ToolExecContext` — it carries `abort`, `trajectory`, `tool_call_id`, and `step_index`. Pass `ctx.abort` to `fetch` so the tool respects run cancellation. `out` is the model's final answer; when the harness wants the `ToolCallRecord`s, per-step usage, or finish reason, swap in `model_call` and read the envelope.

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

Tools can also end the loop. By default the loop runs until the model emits a turn with no tool call or `max_steps` is hit; a weak local model often does better with an explicit `finish` tool it can call to signal it is done. Flag that tool `ends_turn: true` and a successful call ends the loop immediately, with no extra model turn:

```ts
const finish = {
  name: 'finish',
  description: 'Call when the task is complete. Provide a short summary.',
  input_schema: z.object({ summary: z.string() }),
  execute: ({ summary }: { summary: string }) => summary,
  ends_turn: true,
};
```

The call runs its `execute` first (so the summary lands in the `ToolCallRecord` output and the trajectory), then the loop stops with `finish_reason: 'stop'`. Only a successful call ends the loop: a denied, invalid, dropped, or throwing terminal call is fed back like any other tool error and the loop keeps going. A terminal call also wins over a coincident `max_steps` cap, so a `finish` on the last allowed step is a clean stop, not a cutoff. `ends_turn` composes with `tool_call_repair_attempts` (a salvaged `finish` ends the loop too) and `max_tool_calls_per_step`.

## Structured output with zod

Pass a schema; the engine validates, repairs (up to `schema_repair_attempts`, default 1), or throws.

```ts
import { model_step, run } from 'fascicle';
import { z } from 'zod';

const plan_schema = z.object({
  title: z.string(),
  steps: z.array(z.string()).min(1),
  risk: z.enum(['low', 'med', 'high']),
});

const plan = model_step({
  engine,
  model: 'sonnet',
  schema: plan_schema,
  system: 'Return a plan object. No prose outside JSON.',
});

const out = await run(plan, 'migrate the payments service to pg17');
// out is typed as z.infer<typeof plan_schema>
```

`schema_validation_error` carries `.schema_issues` and `.raw_text` so your harness can surface both to a human. A call that never got far enough to validate — blocked by a content filter, truncated by the token limit, ended by the step cap — throws `incomplete_generation_error` instead, carrying `.finish_reason`, `.raw_text`, and `.provider_reported`.

## Streaming tokens to a consumer

Plain `run` drops streaming events. `run.stream` delivers them:

```ts
import { model_step, run } from 'fascicle';

const ask = model_step({ engine, model: 'sonnet' });

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
import { filesystem_logger } from 'fascicle/adapters';

await run(flow, input, {
  trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }),
});
```

One JSON object per line. Use `jq` or anything else to inspect. Note `filesystem_logger` writes synchronously and uses an in-memory span stack — see [concepts.md](./concepts.md#adapter-limits) before using it on a hot path.

For custom sinks, write an object that satisfies `TrajectoryLogger`:

```ts
import type { TrajectoryLogger } from 'fascicle';

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

## Threading state with chain

When a downstream step needs a value that is not its immediate predecessor's output, `chain` carries it as a named binding in a growing typed record:

```ts
import { chain } from 'fascicle';

const flow = chain<string, 'email'>('email')
  .step('user', ({ email }) => find_user(email))
  .step('token', () => generate_token())
  .step('published', ({ user, token }) => publish({ user, token }))
  .output(({ published }) => published);
```

Each `.step` merges its result under its name; later bindings destructure whatever earlier names they need, checked at compile time. `.stage(name, project?)` concludes a phase (with `project`, it narrows the record so earlier bindings go out of scope). The raw string-keyed tier underneath (`scope` / `stash` / `use`) remains for shapes bindings cannot express — see [advanced-composition.md](./advanced-composition.md#scope-stash-use-named-state-without-types).

## Multi-provider fallback

Prefer Anthropic; fall back to OpenAI if it fails:

```ts
import { fallback, model_step } from 'fascicle';

const primary  = model_step({ engine, model: 'sonnet',  id: 'primary'  });
const backup   = model_step({ engine, model: 'gpt-4o',  id: 'backup'   });

const ask = fallback(primary, backup);
```

Pair with `retry` if you want retries on the primary before falling back:

```ts
const ask = fallback(retry(primary, { max_attempts: 2, backoff_ms: 500 }), backup);
```

The `handoff` option builds the backup's input from the original input and the
error, so the backup knows why it is running instead of retrying blind:

```ts
const ask = fallback(primary, backup, {
  handoff: (prompt, err) =>
    `${prompt}\n\n(A previous attempt failed: ${err instanceof Error ? err.message : 'unknown'}. Answer from scratch.)`,
});
```

Control-flow signals (suspend, abort) still propagate without triggering the
backup, and `handoff` is never called for them.

## Escalation tiering with a judge

`fallback` escalates on a *throw*. This pattern escalates on *mediocrity*: run
a cheap model first, have a judge read the answer it actually produced, and
only pay for the strong model when the judge says the cheap one is in trouble.
Gateway-level routers (NVIDIA's Switchyard, for one) apply the same idea at
the wire; in a fascicle app you own the call site, so it is plain composition
with the verdict visible in the trajectory.

Three mechanics carry the pattern:

1. **Judge completed work, not predicted difficulty.** The judge rates the
   weak draft, not the request.
2. **Buffer the weak answer.** A verdict that does not escalate costs one weak
   call plus one judge call; the draft is served as-is.
3. **Fail open.** A judge that errors must serve the buffered draft, never
   escalate. This is `fallback` around the judge.

```ts
import { branch, chain, fallback, model_step, sequence, step } from 'fascicle';
import { z } from 'zod';

const verdict_schema = z.object({
  escalate: z.boolean(),
  reason: z.string(),
});

type Turn = {
  prompt: string;
  draft: string;
  verdict: z.infer<typeof verdict_schema>;
};

const weak_draft = model_step({ engine, model: 'haiku', id: 'weak_draft' });

const strong_answer = model_step({ engine, model: 'opus', id: 'strong_answer' });

const judge = model_step({ engine, model: 'sonnet', id: 'judge', schema: verdict_schema,
  system: 'Judge the draft against the request. Escalate only on real trouble.' });

// A judge that dies must not escalate: fail open to "serve the draft".
const safe_judge = fallback(
  judge,
  step('fail_open', () => ({ escalate: false, reason: 'judge unavailable' })),
);

const escalate_or_serve = branch({
  when: (t: Turn) => t.verdict.escalate,
  then: sequence([
    step('handoff', (t: Turn, ctx) => {
      ctx.emit({ escalated: true, reason: t.verdict.reason });
      return `${t.prompt}\n\nA smaller model got stuck; its draft:\n${t.draft}`;
    }),
    strong_answer,
  ]),
  otherwise: step('serve_draft', (t: Turn) => t.draft),
});

// The spine: prompt, draft, and verdict are fan-in, so this is chain territory.
const answer = chain<string, 'prompt'>('prompt')
  .step('draft', ({ prompt }, ctx) => ctx.call(weak_draft, prompt), { arm: weak_draft })
  .step('verdict', ({ prompt, draft }, ctx) =>
    ctx.call(safe_judge, `Request:\n${prompt}\n\nDraft answer:\n${draft}`), { arm: safe_judge })
  .step('served', ({ prompt, draft, verdict }, ctx) =>
    ctx.call(escalate_or_serve, { prompt, draft, verdict }), { arm: escalate_or_serve })
  .output(({ served }) => served);
```

`run(answer, prompt)` serves the weak draft unless the judge escalates; the
`escalated` emit and the per-span costs land in the trajectory, so you can see
exactly which requests paid for the strong tier and why.

### Latching over many turns

For a long run over many work items, one escalate verdict is weak evidence:
require consecutive confirmations, then latch. Hold the streak in a `loop`'s
carry-state:

```ts
import { branch, loop, step } from 'fascicle';

type TierState = {
  tasks: string[];
  done: string[];
  streak: number;   // consecutive escalate verdicts
  latched: boolean; // once true, skip the weak tier and the judge entirely
};

const tiered_run = loop({
  init: (tasks: string[]): TierState => ({ tasks, done: [], streak: 0, latched: false }),
  body: branch({
    when: (s: TierState) => s.latched,
    then: strong_turn,      // latched: straight to the strong tier, no judge
    otherwise: judged_turn, // the pattern above, reshaped to Step<TierState, TierState>
  }),
  guard: step('remaining', (s: TierState) => ({ stop: s.tasks.length === 0, state: s })),
  finish: (s) => s.done,
  max_rounds: 100,
});
```

`judged_turn` pops the next task and runs the weak-draft-then-judge flow. The
streak rules that make it stable:

- an escalate verdict increments `streak`; a decline resets it to zero;
- a fail-open judge *holds* the streak (neither increments nor resets), so a
  flaky judge can neither force nor block a latch;
- when the streak reaches two, the current task is redone on the strong tier
  (that turn pays for all three calls) and `latched` flips, so every later
  round takes the `then` arm with no judge overhead.

### Calibrating when the weak tier is enough

Whether the judge should escalate eagerly or reluctantly is an empirical
question, and trajectory logs make it measurable. The minimum-data path:

1. **Run the task set on the strong tier alone** (~40–75 representative
   tasks). This is the quality baseline, and its trajectories record cost.
2. **Probe the weak tier** on ~20 of those tasks, stratified: easy and clean,
   easy but subtle, hard and structural, hard but localized. Don't
   over-represent one project or task shape.
3. **Quadrant the overlap.** RESCUE = strong-fail ∩ weak-pass (tiering wins
   here). LOSS = strong-pass ∩ weak-fail (never serve weak here). SAFE = both
   pass (free savings). HARD = both fail (tiering is irrelevant).
4. **Tune the judge** (its prompt, and the confirmation count in the latch)
   to the most permissive setting that keeps LOSS escalated without burning
   strong-tier calls on SAFE.

`bench` over a fixture set is the natural harness for the two probe runs, and
`regression_compare` against a committed baseline keeps the calibration from
drifting as prompts and models change.

## Using the `claude_cli` provider for one task and `anthropic` for another

One engine, both providers:

```ts
import { create_engine, model_step, sequence } from 'fascicle';

const engine = create_engine({
  providers: {
    claude_cli: { auth_mode: 'oauth' },
    anthropic:  { api_key: process.env.ANTHROPIC_API_KEY! },
  },
});

// The CLI has built-in tools — use it when you want them.
const do_research = model_step({
  engine,
  model: 'sonnet',
  provider: 'claude_cli',   // engine has two providers; name the transport explicitly
  id: 'research',
  provider_options: {
    claude_cli: { allowed_tools: ['Read', 'Grep', 'Bash'] },
  },
});

// Direct API for deterministic critique.
const judge = model_step({
  engine,
  model: 'haiku',
  id: 'judge',
  system: 'Be terse. Reply pass or fail.',
});

const flow = sequence([do_research, judge]);
```

More CLI patterns — schema-constrained output, sub-agents, session resume, sandboxing — in [cli.md](./cli.md). For which layer of a flow each recipe belongs to (leaves, arms, spine), see [leaf-arm-spine.md](./leaf-arm-spine.md); for how to organize a whole app around these recipes — one composition layer, stage factories, markdown prompts — see [blueprint.md](./blueprint.md).

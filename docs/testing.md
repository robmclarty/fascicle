# Testing

How to unit-test flows with `fascicle/testing`, which gives you engine doubles that drive
the real `run()` through real composition with zero network and zero API keys.

The doubles exist because the seam that's worth stubbing is the engine and not
the flow. A flow is plain composition, and what makes it untestable is the
provider behind `engine.generate`. Swap that one member for a canned one and
everything else (routing, schema validation, retries, suspends, trajectories)
runs for real. The pattern is worked through in
[blueprint.md](./blueprint.md#testing-stub-the-engine-not-the-flow).

```ts
import {
  assert_prefix_stable,
  checkpoint_store_conformance,
  engine_from_generate,
  make_capture_engine,
  make_loop_engine,
  make_script_engine,
  make_stub_engine,
  text_of,
} from 'fascicle/testing';
```

All four factories build a full `Engine` (`make_capture_engine` and
`make_loop_engine` hand it back inside an object, beside what they record). The
three that are built on `engine_from_generate` keep their non-`generate`
members inert, so pricing calls are no-ops, `dispose` resolves immediately, and
`with_providers` throws. `make_loop_engine` is a whole engine that
`create_engine` built, with a provider that plays your script. It registers no
pricing, so when you pass a trajectory, a call on it records `pricing_missing`,
once for each provider and model it reached.
`make_stub_engine` and `make_script_engine` honor the engine contract at the
seams your tests exercise, so a call whose `opts.abort` is already aborted
throws the engine's `aborted_error`, a provided `opts.on_chunk` receives the
content as a text chunk plus a finish chunk before the result resolves (so
`model_chunk` trajectory events fire), and content is validated through the
call's own schema, failing with the engine's `schema_validation_error`.
`make_capture_engine` does none of that. It records the call and returns its
canned result, and its `on_generate` hook is where you drive chunks or aborts
yourself.

## `make_stub_engine`

Routes each generate call by system-prompt prefix, where the first canned response
whose `prefix` the call's system prompt starts with answers it. An unmatched
system throws, so a flow that grows a new model boundary fails loudly on you
instead of silently reusing a fixture. The empty-string prefix matches every
call, which is the case where you have a single model boundary.

```ts
import { make_stub_engine } from 'fascicle/testing';

const engine = make_stub_engine([
  { prefix: 'app/review', content: { verdict: 'ship', reasons: ['clean diff'] } },
  { prefix: 'app/plan', content: 'plan: do the thing' },
]);
```

`content` may also be a function of `(opts, call_index)`, where `call_index`
counts how many times that prefix route has matched before, starting at 0.
That's how you script a route your flow hits repeatedly, like a revision loop:

```ts
const engine = make_stub_engine([
  { prefix: 'app/revise', content: (_opts, i) => (i < 2 ? 'draft with TODO' : 'final') },
]);
```

A function written inline like that takes its parameter types from
`StubContentFn`, so `opts` is a `GenerateOptions` and `i` is a number, with
nothing to annotate, and `content` still accepts any other value, one typed
`unknown` included.

For options, `make_stub_engine(canned, { usage, model_id })` sets the usage totals
reported on every result (default `{ input_tokens: 40, output_tokens: 20 }`)
and `model_resolved.model_id` (default `'stub'`).

### The `define_agent` Caveat

A markdown-only agent (no `build_prompt`) sends its body as the user prompt and **no system
prompt at all**. To a stub, every such call looks identical, because they all hit the `''`
prefix route, and you can't tell two agents defined this way apart. Either give the agent a
`build_prompt` (the markdown body then becomes the system prompt, so a prefix can match it),
or reach for `make_script_engine`, which tells calls apart by order instead of by prefix.

### Schema Validation

Canned content is validated through your own schema (`opts.schema['~standard'].validate`),
so your fixtures can't drift from the contracts they stand in for, and a schema change
breaks the test that ships stale data. A failure throws the engine's real
`schema_validation_error`, with `schema_issues` holding the normalized issues and `raw_text`
holding the canned content (strings verbatim, other values JSON-serialized). So your own
code that branches on `instanceof schema_validation_error` is testable against the stub:

```ts
import { schema_validation_error } from 'fascicle';

try {
  await run(flow, input);
} catch (err) {
  if (err instanceof schema_validation_error) {
    console.error(err.schema_issues, err.raw_text);
  }
}
```

## `make_script_engine`

A queue of responses that are consumed strictly in call order, so call 1 gets
the first entry, call 2 the next. Use it when order matters and prefixes can't see a
difference, like loops that must converge, retry paths, and markdown-only agents. A
call past the end throws and names how many responses you scripted versus how
many arrived, so an unexpected extra model call fails loudly.

```ts
import { make_script_engine } from 'fascicle/testing';

const engine = make_script_engine([
  'first answer',
  { verdict: 'ship' },
  { content: 'third answer', finish_reason: 'length' },
]);
```

Each entry is either plain content, or a `ScriptResponse` object that supports
`{ content?, tool_calls?, finish_reason?, usage?, throw? }`. Only an object
whose keys all belong to that shape counts as scripted, and anything else
(including `{ verdict: 'ship' }` above) becomes content as-is. If your literal
content collides with that shape, wrap it in `{ content }`.

`tool_calls` passes `ToolCallRecord`s through to the result, for flows that
read the envelope:

```ts
const engine = make_script_engine([
  {
    content: 'looked it up',
    tool_calls: [
      { id: 'c1', name: 'lookup', input: { q: 'x' }, output: { hits: 2 }, duration_ms: 5, started_at: 0 },
    ],
  },
]);
```

`throw` raises the given error for that call instead of answering, which is how you script
provider failures and rate limits. See the retry recipe below. The options mirror
`make_stub_engine`'s `{ usage, model_id }`, with `model_id` defaulting to `'script'`.
Per-entry `usage` wins over the option.

## `make_capture_engine`

Records every call's `GenerateOptions` into a live `calls` array and answers
each with the same canned result. Use it to assert what reached the engine,
because it doesn't script conversations for you.

```ts
import { make_capture_engine, text_of } from 'fascicle/testing';

const { engine, calls } = make_capture_engine();
await run(flow, input);

expect(calls).toHaveLength(1);
expect(calls[0]?.system).toContain('app/review');
expect(text_of(calls[0]!)).toContain('the diff under review');
```

`text_of(opts)` extracts the user-visible prompt text from a captured call
whether `prompt` is a string or a `Message[]` with content parts. You get a
string prompt verbatim, and otherwise every user turn's text joined with
newlines. It's total (it returns `''` when there's none), so no more
`calls[0].prompt[0].content[0].text` navigation. System and assistant text
are excluded on purpose, so assert those through `opts.system` and the raw
messages.

`make_capture_engine({ result, on_generate })` overrides the canned result
and hooks each call after it's recorded. `on_generate` is awaited before the
result resolves, which is where you drive chunks or aborts against the captured
options.

## `make_loop_engine`

The other three doubles stand in for the whole engine, so no tool loop runs
under them, and a tool you hand a model call never runs. `make_loop_engine`
keeps the real engine and swaps only the model. It registers a provider that
plays your script, and the engine runs its own tool loop around it. Your tools
run, your approval handler is asked, tool results are fed back, and your
`on_chunk` sees chunks the way it would with a model behind the call. Every
request that the model was sent lands in a live `requests` array, so you can
read what the loop sent, tool results included.

```ts
import { define_tool, model_step, run } from 'fascicle';
import { make_loop_engine } from 'fascicle/testing';
import { z } from 'zod';

const get_weather = define_tool({
  name: 'get_weather',
  description: 'Look up the weather for a city.',
  input_schema: z.object({ city: z.string() }),
  execute: ({ city }) => `sunny in ${city}`,
});

const { engine, requests } = make_loop_engine([
  [{ name: 'get_weather', input: { city: 'Oslo' } }],
  'It is sunny in Oslo.',
]);

const ask = model_step({ engine, tools: [get_weather] });

expect(await run(ask, 'weather in Oslo?')).toBe('It is sunny in Oslo.');
expect(requests[1]?.messages.at(-1)).toMatchObject({
  role: 'tool',
  tool_call_id: 'call_0_0',
  content: 'sunny in Oslo',
});
```

Each entry is one model turn, and each time the loop asks the model for a turn,
the next entry plays. A string is a final answer that ends with `'stop'`. An
array is the calls a turn makes, and it ends with `'tool_calls'`. When you need
more than that, an object spells the turn out as
`{ text?, tool_calls?, content?, finish_reason?, usage?, paused?, throw? }`. Its `text`
and `tool_calls` default to the text parts and the `tool_call` parts of its
`content`, which the loop sends back as the assistant message, and its `finish_reason` defaults to `'tool_calls'` when the turn makes
calls and `'stop'` when it doesn't. `paused: true` plays a turn that the
provider paused partway through, as Anthropic's `pause_turn` does, so the loop
sends it back and asks the next entry to continue it, and the call's text joins
the two turns' texts. A turn streams its text as one chunk, and then each call
as a start and an end.

A call that you give no `id` gets `call_<turn>_<n>`, where `<turn>` is the
entry's place in the script and `<n>` is the call's place in the turn, both
counted from 0. The script runs across every call you make through the engine,
so your second `generate` call picks up where the first one left off. A request
lands in `requests` before its turn plays, so a turn that throws, and a turn
past the end of the script, still leave their request behind for you to read.
A turn past the end throws and names how many turns you scripted and which one
was asked for, so a loop that goes round one more time than you planned fails
loudly.

The provider and the default model are both `'loop'`, and the options are
`{ model_id, usage, prompt_cache }`. `model_id` changes the default model, and
`usage` is what a turn reports when you set none on it (default `{
input_tokens: 40, output_tokens: 20 }`). Per-turn `usage` wins over the option.
`prompt_cache` declares the caching that the double's provider does
(`'with_tools'`, `'opt_in'`, or `'automatic'`), so a test can read the `cache`
that each request carries. Left out, the provider declares nothing, and no
request carries one (see
[providers.md](./providers.md#prompt-caching)).

### Scripting a Provider Failure

`throw` raises your error for that turn before anything streams, and the engine
reads it the way it reads an error that a provider threw. That's what makes it
useful, and it's also the catch. An error that the engine counts as retryable,
like a `provider_error` with a 5xx `status`, is retried by the engine's own
retry policy, and the retry asks for a turn again, so it uses up the next entry
in your script under the same `step_index`. A plain `Error` is never retried,
and your call rejects with it. Give the call a retry policy that doesn't wait,
or your test sits through the default backoff:

```ts
import { provider_error } from 'fascicle';
import { make_loop_engine } from 'fascicle/testing';

const { engine, requests } = make_loop_engine([
  { throw: new provider_error('overloaded', { status: 503 }) },
  'recovered',
]);

const result = await engine.generate({
  prompt: 'hello',
  retry: { max_attempts: 2, initial_delay_ms: 0, max_delay_ms: 0, retry_on: ['provider_5xx'] },
});

expect(result.content).toBe('recovered');
expect(requests.map((request) => request.step_index)).toEqual([0, 0]);
```

## `assert_prefix_stable`

A provider's prompt cache matches each request by its prefix, which is the
system prompt, the tools, and the messages, in the order the wire sends them. A
tool loop that only appends keeps that prefix whole, so from the second turn
on, each turn can read the one before it from the cache. A loop that rewrites
the prefix misses the cache on every turn, and nothing fails to tell you. A
`prepare_step` sliding window does it, and so does a tool list that you rebuild
in another order, or a system prompt that carries the time.

`assert_prefix_stable(requests)` reads the requests that `make_loop_engine`
recorded and checks each turn against the turn before it in the same call. The
system prompt has to match, the tools have to match in the same order (their
names, descriptions, and input schemas), and the later turn has to send every
earlier message again before any new one. Messages are compared as JSON text,
because that's what the wire sends, so a message whose keys you rebuilt in
another order counts as a change. A schema counts as unchanged when it's the
same object or when it converts to the same JSON Schema, and a new object that
has no JSON Schema to compare counts as a change.

```ts
import { assert_prefix_stable, make_loop_engine } from 'fascicle/testing';

const { engine, requests } = make_loop_engine(turns);
await run(build_flow(engine), input);

assert_prefix_stable(requests);
```

It throws a plain `Error` at the first difference, so it works under any test
runner. The message names the call (counted from 1), the step (its
`step_index`), and the difference, as in `call 1, step 2: message 3 differs
from step 1`, where message and tool positions count from 0 the way the
request's arrays hold them. It ends by saying that the check reads calls that
ran one at a time, for the reason below.

Requests carry no call id, so the check starts a new call wherever a
`step_index` doesn't go up, and two things follow from that. A retried turn
repeats its `step_index`, so it starts a new call in the check, and the turn
after it is compared with the retry. And the check reads calls that ran one at
a time. Calls that run at once on one engine interleave their requests, so a
`parallel` flow takes one double per branch.

## `engine_from_generate`

The 12-line shell that the three canned factories build on, for when you roll your own double.
Your double only has to implement `generate`, which accepts `GenerateOptions`
and resolves a complete `GenerateResult` (`content`, `tool_calls`, `steps`,
`usage`, `finish_reason`, `model_resolved`). Honoring `opts.abort`,
`opts.on_chunk`, and `opts.schema` is optional, so honor whichever ones the code
under test exercises. You don't have to implement pricing, `with_providers`, or
`dispose`, because the shell supplies inert versions.

```ts
import { engine_from_generate } from 'fascicle/testing';

const flaky = engine_from_generate(async (opts) => ({
  content: opts.system?.startsWith('app/judge') ? 'ship' : 'hold',
  tool_calls: [],
  steps: [],
  usage: { input_tokens: 1, output_tokens: 1 },
  finish_reason: 'stop',
  model_resolved: { provider: 'stub', model_id: 'flaky' },
}));
```

## `checkpoint_store_conformance`

A store is three small functions, and every one of them hides a decision that's
easy to get wrong. A value that a crash left half-written has to read as a miss
and not throw. Two keys can't share storage just because they encode to the
same file name, and clearing scope `a` can't reach a scope named `a/b` just
because its name begins the same way. A claim has to refuse a second owner even
when both ask at the same moment, and once it's expired, it has to pass to the
next one.
`checkpoint_store_conformance` checks all of that against a store you wrote,
so a store over S3, DynamoDB, or Postgres can earn the same trust that
`filesystem_store` has.

<!-- snippet: check -->
```ts
import type { CheckpointStore } from 'fascicle';
import { checkpoint_store_conformance } from 'fascicle/testing';

declare function make_my_store(): CheckpointStore;

export async function prove_my_store(): Promise<void> {
  const report = await checkpoint_store_conformance(() => make_my_store());
  if (report.failed.length > 0) {
    throw new Error(report.failed.map((f) => `${f.check}: ${f.message}`).join('\n'));
  }
}
```

It hands every check a fresh store from the factory you pass, so the factory
should give each store a namespace of its own (a temporary directory, a random
key prefix, a throwaway table). The scope checks run when your store has
`scope`, the claim checks run when it has `claim` or `release`, and the report
lists whatever it's skipped. It doesn't register tests. It returns the report
instead, so it works under any runner, and asserting that `failed` is empty is
the whole test.

Two options tune it. `corrupt(store, key)` damages the value stored at a key the
way a torn write would, and when you pass it, the suite checks that the
damaged value reads as a miss. `ttl_ms` sets the claim lifetime that the expiry
checks wait out. It's 200 milliseconds by default, and if your store's clock is
coarse, you'll want it longer.

For a worked example, [examples/object-store](../examples/object-store/) writes a
store over an S3-style client, with claims made of conditional writes, and runs
it through the suite before `durable` keeps a run in it.

## Recipes

All five run keyless and network-free in the default test suite, so you can paste any of
them straight into yours.

### Testing a Retry Path

Script the failure, then the recovery. `retry` reads your scripted
`rate_limit_error` as an application failure and re-runs the step, which
consumes the next queue entry:

```ts
import { model_step, rate_limit_error, retry, run } from 'fascicle';
import { make_script_engine } from 'fascicle/testing';

const engine = make_script_engine([
  { throw: new rate_limit_error('scripted 429', { retry_after_ms: 1 }) },
  'recovered',
]);

const ask = model_step({ engine, model: 'test-model' });
const resilient = retry(ask, { max_attempts: 2, backoff_ms: 1 });

expect(await run(resilient, 'hello')).toBe('recovered');
```

### Testing a Loop That Converges

The script's order sensitivity is exactly what you want for a convergence test.
Round 1 gets the unconverged draft, round 2 the final one, and a loop that
fails to converge in the rounds you scripted exhausts the queue and fails with
the call count in the message:

```ts
import { loop, model_step, run, step } from 'fascicle';
import { make_script_engine } from 'fascicle/testing';

const engine = make_script_engine(['draft with TODO', 'final draft']);
const revise = model_step({ engine, model: 'test-model' });

const converge = loop({
  init: (brief: string) => brief,
  body: revise,
  guard: step('done', (draft: string) => ({ stop: !draft.includes('TODO'), state: draft })),
  finish: (draft) => draft,
  max_rounds: 5,
});

expect(await run(converge, 'write the brief')).toBe('final draft');
```

### Testing Suspend/Resume Flows Keyless

`suspend` gates are pure composition, so `run.until_suspended` reports the pause
as a typed outcome and `outcome.resume(data)` re-runs with the decision, with no
engine involved. Stub the model steps around the gate and your whole
human-in-the-loop path runs in a unit test. The full worked example is
[examples/suspend-resume/main.ts](../examples/suspend-resume/main.ts):

```ts
const outcome = await run.until_suspended(flow, input, { install_signal_handlers: false });
if (outcome.kind !== 'suspended') throw new Error('expected the gate to suspend');

const resumed = await outcome.resume({ approved: true });
```

### Testing a Tool Loop Keyless

`make_loop_engine` and `assert_prefix_stable` test a tool loop end to end with
no key. The script plays the model, the engine runs your real tools and feeds
their results back, and the check proves that each turn only appended, which is
what keeps a provider's cache warm across the loop:

<!-- snippet: check -->
```ts
import { define_tool, model_step, run } from 'fascicle';
import { assert_prefix_stable, make_loop_engine } from 'fascicle/testing';
import { expect, it } from 'vitest';
import { z } from 'zod';

const search = define_tool({
  name: 'search',
  description: 'Find the files that mention a pattern.',
  input_schema: z.object({ pattern: z.string() }),
  execute: ({ pattern }) => [`src/a.ts: ${pattern}`],
});

const read_file = define_tool({
  name: 'read_file',
  description: 'Read a file from the workspace.',
  input_schema: z.object({ path: z.string() }),
  execute: ({ path }) => `// TODO: tidy ${path}`,
});

it('finds the TODO in two tool turns, appending each time', async () => {
  const { engine, requests } = make_loop_engine([
    [{ name: 'search', input: { pattern: 'TODO' } }],
    [{ name: 'read_file', input: { path: 'src/a.ts' } }],
    'src/a.ts has one TODO.',
  ]);
  const ask = model_step({
    engine,
    system: 'You answer questions about the workspace.',
    tools: [search, read_file],
  });

  expect(await run(ask, 'where are the TODOs?')).toBe('src/a.ts has one TODO.');
  expect(requests).toHaveLength(3);
  assert_prefix_stable(requests);
});
```

### Testing Timeout Behavior

Fake a hung provider with `engine_from_generate`, passing it a `generate` that
sits there and rejects only when `opts.abort` fires. `timeout` cancels the inner
step after the budget and your run rejects with `timeout_error`:

```ts
import { model_step, run, timeout, timeout_error } from 'fascicle';
import { engine_from_generate } from 'fascicle/testing';

const never_answers = engine_from_generate(
  (opts) =>
    new Promise((_resolve, reject) => {
      opts.abort?.addEventListener('abort', () => {
        reject(opts.abort?.reason);
      });
    }),
);

const ask = model_step({ engine: never_answers, model: 'test-model' });

await expect(run(timeout(ask, 50), 'hello')).rejects.toThrow(timeout_error);
```

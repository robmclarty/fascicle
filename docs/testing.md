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
  engine_from_generate,
  make_capture_engine,
  make_script_engine,
  make_stub_engine,
  text_of,
} from 'fascicle/testing';
```

All three factories return a full `Engine`. The non-`generate` members are
inert, so pricing calls are no-ops, `dispose` resolves immediately, and
`with_providers` throws. All three honor the engine contract at the seams your
tests exercise, so a call whose `opts.abort` is already aborted throws the
engine's `aborted_error`, a provided `opts.on_chunk` receives the content as a
text chunk plus a finish chunk before the result resolves (so `model_chunk`
trajectory events fire), and content is validated through the call's own
schema, failing with the engine's `schema_validation_error`.

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

A queue of responses consumed strictly in call order, so call 1 gets the first
entry, call 2 the next. Use it when order matters and prefixes can't see a
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

Each entry is either plain content, or a `ScriptResponse` object supporting
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

## `engine_from_generate`

The 12-line shell every factory builds on, for when you roll your own double.
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

## Recipes

All four run keyless and network-free in the default test suite, so you can paste any of
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
[examples/suspend_resume.ts](../examples/suspend_resume.ts):

```ts
const outcome = await run.until_suspended(flow, input, { install_signal_handlers: false });
if (outcome.kind !== 'suspended') throw new Error('expected the gate to suspend');

const resumed = await outcome.resume({ approved: true });
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

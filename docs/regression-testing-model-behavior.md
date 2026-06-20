# Regression-testing model behavior with mutation-tested judges

You cannot diff a model's output against a golden string. The same prompt yields different words every run, so the equality assertion that anchors ordinary regression testing does not apply. But you can regression-test model behavior the same way you regression-test code: score the output with judges, summarize the scores into a report, and diff that report against a committed baseline. A drop in the scores is a regression, exactly as a failing assertion is.

This works only if the judges are trustworthy, and a judge is just code. So the judges are held to the same bar as the rest of the library: they are mutation-tested. The thing that tests your model is itself tested. This essay walks the loop and then makes that meta-point land.

It builds on [concepts.md](./concepts.md) (step-as-value, trajectories) and the deliberation composites in [deliberation-as-composition.md](./deliberation-as-composition.md). The three pieces here, `judges`, `bench`, and `regression`, live in [`src/composites/`](../src/composites/) and are re-exported from `fascicle`.

## A judge is a step that scores

The whole judge abstraction is one type:

```typescript
type Judge<I, O, S = Score> = Step<{ input: I; output: O; meta?: ... }, S | undefined>;
type Score = { score: number; reason?: string };
```

A `Judge` is a `Step` whose input is the `{ input, output, meta }` triple from one evaluated case and whose output is a `Score` (or `undefined`). That is the entire contract. Because a judge is a step, everything from [the composition layer](./composition.md) applies: you can `compose` judges, run them under the same trajectory logger as the flow, and reuse them across benches.

Returning `undefined` (or throwing) means the judge **abstains**. Abstention is not a zero. `bench` records the absence as a missing key in that case's scores and excludes the case from that judge's mean. A judge that only applies to some cases is therefore first-class: it scores what it understands and stays silent on the rest.

Three stock judges ship in [`src/composites/judges.ts`](../src/composites/judges.ts):

- `judge_equals<O>()` scores `1` when the output deep-equals `meta.expected` and `0` otherwise. It abstains when no `meta.expected` is present, so it is safe to include on a mixed fixture set.
- `judge_with<I, O>(fn)` wraps a scoring function of your own. The function receives the `{ input, output, meta }` triple and returns a number, a `Score`, or `undefined`. Bare numbers are normalized to `{ score }`.
- `judge_llm<I, O>({ model, rubric, scale? })` prompts a model with your rubric and parses the numeric score out of the reply. It is engine-agnostic on purpose: you pass an already-configured `model_call` step (`Step<string, string>`), so the judge stays decoupled from the engine. If the reply does not parse, the judge abstains rather than guessing.

A pair of judges, one exact and one stylistic:

<!-- snippet: check -->
```typescript
import { judge_equals, judge_with } from 'fascicle';
import type { Judge } from 'fascicle';

// Scores 1/0 against meta.expected; abstains when there is no expected value.
const exact: Judge<string, string> = judge_equals<string>();

// A one-word answer scores 1, anything wordier scores 0.
const terse: Judge<string, string> = judge_with<string, string>(({ output }) =>
  output.trim().split(/\s+/).length === 1 ? 1 : 0,
);
```

## `bench` runs a flow over fixtures and scores it

`bench(flow, cases, judges, options?)` is the online evaluator. It runs the flow once per fixture, scores each output with every judge, and returns a `BenchReport`. Where `learn` reflects on past trajectories after the fact, `bench` runs the flow live against fresh cases.

Each case is one `run(flow, case.input, ...)`. Each case carries an `id`, an `input`, and optional `meta` (where `expected` lives for `judge_equals`). The report has two halves:

- `report.cases` is the per-case detail: each `CaseResult` has the `output`, the `scores` keyed by judge name, the `duration_ms`, the `cost_usd`, and, if you set `trajectory_dir`, a `trajectory_path` pointing at that case's `.jsonl`. The trajectory is the audit trail: every span, every model call, every cost event for that one case.
- `report.summary` is the rollup: `pass_rate` (the fraction of cases that ran without throwing), `mean_scores` (per judge, averaged only over the cases that judge did not abstain on), `total_cost_usd`, and the duration totals.

A full bench over a model flow:

<!-- snippet: check -->
```typescript
import { bench, create_engine, judge_equals, model_call, pipe } from 'fascicle';
import type { BenchCase } from 'fascicle';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY! } },
});

// The flow under test: classify a sentence as "ship" or "hold".
const classify = pipe(
  model_call({ engine, model: 'sonnet', system: 'Reply with one word: ship or hold.' }),
  (r) => r.content.trim().toLowerCase(),
);

const cases: ReadonlyArray<BenchCase<string>> = [
  { id: 'green', input: 'All checks pass.', meta: { expected: 'ship' } },
  { id: 'red', input: 'The build is broken.', meta: { expected: 'hold' } },
];

const report = await bench(classify, cases, { exact: judge_equals<string>() }, {
  trajectory_dir: 'bench/classify/trajectories',
});

console.log(report.summary.pass_rate, report.summary.mean_scores.exact);
```

`bench` runs cases concurrently (cap it with `options.concurrency`), tracks cost per case by intercepting `cost` events on the trajectory pipeline, and writes each case's trajectory under `trajectory_dir` when set. It never throws on a failed case; a case that throws is recorded with `ok: false` and drags down `pass_rate`. See the per-case observability options in [`src/composites/bench.ts`](../src/composites/bench.ts).

## `regression_compare` diffs two reports

A single report is a snapshot. Regression testing is the diff between two of them. `regression_compare(current, baseline, options?)` produces a `RegressionReport` whose `ok` flag is `false` when any tracked metric got worse beyond a threshold:

- `pass_rate` dropping at all is a regression (the default `score_threshold` is `0`).
- any per-judge `mean_scores.<name>` dropping is a regression.
- `total_cost_usd` rising by more than `cost_threshold` (default `0.1`, i.e. 10%) is a regression.

It does not short-circuit on the first failure. Every metric and every per-case delta is computed, so you can print the whole picture rather than the first thing that broke. The result is plain data: `deltas` for the summary metrics and `per_case` for the case-by-case story.

Baselines are plain JSON. `write_baseline(path, report)` serializes a report; `read_baseline(path)` loads and validates one. They live wherever you decide, typically checked into git at `bench/<flow>/baseline.json`, so the baseline travels with the code that produced it and a regression shows up as a diff in review.

<!-- snippet: check -->
```typescript
import { read_baseline, regression_compare, write_baseline } from 'fascicle';
import type { BenchReport } from 'fascicle';

declare const fresh: BenchReport; // the report from a current bench(...) run

// First run ever: record the baseline and commit it.
await write_baseline('bench/classify/baseline.json', fresh);

// Every later run: diff the fresh report against the committed baseline.
const baseline = await read_baseline('bench/classify/baseline.json');
const diff = regression_compare(fresh, baseline, { cost_threshold: 0.2 });

if (!diff.ok) {
  for (const d of diff.deltas.filter((delta) => delta.is_regression)) {
    console.error(`${d.metric}: ${String(d.baseline)} -> ${String(d.current)}`);
  }
  process.exit(1);
}
```

## The loop

Putting it together, model regression testing is five steps, and only the middle three run on every commit:

1. **Write fixtures.** A `BenchCase[]`: representative inputs, with `meta.expected` where a known-good answer exists.
2. **Pick or compose judges.** Stock ones for equality and rubric scoring, `judge_with` for anything domain-specific. Judges are steps, so compose freely.
3. **Bench.** `bench(flow, cases, judges)` produces the report. The per-case trajectories are your audit trail when a score moves and you need to know why.
4. **Write the baseline, once.** `write_baseline(path, report)`, then commit the JSON.
5. **Bench again, then compare.** On later runs, `regression_compare(fresh, baseline)`. If `ok` is `false`, fail the build, exactly as a unit test would.

The shape is deliberately the shape of code regression testing: a fixture set, a deterministic scoring of non-deterministic output, a committed expectation, a diff. The only new idea is that the assertion is a learned-or-rubric score instead of `assertEquals`.

## The judges themselves are mutation-tested

Here is the part that closes the loop. Steps 3 through 5 only mean something if the judges are correct. A judge that always returns `1`, or that compares against the wrong field, or whose threshold is off by one, will happily greenlight a regressed model. The baseline diff would be green and the model would be worse. The tool that tests your model would have lied.

So the judges are tested, and not just with example-based unit tests. They are mutation-tested. This is the bar the whole library is held to, and the judges are not exempt.

Mutation testing inverts the usual question. A unit test asks "does the code pass on this input?" A mutation test asks "if I corrupt the code, does any test notice?" Stryker takes the real source, introduces one small mutation at a time (flip a `>` to `>=`, swap `matches ? 1 : 0` to `matches ? 0 : 1`, change a threshold, delete a clause), runs the suite, and checks whether a test now fails. A surviving mutant is a corruption your tests did not catch: behavior nothing actually pins. For a judge, a surviving mutant is precisely a way the judge could be silently wrong while its tests stay green.

The config is [`stryker.config.mjs`](../stryker.config.mjs). It mutates `src/**/*.ts`, so `judges.ts`, `bench.ts`, and `regression.ts` are all in scope, scored by the vitest suite. It runs as the `mutation` step of `pnpm check:all`. The gate is a `break` threshold:

```javascript
// stryker.config.mjs, excerpt
thresholds: {
  high: 85,
  low: 78,
  break: 78, // never lower it to make a failing run pass; bump it as coverage climbs
},
```

The `break` floor is a ratchet. It only moves up. The config's own comment records that the current score reflects, among other work, a deliberate mutation-hardening pass on the judges, and that the floor must never be lowered to make a failing run pass. That is the mechanism by which a judge earns trust: not by passing a few hand-picked examples, but by having tests strong enough that corrupting the judge's logic breaks at least one of them. A judge with weak tests is a judge you cannot trust, because a weak test suite cannot tell a working judge from a broken one. Mutation testing is what makes the difference observable, and the ratchet is what keeps it from eroding.

So the meta-point is structural, not rhetorical. `bench` and `regression_compare` let you regression-test the model. The mutation gate regression-tests the judges that make that possible. The thing that tests your model also gets tested, by the same `pnpm check:all` that gates everything else. See [concepts.md](./concepts.md#the-check-contract) for the check contract that ties it together.

## Further reading

- [concepts.md](./concepts.md) — step-as-value, trajectories, the check contract.
- [composition.md](./composition.md) — the composition surface judges and benches are built from.
- [cookbook.md](./cookbook.md) — the ensemble-of-judges recipe and other worked patterns.
- [api-reference.md](./api-reference.md) — the public surface at a glance.
- [deliberation-as-composition.md](./deliberation-as-composition.md) — the companion essay: the deliberation composites whose output you score here.

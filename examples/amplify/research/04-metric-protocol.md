# 04 — The metric protocol: one abstraction, many shapes

The `Metric` is the only abstraction in amplify that you, the user, are expected to write per project. Everything else — the loop, the cascade, the budget, the lessons buffer — is generic. This document explains *why* the shape is what it is, and works through three concrete metric examples for very different problems.

## The shape

```ts
type Metric = {
  readonly name: string;
  readonly direction: 'minimize' | 'maximize';
  readonly mutable_path: string;
  readonly gate: {
    readonly command: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly expected_exit?: number;       // default 0
    readonly timeout_ms?: number;          // default 60s
  };
  readonly score: (impl_path: string) => number | Promise<number>;
  readonly judge?: { rubric: string; model?: string };  // optional tiebreak
};
```

Two pieces, in this order:

1. **`gate`** — a *boolean*: did the regression suite survive? Implemented as a shell command. Its exit code is the only signal trusted. **The gate is the load-bearing defense against reward hacking.** A candidate that breaks the gate is dead before its score is ever measured.

2. **`score`** — a *number*: how good is this candidate? An async function the metric author writes. Can shell out, read the file, run a model — the harness doesn't care, it just gets a number.

Optional `judge` is a tiebreak rubric, used when two candidates are within epsilon of each other on `score`. **Never** the primary signal.

## Why this shape

We surveyed how five mature ecosystems represent "what makes a generated artifact better":

| System | Shape | Notes |
|---|---|---|
| DSPy / GEPA | `Prediction(score, feedback)` | Score is the scalar; feedback is verbal context for the next mutation. |
| Inspect AI | `Scorer` returning `Score(value, answer, explanation)` | Same factoring; emphasizes scorer reproducibility. |
| Stryker mutation testing | `MutantState(killed/survived/...)` + score derived from kill rate | Boolean per mutant + aggregate scalar. |
| Aider benchmarks | Pass/fail on edit benchmarks + secondary metrics | Boolean primary, numeric secondary. |
| OpenEvolve | `evaluator(candidate) -> { is_valid, score }` | Same Boolean + scalar pattern. |

Five independent designs converged on Boolean + scalar. We did the same. The Boolean is named `gate` because that's its job: it's a literal gate the candidate must pass. The scalar is named `score` because that's its job: a number to maximize or minimize.

The two-part shape has a third virtue: it makes the **rejection of LLM-as-primary-judge** structural. There is no field where you put "an LLM rates this 1-5 and that's the fitness." The LLM judge field is named `judge`, exists only as a tiebreak, and is wired through a different code path. Reward-hacking the judge requires routing around the gate, which the harness never lets you do.

## Worked example 1 — "Make this Python function faster"

The starter shipping with amplify, in TypeScript, is `metrics/speed.ts`. Equivalent shape for a Python target:

```ts
export function make_metric(target_dir: string): Metric {
  return {
    name: 'py_speed',
    direction: 'minimize',
    mutable_path: `${target_dir}/src/hot_function.py`,
    gate: {
      command: ['pytest', '-q', 'tests/'],
      cwd: target_dir,
      expected_exit: 0,
      timeout_ms: 120_000,
    },
    score: async (impl_path) => {
      const result = await spawn_capture(
        ['hyperfine', '--runs', '5', '--export-json', '/tmp/h.json',
          `python -c "from importlib.util import spec_from_file_location, module_from_spec;
                       s = spec_from_file_location('m', '${impl_path}');
                       m = module_from_spec(s); s.loader.exec_module(m);
                       m.bench()"`],
        target_dir,
      );
      const j = JSON.parse(await readFile('/tmp/h.json', 'utf8'));
      return j.results[0].median * 1000;  // ms
    },
  };
}
```

Notes on what's load-bearing:

- The **gate is `pytest`**. Whatever the locked test suite catches stays caught. The agent cannot win by deleting tests because it can't modify them.
- **The score is wall-clock from `hyperfine`**, an external tool with proper warmup and stat-rigor. The harness just parses `median`.
- **Direction is `minimize`** because lower ms = better.
- **`mutable_path` is exactly one file.** v1 of amplify only mutates one file per candidate. If you need multi-file, fork or wait for v2.

## Worked example 2 — "Make this prompt more robust"

The "prompt" might be a string in a config file or a `.txt`. The score is *evaluation accuracy* on a held-out benchmark. The gate is "the prompt didn't grow over a max length, and the model still parses its output correctly":

```ts
export function make_metric(target_dir: string): Metric {
  return {
    name: 'prompt_robustness',
    direction: 'maximize',
    mutable_path: `${target_dir}/prompts/system.txt`,
    gate: {
      command: ['node', `${target_dir}/scripts/prompt_smoke.js`],
      cwd: target_dir,
      expected_exit: 0,
    },
    score: async (impl_path) => {
      const result = await spawn_capture(
        ['node', `${target_dir}/scripts/eval.js`, '--prompt', impl_path,
          '--examples', `${target_dir}/data/holdout.jsonl`],
        target_dir,
      );
      const out = JSON.parse(result.stdout);
      return out.accuracy;  // 0..1
    },
  };
}
```

Notes:

- **Gate is a custom smoke script.** It might check: parses as valid template, length under cap, doesn't reference removed variables. Whatever a reviewer would catch in a PR is what the script encodes.
- **Score is held-out accuracy.** Accuracy on the *training* slice would invite overfitting. Use a holdout.
- **A plain LLM judge would be brittle** — pairing two candidate prompts and asking a judge "which is better?" fails the moment the candidate prompts learn to flatter the judge's biases. Holdout accuracy on a benchmark sidesteps this entirely.

## Worked example 3 — "Make this SQL query cheaper"

Optimization target is a `.sql` file consumed by a query planner. Score is the planner's cost estimate. Gate is "the query still returns the same rows on a fixture":

```ts
export function make_metric(target_dir: string): Metric {
  return {
    name: 'sql_cost',
    direction: 'minimize',
    mutable_path: `${target_dir}/sql/report.sql`,
    gate: {
      command: ['bash', `${target_dir}/scripts/check_rows_match.sh`],
      cwd: target_dir,
      expected_exit: 0,
    },
    score: async (impl_path) => {
      const sql = await readFile(impl_path, 'utf8');
      const result = await spawn_capture(
        ['psql', '-d', 'fixture', '-c', `EXPLAIN (FORMAT JSON) ${sql}`],
        target_dir,
      );
      const plan = JSON.parse(result.stdout);
      return plan[0].Plan['Total Cost'];
    },
  };
}
```

Notes:

- **Gate runs the new SQL against a fixture DB** and diffs the result rows against a captured baseline. Same pattern as `golden.ts`. If row order matters, sort first or compare as multi-set.
- **Score is the planner's cost.** Imperfect (planner is a heuristic), but a real signal that correlates well with actual cost on the planner's home turf.
- **The agent might still cheat.** It could find SQL that produces equivalent rows but a degenerate plan — e.g., over-using indexed paths the planner under-counts. The locked-baseline check catches the first; the planner trusts itself for the second. That residual reward-hacking risk is real and named in [`05-pitfalls.md`](./05-pitfalls.md).

## What's *not* in the shape

The metric does not own:

- **Iteration budget.** That's a CLI flag.
- **Number of candidates per round.** Also a flag.
- **Lessons buffer size.** Constant in the harness.
- **Choice of model / effort.** Engine config.

The metric only answers "what better means," and only at two grains: gate (yes/no) and score (number). This is the smallest set of decisions that have to be unique per project. Everything else is shared infrastructure.

## How to write your own

1. Copy `metrics/speed.ts` as a template.
2. Replace `gate.command` with whatever your locked regression suite is. Make sure that suite *exists and passes against the starter file*. The harness will refuse to start if the baseline fails the gate.
3. Replace `score` with your number. Throw on infeasibility — the harness will treat a thrown score as `+/- Infinity` per direction.
4. Save the file anywhere. Pass its path to `--metric ./path/to/yourmetric.ts`.

If you find yourself wanting to add fields to the `Metric` type, stop and reread [`02-landscape.md`](./02-landscape.md). Five mature systems use exactly this shape. The pull to add structure is almost always premature; the discipline of "everything I want to express must fit into `gate` + `score`" is what keeps the loop honest.

# amplify — a self-improvement loop on fascicle

A fascicle example that drives Claude Opus 4.7 in a **propose → cascade-eval → keep-best** loop on a single starter file. Each round generates N candidates in parallel, runs them through a syntax-check → regression-gate → measure cascade, accepts the best survivor (if it strictly beats the parent), and stops on iterations / wall-clock / plateau.

The point of the example is the **`Metric` protocol**: the user supplies "what better means" as a regression gate (a shell command) and a `score` function (a thunk returning a number). The harness is metric-agnostic. Speed, code quality, output match — anything you can compute is a metric.

For the full design rationale — the academic landscape, the OSS prior art, the failure modes we're avoiding, the sources — see [`research/`](./research/README.md).

## How it works

```text
┌─ scope ────────────────────────────────────────────────────┐
│  stash(BRIEF)         user input: task + target + metric   │
│  stash(BASELINE)      score the starter; this is the floor │
│  stash(RESEARCH)      one-shot online research summary     │
│                                                            │
│  while !budget.exhausted() && !budget.plateau():           │
│    ensemble(N propose):  parallel model_call               │
│       └─ score():          (sequential, fs-isolated)       │
│            ├─ syntax: tsc --noEmit                         │
│            ├─ gate:   metric.gate.command (exit 0 = pass)  │
│            └─ measure: metric.score(impl_path)             │
│    if winner > parent + ε: accept; commit to disk          │
│    else: append lessons; budget.note_no_progress()         │
└────────────────────────────────────────────────────────────┘
```

The harness uses three fascicle primitives heavily:

- `scope` / `stash` / `use` — the named-state pattern (typed projection of run-time state across phases)
- `ensemble` — N parallel members, scored, winner picked by `select: 'max'`
- `model_call` — `claude_cli` provider with `cli-opus` (Opus 4.7) at `effort: 'xhigh'` (highest adaptive-reasoning level supported)

The starter target is a deliberately slow log aggregator (`target/src/log_aggregator.ts`) with several plausible improvement axes: pre-compile the regex, single-pass, streaming, drop substring allocations.

## Layout

```text
examples/amplify/
├── package.json
├── vitest.config.ts                   harness self-tests
├── research/                          design rationale (read this for "why")
├── src/
│   ├── main.ts                        CLI entry
│   ├── loop.ts                        the scope([...]) flow
│   ├── propose.ts                     model_call → CandidateSpec (zod-validated)
│   ├── apply.ts                       archive + swap-in/restore
│   ├── evaluate.ts                    cascade: syntax → gate → measure
│   ├── budget.ts                      iters / wall-clock / patience guards
│   ├── lessons.ts                     bounded ring buffer of failure summaries
│   ├── research.ts                    Claude Code CLI WebSearch tool with offline fallback
│   ├── prompts.ts                     SYSTEM + per-stage prompts
│   ├── metric.ts                      builtin/custom Metric loader
│   └── types.ts                       Metric, Brief, Candidate, Score
├── metrics/
│   ├── speed.ts                       tests pass + median wall-clock (default)
│   ├── golden.ts                      tests pass + per-char match vs golden
│   └── quality.ts                     tests pass + LOC + branch-count
├── target/
│   ├── src/log_aggregator.ts          starter — slow on purpose
│   ├── tests/log_aggregator.test.ts   locked regression suite (the gate)
│   ├── fixtures/gen.ts                deterministic ~5MB fixture generator
│   ├── bench.ts                       wall-clock harness (median over N runs)
│   └── vitest.config.ts
└── .runs/                             per-run trajectories + candidate archive (gitignored)
```

## Prerequisites

- `claude` CLI on PATH
- An authenticated session (`claude login`) — uses OAuth, no API key required
- pnpm + Node 24+

## Running

```bash
pnpm install
pnpm --filter @repo/example-amplify gen-fixture            # writes target/fixtures/sample.log (~5 MB)

pnpm --filter @repo/example-amplify amplify
```

Defaults: `speed` metric, 5 rounds, 3 candidates/round, 30 min wall-clock, patience = ⌈rounds/3⌉ rounds without progress, `effort: 'xhigh'`.

### Tuning

```bash
amplify --metric quality                 # switch builtin metric
amplify --rounds 10 --candidates 5       # bigger search
amplify --budget-min 60                  # 1 hour wall-clock cap
amplify --metric ./my-metric.ts          # custom metric (any path)
amplify --effort max                     # highest reasoning effort (or low/medium/high/xhigh)
amplify --task "Refactor for clarity, keep behavior identical"
```

### Custom metrics

A metric is a single-file `.ts` exporting `make_metric(target_dir: string): Metric`. Every metric declares a regression gate (a shell command) and a `score` function (a thunk returning a number). See `metrics/speed.ts` for the canonical example.

```ts
// my-metric.ts
import type { Metric } from '@repo/example-amplify/src/types.js';

export function make_metric(target_dir: string): Metric {
  return {
    name: 'my_metric',
    direction: 'maximize',
    mutable_path: `${target_dir}/src/log_aggregator.ts`,
    gate: {
      command: ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.config.ts'],
      cwd: target_dir,
      expected_exit: 0,
    },
    score: async (impl_path) => {
      // any number you can compute; throwing returns +/- Infinity per direction
      return /* ... */;
    },
  };
}
```

The harness never inspects the score's meaning. As long as the gate keeps your locked tests passing, the loop will optimize the score in the direction you asked for.

## Output

Each run gets its own directory under `.runs/<timestamp>/`:

```text
.runs/20260426-220500/
├── trajectory.jsonl            one event per step (baseline, candidate, round, done)
├── research.md                 cached research summary
└── round-N/
    ├── r1c0.ts                 archived candidate content (full file contents)
    ├── r1c1.ts
    └── ...
```

Replay = read the JSONL. The candidate archive lets you diff any winner against the baseline, and lets you re-run the bench against any historical candidate via `IMPL_PATH`.

## Why this design

Three sub-agents researched simplicity, academic literature, and OSS production patterns. They converged. Highlights of what we adopted and what we explicitly didn't:

| Adopted | Source |
|---|---|
| Deterministic gate as primary fitness; LLM judge only as tiebreak | AlphaEvolve, FunSearch, OpenEvolve |
| Population + Best-of-N per round, not greedy regenerate | AlphaEvolve, FunSearch |
| Diff-replacing-rewrite candidates (still smaller than rewriting from scratch) | Aider architect/editor |
| Cascade evaluation: cheap → mid → expensive | OpenEvolve, Inspect AI, Stryker mutation states |
| Lessons buffer (capped, summarized) | Reflexion, Voyager |
| Triple-OR stop: max iterations, wall-clock, plateau | OpenEvolve docs, Anthropic harnesses post |

| Rejected | Why |
|---|---|
| LLM-as-primary-judge | Reward-hacks. Gate kills hacks at the source. |
| MAP-Elites islands, full ToT search | Overkill for a few-hundred-LOC demo. |
| STOP-style scaffold-of-scaffold | Saturates fast; meta-framing is interesting, engine is not. |
| Self-mutating prompts | Fixed prompts have plenty of headroom; meta moves are a v2 concern. |

For citations, the longer version, and the failure-mode-by-failure-mode catalog, read [`research/`](./research/README.md).

## Final gate

```bash
pnpm check:all
```

is the only signal that counts for "done" at the repo level (per `AGENTS.md`).

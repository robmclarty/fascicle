# amplify — a self-improvement loop on Fascicle

A Fascicle example that drives Claude Opus 4.7 in a **propose → cascade-eval → keep-best** loop on a single starter file. Each round generates N candidates in parallel, runs them through a syntax-check → regression-gate → measure cascade, accepts the best survivor (if it strictly beats the parent), and stops on iterations / wall-clock / plateau.

![fascicle-viewer running against an amplify trajectory: span tree on the left, event log on the right, $2.55 cost rolled up in the header](./screenshot.png)

The point of the example is the **`Metric` protocol**: the user supplies "what better means" as a regression gate (a shell command) and a `score` function (a thunk returning a number). The harness is metric-agnostic. Speed, code quality, output match — anything you can compute is a metric.

For the full design rationale (the academic landscape, the OSS prior art, the failure modes we're avoiding, the sources), see [`research/`](./research/README.md).

## How it works

```text
chain
├─ baseline                            score the unmodified starter, the floor to beat
├─ research                            name techniques worth trying, cached to research.md
│  └─ fallback                         fall back to offline research if the web call fails
│     ├─ sequence                      research recent techniques on the web
│     │  ├─ research_prompt            format the research request from the brief
│     │  └─ pipe                       clamp the summary to 2,000 characters
│     │     └─ research_web            researcher with the CLI's WebSearch tool
│     └─ sequence                      research from training knowledge alone
│        ├─ research_prompt            format the research request from the brief
│        └─ pipe                       clamp the summary to 2,000 characters
│           └─ research_offline        researcher from training knowledge, no tools
├─ seeded                              seed round state: parent, baseline, budget
├─ rounds                              run the round loop from the seeded state
│  └─ amplify_rounds                   loop: until max rounds, the wall-clock cap, or a plateau
│     ├─ chain
│     │  ├─ round                      open the round and bump the counters
│     │  ├─ inputs                     per-proposer inputs: research plus lessons
│     │  ├─ specs                      propose N candidate rewrites
│     │  │  └─ propose                 map: one proposal per proposer, N at a time
│     │  │     └─ propose_one          ask the proposer for one candidate rewrite
│     │  │        └─ proposer_call     rationale plus the complete new file, zod-checked
│     │  ├─ candidates                 score every candidate
│     │  │  └─ score                   map: one at a time, each swapped into the mutable path
│     │  │     └─ score_candidate      syntax (tsc --noEmit), gate (exit 0), then metric.score
│     │  ├─ outcome                    pick the winner, accept or reject, bank lessons
│     │  ├─ settled                    commit the winner or keep the parent
│     │  │  └─ round_accepted          branch: did the winner strictly beat the parent?
│     │  │     ├─ then  commit_winner  commit the winner as the new parent
│     │  │     └─ else  keep_parent    keep the parent, carry the new lessons
│     │  └─ output                     step
│     └─ guard  check_budget           stop after patience idle rounds or a spent budget
└─ output                              step
```

The top-level `chain` opens on the `brief` binding, which holds the task, the target, and the metric. Each `output` row is where a chain closes: the inner one hands the settled round state back to the loop, and the outer one summarizes the run and names the rule that stopped it.

The harness uses six Fascicle primitives heavily:

- `chain` — the spine: named, typed bindings for the brief, baseline, research, and seeded round state
- `loop` — the round loop, with the stop rule as a `guard` and progress as immutable carry-state rather than mutable closure variables
- `map` — the per-round fan-out: proposals run concurrently, scoring runs at concurrency 1 because each candidate is swapped into the metric's mutable path while it is evaluated
- `branch` — the accept/reject decision, so it shows up in the trajectory
- `fallback` — the research stage degrades from web search to offline as an edge in the topology, not a `try` inside a step
- `model_step` — `claude_cli` provider with `model: 'opus'` (an id the CLI resolves; API providers need a concrete id) at `effort: 'xhigh'`

The starter target is a deliberately slow log aggregator (`target/src/log_aggregator.ts`) with several plausible improvement axes: pre-compile the regex, single-pass, streaming, drop substring allocations.

## Layout

```text
examples/amplify/
├── package.json
├── vitest.config.ts                   harness self-tests
├── research/                          design rationale (read this for "why")
├── rules/                             the blueprint's ast-grep rules (pnpm check:rules)
├── src/
│   ├── main.ts                        the shell: argv, engine, adapters, exit
│   ├── flow.ts                        THE composition layer: chain + loop + map + branch
│   ├── engine.ts                      the only create_engine call site
│   ├── round.ts                       pure round arithmetic (seed, decide, summarize)
│   ├── budget.ts                      iters / wall-clock / patience rules (pure)
│   ├── lessons.ts                     bounded ring buffer of failure summaries (pure)
│   ├── messages.ts                    format_* user-message builders
│   ├── types.ts                       Metric, Brief, Candidate, Score, RoundState
│   ├── prompts/
│   │   ├── proposer.md                the proposer role, as markdown
│   │   ├── researcher.md              the researcher role, as markdown
│   │   └── load.ts                    frontmatter + body loader
│   ├── stages/
│   │   ├── proposer.ts                model_call → Proposal (zod-validated)
│   │   └── researcher.ts              web and offline researcher factories
│   ├── services/
│   │   ├── workspace.ts               archive + swap-in/restore (Workspace port)
│   │   ├── evaluate.ts                cascade: syntax → gate → measure (CandidateScorer port)
│   │   └── metric.ts                  builtin/custom Metric loader
│   └── __tests__/                     budget, lessons, and the whole flow on a stub engine
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

Defaults: `speed` metric, 5 rounds, 3 candidates/round, 30 min wall-clock, patience = max(2, ⌈rounds/3⌉) rounds without progress, `effort: 'xhigh'`.

### Tuning

```bash
amplify --metric quality                 # switch builtin metric
amplify --rounds 10 --candidates 5       # bigger search
amplify --budget-min 60                  # 1 hour wall-clock cap
amplify --metric ./my-metric.ts          # custom metric (any path)
amplify --effort max                     # reasoning effort: none/low/medium/high/xhigh/max
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

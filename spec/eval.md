# Fascicle Evaluation Surface — Plan

The plan to complete the viewer and land `bench` as the next-up direction from `docs/plans/ideas.md`. Four wedges, smallest first, each ending with `pnpm check:all` green.

> Status: plan accepted, ready to implement. Owner: next session in a fresh context window. Read this whole file before starting.

---

## 1. What and why

`docs/plans/ideas.md` recommends "eval harness + trajectory viewer, together" as the highest-leverage direction. The viewer is mostly built per `spec/viewer.md` (`packages/viewer/` — 5 source files, 19 tests green, both transports verified end-to-end on `examples/viewer_demo.ts`). What remains is positioning, cost rendering, the `bench` primitive, and full dogfooding against `examples/amplify`.

This spec executes those four pieces.

---

## 2. Status before this spec

- `@repo/viewer` package is at `packages/viewer/`. Source: `broadcast.ts`, `cli.ts`, `index.ts`, `server.ts`, `tail.ts`, `static/viewer.html`. Tests: `__tests__/{broadcast,server,tail}.test.ts`. All 19 tests green.
- File-tail (`pnpm fascicle-viewer <path>`) and HTTP-push (`http_logger` → `--listen`) transports both round-trip events end-to-end. Verified manually against `examples/viewer_demo.ts`.
- `http_logger` shipped at `packages/observability/src/http.ts`, exported from `packages/observability/src/index.ts`.
- Cost is already emitted into the trajectory by the engine. See `record_cost` at `packages/engine/src/trajectory.ts:125`. Each `cost` event carries: `kind: 'cost'`, `step_index`, `source` (`engine_derived` or `provider_reported`), `total_usd`, `input_usd`, `output_usd`, optional `cached_input_usd` / `cache_write_usd` / `reasoning_usd`. **No engine work needed.**
- Trajectory event schema: `packages/core/src/trajectory.ts`. `span_start` events carry `kind`, `span_id`, `name` (composite kind: `step`, `sequence`, `map`, `parallel`, `fallback`, `retry`), passthrough `id` (the user identifier passed to `step('foo', ...)`), `run_id`, optional `parent_span_id`. `span_end` carries `kind`, `span_id`, passthrough `id`, optional `error`.
- `learn` and `improve` already shipped in `@repo/composites` (see `packages/composites/src/learn.ts` and `improve.ts`). Both are precedents for the `bench` shape.
- `viewer.html` was already patched in the same session that produced this spec to label tree nodes by `event.id` (e.g. `fetch_brief`) instead of `event.name` (e.g. `step`). Don't undo that.
- Umbrella package: `@repo/fascicle` at `packages/fascicle/`. Currently re-exports core / composites / engine. No bin. Does NOT depend on `@repo/viewer`, and `scripts/check-deps.mjs:150` (`check_viewer_isolation`) actively enforces that.

---

## 3. Decisions

These are inputs, not open questions:

1. **Score type:** richer. Default `S = Score = { score: number; reason?: string }`. Numeric-only callers can pass `S = number`.
2. **Baselines:** embedded goldens. Stored under `bench/<flow>/baseline.json`, checked into git. Not under `.runs/`.
3. **Tournament:** no new primitive. Userland composes `bench` + a ranker.
4. **Cost in bench:** each `CaseResult` carries `cost_usd` (sum of `cost.total_usd` from that case's trajectory). `BenchReport.summary` carries `total_cost_usd` and `mean_cost_usd`. `regression_compare` flags cost regressions.
5. **Streaming during bench:** opt-in. `live_url` option attaches `http_logger` to a running viewer; `trajectory_dir` option writes per-case `filesystem_logger` JSONL.
6. **Amplify dogfood:** reachable. `examples/amplify/src/main.ts` uses `claude_cli` with OAuth — no API key needed.
7. **Positioning:** viewer and bench are first-class fascicle surface. Drop the "ships separately as `fascicle-viewer`" framing in `spec/viewer.md`. Re-export from the `fascicle` umbrella; expose the `fascicle-viewer` bin from the umbrella.

---

## 4. Wedge 1 — Position viewer + bench as first-class

### Files

- `spec/viewer.md` §3 ("Package layout") and §10 ("NOT in scope" item 7) — strike "ships separately as `fascicle-viewer`" framing. Replace with: "ships as part of the `fascicle` umbrella; runtime install graph is `node:*` plus `zod` plus `@repo/core` — no HTTP-server deps to leak." Update §1 framing the same way.
- `packages/fascicle/package.json` — add `"@repo/viewer": "workspace:*"` to `dependencies`. Add `"bin": { "fascicle-viewer": "./bin/fascicle-viewer.js" }` (or similar — see "Bin wiring" below).
- `packages/fascicle/src/index.ts` — re-export `start_viewer` and any public types from `@repo/viewer`.
- `packages/fascicle/bin/fascicle-viewer.js` — new file, three lines: `#!/usr/bin/env node` shebang, then `await import('@repo/viewer/cli')` (or whatever resolves the existing CLI). The viewer's existing bin entry stays; this just surfaces it from the umbrella.
- `scripts/check-deps.mjs:150` — flip `check_viewer_isolation`: assert `@repo/viewer` IS in fascicle's graph, not absent. Rename function to `check_viewer_inclusion`.
- Root `README.md` — promote viewer to the headline surface section, point at `import { start_viewer } from 'fascicle'` and `pnpm dlx fascicle-viewer`.

### Bin wiring

`packages/viewer/package.json` already declares `"bin": { "fascicle-viewer": "./src/cli.ts" }`. The simplest umbrella wiring: re-declare the same bin in `packages/fascicle/package.json` pointing at a tiny shim (`./bin/fascicle-viewer.js`) that imports from `@repo/viewer/cli`. Alternative: depend on `@repo/viewer` and let pnpm hoist the bin — try that first; if it works in `pnpm pack` smoke tests, prefer it.

### Done

- `pnpm check:all` green (including the flipped `check-deps` assertion).
- `node -e "import('fascicle').then(m => console.log(typeof m.start_viewer))"` prints `function`.
- The `fascicle-viewer` bin is on PATH after a fresh install of the umbrella (verify with a temp pnpm pack of the umbrella).

---

## 5. Wedge 2 — Cost in the viewer

### Files

- `packages/viewer/src/static/viewer.html` only. No server/tail changes — `cost` events already arrive on the SSE stream and are already parsed; the UI just doesn't show them.

### Behavior

- Per-span `cost_usd`: sum of `cost.total_usd` events whose `step_index` falls inside the span.
- Tree row: append a small cost badge after the elapsed time when `cost_usd > 0`. Format: `$0.0123` (4 decimals) when `< $0.01`; `$1.23` (2 decimals) otherwise.
- Header running total: `<n> events · <m> errors · $<total>`. Updates as `cost` events arrive. Reset on page reload.
- Run filter affects total: when a `run_id` is selected, total sums only that run's cost.

### Mapping cost events to spans

Cost events carry `step_index`, not `span_id`. Maintain a per-run `Map<step_index, span_id>` populated as `span_start` events arrive (only for `event.name === 'step'`). When a `cost` event arrives:
- If `step_index` is in the map, attribute to that span.
- Otherwise buffer it (`Map<step_index, cost[]>`); flush onto the span when its `span_start` lands.
- If a buffered `cost` is still unmatched at the next `span_end` of the run's root, attribute to the root.

### Done

- `pnpm fascicle-viewer <any trajectory containing cost events>` shows cost badges on step rows and a running total in the header.
- Running total matches `jq -s '[.[] | select(.kind=="cost") | .total_usd] | add' <file>` (sanity check).
- `pnpm check:all` green.

---

## 6. Wedge 3 — `bench` primitive

The headline deliverable. The online counterpart to `learn` (which analyzes past trajectories) — `bench` runs a flow against fresh cases, judges the outputs, and produces a structured report.

### Files (new)

- `packages/composites/src/bench.ts` — `bench`, types.
- `packages/composites/src/regression.ts` — `regression_compare`, `read_baseline`, `write_baseline`.
- `packages/composites/src/judges.ts` — `judge_equals`, `judge_with`, `judge_llm`.
- `packages/composites/src/__tests__/bench.test.ts`, `regression.test.ts`, `judges.test.ts`. Vitest, 70% coverage floor (project default).
- `examples/bench_reviewer.ts` — drives the design end-to-end against `@repo/agents`'s `reviewer`.
- `bench/reviewer/baseline.json` — committed golden, produced by first run of `bench_reviewer.ts` with `WRITE_BASELINE=1`.

### Files (modified)

- `packages/composites/src/index.ts` — re-export.
- `packages/fascicle/src/index.ts` — re-export `bench`, `regression_compare`, `judge_*`.

### Public surface

```ts
export type Score = { score: number; reason?: string }

export type BenchCase<I> = {
  id: string                          // stable id for regression diffs
  input: I
  meta?: Record<string, unknown>      // e.g. { expected: ..., expects_flag: ... }
}

export type Judge<I, O, S = Score> = Step<
  { input: I; output: O; meta?: Record<string, unknown> },
  S
>

export type CaseResult<I = unknown, O = unknown, S = Score> = {
  case_id: string
  ok: boolean
  output?: O
  error?: string
  scores: Record<string, S>           // keyed by judge name; missing key = abstained
  duration_ms: number
  cost_usd: number                    // summed from trajectory cost events
  trajectory_path?: string            // when options.trajectory_dir set
}

export type BenchReport<I = unknown, O = unknown, S = Score> = {
  flow_name: string
  run_id: string
  cases: CaseResult<I, O, S>[]
  summary: {
    pass_rate: number                 // ok cases / total
    mean_scores: Record<string, number>   // arithmetic mean of S.score
    total_duration_ms: number
    total_cost_usd: number
    mean_cost_usd: number
  }
}

export type BenchOptions = {
  concurrency?: number                // default Infinity (capped by ensemble)
  on_case?: (r: CaseResult) => void   // streaming callback
  trajectory_dir?: string             // each case writes its own .jsonl here
  live_url?: string                   // opt-in http_logger push to a running viewer
}

export async function bench<I, O, S = Score>(
  flow: Step<I, O>,
  cases: ReadonlyArray<BenchCase<I>>,
  judges: Record<string, Judge<I, O, S>>,
  options?: BenchOptions,
): Promise<BenchReport<I, O, S>>
```

### Behavior

- Each case: one `run(flow, case.input, ...)`. Case-parallelism uses existing `ensemble` — do not roll a new concurrency primitive.
- After the flow run, each judge runs as a Step on `{ input, output, meta }` so judge spans nest under the bench run in the trajectory. A judge may throw or return `undefined` to abstain — represented as a missing key in `case.scores`.
- `trajectory_dir`: each case writes `${trajectory_dir}/${case.id}.jsonl` via `filesystem_logger`. After the case completes, parse the file and sum `cost.total_usd` events into `case.cost_usd`. Set `trajectory_path`.
- `live_url`: also attach `http_logger({ url: live_url })`. If both options set, tee them. If `@repo/observability` doesn't already support multiple loggers, add a small `tee_logger(...loggers)` helper there. Verify before writing.
- `summary.pass_rate` = `cases.filter(c => c.ok).length / cases.length`.
- `summary.mean_scores[name]` = mean of `c.scores[name].score` across cases that scored under that judge.

### Stock judges

```ts
// Equality vs case.meta.expected. Returns { score: 0|1 }.
export function judge_equals<O>(): Judge<unknown, O, Score>

// User-supplied scorer. Accepts number or Score; we normalize.
export function judge_with<I, O>(
  fn: (args: { input: I; output: O; meta?: Record<string, unknown> }) =>
    number | Score | Promise<number | Score>,
): Judge<I, O, Score>

// LLM-as-judge. Reuses provider stack; default to claude_cli to mirror amplify.
export function judge_llm<I, O>(options: {
  model: string                       // 'claude_cli:sonnet' etc.
  rubric: string                      // human-readable scoring criteria
  scale?: { min: number; max: number }    // default { min: 0, max: 1 }
}): Judge<I, O, Score>
```

### regression_compare

```ts
export type RegressionDelta = {
  metric: string                      // 'pass_rate', 'mean_scores.<name>', 'total_cost_usd', etc.
  baseline: number
  current: number
  delta: number                       // current - baseline
  is_regression: boolean
}

export type RegressionReport = {
  ok: boolean                         // false if any delta is_regression
  deltas: RegressionDelta[]
  per_case: Array<{
    case_id: string
    baseline: CaseResult | undefined
    current: CaseResult | undefined
    score_deltas: Record<string, number>
    cost_delta: number
    is_regression: boolean
  }>
}

export async function regression_compare(
  current: BenchReport,
  baseline: BenchReport,
  options?: {
    score_threshold?: number          // default 0; any drop is a regression
    cost_threshold?: number           // default 0.10 (10% relative increase fails)
  },
): Promise<RegressionReport>

export async function read_baseline(path: string): Promise<BenchReport>
export async function write_baseline(path: string, report: BenchReport): Promise<void>
```

`regression_compare` does NOT short-circuit on first failure — produce a complete report so callers can print or assert against it.

### Driving example

`examples/bench_reviewer.ts`:

```ts
import { reviewer } from '@repo/agents'
import { bench, judge_with, regression_compare, read_baseline, write_baseline } from 'fascicle'

const cases = [
  { id: 'sql-injection', input: { diff: '...' }, meta: { expects_flag: 'security' } },
  { id: 'unused-import', input: { diff: '...' }, meta: { expects_flag: 'lint' } },
  { id: 'safe-refactor', input: { diff: '...' }, meta: { expects_flag: null } },
]

const judges = {
  flagged_correctly: judge_with(({ output, meta }) =>
    output.flags.some(f => f.kind === meta.expects_flag) ? 1 : 0),
  no_false_positives: judge_with(({ output, meta }) =>
    meta.expects_flag === null && output.flags.length === 0 ? 1 : 0),
}

const report = await bench(reviewer, cases, judges, {
  trajectory_dir: '.runs/bench-reviewer/',
})

console.log('pass_rate:', report.summary.pass_rate)
console.log('total cost: $', report.summary.total_cost_usd.toFixed(4))

if (process.env.WRITE_BASELINE === '1') {
  await write_baseline('bench/reviewer/baseline.json', report)
} else {
  const baseline = await read_baseline('bench/reviewer/baseline.json')
  const diff = await regression_compare(report, baseline)
  if (!diff.ok) {
    console.error('regression:', diff.deltas.filter(d => d.is_regression))
    process.exit(1)
  }
}
```

The actual `cases` array should pull from a small fixture file (e.g. `bench/reviewer/cases.json`) so the example file stays readable.

### Done

- All three test files green; coverage ≥ 70% on new files.
- `pnpm tsx examples/bench_reviewer.ts` (with `WRITE_BASELINE=1` first time) produces `bench/reviewer/baseline.json`. Subsequent runs produce a regression report.
- `bench`, `regression_compare`, `judge_equals`, `judge_with`, `judge_llm` all importable from `'fascicle'`.
- `pnpm check:all` green.

---

## 7. Wedge 4 — Amplify dogfood

### Steps

1. Find or generate `examples/amplify/.runs/<latest>/trajectory.jsonl`. If none exists, run amplify briefly (claude_cli OAuth, no key needed).
2. `pnpm fascicle-viewer examples/amplify/.runs/<latest>/trajectory.jsonl` — confirm tree renders, costs accumulate, errors visible.
3. Add `http_logger({ url: 'http://127.0.0.1:4242/api/ingest' })` to amplify's loggers in `examples/amplify/src/main.ts` (kept guarded behind an env var so it doesn't break standalone runs). Run with viewer in `--listen` mode and confirm live tree.
4. File any UI papercuts as new entries in §10 of this file.

### Done

- Both transports verified live against amplify.
- `spec/viewer.md` §12 done-def items 2 and 3 checked off (or trimmed, since this spec is now the source of truth for those).

---

## 8. Out of scope

Deliberately deferred:

- `tournament_bench` primitive (decision §3.3).
- Multi-model judge calibration / cross-judging.
- Replay scrubber in viewer.
- Bench-time caching across runs.
- Cost projection / budget enforcement during bench.
- `spec/studio.md` (separate north-star; unrelated to this spec).
- Engine cost emission changes (data is already there).

---

## 9. Verification

After every wedge:

```bash
pnpm check:all
```

Inner-loop iteration:

```bash
pnpm check --bail --only types,lint,test
pnpm exec vitest run --no-coverage packages/viewer
pnpm exec vitest run --no-coverage packages/composites
```

---

## 10. Pointers (read first)

- `docs/plans/ideas.md` — the menu and recommendation
- `spec/viewer.md` — viewer plan (mostly executed; needs §1/§3/§10 framing edits per wedge 1)
- `packages/viewer/src/` — current viewer implementation
- `packages/observability/src/http.ts` — `http_logger` reference shape
- `packages/composites/src/learn.ts` — closest existing primitive to bench
- `packages/composites/src/improve.ts` — second-closest (proposer/scorer pattern)
- `packages/engine/src/trajectory.ts:125` — `record_cost`, the wire format for cost events
- `packages/core/src/trajectory.ts` — `trajectory_event_schema` (the contract)
- `examples/viewer_demo.ts` — non-trivial trajectory fixture
- `examples/learn_reviewer.ts` — closest existing eval-shaped example
- `scripts/check-deps.mjs:150` — `check_viewer_isolation` (must flip in wedge 1)
- `AGENTS.md` and `CLAUDE.md` — repo conventions (snake_case, named exports, no classes, `.js` import extensions, em-dashes prohibited in code/docs)

---

## 11. Open questions surfaced during execution

1. **judge_llm engine wiring.** Spec §6 sketched `judge_llm({ model: 'claude_cli:sonnet', rubric, scale })`, implying judge_llm could resolve an engine from a string. composites doesn't import `@repo/engine`, and adding it would break the layering. Implemented instead as `judge_llm({ model: Step<string, string>, rubric, scale })`: the user wires their own `model_call({ engine, model: 'sonnet' })` into the judge. Closer to the rest of the codebase; "no ambient engine" stays intact.
2. **Judge abstention encoding.** Spec §6 said judges may "throw or return `undefined` to abstain". Implemented `Judge<I, O, S>` as `Step<JudgeArgs, S | undefined>` (the `undefined` is in the value channel, not a separate abstain channel), and bench treats both throws and undefined returns the same way. Means `S = number` callers technically get `Step<_, number | undefined>`; in practice users go through `judge_with`, which normalizes to `Score | undefined` for them.
3. **bench cases parallelism.** Spec §6 said "case-parallelism uses existing `ensemble`". Ensemble is for multiple steps with the same input; cases have different inputs. Used a small worker-pool (`run_with_concurrency`) instead. The intent — "don't roll a new concurrency primitive" — is preserved (this is just `Promise.all` with a slot count), but it's not literally `ensemble`.
4. **bench baseline `run_id`.** Each baseline-write produces a different `run_id`, so `bench/reviewer/baseline.json` has a noisy line on every regen. Not load-bearing for `regression_compare` (which only consults summaries and case_ids), but creates churn in git diffs. Could be deterministic (hash of cases + flow_name) — left as-is for now.
5. **viewer log pane is capped to last 200 rows.** Header shows the full event count (e.g. "203 events") but the right-side log only renders the tail. Discoverability footgun for users looking for an early event in a long trajectory. Existing comment says it's intentional (`if (log_rows.length > 5000) log_rows.splice(0, ...)`) but the *display* slice is hard-coded to 200. Worth a "show all" toggle or pagination in v2.
6. **Run filter dropdown shows raw UUIDs.** A real `run_id` is `9944a2e1-6aa7-4398-b258-8c3c7213b0b7` — useful for grepping but not scannable. v2: truncate to 8 chars + tooltip with full id, or show timestamp where available.
7. **Live amplify dogfood was simulated, not driven.** Wedge 4 verified the `http_logger` round-trip by piping a recorded amplify trajectory through `curl -X POST /api/ingest` (203 events accepted, $2.5550 reconstructed). A live `amplify` run with `AMPLIFY_VIEWER_URL` set is wired and would push events as they fire, but I didn't burn a real run. The wiring is the change worth landing; live verification is a one-line invocation when needed.

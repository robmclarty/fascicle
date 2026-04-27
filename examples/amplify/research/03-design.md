# 03 — Design log: choices and rejected alternatives

Each load-bearing decision below is traced to a finding in [`02-landscape.md`](./02-landscape.md) and a source in [`sources.md`](./sources.md). Format:

> **Decision** — what we did
> **Why** — the research finding that justifies it
> **Rejected** — what we considered and why we didn't ship it
> **Where** — code path

---

## D1. Deterministic gate is primary fitness; LLM judge is at most a tiebreak

**Why.** Reward hacking against an LLM judge is the most-documented and most-undertreated failure mode in the LLM-self-improvement literature (Meta-Rewarding 2407.19594; RLSR 2505.08827; "Are We on the Right Way" 2512.16041; LLM-as-Judge IRT 2602.00521). When the same model proposes and judges, the actor learns the judge's quirks. AlphaEvolve and FunSearch sidestep this by construction: their fitness is a deterministic numerical scorer, not a model rating.

**Rejected.** "Pure LLM-judge" mode (`--judge-only`) was on the table for a one-knob demo. Cut: a self-improvement loop with no programmatic gate is sophistry — there's nothing the loop is grounded against, so the model "improves" by drifting toward whatever the judge tolerates. We don't ship the foot-gun.

**Where.** `src/evaluate.ts:evaluate_candidate` always runs `metric.gate.command` first; non-zero exit short-circuits to a failure score. The judge is plumbed but only invoked on top-of-round ties (and the v1 metric kits don't define one).

---

## D2. Population + Best-of-N parallel candidates per round, not greedy regenerate-until-good

**Why.** OpenEvolve, FunSearch, and AlphaEvolve all show that population-based search dominates greedy chains at the same compute. Diversity inside a round is what bridges plateaus; with one greedy chain you tend to local-min lock. Anecdotally, DSPy/GEPA reports the same on small budgets.

**Rejected.** Single-track hill climbing (Karpathy autoresearch's literal pattern). Cleaner, but it gives up the plateau-bridging that's most of the point. Karpathy's defense — "git is your population" via branching — is real but requires manual curation. We replicate that idea automatically inside one round.

**Rejected.** MAP-Elites islands. Too much complexity for a demo. Worth trying if a user finds the v1 plateau is sticky.

**Where.** `src/loop.ts:run_one_round` builds an `ensemble` of N `propose` members. Each member is one Anthropic call. Selection is `select: 'max'` over the per-candidate score (sign-flipped for `minimize` direction).

---

## D3. Cascade evaluation: syntax → gate → measure (→ judge)

**Why.** OpenEvolve, Inspect AI, and Stryker all converge on cheap-filter-first eval. The economic argument: a candidate that doesn't compile shouldn't burn benchmark cost. The robustness argument: each stage's failure mode is different and a per-stage tail is more diagnostic than a single Boolean.

**Rejected.** Gate-only (skip syntax). A non-compiling candidate would still fail the gate, but vitest spends ~1s on tooling startup before failing — the syntax stage catches it in ~50ms. At N candidates per round, this matters.

**Rejected.** Measure-then-gate. Defeats the point of the gate; measuring a candidate that breaks tests gives you a Goodhart-friendly score the loop will then chase. We never measure a candidate that didn't pass the gate.

**Where.** `src/evaluate.ts:evaluate_candidate` runs syntax → gate → measure in order, returning a `Score` with `stage_failed` filled in on first failure.

---

## D4. The metric is `(gate, score, optional judge)` — no further structure

**Why.** GEPA's `Prediction(score, feedback)` and Inspect AI's `Scorer` are the two most-used external shapes for "what does better mean," and both decompose cleanly into a Boolean and a number. A regression gate is the Boolean; the score function is the number; both are pluggable.

**Rejected.** A richer Metric type with phases (`pre_gate`, `mid_gate`, `post_gate`, ...). Premature; nobody we surveyed needed more than two stages plus optional judge.

**Rejected.** Async/sync split for `score`. Just async. The cost of `await` on a sync compute is zero.

**Where.** `src/types.ts:Metric`, loaded by `src/metric.ts:load_metric`. Three builtins ship in `metrics/` as worked examples; custom paths load via dynamic import.

---

## D5. Diff-style "swap in / restore" instead of per-candidate worktree

**Why.** Each candidate is one file's full content. Eval needs that file at a stable path so the test/bench tooling resolves imports. The simplest mechanism that's safe under parallel proposes is: **swap-in before each candidate's eval, restore after, sequential.** The ensemble's `score` callback is documented as sequential (`packages/core/src/ensemble.ts:88-92`) so this is fs-safe.

**Rejected.** Per-candidate worktree (copy `target/` to `.runs/<run>/cand-K/`). Avoids restore but bloats disk and requires symlinking `node_modules`. Also means the gate command's `cwd` would have to change per candidate — a moving target compared to the simple "always run from `target_dir`" of the swap-in approach.

**Rejected.** A test-side shim resolving via `IMPL_PATH`. Would let parallel eval but pollutes the regression test suite with harness concerns. The regression suite is *the* artifact that should never know about the harness.

**Where.** `src/apply.ts:swap_in` and `src/evaluate.ts` use the resulting `RestoreFn` in a `try/finally`.

---

## D6. Lessons buffer is bounded (K=5) and verbal, not transcript-based

**Why.** Reflexion (2303.11366) showed that verbal failure summaries help. Cognition's "Don't Build Multi-Agents" and Anthropic's "effective context engineering" both name context bloat as the dominant decay mode. K=5 is a starting point; the failure summaries *replace* a long-running transcript.

**Rejected.** Full per-round transcript replay. Linear context growth, model loses focus past round 6 or so.

**Rejected.** A vector-DB / RAG over past failures. Overkill for a demo. K=5 covers the cases that matter for one run; cross-run learning isn't a v1 goal.

**Where.** `src/lessons.ts:make_lessons` is a ring buffer; `format()` produces the markdown bullet list that gets prepended to the next round's propose prompt.

---

## D7. Triple-OR stop: max iterations, wall-clock, plateau

**Why.** Each one alone fails. Max-iters lets a stuck loop burn the wall-clock. Wall-clock alone says nothing about whether progress was happening. Plateau alone runs forever if noise produces tiny "wins." The OpenEvolve docs and Anthropic's harness post both ship all three.

**Rejected.** Max-cost in dollars. Worth adding when the loop is multi-day; not relevant at a few-rounds demo scale.

**Where.** `src/budget.ts:make_budget`, with `exhausted()` ⇒ rounds *or* time limit hit, `plateau()` ⇒ patience exhausted, `note_progress()` / `note_no_progress()` toggle the patience counter.

---

## D8. Online research is one shot at startup, with a graceful offline fallback

**Why.** The user explicitly asked for online research so the loop "stays up to date." But:

- **One shot is enough.** The research summary is general — names of patterns the model might consider. Per-round web search burns budget for marginal gains; the next-round bottleneck is rarely "I didn't know algorithm X exists" — it's the specific characteristics of the parent.
- **Cap the summary.** ~2000 chars (~500 tokens) prepended to every propose prompt. Bigger and we hit context bloat (D6).
- **Offline fallback.** When the CLI's `WebSearch` tool is unavailable or the call fails, we fall back to the model's training knowledge. Demo still works. Forced via `AMPLIFY_RESEARCH=offline`.

**Rejected.** Per-round re-search with bottleneck-focused queries. Justified design but a v2 polish — adds non-trivial cost and the on-plateau trigger logic isn't load-bearing for the demo.

**Where.** `src/research.ts:gather_research`. Mode picked by `pick_mode()`; web mode allows the Claude Code CLI's `WebSearch` tool via `provider_options.claude_cli.allowed_tools: ['WebSearch']`.

---

## D9. Opus 4.7 via the Claude Code CLI at `effort: 'xhigh'` (configurable)

**Why claude_cli, not the Anthropic API.** Opus 4.7 always uses adaptive reasoning ([env-vars docs](https://code.claude.com/docs/en/env-vars)) — there is no fixed thinking-token budget to set. Effort levels (`low | medium | high | xhigh | max`) are how you tune reasoning depth, and `CLAUDE_CODE_EFFORT_LEVEL` is the documented mechanism. The CLI also exposes a richer `WebSearch` tool than the API's hosted web search and uses OAuth via `claude login` (no metered API key for the demo).

**Why `xhigh` as default.** It's the most reasoning Opus 4.7 will allocate without saturating the wall-clock; `max` is also exposed via `--effort max`. The proposer is the cognitively hardest call — it reasons about parent code + metric + lessons + research and emits a complete file rewrite — so allocating the highest available effort is the right default. Aider's architect/editor split makes the same argument: the reasoner is expensive, the executor doesn't need to be.

**How it flows through fascicle.** Amplify passes `defaults.effort = cli.effort` to `create_engine`. The `claude_cli` provider's `effort_env_for_claude_cli()` (`packages/engine/src/providers/claude_cli/index.ts`) translates that value to the `CLAUDE_CODE_EFFORT_LEVEL` env var injected into the spawn args. Settings precedence: `--effort` flag → `AMPLIFY_EFFORT` env → `'xhigh'` default.

**Rejected.** Sonnet for proposals. The point of the demo is using the most capable reasoning we can afford.

**Rejected.** Different effort levels per round (low for round 1, high after plateau). Plausible cost optimization; doesn't generalize. Future knob.

**Rejected.** Anthropic-direct API as a fallback. Subscription billing under the CLI is the right cost model for a hobby/experimentation demo, and dual-path config doubles the test surface for no demo gain.

**Where.** `src/main.ts:run_amplify` passes `effort: cli.effort` to engine defaults. `src/propose.ts:build_propose_step` does NOT override per-call effort — the CLI flag wins. The judge stage (if a metric defines one) should still override with a cheaper level.

---

## D10. Schema-validated structured output for proposals

**Why.** The propose step needs `{ rationale, content }` reliably. Free-text parsing of "the model emitted a code block" is brittle. Fascicle's `model_call` accepts a Zod schema and uses the SDK's structured-output mode plus its own schema-repair logic.

**Rejected.** Diff format. Models emit invalid unified diffs often enough that we'd need a parser + tolerance window. Full file content is more bytes but bulletproof at parse time.

**Where.** `src/propose.ts:PROPOSAL_SCHEMA`, passed via `model_call({ schema })`.

---

## D11. Strict acceptance with epsilon

**Why.** The model will produce noise-level wins (0.001ms faster). Accepting them lets the lessons buffer fill with low-information notes and burns budget. We require `winner > parent + ε` (or `<` for minimize) where ε is a small constant.

**Rejected.** No epsilon. Demo would oscillate around a noise floor.

**Rejected.** Statistical significance test on the bench samples. Worth doing for serious work; demo doesn't need it.

**Where.** `src/loop.ts:strictly_better` and the `EPSILON` constant.

---

## D12. Trajectory logging per round to a single JSONL

**Why.** Replay is the single most useful debugging affordance. One JSONL per run, one line per fascicle event (including our `amplify.*` custom events), is the same shape the rest of the repo uses. Mirrors red-green-refactor. Plays nicely with Inspect AI / Braintrust later.

**Where.** `src/main.ts` wires `filesystem_logger` to `<run_dir>/trajectory.jsonl`; events are recorded inside `src/loop.ts` via `ctx.trajectory.record(...)`.

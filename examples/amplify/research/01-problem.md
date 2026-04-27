# 01 — The problem and why it matters

## What a self-improvement loop is

A self-improvement loop is a tight feedback cycle in which an LLM **proposes** a change to a target artifact (code, prompt, schema, query plan), an **evaluator** scores the result, and a **selector** decides whether to keep it or revert. Iterate until a stop condition fires.

Karpathy's `autoresearch` puts it in one sentence:

> If val_bpb improved (lower), you 'advance' the branch, keeping the git commit. If val_bpb is equal or worse, you git reset back to where you started.
>
> — `karpathy/autoresearch/program.md`

That's the entire control structure. Everything else is plumbing: parallel candidates, lessons memory, plateau detection, online research, judge calibration. The skeleton is one decision at one bottleneck.

Anthropic's "Building Effective Agents" calls this the **evaluator-optimizer pattern** and recommends starting with the simplest version that converges:

> One LLM call generates a response while another provides evaluation and feedback in a loop. […] Add multi-step agentic systems only when simpler solutions fall short.

## Why it matters

Three reasons it's worth building, not just reading about:

**1. It collapses a class of human work.** Performance optimization, code golfing, prompt tuning, SQL plan rewriting, regex tightening — anything where "I know it can be better but I don't know exactly how" — is a search problem. A loop with a real eval signal can crawl that space *while you sleep*. The output isn't novel science; it's the third or fourth-pass refinement that humans rarely do because the marginal hour-per-percent-improvement is too expensive for a person and roughly free for a process.

**2. It exposes the load-bearing abstraction.** "What does better mean?" is the actual hard question. Most demos hide it by hardcoding the metric. A reusable loop forces the answer into a single explicit interface — what we call the [`Metric` protocol](./04-metric-protocol.md). Once that's named, you start seeing how every prompt-eng / RLHF / fine-tuning pitch is or isn't honest about its eval signal.

**3. It's a sharp diagnostic of LLM capability.** Run the same loop with different models, same metric, same starter, same budget: the spread in plateau heights is a real measurement of model quality on this kind of task. Better than benchmark scores because the metric is your own.

## What "improvement" actually means here

Improvement is not novelty. The agent isn't going to invent a new sort algorithm. It's going to find the local-optimum for *this* code in *this* shape against *this* metric. AlphaEvolve's most-quoted result — beating Strassen on 4×4 complex matmul — happened because the eval signal was a bit-exact correctness oracle plus a counting metric. Where it works:

- **Compute kernels** (loop fusion, vectorization, cache locality)
- **Algorithmic constants** (smaller hidden constants, better branch prediction)
- **Allocation patterns** (pre-allocated buffers, fewer string concatenations, single-pass)
- **Prompt phrasing** (reordering instructions, cutting filler) — when a benchmark exists
- **Query plans** (when EXPLAIN cost is the metric)

Where it doesn't:

- **API redesign**, **architecture change**, **breaking-behavior refactors** — no metric will catch the regression that "users now hate this".
- **Things without a measurable target** — if you can't write the score function, the loop is sophistry.
- **Anything where the metric is itself the thing the agent is trying to game** — see [reward hacking in `05-pitfalls.md`](./05-pitfalls.md).

## What this example contributes

Amplify's contribution isn't the loop. The loop is well-known. The contribution is making the **metric pluggable** in a way that's:

- **One file** — a metric is a `.ts` exporting `make_metric(target_dir)`. No framework, no inheritance.
- **Two parts** — a gate (boolean: did regression tests survive?) and a score (number: how good?).
- **Adversarially honest** — the gate is shell-spawned and its exit code is the only signal trusted; the agent cannot lie its way past it.

That shape happens to coincide with what GEPA / DSPy and Inspect AI converged on independently — `Prediction(score, feedback)` and `Scorer` respectively — which is a strong signal it's the right factoring.

The cost of building this is the cost of writing the `Metric` once. Subsequent improvement loops on completely different targets (your slow database query, your verbose prompt, your CPU-bound endpoint) reuse the entire harness. That's the value.

# research/ — why amplify looks the way it does

This directory is the design backstory. It exists because every load-bearing choice in `src/` traces to a finding from a body of research that you can re-read independently — academic papers, OSS implementations, production engineering blogs. Skimming the code without this context will get you the *what*; reading the docs first will get you the *why*.

## Reading order

1. [`01-problem.md`](./01-problem.md) — what a self-improvement loop is, why it matters, where the value is, and where it doesn't apply.
2. [`02-landscape.md`](./02-landscape.md) — three-stream synthesis: simplicity, academic literature, OSS/production. What's hyped vs robust.
3. [`03-design.md`](./03-design.md) — decision log. Each architectural choice traced to a research finding, with rejected alternatives.
4. [`04-metric-protocol.md`](./04-metric-protocol.md) — the load-bearing abstraction. Why `Metric = { gate, score, judge? }` is the right shape, with worked examples for "make this faster," "make this prompt more robust," "make this SQL query cheaper."
5. [`05-pitfalls.md`](./05-pitfalls.md) — the five canonical failure modes (reward hacking, judge drift, plateau, context bloat, regression on un-tested behavior) and the specific defenses we ship.
6. [`sources.md`](./sources.md) — full bibliography with URLs.

## TL;DR

A self-improvement loop is **propose → evaluate → keep-or-revert** wrapped in a budget. The core risk is that the LLM optimizes the *measurement* instead of the *thing*. Three independent traditions (Karpathy autoresearch / Anthropic harness post; FunSearch / AlphaEvolve / OpenEvolve; Aider / SWE-agent / DSPy/GEPA) converge on the same defense: a **deterministic regression gate runs first**, and the LLM-flavored signal — judge, rubric — is at most a tiebreak. Amplify ships exactly this shape, with a metric-agnostic protocol so the gate and the score can be swapped without touching the loop.

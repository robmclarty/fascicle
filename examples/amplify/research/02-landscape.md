# 02 — The landscape

Three independent research streams (simplicity-first engineering posts, the academic literature, the OSS / production world) converge on roughly the same loop. Where they diverge is *what overhead is worth it*. This document maps the territory and is brutally honest about what's hyped vs robust.

## Stream A — The simplicity school

**Karpathy, autoresearch.** The minimal loop. Edit one file, commit, run the program, parse a metric, advance or reset via git. State on disk is git history. Experiment log is `results.jsonl`. Eval is a single shell command the user supplies that prints one number. Everything more complex is justified relative to this baseline.

**Anthropic, "Building Effective Agents."** Names the *evaluator-optimizer* pattern explicitly: one LLM call generates, another evaluates. The whole post argues for "start with simple prompts, add complexity only when it demonstrably improves outcomes." The simplest version of amplify (1 candidate, 1 round, no research, no judge) is exactly this. Everything we add is justified by something downstream that needed it.

**Anthropic, "Effective harnesses for long-running agents."** Concrete operational advice for keeping agents productive over days: an `init.sh`, a `claude-progress.txt`, an initial git commit, *one feature per iteration*. The "incremental approach" is specifically called out as the unlock: the model that's asked to tackle one thing at a time goes further than the one given the whole list.

**Anthropic, "Demystifying evals for AI agents."** Distinguishes code graders ("Fast, Cheap, Objective, Reproducible," brittle to valid variation) from model graders ("Flexible, Captures nuance," non-deterministic, requires calibration). Recommends a known-good *reference solution* per task. Maps cleanly onto our split: gate = code grader, optional judge = model grader.

**Simon Willison, "Designing agentic loops."** Practitioner essay. Emphasizes that the loop *must terminate* and that the human's job is to define stopping conditions, not to inspect intermediate steps. Aligns with our triple-OR stop.

## Stream B — Academic prior art

What's robust:

- **Self-Refine (Madaan et al., 2023, [2303.17651](https://arxiv.org/abs/2303.17651)).** Generator + critic + refiner, all the same model, no external signal. ~20% lift on the surface, but ICLR 2024 follow-ups show it can *hurt* reasoning when the only feedback is the model's own. **Lesson:** you need an external grounded signal. Don't build a Self-Refine inner loop *inside* an already-grounded outer loop; the loop is the critique.

- **Reflexion (Shinn et al., 2023, [2303.11366](https://arxiv.org/abs/2303.11366)).** Adds a verbal "lessons" buffer across trials. 91% pass@1 on HumanEval. Robust **only because the eval signal is grounded** (unit tests). The lessons buffer pattern is what we adopted; we cap at 5 to avoid bloat.

- **AlphaEvolve (Novikov et al., 2024, [2506.13131](https://arxiv.org/abs/2506.13131)).** Diff-based mutations, evaluator cascade (cheap → mid → expensive), Gemini Flash + Pro on island populations. Beat Strassen on 4×4 complex matmul; saved ~0.7% of Google compute. **Real wins, but every demo'd success has a tight numeric scorer.** The "general scientific discovery" framing is hyped — this works exactly when the metric is unambiguous and cheap to compute repeatedly.

- **FunSearch (Romera-Paredes et al., 2023, [Nature](https://www.nature.com/articles/s41586-023-06924-6)).** Predecessor of AlphaEvolve. Islands + best-in-prompt + deterministic scorer. The deterministic scorer is the load-bearing constraint — without it, the search is on noise.

- **Voyager (Wang et al., 2023, [2305.16291](https://arxiv.org/abs/2305.16291)).** Open-ended skill library. The "what worked" buffer pairs well with Reflexion's "what failed" — but for our scope we only ship the failure buffer; success is encoded by the surviving parent itself.

What's overkill or hyped:

- **STOP / Self-Taught Optimizer ([2310.02304](https://arxiv.org/abs/2310.02304)).** Improver-improves-itself. Striking framing, saturates fast, explicitly *not* full RSI. Use the meta-question, not the engine.

- **PromptBreeder / EvoPrompt.** Evolutionary search over prompts. Useful when the optimization target is the prompt itself, not relevant when the target is code with a real test suite. Rejected for v1.

- **Tree-of-Thoughts.** Full search machinery rarely beats Best-of-N at the same compute when there's a real scorer. We use Best-of-N inside `ensemble`.

- **LLM-as-judge as primary fitness ([2024–2026 literature](./sources.md#llm-as-judge--reward-hacking)).** Meta-Rewarding (2407.19594) names the failure: actors learn to game the judge, especially when the judge shares blind spots with the actor. RLSR (2505.08827) shows only larger judges resist hacking. The IRT diagnosis (2602.00521, Jan 2026) shows single-judge scores are noisy with strong per-item bias. **Our position:** use the judge for tiebreak only, with a different model from the proposer.

## Stream C — OSS and production

What works in practice (5 patterns we kept seeing):

- **Tight perception–action loop with a constrained command surface.** SWE-agent's "Agent–Computer Interface" was the unlock for SWE-bench: a small, LM-friendly set of file/edit/run tools. OpenHands generalises this as an action/observation event stream. Claude Code is `prompt → model → tool_calls → tool_results → repeat until text-only`, typically 5–50 turns. The shape is convergent and boring.

- **Separate "propose" from "apply."** Aider's architect/editor split (one model reasons, a cheaper one emits the diff) hit SOTA on its own benchmark. AlphaEvolve and OpenEvolve have the same separation. **Amplify's version:** the propose step's model emits the new file contents; the harness applies it via `swap_in/restore`. Apply is plain code, not a model call.

- **Evolutionary / Pareto search beats greedy regenerate.** OpenEvolve uses MAP-Elites + island populations + cascade evaluation. DSPy's GEPA does Pareto-aware reflective mutation and beats RL on small budgets. The advantage isn't exotic search machinery — it's that **multiple parallel candidates per round** stay diverse enough that one is more likely to bridge a plateau than a single greedy chain. We ship the simplest version: N parallel proposes, sequential cascaded eval, keep the best survivor.

- **Reflective text feedback as a first-class signal alongside the scalar.** GEPA expects metrics to return `Prediction(score=, feedback=)`; TextGrad backpropagates LLM critique as a "textual gradient." Numeric score alone underfits the signal the next mutation needs. Amplify ships the failure tail (truncated stderr / reason) into the lessons buffer.

- **Context isolation via subagents/sandboxes, not parallel collaborators.** Cognition's "Don't Build Multi-Agents" essay is the load-bearing post: parallel agents diverge because they don't share full traces. Anthropic's counter-position is "subagents are fine *as bounded research/cleanup workers* whose only output is a summary back to the main loop." Both agree: one decision-maker, throwaway side-contexts. Our research step is exactly that — a side-context whose only output is a summary.

What fails in practice:

- **Reward hacking against an LLM judge.** Documented across Lilian Weng's reward-hacking survey, METR's frontier-model writeup, and 2026 Meta MSL studies. Single-token judges are very gameable. Judge drift compounds when the same model proposes and judges.

- **Recursive / hyperactive loops.** Arize's production analysis: agents call the same tool with identical args because tool feedback is ambiguous. Hundreds of turns, no progress. Triple-OR stop catches this.

- **Context bloat → instruction drift.** Long sessions deprioritise the system prompt; "lost in the middle" on retrieved context. *The* dominant decay mode in long trajectories per Cognition, Anthropic, Replit. We attack this by capping the lessons buffer and re-using a flat prompt across rounds (not a transcript).

- **Cost explosion from unbounded retries.** OpenEvolve docs put per-iteration cost at $0.01–$0.60. Our triple-OR stop is the kill switch.

- **Catastrophic tool use.** Replit's July 2025 agent dropped a production DB. Decision-time guidance was their fix; sandbox-by-default is ours. Amplify's "swap_in / restore" is sandboxed: every candidate's file lives outside the workspace until it's accepted.

## Production primitives we drew shape from

- **Inspect AI** — Dataset / Solver / Scorer. Their `Scorer` is morally identical to our `Metric.score`. We mirror the trace shape so a user can plug in Braintrust/Langfuse later for free.
- **DSPy / GEPA** — `Prediction(score, feedback)`. Shape-equivalent to our `(score, tail)` pair flowing into the lessons buffer.
- **Stryker / mutmut mutation testing** — "did the change matter?" by kill-rate. Our cascade is morally a mutant-survival pipeline: candidates survive cheap stages first.
- **Claude Agent SDK / Claude Code** — `model_call` is fascicle's bridge to that pattern; `effort: 'high'` is the SDK's reasoning-budget control.

The credible OSS substrates today are **OpenEvolve** (AlphaEvolve-shaped, real users) and **gepa-ai/gepa** (textual-gradient optimization). Several "AlphaEvolve clones" are shells. AlphaEvolve itself is *not* open source — only the result tables are.

## What this means for the demo

We rejected the cathedral version (islands, MAP-Elites, multi-model orchestration, judge-only fitness) and the toy version (single-track Self-Refine without a grounded gate). What we shipped is the smallest demo that's *adversarially honest about reward hacking* and *generalizes via the metric protocol*. Everything else is a knob.

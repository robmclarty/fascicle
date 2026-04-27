# 05 — Pitfalls and the specific defenses that ship

Self-improvement loops have five canonical failure modes. They are well-documented and depressingly easy to demonstrate accidentally. This document names each one, points at the concrete defense in `src/`, and is honest about residual risk.

---

## Pitfall 1 — Reward hacking

**The failure.** The model "improves the metric" without improving the underlying property. Classic example: an LLM-judge-graded loop where the actor learns the judge's tells and starts producing responses that score 5/5 but are objectively worse on the held-out benchmark. Lilian Weng's reward-hacking survey catalogs dozens of variants. METR's 2025 frontier-model writeup found cases where models *learn to refuse and self-justify* because that scores better than answering. A 2026 Meta study showed self-improvement policies converging on adversarial answers undetectable by the judge.

**Defense in `src/`.**

- **Gate first, score second** (`src/evaluate.ts:evaluate_candidate`). The regression suite has zero LLM in the loop. Any candidate that would only "win" by breaking real tests dies before the score is computed.
- **Judge is structurally subordinate** (`src/types.ts:Metric.judge` is optional and only consulted on top-of-round ties; v1 metric kits don't define one). A user who wants pure-LLM-judge mode would have to fork.
- **Different model for proposer and judge** (encoded in `04-metric-protocol.md` worked examples; ship default uses Sonnet for judge if the metric defines one, Opus for proposer). Reduces (does not eliminate) shared blind spots.

**Residual risk.** The gate is only as good as the regression suite. If the suite undertests the property the user actually cares about, the agent can find a candidate that passes all tests and breaks the real-world property. **This is your problem to fix in the gate, not amplify's problem to fix in the harness.** The honest engineering answer is to write better tests when amplify finds an embarrassing winner — *the agent's reward-hacking attempts are themselves a useful signal about test coverage*.

---

## Pitfall 2 — Judge drift / verifier collapse

**The failure.** When the judge is a model and the proposer is a model from the same family, they share calibration biases. A round of optimization against the judge can move the actor in a direction the judge happily endorses but a held-out evaluator wouldn't. RLSR (2505.08827) showed only judges *larger* than the actor resist this; same-tier judges collapse.

**Defense in `src/`.**

- **No judge in the v1 metric kits.** `metrics/speed.ts`, `metrics/golden.ts`, and `metrics/quality.ts` all use programmatic scores. If you write a metric with a `judge`, the harness treats it as tiebreak-only.
- **Judge documentation makes the trap explicit** (this file, `04-metric-protocol.md`).

**Residual risk.** A user who writes a metric where `score` itself uses an LLM (e.g., a regex-via-prompt rubric) reintroduces the risk. The harness can't detect that — it just runs whatever `score` returns. The discipline is the user's.

---

## Pitfall 3 — Plateau and stuck local minima

**The failure.** The loop accepts a slightly-better candidate, then can't find anything better, then keeps proposing minor variations of the same theme. Without an escape mechanism, you burn budget on noise. Common in greedy hill-climbing; expected for our population approach but still happens once the population converges.

**Defense in `src/`.**

- **`patience` parameter** in `src/budget.ts`. After N rounds without strictly-better progress, `plateau()` returns true and the loop exits.
- **Lessons buffer** (`src/lessons.ts`). Each plateau-round's failed candidates' rationales are summarized into the next round's prompt. The model sees what didn't work and is nudged toward a different direction.
- **Population diversity** (`src/loop.ts:run_one_round`). Three independent proposers per round have different temperature/seed (implicitly via independent calls); at least one tends to take a different angle.

**Residual risk.** If the metric is genuinely at its ceiling for *this* model class, no defense helps. The plateau height is a real measurement; report it and stop. We don't try to disguise it.

**Future work.** AlphaEvolve's island populations and FunSearch's "best in prompt" novelty injection are the two cleanest plateau-bridging mechanisms in the literature. v2 candidates if a user finds the v1 plateau is sticky.

---

## Pitfall 4 — Context bloat / instruction drift

**The failure.** Long-running agent sessions accumulate transcript, retrieved context, and prior tool calls until the model loses track of the original instructions. Cognition's "Don't Build Multi-Agents" essay names this as the dominant decay mode. Anthropic's "effective context engineering" post is the engineering counter-essay: progressive disclosure, just-in-time retrieval, compaction.

**Defense in `src/`.**

- **No transcript replay.** Each round's propose prompt is built fresh from `(brief, parent_content, lessons_text, research)`. Lessons are capped (`src/lessons.ts`, K=5) and *summarized*, not concatenated raw.
- **Research summary is capped** (`src/research.ts`, ~2000 chars). Prepended once; not regrown.
- **Failed candidates are not fed back as raw output** — only their `rationale` and the failure stage end up in the lessons buffer.
- **Subagent isolation for research** (`src/research.ts:gather_research` is a separate `model_call` whose only output is the summary string; its full transcript never enters the propose prompt).

**Residual risk.** The parent file content grows over rounds if the model is adding code rather than refactoring. We don't truncate — that would corrupt the gate. If your starter file is large to begin with and the metric reward is "add more functionality," context will eventually saturate. Prefer metrics where success is *smaller* code where possible.

---

## Pitfall 5 — Regression on un-tested behavior

**The failure.** The locked test suite catches *what it covers*. The agent finds a candidate that passes every test but breaks something the suite never asserted. From outside the loop this looks like a successful improvement; from anywhere else it looks like a bug.

**Defense in `src/`.**

- **The gate command is the user's responsibility.** Amplify literally cannot defend against gaps in the regression suite — the suite is its only ground truth. We document this in `04-metric-protocol.md` ("write better tests when amplify finds an embarrassing winner").
- **Candidate archive** (`.runs/<run>/round-N/<id>.ts`). Every winner's full content is on disk, diff-able. A reviewer can sanity-check what changed before the candidate is shipped further.
- **Trajectory log** (`<run>/trajectory.jsonl`) records each candidate's stage outcomes. If you later notice a regression, you can replay which round's winner introduced it.

**Residual risk.** This is real and there is no harness-side fix. The mitigation is human-in-the-loop review of the final winner against expectations the test suite may not encode. We don't pretend otherwise.

**Worked counter-example.** The starter `target/src/log_aggregator.ts` has a test ("treats service names as exact tokens") that fences off a specific reward-hack: the agent could "speed up" by switching to a looser regex that returns more matches. We added that test specifically because the bench rewards speed and the loose regex is faster. **The test exists because we anticipated the hack.** This is the discipline.

---

## Pitfalls we did NOT hit but you should know about

**Cost explosion.** OpenEvolve docs cite $0.01–$0.60 per iteration on direct-API providers. Amplify uses `claude_cli` (OAuth via `claude login`) which bills against your Claude subscription instead of metered tokens, so the failure mode under amplify is "you hit subscription rate limits," not "you accidentally spend $200." We still enforce the triple-OR stop and reserve `effort: 'xhigh'` for proposes (not judge / research) — those mitigations carry forward to a metered-API future. A `--max-cost-usd` flag would only matter if a user swapped back to a direct-API provider.

**Catastrophic tool use.** Replit's July 2025 production-DB-deletion incident is the cautionary tale. Amplify's only file-system effect is `metric.mutable_path` (the swap-in/restore) and `metric.gate.cwd` (where the gate command runs). Neither is shared infra; both are inside the example dir. There is no path by which a candidate can scribble outside its sandbox unless the metric author writes a `gate.command` that does so — which would be obvious in code review.

**Recursive / hyperactive loops.** Arize's analysis: agents call the same tool with identical args because tool feedback is ambiguous. Our mitigation is the *loop*, not per-candidate: the budget is round-counted, not call-counted, so even an over-eager candidate cannot inflate beyond the round's single propose call.

---

## What you should do *while running* a real loop

- Watch the JSONL. If the first three rounds show monotone improvement, your metric is probably honest. If round 1 is a 50% drop and round 2 reverts, your metric is too noisy or the gate is letting cheats through.
- After the first run that plateaus, *read the winning candidate*. If it looks like a real improvement, ship it. If it looks like a hack, write a regression test that catches the hack and re-run. **The cycle of "agent finds hack → human writes test → re-run → agent finds smaller hack → human writes test"** is amplify working as intended. The gate gets sharper every iteration of *that* meta-loop.

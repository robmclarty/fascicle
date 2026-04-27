# Sources

All citations referenced from the other documents in this directory. Grouped by theme, then alphabetized.

## Anthropic engineering guidance

- [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — the evaluator-optimizer pattern is named here.
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — `init.sh`, progress-log, one-feature-per-iteration discipline.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — compaction, just-in-time retrieval.
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) — code graders vs model graders, reference solutions, pass@k vs pass^k.
- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) — subagent isolation, summary-only outputs.
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [How the agent loop works (Claude Agent SDK)](https://platform.claude.com/docs/en/agent-sdk/agent-loop)
- [Common workflows — Use extended thinking](https://code.claude.com/docs/en/common-workflows) — `/effort`, `CLAUDE_CODE_EFFORT_LEVEL`, adaptive reasoning on Opus 4.7.
- [Environment variables](https://code.claude.com/docs/en/env-vars) — `CLAUDE_CODE_EFFORT_LEVEL`, `MAX_THINKING_TOKENS`, and adaptive-reasoning notes per model.

## Academic — iterative self-improvement

- Madaan et al., 2023. **Self-Refine: Iterative Refinement with Self-Feedback.** [arXiv 2303.17651](https://arxiv.org/abs/2303.17651).
- Shinn et al., 2023. **Reflexion: Language Agents with Verbal Reinforcement Learning.** [arXiv 2303.11366](https://arxiv.org/abs/2303.11366).
- Zelikman et al., 2023. **Self-Taught Optimizer (STOP).** [arXiv 2310.02304](https://arxiv.org/abs/2310.02304).
- Wang et al., 2023. **Voyager: An Open-Ended Embodied Agent.** [arXiv 2305.16291](https://arxiv.org/abs/2305.16291).
- Yao et al., 2023. **Tree of Thoughts.** [arXiv 2305.10601](https://arxiv.org/abs/2305.10601).

## Academic — evolutionary / population search

- Romera-Paredes et al., 2023. **Mathematical discoveries from program search with large language models (FunSearch).** [Nature article](https://www.nature.com/articles/s41586-023-06924-6).
- Novikov et al., 2024–2025. **AlphaEvolve: A Gemini-powered coding agent for designing advanced algorithms.** [arXiv 2506.13131](https://arxiv.org/abs/2506.13131) · [DeepMind blog](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/).
- Ma et al., 2023. **Eureka: Human-Level Reward Design via Coding LLMs.** [arXiv 2310.12931](https://arxiv.org/abs/2310.12931).
- Fernando et al., 2023. **PromptBreeder: Self-Referential Self-Improvement.** [arXiv 2309.16797](https://arxiv.org/abs/2309.16797).
- Guo et al., 2023. **EvoPrompt.** [arXiv 2309.08532](https://arxiv.org/abs/2309.08532).

## LLM-as-judge / reward hacking

- Wu et al., 2024. **Meta-Rewarding Language Models.** [arXiv 2407.19594](https://arxiv.org/abs/2407.19594).
- Singh et al., 2025. **RLSR: Reinforcement Learning from Self-Reward.** [arXiv 2505.08827](https://arxiv.org/abs/2505.08827).
- Anonymous, 2025. **Are We on the Right Way for Self-Improving LLMs?** [arXiv 2512.16041](https://arxiv.org/abs/2512.16041).
- Anonymous, 2026. **An Item-Response-Theory Diagnosis of LLM-as-Judge.** [arXiv 2602.00521](https://arxiv.org/abs/2602.00521).
- Survey: **A Survey on LLM-as-a-Judge.** [arXiv 2411.15594](https://arxiv.org/abs/2411.15594).
- Lilian Weng. **Reward Hacking in Reinforcement Learning.** [Blog post](https://lilianweng.github.io/posts/2024-11-28-reward-hacking/).
- METR. **Recent frontier models are reward hacking.** [LessWrong](https://www.lesswrong.com/posts/Zu4ai9GFpwezyfB2K/metr-recent-frontier-models-are-reward-hacking).

## Production / OSS systems

- **SWE-agent.** [GitHub](https://github.com/SWE-agent/SWE-agent).
- **OpenHands SDK.** [arXiv 2511.03690](https://arxiv.org/html/2511.03690v1).
- **Aider — architect/editor split.** [Blog post](https://aider.chat/2024/09/26/architect.html).
- **Cline — Plan & Act paradigm.** [Blog](https://cline.bot/blog/plan-smarter-code-faster-clines-plan-act-is-the-paradigm-for-agentic-coding).
- **Cursor — agent best practices.** [Blog](https://cursor.com/blog/agent-best-practices).
- **Cognition — Don't Build Multi-Agents.** [Blog](https://cognition.ai/blog/dont-build-multi-agents).
- **Cognition — Closing the Agent Loop.** [Blog](https://cognition.ai/blog/closing-the-agent-loop-devin-autofixes-review-comments).
- **Replit — Decision-Time Guidance.** [Blog](https://blog.replit.com/decision-time-guidance).
- **Sourcegraph Amp.** [Product page](https://sourcegraph.com/amp).
- **DSPy GEPA optimizer.** [Docs](https://dspy.ai/api/optimizers/GEPA/overview/).
- **gepa-ai/gepa.** [GitHub](https://github.com/gepa-ai/gepa).
- **TextGrad.** [GitHub](https://github.com/zou-group/textgrad) · [arXiv 2406.07496](https://arxiv.org/abs/2406.07496).
- **OpenEvolve.** [GitHub](https://github.com/algorithmicsuperintelligence/openevolve).

## Evaluation / observability primitives

- **Inspect AI.** [Site](https://inspect.aisi.org.uk/) · [GitHub](https://github.com/UKGovernmentBEIS/inspect_ai).
- **Braintrust.** [Site](https://www.braintrust.dev).
- **Langfuse — Braintrust comparison.** [FAQ](https://langfuse.com/faq/all/best-braintrustdata-alternatives).
- **Stryker — mutant states & mutation score.** [Docs](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/).

## Practitioner essays

- **Karpathy, autoresearch.** [Repo](https://github.com/karpathy/autoresearch) · [`program.md` source-of-truth file](https://github.com/karpathy/autoresearch/blob/master/program.md).
- **awesome-copilot — autoresearch SKILL.** [GitHub](https://github.com/github/awesome-copilot/blob/main/skills/autoresearch/SKILL.md).
- **Simon Willison — Designing agentic loops.** [Blog](https://simonwillison.net/2025/Sep/30/designing-agentic-loops/).
- **Arize — Why AI agents break: production failures.** [Blog](https://arize.com/blog/common-ai-agent-failures/).

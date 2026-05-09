# Spec: Automated PR Improvement Pipeline ("majestic-sky")

## Context

When a developer opens a PR, an opt-in trigger should kick off an automated agent pipeline that:

1. Reviews the PR's diff and surfaces suggested changes.
2. Distills those suggestions into a *pragmatic* subset — ruthlessly biased toward fewer changes — and emits a concrete spec.
3. Builds those changes in a new branch, with a handoff file describing what it did.
4. Reviews the build against the spec, looping back to the builder with feedback until the review verdict is `pass`.
5. Pushes the branch, opens an *improvement PR* targeting the original PR's head branch, and comments on the original with a 2-sentence summary linking to it.

**Why now.** We have the building blocks (fascicle composition + multi-provider engine, AWS infra + SRE, Claude API access) but no end-to-end product loop that *uses our own developer-loop work to improve our own PRs*. This is dogfooding the toolkit and a recurring source of taste-aligned suggestions for every dev who opts in.

**Proof point: provider portability.** Fascicle's reason to exist is that the same composition runs against any provider — Anthropic, OpenRouter, Google, Ollama. This app is a forcing function for that claim. Every stage uses the API engine (no `claude_cli` subprocess, no OAuth), the model is configured via alias (`'sonnet'`, `'opus'`), and the provider is selected by env. **Acceptance criterion: changing `FASCICLE_PROVIDER=anthropic` to `FASCICLE_PROVIDER=openrouter` runs the entire pipeline end-to-end with no code changes.**

**Aesthetic anchor.** "The overall goal of all software is to manage complexity." The pragmatist stage embodies this — it picks the smallest set of changes that move quality forward and rejects everything else. The architecture of the pipeline itself follows the same rule: one Node process, one library, no microservice fan-out unless something forces it.

---

## High-level architecture

```text
GitHub PR opened
   │
   │  (label: fascicle-improve)
   ▼
GitHub webhook ──► API GW + tiny Lambda ──► SQS ──► ECS Fargate task (fascicle worker, Node, TS)
                                          │
                                          ├─ workspace: git worktree of PR head
                                          │
                                          ├─ stage 1  Reviewer        (model: sonnet)
                                          ├─ stage 2  Pragmatist      (model: opus)
                                          ├─ stage 3  Builder         (model: sonnet + file-editing tool loop)
                                          │   ↑ feedback loop ↓
                                          ├─ stage 4  Build-Reviewer  (model: opus)

All four stages go through the fascicle engine via `model_call`. Provider is a single config knob.
                                          │
                                          ├─ git push + gh pr create
                                          └─ gh pr comment on original (link + 2-sentence summary)
```

One process, four agents, in-memory state passing via fascicle's `scope` / `stash` / `use`. Trajectory written to disk for replay and observability via the fascicle viewer.

---

## The 4-stage pipeline

### Stage 1 — Reviewer

**Input:** PR metadata + unified diff (from `gh pr diff <number> --patch`) + repo context (CLAUDE.md, AGENTS.md if present).

**Agent:** Schema-driven reviewer (mirrors `examples/reviewer.ts` pattern). Outputs structured suggestions:

```ts
type Suggestion = {
  id: string;                  // stable hash of file+line+gist
  file: string;
  line_range: [number, number];
  category: 'bug' | 'clarity' | 'naming' | 'duplication' | 'safety' | 'perf';
  severity: 'low' | 'medium' | 'high';
  one_liner: string;           // <=120 chars
  rationale: string;           // why this matters
  proposed_change: string;     // brief sketch, not full code
}
```

**Prompt anchor:** "Review for clarity, correctness, and complexity. Do *not* propose stylistic preferences or speculative refactors."

**Output:** `Suggestion[]`, capped at 10. Stashed under key `suggestions`.

### Stage 2 — Pragmatist

**Input:** `Suggestion[]` + the original diff.

**Model:** `opus`. This stage is the load-bearing judgment call of the whole pipeline — deciding what *not* to do is harder than producing suggestions, and worth the extra cost.

**Behavior:** Filters and distills to a small set of changes, emitting `IMPROVEMENT_SPEC.md`.

**Prompt anchor (load-bearing):**
> Default verdict on every suggestion is REJECT. Only ACCEPT when the change clearly reduces complexity, fixes a real bug, or removes hazard. Style, naming, or "could be cleaner" are not enough on their own. Cap accepted changes at **N=3**. Fewer is better. If nothing meets the bar, output an empty spec and the pipeline halts cleanly.

**Output:** `IMPROVEMENT_SPEC.md` shape:

```markdown
# Improvement Spec for PR #{number}
## Accepted changes (N)
- [id] one-liner — file:lines — why this change is worth the complexity it adds
## Rejected (with brief reason)
- [id] reason
## Constraints
- Do not modify files outside the accepted change list.
- Do not add new dependencies.
- Preserve existing tests; add tests only if the change is risky without one.
```

Stashed under key `improvement_spec`. If accepted list is empty → exit cleanly with a single line comment on the original PR ("Reviewed — no pragmatic improvements proposed.") and stop.

### Stage 3 — Builder

**Input:** `improvement_spec`, the worktree path, the original PR diff for context.

**Model:** `sonnet` via the fascicle engine (API). No `claude_cli` subprocess — that path needs OAuth/interactive login and doesn't fit a Fargate container. The portability proof requires every stage go through the engine.

**Mechanism:** Fascicle `tool_loop` agent equipped with a small, locked-down toolset scoped to the worktree:

```ts
const builder_tools = [
  list_dir(worktree),
  read_file(worktree),
  write_file(worktree),       // overwrite full file contents
  edit_file(worktree),        // string-replace within a file
  run_shell(worktree, {       // for: pnpm install, pnpm build, tests
    allow: ['pnpm', 'git status', 'git diff', 'git add', 'git commit'],
  }),
  finish({ schema: HandoffSchema }),  // terminal tool — agent calls when done
];
```

All file paths are joined against the worktree root and rejected if they escape it. Shell commands are an allowlist, not a free shell. Pattern mirrors `examples/tool_loop.ts` and `examples/adversarial_build.ts`.

**Output:** Commits in the worktree on a new branch `fascicle/improve-{original-pr-number}`. The agent's terminal `finish` tool produces `HANDOFF.md` content (files touched, one line per change, deviations from spec and why) that the harness writes to disk.

Stashed under key `build_result`.

### Stage 4 — Build-Reviewer (with feedback loop)

**Input:** `improvement_spec`, `HANDOFF.md`, diff of build vs. PR head.

**Model:** `opus`. Pass/fail judgment against the spec is the gate that protects the original PR author from low-quality automated noise; worth the better model.

**Agent:** Reviewer with binary verdict.

```ts
type BuildVerdict =
  | { kind: 'pass'; summary: string; rationale: string }
  | { kind: 'needs-changes'; feedback: string };
```

**Loop primitive:** fascicle's `adversarial` (or a hand-rolled `loop` with bounded iterations). Max **3** build↔review rounds. On `needs-changes`, write `FEEDBACK.md` in the worktree and re-invoke the builder. After 3 rounds with no pass, abort the run (no push, no comment) — failure surfaces in CloudWatch.

**Why not ridgeline here.** Ridgeline is the right tool when the work is *plan → multi-phase build → eval over a greenfield spec*. It also currently leans on `claude_cli`, which we're explicitly avoiding for the portability proof. This pipeline is single-phase, short-horizon, with the spec already produced. Revisit if the typical build grows past a couple of files *and* ridgeline gains an API-backed builder path.

---

## Trigger & runtime host

### Recommended: **AWS Fargate task, kicked off by SQS**

Plays to existing strengths: terraform + IaC + SRE team. Three terraform-managed pieces:

1. **API Gateway → tiny webhook Lambda** (~2s, validates GitHub HMAC, enqueues to SQS). Lambda is the right shape here — short, sync, scales free.
2. **SQS queue** with FIFO + `MessageGroupId = repo+pr_number` for the per-PR concurrency invariant.
3. **ECS Fargate task** running the fascicle worker. Triggered by EventBridge Pipes (SQS → ECS RunTask), one task per message. No time limit. Container scales out horizontally as queue depth grows; scales to zero when idle (no minimum task count).

Container is a single Node image (Dockerfile in `examples/pr-improve/`) with `gh` CLI + `git` baked in. No `claude` CLI — every model call goes through the fascicle engine via API. SRE owns the terraform module; the app team owns the Dockerfile and the worker code.

**Why this fits the timing math.** Pipeline p99 is ~18–25 min and Lambda's 15-min cap kills the tail. Fargate has no such cap — pathological runs complete instead of silently dying mid-build.

### Alternative: **trigger.dev**

- Removes the timeout problem and gives a richer run dashboard out of the box.
- Cost: onboarding a new platform for one app. Worth it if/when we have a *portfolio* of agent workloads to migrate; not worth it just for this.
- Reasonable revisit point: when the second triggerable agent app shows up.

### Not recommended

- **Plain Lambda** — 15-min hard limit cuts the p90+ tail of the build↔review loop. The tail is also the most valuable runs (harder PRs → bigger wins).
- **Step Functions + Lambda fan-out** — works, but state-threading between separately-invoked Lambdas adds plumbing the rest of the spec stays clear of. Not worth the complexity over one Fargate task.
- **n8n as the executor** — fine as a webhook router if we already have it in the path, wrong fit for the agent work itself.

---

## Opt-in mechanism

**Recommended:** PR label `fascicle-improve`.

- Simplest possible signal. Dev adds the label, webhook fires on `pull_request.labeled`.
- Granular: per-PR opt-in, easy to add to `auto_label` rules later.
- No central config to maintain.

**Alternatives:**

- Comment command (`/fascicle improve`) — slightly more dev friction; adds a parser.
- Repo-level config (`.fascicle/pr-improve.yaml`) — best for "always-on for this repo," worse for selective use.

Start with the label. Add comment-command if asked.

---

## Module breakdown

New package: `examples/pr-improve/` (or `apps/pr-improve/` if we want it published separately later — start as an example to keep the bar low).

```text
examples/pr-improve/
├── package.json
├── README.md
├── Dockerfile                            # node + gh CLI + git; entrypoint = src/worker.ts
├── infra/                                # terraform module (owned with SRE)
│   ├── main.tf                            # API GW + webhook lambda + SQS + ECS task def + IAM
│   └── variables.tf
└── src/
    ├── main.ts                            # CLI entry: takes PR ref, runs flow (testable locally)
    ├── worker.ts                          # Fargate entrypoint: poll SQS msg → run flow
    ├── webhook_lambda.ts                  # tiny Lambda: validate HMAC, enqueue SQS msg
    ├── flow.ts                            # the fascicle composition (scope + 4 stages)
    ├── stages/
    │   ├── reviewer.ts                    # stage 1
    │   ├── pragmatist.ts                  # stage 2
    │   ├── builder.ts                     # stage 3 (tool_loop + worktree-scoped tools)
    │   └── build_reviewer.ts              # stage 4 + feedback loop
    ├── tools/                              # builder's toolset, all worktree-scoped
    │   ├── list_dir.ts
    │   ├── read_file.ts
    │   ├── write_file.ts
    │   ├── edit_file.ts
    │   └── run_shell.ts                    # allowlist-based, no free shell
    ├── engine.ts                           # provider selection by env (anthropic | openrouter | ...)
    ├── observability.ts                    # stdout_logger adapter (TrajectoryLogger → stdout JSON)
    ├── github/
    │   ├── pr.ts                          # gh CLI wrappers (view/diff/create/comment)
    │   └── workspace.ts                   # clone + worktree + branch helpers
    └── types.ts                           # Suggestion, BuildVerdict, RunContext shapes
```

Single tsconfig, single package boundary, no monorepo gymnastics.

**Subprocess calls (`gh`, `git`)** must use the safe spawn helper pattern in this repo (no shell-string concatenation). Mirror how `packages/engine/src/providers/claude_cli/spawn.ts` invokes the CLI: argv array, no `shell: true`, env passed explicitly. (Reference for spawn hygiene only — we don't depend on the `claude_cli` provider.)

### Reuse — read these before writing anything new

- `examples/red-green-refactor/src/harness.ts` — canonical multi-stage `scope` + `stash` + `use` flow. **Mirror this structure.**
- `examples/reviewer.ts` — schema-driven reviewer with stub engine for tests.
- `examples/adversarial_build.ts` — API-backed adversarial build↔critique loop. **This is the structural template for stages 3–4** (NOT `adversarial_claude_cli.ts`, which we're explicitly not using).
- `examples/tool_loop.ts` — tool-equipped agent pattern. The builder is a tool_loop with file-editing tools.
- `packages/agents/src/define_agent.ts` — markdown-defined agent factory; stage prompts live as markdown files loaded through this so we can iterate on prompts without redeploying.
- `packages/engine/src/index.ts` — `create_engine` factory; multi-provider config is a single object.
- `packages/observability/src/filesystem_logger.ts` — write trajectory to `.fascicle-pr-bot/<run-id>/trajectory.jsonl` for viewer replay (uploaded to S3 on container exit).

For subprocess calls (`gh`, `git`) the worker still follows the safe-spawn pattern shown in `packages/engine/src/providers/claude_cli/spawn.ts` (argv array, no `shell: true`, env passed explicitly) — we're using that file as a *reference for spawn hygiene*, not depending on the provider it implements.

### What we are *not* building

- A generic webhook framework. The webhook Lambda is ~30 lines (HMAC verify + SQS `SendMessage`).
- A GitHub octokit wrapper. The `gh` CLI covers everything we need (PR view, diff, create, comment, push) via a single thin module. One auth path: `GH_TOKEN` env (sourced from Secrets Manager in prod).
- An orchestrator. SQS message group per PR enforces concurrency; ECS RunTask handles per-message lifecycle.
- Any out-of-band notification surface (Slack, email). The PR comment is the only output.

---

## Iteration limits, failure modes, observability

| Stage | Failure mode | Behavior |
|---|---|---|
| 1 Reviewer | model error / empty output | Abort run; trajectory captures the error; container exits non-zero, ECS task marked failed |
| 2 Pragmatist | empty accept list | Halt cleanly; comment on original: "Reviewed — no pragmatic improvements proposed." |
| 3 Builder | builder agent returns malformed handoff / fails to commit | Retry once; on second fail, abort run |
| 4 Reviewer | needs-changes loop exceeds 3 rounds | Abort; do not push; do not comment |
| any | network / GH API failure | Exponential retry (3x, jittered); then abort |
| any | exception | Trajectory captures it; container exits non-zero so ECS marks the task failed |

Failures are visible in CloudWatch (ECS task logs) and in the per-run trajectory file (uploaded to S3 on container exit). SQS dead-letter queue catches messages whose tasks failed repeatedly. No out-of-band alert channel — if a run fails, it shows up in CloudWatch and the DLQ.

### CloudWatch via fascicle events (no new IAM)

Fascicle's `tee_logger` (`@repo/observability`) fans one stream of trajectory events out to multiple sinks. We compose:

```ts
trajectory: tee_logger(
  filesystem_logger({ output_path: `.trajectory/${run_id}.jsonl` }),
  stdout_logger(),  // writes one JSON line per event to stdout
)
```

A tiny `stdout_logger` adapter (~20 lines, lives in `examples/pr-improve/src/observability.ts`) implements the `TrajectoryLogger` contract by `JSON.stringify`-ing each `record` / `start_span` / `end_span` call and writing to `process.stdout`. Fargate's default `awslogs` driver ships stdout straight to CloudWatch — **zero new IAM, zero new API calls, no `PutLogEvents` plumbing**. CloudWatch Logs Insights queries the stream as structured JSON because each line is already JSON:

```text
fields @timestamp, run_id, span_name, kind, error
| filter kind = "error"
| sort @timestamp desc
```

Same events end up in `.trajectory.jsonl` (for fascicle-viewer replay locally and S3 upload on container exit) and CloudWatch (for live tailing and ad-hoc queries). One source of truth, two destinations.

**Concurrency:** Per-PR singleton via SQS FIFO `MessageGroupId = repo+pr_number`. A second webhook for the same PR queues behind the in-flight run rather than racing it. Use `MessageDeduplicationId` to drop duplicate label events within the 5-minute window.

**Cost guardrail:** Hard cap on total tokens per run (e.g. $1 USD via the engine's cost tracking). Abort if exceeded.

---

## Decisions to confirm before building

These are the points where I picked a default to keep the spec concrete; flag any you want changed:

1. **Runtime host = AWS Fargate** (webhook → tiny Lambda → SQS FIFO → ECS RunTask). Owned jointly with SRE via terraform. Reasoning: timing math (p99 ~25 min) blows through Lambda's 15-min cap; trigger.dev solves the same problem but adds a new platform we'd need to onboard for one app.
2. **Opt-in = PR label `fascicle-improve`** (vs comment command, vs repo config).
3. **Pragmatist cap N=3 accepted changes** (smaller is more aligned with the "fewer changes" anchor).
4. **Build↔review loop max 3 rounds** before abort.
5. **Models:** Reviewer=sonnet, Pragmatist=**opus**, Builder=sonnet (API + tool_loop), Build-Reviewer=**opus**. All four through the fascicle engine via `model_call`. Default provider=`anthropic`; swappable to `openrouter` (or any supported provider) by env var alone — that's the explicit proof point of this app.
6. **Single-repo scope first** (the fascicle repo). Multi-repo opens auth/permission scope work; defer.
7. **Pure fascicle for stages 3–4** (no ridgeline). Revisit if builds grow multi-phase.

If any of these is wrong I want to know before writing code — they each shift the module layout meaningfully.

---

## Build sequence (phases)

Recommend three phases, each independently demoable:

### Phase A — Local end-to-end on stub data

1. Scaffold `examples/pr-improve/` with `main.ts`, `flow.ts`, `types.ts`.
2. Implement stages 1–4 against a fixture diff (one of our recent PRs, saved as a `.patch` file). Use a stub engine for fast iteration.
3. Run with `pnpm exec tsx examples/pr-improve/src/main.ts --fixture <path>`. Verify trajectory in viewer.

### Phase B — Real GitHub on the real repo

1. Add `github/pr.ts` and `github/workspace.ts` (gh CLI wrappers + worktree).
2. Swap the stub engine for the real Anthropic engine; test the builder tool_loop end-to-end against a real PR locally (still no webhook).
3. Run end-to-end against an open PR with a `--dry-run` flag (does not push or comment).

### Phase C — Triggered from a webhook (with SRE)

1. Write `Dockerfile` (Node + `gh` CLI + `git`) and `src/worker.ts` (poll-one-message-and-run shape).
2. Pair with SRE on the terraform module: API Gateway + webhook Lambda + SQS FIFO + ECS task definition + IAM + Secrets Manager (`GH_TOKEN`, `ANTHROPIC_API_KEY`). Add CloudWatch log group + DLQ.
3. Configure GitHub webhook to fire on `pull_request.labeled` (filter: `fascicle-improve`) and POST to API Gateway.
4. Add concurrency invariant via SQS `MessageGroupId` and the cost guardrail in `worker.ts`.
5. Roll out as opt-in for one repo (the fascicle repo). Tag a PR. Verify the loop end-to-end (improvement PR opens, comment lands on original).

---

## Verification

- **Phase A:** `pnpm exec tsx examples/pr-improve/src/main.ts --fixture fixtures/pr-1234.patch` produces an `IMPROVEMENT_SPEC.md` and an `HANDOFF.md` in a temp worktree, and a trajectory file viewable via `pnpm dlx fascicle-viewer .trajectory.jsonl`.
- **Phase B:** Running against a real open PR with `--dry-run` produces a local branch with commits and a printed preview of the comment that *would* land on the original PR. Nothing is pushed.
- **Phase C:** Adding the `fascicle-improve` label to a PR causes a new improvement PR to appear within ~5 min, and a comment with a 2-sentence summary + link lands on the original PR.
- **Provider portability check (the proof):** the same fixture from Phase A run with `FASCICLE_PROVIDER=openrouter FASCICLE_MODEL_REVIEWER=anthropic/claude-sonnet-4.6 …` (or equivalent OpenRouter aliases) produces an end-to-end run with no code changes. Ship the spec only after this passes.
- **Pipeline-level checks:** `pnpm check:all` is green. New stage prompts have schema tests under `__tests__/` mirroring `examples/reviewer.ts`'s test pattern.
- **Negative tests:** A PR with nothing worth changing produces an empty pragmatist spec and a single "no improvements proposed" comment on the original PR; no improvement PR is opened.
- **Builder safety tests:** unit tests for the worktree-scoped tools — path traversal attempts (`../../etc/passwd`) reject; shell allowlist rejects unauthorized commands; oversized writes reject.

# pr-improve

Automated PR improvement pipeline. Triggered (eventually) by a `fascicle-improve` label on a GitHub PR; runs a 4-stage agent pipeline that reviews the diff, distills a pragmatic subset of changes, builds them in a new branch, and reviews the build before opening an improvement PR.

- [SPEC.md](./SPEC.md) — full design (4-stage pipeline, Fargate trigger, opt-in, decisions).
- [docs/architecture.md](./docs/architecture.md) — why `flow.ts` is pure fascicle composition, and the module split that keeps it that way.

## Status

**Phase C, PR B** (current): single-command demo against a real GitHub PR with full provider portability. The builder dispatches by provider — `claude_cli` uses the CLI's built-in Read/Write/Edit, while API providers (`anthropic`, `openrouter`) get explicit worktree-scoped tools. Same `flow.ts`, same `Step<string, GenerateResult<Handoff>>` contract, no code changes between runs.

```sh
pr-improve <pr-number>                       # default: --provider claude_cli
pr-improve <pr-number> --provider anthropic  # API path; requires ANTHROPIC_API_KEY
```

**Phase A** (still works): local end-to-end against a fixture diff with a stub engine. No GitHub, no real model calls.

```sh
pnpm --filter @repo/example-pr-improve improve:stub
```

Phase D (cloud trigger via Fargate) is described in `SPEC.md`.

## Demo: install + run

Prerequisites: `gh auth login` and `claude` (the Claude CLI) logged into your account.

```sh
gh repo clone robmclarty/fascicle ~/src/fascicle
cd ~/src/fascicle && pnpm install
ln -s "$PWD/examples/pr-improve/bin/pr-improve" ~/.local/bin/pr-improve
```

Then, from inside any local checkout of a GitHub-hosted repo:

```sh
cd ~/projects/some-repo
pr-improve 1234        # → review comment + improvement PR + linking comment on PR #1234
```

What happens:

1. The pipeline pulls the PR via `gh`, sets up an isolated `git worktree` at `.fascicle/<run-id>/`, and runs reviewer → pragmatist → builder → build-reviewer through `claude_cli`.
2. A review comment with the reviewer's suggestions is posted on the target PR.
3. If the build-reviewer's verdict is `pass`, a new improvement PR is opened against the target PR's head branch and a follow-up comment links the two.
4. Otherwise (no pragmatic improvements / failed to converge), only the review comment + a brief follow-up explaining why is posted.

Per-run artifacts are written under `.runs/<run-id>/` for inspection: `REVIEW_COMMENT.md`, `HANDOFF.md`, `PR_COMMENT.md`, `result.json`, `trajectory.jsonl`.

If you're running this against a third-party repo where you don't want the worktree dir tracked, add `.fascicle/` to that repo's `.gitignore`.

## Provider portability proof

Every stage routes through the fascicle engine via `model_call`. Provider is selected by `--provider <name>` (CLI flag) or `FASCICLE_PROVIDER` env var. Three providers coexist:

- `claude_cli` — default; uses the developer's logged-in Claude (no API key). The CLI's built-in Read/Write/Edit tools handle file edits in the worktree's cwd.
- `anthropic` — requires `ANTHROPIC_API_KEY`. The builder gets explicit worktree-scoped tools (`read_file`, `write_file`, `edit_file`, `list_dir`, `run_shell`) wired by `make_builder_tools(worktree_root)`.
- `openrouter` — requires `OPENROUTER_API_KEY`. Same explicit-tool path as `anthropic`.

Acceptance criterion (live as of Phase C, PR B): the same PR run with `--provider claude_cli` and `--provider anthropic` produces the same end-to-end result with no code changes.

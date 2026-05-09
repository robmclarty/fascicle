# pr-improve

Automated PR improvement pipeline. Triggered (eventually) by a `fascicle-improve` label on a GitHub PR; runs a 4-stage agent pipeline that reviews the diff, distills a pragmatic subset of changes, builds them in a new branch, and reviews the build before opening an improvement PR.

- [SPEC.md](./SPEC.md) — full design (4-stage pipeline, Fargate trigger, opt-in, decisions).
- [docs/architecture.md](./docs/architecture.md) — why `flow.ts` is pure fascicle composition, and the module split that keeps it that way.

## Status

**Phase B** (current): single-command demo against a real GitHub PR via the `claude_cli` provider. Runs the full 4-stage pipeline locally and posts the resulting GitHub artifacts (a review on the target PR, an improvement PR, and a follow-up comment linking the two).

```sh
pr-improve <pr-number>
```

**Phase A** (still works): local end-to-end against a fixture diff with a stub engine. No GitHub, no real model calls.

```sh
pnpm --filter @repo/example-pr-improve improve:stub
```

Phase C and Phase D scopes are described in `SPEC.md`.

## Phase B demo: install + run

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

- `claude_cli` — Phase B default; uses the developer's logged-in Claude (no API key). The CLI's built-in Read/Write/Edit tools handle file edits in the worktree's cwd.
- `anthropic` — requires `ANTHROPIC_API_KEY`. In Phase B the builder produces a Handoff but does not yet edit files (Phase C wires an explicit `tool_loop`).
- `openrouter` — requires `OPENROUTER_API_KEY`. Same Phase B caveat as `anthropic`.

Acceptance criterion (deferred to Phase C): the same PR run with `--provider claude_cli` and `--provider anthropic` produces the same end-to-end result with no code changes.

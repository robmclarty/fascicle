---
name: version
description: Bump every workspace package in lockstep (root package.json, every packages/*/package.json, packages/{core,engine}/src/version.ts) via scripts/bump-version.mjs, summarize every commit since the last release into a new CHANGELOG.md section, and commit with a `vX.Y.Z` message. Also supports `--repair-skew` to force-align the lockstep set to the root's current version without bumping. Use when cutting a release or recovering from version drift.
argument-hint: "[major|minor|patch] [--repair-skew]"
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Bash(node scripts/bump-version.mjs*), Bash(pnpm check*), Bash(git log*), Bash(git diff*), Bash(git describe*), Bash(git status*), Bash(git add *), Bash(git commit *), Bash(git tag *), Bash(git push origin v*), Bash(git reset *), Bash(git restore *), Bash(git checkout *), Bash(node -e *), Bash(cat *)
---

# version

Bump every workspace package in lockstep, prepend a `CHANGELOG.md` section summarizing every commit since the last release, and commit. The deterministic work — dirty-tree check, skew check, semver math, file rewrites — happens in `scripts/bump-version.mjs` *before this skill begins reasoning*. The skill itself only summarizes commits, drafts prose, and runs git.

The lockstep set is the root `package.json`, every `packages/*/package.json`, and the literal `export const version = '...';` lines in `packages/core/src/version.ts` and `packages/engine/src/version.ts`. The script enumerates this set via `scripts/lib/lockstep.mjs` — the single source of truth shared with `check-deps.mjs` and `check-publish.mjs`.

## Arguments

`$ARGUMENTS` — one of:

- `major`, `minor`, or `patch` — standard bump.
- `patch --repair-skew` (any bump type plus `--repair-skew`, or `--repair-skew` alone) — force-align mode. Reads the root's current version and rewrites every other lockstep-set file to match. No bump, no `CHANGELOG.md` edit, no commit. Changes are left in the working tree for manual review. Intended as a one-shot recovery when skew is discovered.

No default; fail fast if missing or anything else.

## Preflight context

- Bump result: !`node scripts/bump-version.mjs $ARGUMENTS`

The bump script runs *first*, before the skill reasons about anything. By the time you read this, one of three things is true on disk:

- the lockstep set has been rewritten to the new version (`mode: "bump"`),
- the lockstep set has been force-aligned to the root (`mode: "repair-skew"`),
- nothing was changed and the script emitted an error JSON (`mode: "error"`).

On a successful bump, the JSON carries everything the skill needs: `new` is the authoritative version (never recompute it), and `since` is the SHA of the previous `vX.Y.Z` release commit — the left boundary for the CHANGELOG commit range. If `since` is `null`, there is no prior release and this is an initial release.

## Steps

1. **Parse the bump-result JSON from preflight.** Read the `mode` field and branch:
   - `mode: "error"` → go to "Steps — error". Do not proceed.
   - `mode: "repair-skew"` → go to "Steps — repair skew".
   - `mode: "bump"` → continue below.

2. **Sanity-check the rewrite.** The JSON's `files[]` lists every lockstep-set file with `changed: true|false`. If `changed_count` is 0, something is wrong (the script claimed success but rewrote nothing) — stop and tell the user, don't continue to commit.

3. **Fetch the commit range** using the JSON's `since` SHA:
   - If `since` is a SHA: `git log <since>..HEAD --no-merges --pretty=format:'%h %s'`
   - If `since` is `null`: `git log --no-merges --pretty=format:'%h %s'` (initial release)

4. **Draft the CHANGELOG section.** Use the JSON's `new` field for the version heading (don't recompute):

   ```markdown
   ## vX.Y.Z — YYYY-MM-DD

   ### Added
   - <one line per user-visible addition>

   ### Changed
   - <behavior changes, refactors that matter externally>

   ### Fixed
   - <bug fixes>

   ### Internal
   - <tooling, tests, docs — keep this section short or omit>
   ```

   Rules for the summary:
   - Group by impact, not by commit. Collapse three commits that together land one feature into one bullet.
   - Omit any `Added/Changed/Fixed/Internal` section that has no entries.
   - Each bullet is one line. Reference commit hashes only if the line is genuinely ambiguous without one.
   - Write for a reader who didn't follow the work. "Fixed flaky cache eviction under concurrent writes" beats "fixed bug in cache".
   - If the JSON's `since` is `null`, this is the first release — title the section "vX.Y.Z — initial release" instead of listing every commit in repo history.

   **Print the drafted section back to the user** as a fenced `markdown` code block in your response text — the entire block, verbatim, exactly as it will be prepended to `CHANGELOG.md`. This is the user's one chance to see the prose in isolation before it's folded into the file, committed, and tagged. Do this before moving on to step 5; don't summarize or abbreviate — print the raw markdown. The skill continues automatically after printing (no wait for confirmation); if the user wants to change the prose, they'll interrupt.

5. **Prepend the new section to `CHANGELOG.md`.** If the file exists, prepend above the existing content (keep a single `# Changelog` heading at the very top). If it doesn't exist, create it with:

   ```markdown
   # Changelog

   <new section here>
   ```

6. **Stage exactly the lockstep set + `CHANGELOG.md`, nothing else.** Use explicit paths (matches the JSON's `files[]`):

   ```bash
   git add package.json \
           packages/*/package.json \
           packages/core/src/version.ts \
           packages/engine/src/version.ts \
           CHANGELOG.md
   ```

   Confirm via `git status --short` that no other files are staged. If anything unexpected is staged, stop and hand it back to the user — a release commit is not the place to sneak other changes in.

7. **Commit.** Use the JSON's `new` field literally:

   ```bash
   git commit -m "vX.Y.Z"
   ```

   No prefix, no body, no footer. That matches the tag convention the repo uses to find "the last release" on the next bump.

8. **Verify with `pnpm check --only docs,links,spell --bail`.** Only these three checks can fail on a `(version strings + CHANGELOG)` diff — semver-string replacement in 9 files can't break types, lint, struct, deps, dead-code, or tests, so running the full pipeline is wasted CPU. The heavy checks gate `prepublishOnly` (`check:all`) instead, which is where release-readiness actually matters. If the narrow check exits 0, continue to step 9.

   If it exits non-zero:
   - The release commit is already created (step 7 already ran).
   - Undo with `git reset --hard HEAD~1`. This restores both the lockstep-set files (back to the old version) and `CHANGELOG.md`.
   - Tell the user the check failed, show the tail of the relevant `.check/*.txt` or `.check/*.json` diagnostic, and stop. Don't retry the commit; the user decides whether to fix and re-invoke the skill or investigate first.

9. **Create an annotated tag and push it.** Use the JSON's `new` field literally:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

   Annotated (not lightweight) so the tag carries author, date, and message. The explicit tag-only push is intentional — branch merges and branch pushes are managed separately by the user; the skill only publishes the release marker. Pushing `refs/tags/vX.Y.Z` also sends the commit it points to, so the release commit reaches the remote even if the branch ref hasn't moved yet.

   Error handling:
   - `git tag` fails because the tag already exists → stop and tell the user. Don't force-overwrite. A prior release at this version already exists and the user needs to resolve it by hand.
   - `git push` fails (network, auth, permissions) → the local tag is already created. Tell the user the commit + tag exist locally, show the push error, and suggest re-running `git push origin vX.Y.Z` once the issue is resolved. Do not delete the tag.

10. **Report back.** Tell the user: the old version, the new version (both from the JSON), the commit SHA, the tag name, the number of commits summarized, and whether the tag push succeeded. The user still pushes the release branch themselves when they're ready (matching their manual `npm publish` step).

## Steps — repair skew

Triggered when the preflight JSON's `mode` is `"repair-skew"`.

1. **Print the JSON verbatim** so the user sees which files changed and what their prior versions were (the `before` field on each entry).
2. **Do not edit `CHANGELOG.md`.** Repair is not a release.
3. **Do not stage, do not commit.** Tell the user explicitly: nothing was committed; review `git diff` and commit by hand if the alignment is correct.

## Steps — error

Triggered when the preflight JSON's `mode` is `"error"`. The script made no changes (no version files touched, no commit). Branch on `error_type`:

- `dirty_tree` → tell the user the working tree must be clean before a release commit; show the listed dirty files; suggest committing or stashing first; stop.
- `skew` → tell the user the lockstep set has version skew; quote the script's diagnostic; suggest `/version patch --repair-skew` (or hand-fix the listed files); stop.
- `usage` → relay the script's usage message verbatim; stop.
- `runtime` → relay the script's message and stop. Don't speculate or retry.

In every error case: no edits, no git operations, no retry. The user decides what to do next.

## When to use this skill

- Cutting a release, even an internal one (`patch`/`minor`/`major`).
- Recovering from workspace version skew (`--repair-skew`).
- User asks to "bump the version" or "tag a new version".

## When NOT to use this skill

- There's no meaningful change since the last release (no commits between last tag and HEAD). Tell the user and stop.
- The user wants to edit an existing CHANGELOG entry or retro-tag an older commit — that's a different workflow, not this skill.
- A *single* per-package version bump in the workspace. Lockstep is the project policy (see `.ridgeline/taste.md` Principle 16); bumps move every package together.

## Edge cases

- **No prior release.** When `since` in the JSON is `null`, treat the entire history as the range and title the section `vX.Y.Z — initial release`. The script identifies prior releases by commit message (`vX.Y.Z`), not by git tag — see `.ridgeline/taste.md` Principle 16.
- **`CHANGELOG.md` exists but has no `# Changelog` heading.** Prepend the new heading plus the new section; leave the old content below untouched.
- **Commit list contains merge commits.** Drop them from the summary unless they introduced something not present in the squashed commits. `--no-merges` on the log is fine if the output is noisy.
- **A commit is marked with `BREAKING:` or `!:` but the user asked for `patch` or `minor`.** Warn the user and ask if they meant `major`. Don't override silently. Note: by this point the bump has *already happened on disk* (the script ran in preflight); if the user wants `major` instead, they need to `git restore` the lockstep set and re-invoke `/version major`.
- **`pnpm check --only docs,links,spell --bail` fails in step 8.** `git reset --hard HEAD~1` restores the pre-bump state. Do not amend, do not retry the commit from inside the skill — the user decides. Common cause: a word in the new CHANGELOG entry is missing from `cspell.json`'s `words` list. Fix via a separate commit, then re-invoke `/version`.

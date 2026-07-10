---
name: version
description: Bump the root package.json version via scripts/bump-version.mjs, summarize every commit since the last release into a new CHANGELOG.md section, and commit with a `vX.Y.Z` message. Use when cutting a release.
argument-hint: "[major|minor|patch]"
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Bash(node scripts/bump-version.mjs*), Bash(pnpm check*), Bash(git log*), Bash(git diff*), Bash(git describe*), Bash(git status*), Bash(git add *), Bash(git commit *), Bash(git tag *), Bash(git push origin v*), Bash(git reset *), Bash(git restore *), Bash(git checkout *), Bash(node -e *), Bash(cat *)
---

# version

Bump the version in the root `package.json`, prepend a `CHANGELOG.md` section summarizing every commit since the last release, and commit. The deterministic work — dirty-tree check, semver math, file rewrite — happens in `scripts/bump-version.mjs` *before this skill begins reasoning*. The skill itself only summarizes commits, drafts prose, and runs git.

The repo is one package with one manifest, so a bump rewrites exactly one version field: the root `package.json`.

## Arguments

`$ARGUMENTS` — one of `major`, `minor`, or `patch`. No default; fail fast if missing or anything else.

## Preflight context

- Bump result: !`node scripts/bump-version.mjs $ARGUMENTS`

The bump script runs *first*, before the skill reasons about anything. By the time you read this, one of two things is true on disk:

- the root `package.json` version has been rewritten to the new version (`mode: "bump"`),
- nothing was changed and the script emitted an error JSON (`mode: "error"`).

On a successful bump, the JSON carries everything the skill needs: `new` is the authoritative version (never recompute it), and `since` is the SHA of the previous release — the commit the most recent `vX.Y.Z` git tag reachable from HEAD points at — the left boundary for the CHANGELOG commit range. If `since` is `null`, there is no prior release and this is an initial release.

## Steps

1. **Parse the bump-result JSON from preflight.** Read the `mode` field and branch:
   - `mode: "error"` → go to "Steps — error". Do not proceed.
   - `mode: "bump"` → continue below.

2. **Fetch the commit range** using the JSON's `since` SHA:
   - If `since` is a SHA: `git log <since>..HEAD --no-merges --pretty=format:'%h %s'`
   - If `since` is `null`: `git log --no-merges --pretty=format:'%h %s'` (initial release)

3. **Draft the CHANGELOG section.** Use the JSON's `new` field for the version heading (don't recompute):

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

   **Print the drafted section back to the user** as a fenced `markdown` code block in your response text — the entire block, verbatim, exactly as it will be prepended to `CHANGELOG.md`. This is the user's one chance to see the prose in isolation before it's folded into the file, committed, and tagged. Do this before moving on to step 4; don't summarize or abbreviate — print the raw markdown. The skill continues automatically after printing (no wait for confirmation); if the user wants to change the prose, they'll interrupt.

4. **Prepend the new section to `CHANGELOG.md`.** If the file exists, prepend above the existing content (keep a single `# Changelog` heading at the very top). If it doesn't exist, create it with:

   ```markdown
   # Changelog

   <new section here>
   ```

5. **Stage exactly `package.json` + `CHANGELOG.md`, nothing else:**

   ```bash
   git add package.json CHANGELOG.md
   ```

   Confirm via `git status --short` that no other files are staged. If anything unexpected is staged, stop and hand it back to the user — a release commit is not the place to sneak other changes in.

6. **Commit.** Use the JSON's `new` field literally:

   ```bash
   git commit -m "vX.Y.Z"
   ```

   No prefix, no body, no footer, so the release commit reads as `vX.Y.Z` in the log. The authoritative release marker is the annotated tag created in step 8; the next bump finds "the last release" from that tag (the plain commit message is only a fallback).

7. **Verify with `pnpm check --only docs,links,spell --bail`.** Only these three checks can fail on a `(version string + CHANGELOG)` diff — a single semver-string replacement plus prose can't break types, lint, struct, deps, dead-code, or tests, so running the full pipeline is wasted CPU. The heavy checks gate `prepublishOnly` (`check:all`) instead, which is where release-readiness actually matters. If the narrow check exits 0, continue to step 8.

   If it exits non-zero:
   - The release commit is already created (step 6 already ran).
   - Undo with `git reset --hard HEAD~1`. This restores both `package.json` (back to the old version) and `CHANGELOG.md`.
   - Tell the user the check failed, show the tail of the relevant `.check/*.txt` or `.check/*.json` diagnostic, and stop. Don't retry the commit; the user decides whether to fix and re-invoke the skill or investigate first.

8. **Create an annotated tag and push it.** Use the JSON's `new` field literally:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

   Annotated (not lightweight) so the tag carries author, date, and message. **Pushing the tag triggers the release pipeline**: `publish.yaml` starts an OIDC trusted-publishing run that pauses at the `npm-publish` environment for a required-reviewer approval, and `release.yaml` creates the GitHub Release from the CHANGELOG section. Pushing `refs/tags/vX.Y.Z` also sends the commit it points to, so the tagged commit reaches the remote even if the branch ref hasn't moved yet. The push is tag-only by design — branch pushes stay the user's call — but that means the branch ref lags until they push it (see step 9).

   Error handling:
   - `git tag` fails because the tag already exists → stop and tell the user. Don't force-overwrite. A prior release at this version already exists and the user needs to resolve it by hand.
   - `git push` fails (network, auth, permissions) → the local tag is already created. Tell the user the commit + tag exist locally, show the push error, and suggest re-running `git push origin vX.Y.Z` once the issue is resolved. Do not delete the tag.

9. **Report back.** Tell the user: the old version, the new version (both from the JSON), the commit SHA, the tag name, the number of commits summarized, and whether the tag push succeeded. Then point them at the two things that finish the release: **(a)** approve the paused `publish.yaml` run in GitHub Actions (the `npm-publish` gate) to let the provenance publish proceed, and **(b)** push the release branch (`git push origin main`) so the branch ref includes the release commit — the skill pushes only the tag.

## Steps — error

Triggered when the preflight JSON's `mode` is `"error"`. The script made no changes (no version field touched, no commit). Branch on `error_type`:

- `dirty_tree` → tell the user the working tree must be clean before a release commit; show the listed dirty files; suggest committing or stashing first; stop.
- `usage` → relay the script's usage message verbatim; stop.
- `runtime` → relay the script's message and stop. Don't speculate or retry.

In every error case: no edits, no git operations, no retry. The user decides what to do next.

## When to use this skill

- Cutting a release, even an internal one (`patch`/`minor`/`major`).
- User asks to "bump the version" or "tag a new version".

## When NOT to use this skill

- There's no meaningful change since the last release (no commits between last tag and HEAD). Tell the user and stop.
- The user wants to edit an existing CHANGELOG entry or retro-tag an older commit — that's a different workflow, not this skill.

## Edge cases

- **No prior release.** When `since` in the JSON is `null`, treat the entire history as the range and title the section `vX.Y.Z — initial release`. The script identifies the previous release from the most recent `vX.Y.Z` git tag reachable from HEAD (resolved to its commit), falling back to a commit messaged exactly `vX.Y.Z` only when no release tag exists — so a release cut by direct-tagging (rather than through this skill) is still detected correctly.
- **`CHANGELOG.md` exists but has no `# Changelog` heading.** Prepend the new heading plus the new section; leave the old content below untouched.
- **Commit list contains merge commits.** Drop them from the summary unless they introduced something not present in the squashed commits. `--no-merges` on the log is fine if the output is noisy.
- **A commit is marked with `BREAKING:` or `!:` but the user asked for `patch` or `minor`.** Warn the user and ask if they meant `major`. Don't override silently. Note: by this point the bump has *already happened on disk* (the script ran in preflight); if the user wants `major` instead, they need to `git restore package.json` and re-invoke `/version major`.
- **`pnpm check --only docs,links,spell --bail` fails in step 7.** `git reset --hard HEAD~1` restores the pre-bump state. Do not amend, do not retry the commit from inside the skill — the user decides. Common cause: a word in the new CHANGELOG entry is missing from `cspell.json`'s `words` list. Fix via a separate commit, then re-invoke `/version`.

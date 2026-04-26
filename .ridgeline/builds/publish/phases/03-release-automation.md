# Phase 3: Release Automation — /version lockstep and two-name documentation

## Goal

Close the release loop so shipping a new version is one command instead of a human checklist, and write down the two-name discipline so the distinction between `@robmclarty/agent-kit` (published) and `@repo/*` (workspace-internal) survives contributor turnover.

The `/version` skill is rewritten to walk the full lockstep set (root `package.json` plus every `packages/*/package.json` plus the two literal-string version constants at `packages/{core,engine}/src/version.ts`), refuse to run on a skewed workspace, bump every file atomically, regenerate the relevant `CHANGELOG.md` section grouped by commit impact, commit with the literal message `vX.Y.Z`, and verify with `pnpm check --bail` (rolling back on failure). A separate `--repair-skew` codepath force-aligns the lockstep set to the root's current version without bumping, providing a one-shot recovery mode.

Documentation lands alongside the skill because both capture the same decision (umbrella-is-the-seam, lockstep-first) from different angles. The root `README.md` gains a `## Names` section at the top of Layout. `AGENTS.md` gains a one-line pointer to the discipline. `.ridgeline/taste.md` gains Principle 15 (Umbrella-is-the-seam) and Principle 16 (Lockstep first; semver-per-package on demand) numbered to continue the existing list.

No publish plumbing changes in this phase; Phase 2 already produced a publishable artifact. Final end-to-end validation proves the release flow works: the tarball installs cleanly into a scratch project, every expected symbol is importable, and `pnpm publish --dry-run` reports the expected file list. The mutation gate stays out per spec §8's explicit deferral.

After this phase, `pnpm /version patch` followed by `pnpm publish --access public` is the complete release workflow, with tagging remaining a human-or-CI step after reviewing the commit.

## Context

Phases 1 and 2 are complete. The v0.2.0 API surface exists (`describe.json`, `model_call`), `pnpm build` produces a valid `dist/`, `scripts/check-publish.mjs` validates pack contents and type resolution, `scripts/check-deps.mjs` enforces the lockstep-version invariant and the privacy invariant (root not private, packages private), the link-check step guards every internal markdown link, and the ast-grep bridge rule locks `model_call` as the sole cross-layer bridge. The two `version.ts` constants exist under `packages/{core,engine}/src/`, each exporting `export const version = '<SEMVER>';`. The root `package.json` has `prepublishOnly: 'pnpm check && pnpm build && pnpm check:publish'`.

The current `.claude/skills/version/SKILL.md` bumps only the root `package.json`. It must be rewritten to walk the full lockstep set and edit every member atomically. The `version.ts` rewrites are surgical: a targeted regex on the literal `export const version = '<SEMVER>';` line in each file, not a general TS-aware transform. The skill does not create git tags (spec §6.3); tagging remains a human-or-CI step after reviewing the commit.

Spec §6.4 specifies `--repair-skew` as a separate codepath: no bump, no CHANGELOG entry, no release commit. It exists to recover from the one-time skew situation that led to this spec.

Spec §9 specifies the exact wording for the README Names section. Spec §12 gives the exact text for taste.md Principles 15 and 16; they continue the existing numbering (the current taste.md goes through Principle 14).

This is the final phase. After acceptance, the spec's release flow is executable end-to-end.

## Acceptance Criteria

### /version skill rewrite

1. `.claude/skills/version/SKILL.md` is rewritten to document and implement a walk over the full `LOCKSTEP_SET`: root `package.json`, every `packages/*/package.json` (five files), `packages/core/src/version.ts`, and `packages/engine/src/version.ts` — eight files total.
2. On invocation, the skill first reads the current version from the root `package.json`.
3. A pre-flight skew check verifies every file in `LOCKSTEP_SET` already carries the root's current version; on any mismatch the skill aborts with a diagnostic naming the offending file and both conflicting versions, and makes no file changes and no commit.
4. Given `patch`, `minor`, or `major` as the bump type, the skill computes the new version via standard semver rules and rewrites every `LOCKSTEP_SET` file to the same new version.
5. The two `version.ts` rewrites target the literal `export const version = '<SEMVER>';` line via a regex keyed on that exact pattern; the rewrite is idempotent and does not perturb other file content. A fixture with a non-matching line shape causes the skill to fail rather than silently not-edit.
6. The skill regenerates the relevant `CHANGELOG.md` section grouped by commit impact, matching the project's existing CHANGELOG convention (preserves prior entries; creates the file with an initial structure if it does not exist).
7. Exactly the `LOCKSTEP_SET` files plus `CHANGELOG.md` are staged; no other files enter the commit.
8. The commit message is literally `vX.Y.Z` (no prefix, no description, no body).
9. After committing, the skill runs `pnpm check --bail`; on failure it prints a clear error and returns the working tree to its pre-bump state (either via the existing skill's rollback pattern or an equivalent `git reset` — the chosen mechanism is documented inline).
10. The skill does not create git tags under any flag; tagging is explicitly a user or CI responsibility.
11. `/version patch --repair-skew` exists as a separate codepath: reads the root's current version, force-aligns every `LOCKSTEP_SET` member to that version, does not compute a bump, does not regenerate `CHANGELOG.md`, does not create a release commit, and leaves changes in the working tree for the user to review and commit manually.
12. The `--repair-skew` mode is documented in the skill with a one-sentence explanation of its intended one-shot use.
13. A fresh workspace at `0.1.5` → `/version patch` produces every `LOCKSTEP_SET` file at `0.1.6` in a single commit whose payload is exactly those files plus `CHANGELOG.md`, with message `v0.1.6`. Test 20 from spec §10 passes.
14. Artificially setting one `packages/*/package.json` (or one `version.ts` constant) to `0.1.4`, then running `/version patch`, causes the skill to refuse with a clear diagnostic naming the offending file; no files are modified and no commit is created. Test 21 from spec §10 passes.
15. `scripts/check-deps.mjs`, `scripts/check-publish.mjs`, and the rewritten `/version` skill either share a single source-of-truth definition of `LOCKSTEP_SET` (e.g. a small helper under `scripts/lib/`) or each independently enumerates the same exact set with equivalent semantics; if divergence is chosen, an inline comment in each location explains why the shared helper was not used.

### Two-name documentation

16. Root `README.md` gains a `## Names` section at the top of its Layout area containing the two-name discipline paragraph from spec §9 verbatim: explains that `@robmclarty/agent-kit` is the one thing installed from npm, that the `@repo/*` packages are workspace-only, and that only `@robmclarty/agent-kit` reaches npm.
17. `AGENTS.md` gains a one-line pointer to the two-name discipline (either pointing to the README Names section or restating the umbrella-is-the-seam rule); placement is natural within the existing document structure.
18. `.ridgeline/taste.md` gains Principle 15 (Umbrella-is-the-seam) with the full paragraph from spec §12 — including the rationale for rejecting multi-package publish and the pnpm-workspace `@repo/*` internal signal reasoning — numbered to continue the existing principle list.
19. `.ridgeline/taste.md` gains Principle 16 (Lockstep first; semver-per-package on demand) with the full paragraph from spec §12 — including the circumstances under which the default would change (one layer churning significantly faster than another).
20. All documentation additions pass markdownlint, cspell, and the Phase 2 link checker; no em dashes in the prose (per CLAUDE.md and taste.md's existing discipline).

### End-to-end validation

21. `pnpm check` exits 0 on a clean tree with every Phase 1 and Phase 2 guard still active (bridge ast-grep rule, link check, lockstep-version invariant, root-not-private invariant).
22. `pnpm build` produces a non-empty `./dist/index.js`, `./dist/index.js.map`, and `./dist/index.d.ts`; every symbol in the umbrella's export surface (16 composition primitives, `create_engine`, `model_call`, `describe`, `describe.json`, `core_version`, `engine_version`, the typed errors including `describe_cycle_error`) is importable from the built bundle.
23. `pnpm check:publish` exits 0: pack dry-run file list matches the allowlist, arethetypeswrong reports no resolution failures, lockstep-version invariant holds across all eight sources.
24. `pnpm publish --dry-run` from the repo root reports the expected file list and emits no warnings beyond the accepted "no license" notice and any pnpm-workspace-root noise.
25. Scratch-project smoke install: creating a fresh temporary directory, running `pnpm init`, installing the packed tarball (`pnpm add file:/<path-to-packed-tgz>`), and executing a Node one-liner `await import('@robmclarty/agent-kit').then(m => { if (!m.run || !m.create_engine || !m.model_call || !m.describe || !m.sequence || !m.parallel) throw new Error('missing export') })` exits 0. This proves peer-dep resolution works end-to-end against a real consumer environment.
26. A manual `/version patch --repair-skew` run against a deliberately-skewed fixture tree demonstrates recovery (then is reverted so the committed tree stays aligned).
27. The repository URL in root `package.json` (spec §13 open question 7) is confirmed final or updated to the correct GitHub slug before phase completion.
28. The workspace, after this phase, can ship a new version by running `pnpm /version patch` followed by `pnpm publish --access public`; the only remaining manual step is `git tag vX.Y.Z && git push --tags` after reviewing the commit.

## Spec Reference

- §1 (gap 5 "`/version` is single-file")
- §2 Solution Overview — Release flow, Versioning
- §6 `/version` Skill Rewrite — §6.1 new behavior, §6.2 algorithm, §6.3 tag policy, §6.4 skew-repair flag
- §8 Mutation Gate — deferred; no work in this phase
- §9 README Documentation — Names section at top of Layout (verbatim wording)
- §10 Success Criteria — automated tests 20–21; manual validation block
- §11 File Structure — `.claude/skills/version/SKILL.md` edit, `.ridgeline/taste.md` edit, root `README.md` edit, `AGENTS.md` edit, `CHANGELOG.md` creation/append via `/version`
- §12 `taste.md` Additions — Principle 15 (Umbrella-is-the-seam) and Principle 16 (Lockstep first) verbatim
- §13 Open questions 1 (arethetypeswrong pin confirmed in Phase 2 still valid), 7 (repository URL confirmation)
- §13 Closed-by-review items — inform the rationale prose in the taste.md additions
- Bootstrap build order — items 9–10
- Invariants-to-enforce: every workspace `package.json` version plus the two `version.ts` constants remain identical after any `/version` run; `/version` does not create tags; no `dist/` imported from source

# Phase 2: Publish Infrastructure — bundle, preflight, link check, invariants

## Goal

Turn the workspace into something `pnpm publish` can actually ship. The umbrella source becomes the single bundled artifact that reaches npm: `tsdown` inlines every `@repo/*` workspace dependency into a self-importable `./dist/`, while `ai`, `zod`, and all `@ai-sdk/*` / OpenRouter / Ollama adapter packages stay external and surface as peer dependencies. The root `package.json` is rewritten from a workspace-only manifest into the published-artifact description: drops `"private": true`, gains `publishConfig`, `main`, `module`, `types`, `exports`, `files`, `peerDependencies`, `peerDependenciesMeta`, and the `build` / `check:publish` / `prepublishOnly` scripts.

A publish preflight script validates pack contents with `npm pack --dry-run`, runs `@arethetypeswrong/cli` against the built dist, and asserts the lockstep-version invariant. The `pnpm check` pipeline grows a new `links` step (a ~60-line Node walker that verifies every relative markdown link target exists on disk) and `scripts/check-deps.mjs` grows two invariants: root-not-private (only the root manifest drops `"private": true`; every `packages/*/package.json` keeps it) and lockstep-versions across the root, every workspace package, and two new literal-string constants seeded at `packages/core/src/version.ts` and `packages/engine/src/version.ts`.

After this phase, `pnpm build && pnpm check:publish && pnpm publish --dry-run` is a working command chain. The workspace is demonstrably shippable; the only thing standing between here and an actual release is a human running `pnpm publish`. The `/version` skill rewrite and the two-name documentation are intentionally held until Phase 3 — a human can bump versions by hand against the new lockstep invariant for one release without blocking this phase.

## Context

Phase 1 landed the composition-surface additions: `describe.json` on `@repo/core`, `model_call` in the umbrella, the bridge ast-grep rule (`rules/model-call-is-sole-bridge.yml`), `describe_cycle_error`, and the `FlowNode` / `FlowValue` type surface. Every new symbol is re-exported from `@repo/fascicle`. `pnpm check` is green. No packaging work has started; the root is still `"private": true` and no `dist/` exists.

Three concerns in this phase share the same verification loop (`pnpm check` plus `pnpm build` plus `pnpm check:publish`) and benefit from landing together:

1. **Build pipeline** — `tsdown` config, `scripts/build.mjs`, and the root `package.json` rewrite that exposes the built dist as `@robmclarty/agent-kit`.
2. **Publish preflight** — `scripts/check-publish.mjs` validating tarball contents and type resolution, plus the lockstep assertion that guards against skew mid-release.
3. **Workspace invariants** — the `links` check landing as a new step in `scripts/check.mjs`'s `CHECKS` array, plus the lockstep-version and root-not-private additions to `scripts/check-deps.mjs`. These invariants are prerequisite to the build phase: the lockstep assertion needs real files to check, which is why the two `version.ts` constants are seeded here.

Splitting the three across phases would leave `pnpm check:publish` half-wired across a phase boundary. Bundling them means one coherent round of pipeline-runtime measurement (the total `pnpm check` budget stays ≤10s) and one round of end-to-end dry-run validation.

Spec §3.2 specifies the exact shape of the rewritten root `package.json`, including every peer dependency version range, the `exports` map conditions ordering (`types` before `import`), and the deliberate omission of the `license` field — the repo ships without a LICENSE at this stage and the `npm publish` "no license" warning is accepted. Spec §3.3 specifies the exact tsdown configuration including `noExternal: [/^@repo\//]` and the external list. Spec §3.4 specifies the build pipeline and the publish preflight's three validation arms: pack-file-list allowlist, arethetypeswrong clean, version-lockstep re-assertion.

The `dist/` directory is gitignored. The build script exits non-zero on any tsdown warning — silent success is not acceptable.

## Acceptance Criteria

### Workspace invariants and link check

1. `packages/core/src/version.ts` and `packages/engine/src/version.ts` exist, each exporting `export const version = '<SEMVER>';` where the literal matches the current root `package.json` version.
2. The umbrella (`packages/fascicle/src/index.ts`) re-exports those constants as `core_version` and `engine_version`.
3. `scripts/check-links.mjs` exists, globs every `*.md` under the repo, excludes `node_modules/**`, `dist/**`, `.check/**`, `.stryker-tmp/**`, `docs/**`, `research/**`, and `.ridgeline/**`, resolves each relative `[text](target)` link against the source file's directory, ignores `http://`, `https://`, `mailto:`, and bare-anchor (`#...`) targets, strips the fragment after `#` before existence checks, writes `.check/links.json` as `{ ok: true }` on success or `[{ file, line, link, resolved }]` on misses, and exits 1 on any miss.
4. An inline `LINK_CHECK_ALLOWLIST` regex array is declared at the top of the link-check script (empty by default) with a comment requiring commit-message justification for additions.
5. `scripts/check.mjs`'s `CHECKS` array gains a `links` entry placed after `docs` and before `spell`, with an `output_file` of `links.json`.
6. The `links` check runs in ≤200ms on the current tree; total `pnpm check` runtime stays within the project's existing performance envelope (≤10s).
7. A fixture `.md` containing `[bad](./nonexistent.md)` causes the link check to write the miss to `.check/links.json` and exit 1; the fixture is cleaned up before phase completion so the committed tree stays green.
8. A fixture `.md` containing `[x](https://example.com)` does not produce a link-check failure.
9. `scripts/check-deps.mjs` gains a lockstep-versions invariant: every `packages/*/package.json` version equals the root's, and both `packages/{core,engine}/src/version.ts` literal constants match the root version. Skew in any single location makes `pnpm check` fail with a diagnostic naming the offending file and both conflicting versions.
10. `scripts/check-deps.mjs` gains a root-not-private invariant: the root `package.json` must not contain `"private": true`, and every `packages/*/package.json` must carry it. Both halves are negative-tested (artificially re-adding `"private": true` to the root, and artificially removing it from a subpackage, each fire `pnpm check` with a path-naming diagnostic); all fixtures are reverted. Note: the root-not-private half only becomes green after the root `package.json` rewrite below.

### Build pipeline

11. `tsdown.config.ts` at the repo root matches spec §3.3 exactly: `entry: ['./packages/fascicle/src/index.ts']`, `outDir: './dist'`, `format: ['esm']`, `dts: true`, `sourcemap: true`, `clean: true`, `target: 'node24'`, `platform: 'node'`, `noExternal: [/^@repo\//]`, `external: ['ai', 'zod', /^@ai-sdk\//, 'ai-sdk-ollama', '@openrouter/ai-sdk-provider']`.
12. `scripts/build.mjs` deletes `./dist/`, runs tsdown, verifies `./dist/index.js` and `./dist/index.d.ts` exist and are non-empty, runs a dynamic-import smoke test asserting the 16 composition primitives plus `create_engine`, `model_call`, `describe`, and `describe.json` are all exported from the built bundle, and exits non-zero on any tsdown warning or failure.
13. `pnpm build` from a clean state produces non-empty `./dist/index.js`, `./dist/index.js.map`, and `./dist/index.d.ts`, and exits 0.
14. Grepping `./dist/index.js` for `from '@repo/` yields zero matches (workspace deps inlined).
15. Grepping `./dist/index.js` yields at least one match each for `from 'ai'`, `from 'zod'`, and `from '@ai-sdk/` (peer deps kept external).
16. A one-liner smoke import of the built bundle (`node -e "import('./dist/index.js').then(m => { if (!m.run || !m.create_engine || !m.model_call || !m.describe || !m.describe.json) process.exit(1) })"`) exits 0 after `pnpm build`.
17. `.gitignore` contains `/dist`; the `dist/` directory is not tracked by git after `pnpm build`.

### Root package.json rewrite

18. Root `package.json`: `"private": true` is removed; `name` stays `@robmclarty/agent-kit`; `type` is `module`; `main` and `module` point to `./dist/index.js`; `types` points to `./dist/index.d.ts`; `exports['.']` declares `types` before `import` conditions; `files` is `["dist", "README.md", "CHANGELOG.md"]`; `engines.node` is `>=24.0.0`; `repository`, `homepage`, and `bugs` are present; `publishConfig.access` is `public`; no `license` field is present.
19. Root `package.json` `peerDependencies` contains `ai ^6.0.0`, `zod ^4.0.0`, `@ai-sdk/anthropic ^3.0.0`, `@ai-sdk/google ^3.0.0`, `@ai-sdk/openai ^3.0.0`, `@ai-sdk/openai-compatible ^2.0.0`, `@openrouter/ai-sdk-provider ^2.0.0`, `ai-sdk-ollama ^3.0.0`.
20. Root `package.json` `peerDependenciesMeta` marks every `@ai-sdk/*` entry, `@openrouter/ai-sdk-provider`, and `ai-sdk-ollama` as `optional: true`; `ai` and `zod` are not marked optional.
21. Root `package.json` `scripts` gains `build`, `check:publish`, and `prepublishOnly: 'pnpm check && pnpm build && pnpm check:publish'`; the existing `check` script is preserved.
22. `@arethetypeswrong/cli` is added to root `devDependencies` and resolves under `pnpm install`.
23. Every `packages/*/package.json` still carries `"private": true`.

### Publish preflight

24. `scripts/check-publish.mjs` runs `npm pack --dry-run --json`, asserts the file list contains `dist/index.js`, `dist/index.d.ts`, `README.md`, and `CHANGELOG.md`, and asserts `.ts` source files, test files, `.ridgeline/`, `docs/`, `research/`, `.stryker-tmp/`, `.check/`, `rules/`, `scripts/`, and `packages/*/src/` paths are absent.
25. `scripts/check-publish.mjs` runs `@arethetypeswrong/cli` against `./dist/` and fails on any Node-ESM resolution error. Any version-specific false positive from arethetypeswrong is addressed by pinning its invocation with an inline comment explaining the pin (spec §13 open question 1).
26. `scripts/check-publish.mjs` re-asserts the lockstep-version invariant across the root `package.json`, every `packages/*/package.json`, and both `packages/{core,engine}/src/version.ts` literal constants; skew fails with a diagnostic naming the offending file and both conflicting versions.
27. `pnpm check:publish` exits 0 on the committed tree after phase completion.
28. Artificially skewing one `packages/*/package.json` version (or one `version.ts` constant) causes `pnpm check:publish` to fail with a diagnostic naming the offending file; skew is reverted so the committed tree stays green.
29. Artificially adding a `.ts` source path to the root `files` array causes `pnpm check:publish` to fail naming the unexpected inclusion; revert before phase completion.

### End-to-end verification

30. `pnpm check`, `pnpm build`, and `pnpm check:publish` each exit 0 at phase end (all three run in sequence locally without errors).
31. `pnpm publish --dry-run` from the repo root succeeds, lists only the files enumerated in the root `files` array, and emits no warnings beyond the accepted "no license" notice and any pnpm-workspace-root noise.
32. No Phase 1 regression: the bridge ast-grep rule still passes; no new value-level bridge file has appeared under `packages/fascicle/src/`; no file under `packages/core/src/` has gained a value import of `@repo/engine`; the full umbrella export surface from Phase 1 is still intact and present in the built bundle.
33. Tests 10–19 from spec §10 are implemented and pass under `pnpm check`: dist produced; no `@repo/` in dist; peer deps present as externals in dist; smoke import passes; pack dry-run allowlist enforced; arethetypeswrong clean; version lockstep fails on skew; link check clean on the committed tree; link check detects broken relative links in fixtures; link check ignores external URLs.

## Spec Reference

- §1 (gaps 1 "no publishable artifact", 2 "name ambiguity", 6 "no broken-link guard")
- §2 Solution Overview — Publish topology (Option A, umbrella-only), Release flow
- §3 Publish Topology Detail — §3.1 what publishes (only root manifest), §3.2 root package.json shape, §3.3 tsdown configuration, §3.4 build pipeline and check-publish preflight
- §6.1 — the two `version.ts` constants as part of the lockstep set (seeded here so the invariant has real files to check)
- §7 Link Check — §7.1 script, §7.2 pipeline placement, §7.3 fragment scope (fragments stripped, file-half validated only), §7.4 allowlist policy
- §10 Success Criteria — automated tests 10–19; architectural validation bullets for "`dist/` is never imported from source", "`private: true` removed only from root", and the machine-checked lockstep invariant
- §11 File Structure — `dist/` (NEW, gitignored), `tsdown.config.ts` (NEW), `scripts/build.mjs` (NEW), `scripts/check-publish.mjs` (NEW), `scripts/check-links.mjs` (NEW), `scripts/check-deps.mjs` edit, `scripts/check.mjs` edit, root `package.json` edit, `.gitignore` edit, `packages/core/src/version.ts` (NEW), `packages/engine/src/version.ts` (NEW)
- §13 Open questions 1 (arethetypeswrong false positives), 4 (link-check anchors deferred), 7 (repository URL placeholder — confirm or publish under corrected URL)
- Bootstrap build order — items 4–8
- Invariants-to-enforce: `dist/` is produced by build only and never imported from source; root drops `"private": true` while every `packages/*/package.json` keeps it; every workspace version and both `version.ts` constants remain identical; `scripts/build.mjs` exits non-zero on any tsdown warning

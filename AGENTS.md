# AGENTS.md

Instructions for any coding agent (Claude Code, Codex, Cursor, Windsurf, Amp) operating in this repository.

## The contract

**`pnpm check:all` is the single source of truth for "done".** If it exits 0, your work is complete. If it exits non-zero, it is not. No other signal counts.

`pnpm check` runs the default (fast) set — every check except the opt-in `mutation` step — and is what you should use in tight feedback loops. `pnpm check:all` adds the opt-in checks (Stryker mutation testing) and is the gate before declaring done.

Before declaring a task finished:

1. Run `pnpm check:all`.
2. If it fails, read `.check/summary.json` to find which check failed.
3. Read the corresponding per-tool JSON (`.check/lint.json`, `.check/dead.json`, etc) for structured diagnostics.
4. Fix the root cause, not the symptom.
5. Re-run `pnpm check:all`.

## Tight feedback loops

During iteration, use narrower commands for faster turnaround:

```bash
pnpm check                     # default set (excludes opt-in mutation)
pnpm check --bail              # stop at first failure
pnpm check --only types,lint   # just the fast checks
pnpm check --include mutation  # default set plus opt-in mutation
pnpm test:watch                # watch-mode tests while implementing
pnpm exec tsc --noEmit         # just types
```

`pnpm check:all` (every check, including opt-in) is the final gate before declaring done. Stryker's `mutation` step is the slowest and is opt-in for exactly this reason; incremental mode keeps re-runs cheap once the shared baseline at `stryker.incremental.json` is up to date.

## Conventions

- **TypeScript strict mode.** Everything. No `any`, no `!` non-null assertions without justification.
- **Functional/procedural.** No classes. Use modules, closures, and plain data. Enforced by `rules/no-class.yml`.
- **Named exports.** No default exports. Enforced by `rules/no-default-export.yml`.
- **Naming:** `snake_case` for variables and functions, `PascalCase` for types and interfaces, `SCREAMING_SNAKE_CASE` for constants. Exports are enforced by `rules/snake-case-exports.yml`.
- **File extensions:** import with `.js` even from `.ts` files (NodeNext resolution).
- **Tests colocated in `__tests__/`:** unit tests for `foo.ts` live at `__tests__/foo.test.ts` next to it (e.g. `src/core/branch.ts` ↔ `src/core/__tests__/branch.test.ts`). Cross-cutting tests (integration, signal handling, fixtures) live under `src/<module>/test/` instead, which is outside the source-semantics rules and spell-check.
- **Coverage floor:** 70% lines/functions/branches/statements. Raise it as the codebase matures.
- **Architectural boundaries are enforced.** The rest of `rules/` uses ast-grep to police layer separation between `core`, `engine`, adapters, and the `claude_cli` provider — e.g. no adapter imports in `core`, no cross-composer imports, no `process.env` reads outside the audited exceptions, no provider SDKs outside `src/engine/providers/`, no `child_process` outside `claude_cli`. `fallow.toml` adds a directory-level default-deny boundary DAG on top. Read `rules/` and the `fallow.toml` boundaries before adding a cross-module import.

## Source layout

This is a **single package**. All source lives under `src/`, organized as deep modules: `src/<module>/` (core, engine, composites, agents, observability, stores, viewer), each with a barrel `index.ts` that is its only public face. The umbrella surface sits at the `src/` root (`index.ts`, `adapters.ts`, `model_call.ts`, `forward_standard_env.ts`); that is what bundles to npm as `fascicle`. The 5 apps under `examples/*/` are the only other workspace members; they depend on the library via `fascicle: workspace:*`.

**Barrels are import/export only.** An `index.ts` contains only `import`, `export … from`, `export { … }`, and `export type` statements (bare side-effect imports are fine). No runtime logic: module logic lives in a named sibling file (e.g. `create_engine` in `create_engine.ts`, `start_viewer` in `start_viewer.ts`) that the barrel re-exports. Enforced by `rules/no-logic-in-barrel.yml`.

**Cross-module access is sealed two ways.** Every module is reachable only through its barrel:

- **Use the `#<module>` import alias for cross-module imports**, never a relative path that escapes the module dir. Use `import { x } from '#core'`, never `import { x } from '../core/x.js'`. The `#`-aliases are declared in the root `package.json` `imports` (mapping each to `src/<module>/index.ts`), mirrored in `tsconfig.json` `paths` and `vitest.config.ts` `resolve.alias`. Because only barrels are mapped, deep imports through the alias are impossible; `rules/no-cross-module-relative-import.yml` closes the relative-path channel. (Cross-cutting harnesses under `src/<module>/test/` are exempt — they are spawned as child node processes that cannot resolve `#`-aliases, so they reach siblings relatively.)
- **`engine` imports `core` type-only** (`import type`), the one value exception being `src/engine/errors.ts` re-exporting `aborted_error`.
- **Examples import the published surface** `fascicle` / `fascicle/adapters` (and the repo-only dev alias `fascicle/agents`), so they are copy-pasteable by npm consumers. Resolved via root `tsconfig.json` `paths` + `vitest.config.ts` `resolve.alias`.
- **Dependencies live in the one root `package.json`.** Runtime deps are direct; the provider SDKs are optional peers. The "core depends only on zod" / "engine only on ai+zod" invariants are enforced at the import level by `rules/no-core-npm-dep-except-zod.yml` and `rules/no-engine-npm-dep-except-ai-zod.yml` (the single manifest can no longer express per-module dependency shape).
- **Boundaries are enforced by `rules/*.yml` + `fallow.toml`.** The fallow `[[boundaries.rules]]` DAG is directory-level default-deny (each module lists the siblings it may not import); the umbrella (`src/*.ts`) is unconstrained. Mirrors the ast-grep rules.
- **Adding a module:** create `src/<module>/index.ts`, add `#<module>` to the root `package.json` `imports`, `tsconfig.json` `paths`, and `vitest.config.ts` `resolve.alias`, and add a `[[boundaries.rules]]` entry to `fallow.toml`. `pnpm check` must still exit 0.
- **One set of root configs.** `tsconfig.json`, `vitest.config.ts`, `fallow.toml`, `cspell.json`, `stryker.config.mjs`, and `rules/` glob across `src/**`.

## What NOT to do

- Do not disable lint rules to pass the check. If a rule is wrong for a case, discuss first or use a scoped inline suppression with a comment explaining why.
- Do not add dependencies casually. Every new dep is surface area. Fallow will catch unused ones.
- Do not add a file that is not imported by something. Fallow will flag it.
- Do not skip writing tests for new behavior. Stryker runs as the opt-in `mutation` step (`pnpm check:all`) and will catch tests that pass trivially.
- Do not bypass `pnpm check:all` by running individual tools and claiming done.

## MCP tools available

Both are wired in `.mcp.json`:

- `fallow` — structured codebase analysis. Call `analyze`, `check_changed`, `find_dupes`, `check_health`, `fix_preview`, `fix_apply`, or `project_info`.
- `ast-grep` — structural code search and rule authoring. Useful when adding or debugging rules in `rules/` or finding AST-level patterns the plain grep tools can't express.

Use these during implementation for real-time dead-code, boundary, and structural feedback, rather than waiting for the final `pnpm check`.

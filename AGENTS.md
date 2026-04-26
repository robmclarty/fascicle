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
- **Tests colocated:** `foo.ts` and `foo.test.ts` live in the same directory.
- **Coverage floor:** 70% lines/functions/branches/statements. Raise it as the codebase matures.
- **Architectural boundaries are enforced.** The rest of `rules/` uses ast-grep to police layer separation between `core`, `engine`, adapters, and the `claude_cli` provider — e.g. no adapter SDK imports in `core`, no cross-composer imports, no `process.env` reads in `core`, no provider SDKs outside provider packages, no `child_process` outside `claude_cli`. Read `rules/` before adding a new package or cross-package import.

## Monorepo layout

This is a pnpm workspace. Source lives under `packages/<name>/src/`, never at the repo root.

**Two-name discipline.** Inside the workspace every package uses the `@repo/*` prefix and stays private; the only name that reaches npm is `@robmclarty/fascicle`, bundled from the umbrella (`packages/fascicle/src/index.ts`). See [README.md#names](./README.md#names) and `.ridgeline/taste.md` Principle 15 (Umbrella-is-the-seam).

- **Cross-package imports go through workspace names**, not relative paths. Use `import { x } from '@repo/other'`, never `import { x } from '../../other/src/x.js'`. Enforced by ast-grep rules in `rules/` and by fallow's boundary checker.
- **Runtime dependencies live in the package that imports them.** Declare them in `packages/<name>/package.json`. Inter-package deps use `"workspace:*"`. `scripts/check-deps.mjs` audits the `core`/`engine` production-deps invariant on every `pnpm check`.
- **Tooling dependencies live at the root.** Everything in `scripts/check.mjs` (tsc, oxlint, ast-grep, `check-deps.mjs`, fallow, vitest, markdownlint, cspell, stryker) is a root devDependency. A devDependency inside a package is a smell.
- **Adding a package:** create `packages/<name>/package.json` (name `@repo/<name>`, `type: module`, `private: true`, `exports`) and `packages/<name>/src/index.ts`. No other files required. `pnpm check` must still exit 0 after adding it.
- **No per-package configs yet.** Root `tsconfig.json`, `vitest.config.ts`, `fallow.toml`, `cspell.json`, `stryker.config.mjs`, and `rules/` glob across `packages/*/src/**`. Add a per-package override only when one package genuinely needs different behavior.

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

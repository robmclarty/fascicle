# Fascicle

**`@robmclarty/fascicle` is a TypeScript library for composing agents out of LLM calls, tool calls, and plain functions.** Everything is a `Step<i, o>`; you wire steps together with 16 primitives (`sequence`, `parallel`, `branch`, `retry`, `ensemble`, `checkpoint`, …) and run them as plain values. One `generate` surface fronts seven provider adapters (Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio, and a `claude_cli` subprocess that drives Claude Code itself).

No framework lifecycle, no ambient state, no decorators. Adapters get passed in per run, not configured globally. `npm install @robmclarty/fascicle` and you have the whole surface.

Two layers:

- **Composition (`@repo/core` internal / `@robmclarty/fascicle` public)** — 16 primitives (`step`, `sequence`, `parallel`, `branch`, `map`, `pipe`, `retry`, `fallback`, `timeout`, `adversarial`, `ensemble`, `tournament`, `consensus`, `checkpoint`, `suspend`, `scope`/`stash`/`use`) plus `run`, `run.stream`, and `describe`. Every composable unit is a `Step<i, o>`; every composer returns a `Step<i, o>`. Anywhere a step fits, any composition of steps fits.
- **AI engine (`@repo/engine`)** — `create_engine(config)` returning a unified `generate` surface over seven AI SDK provider adapters: Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio, and a `claude_cli` subprocess adapter that drives the Claude Code CLI.

`@robmclarty/fascicle` is a thin umbrella package that re-exports both layers so downstream apps can install one thing. Internally, workspace packages use the `@repo/*` prefix; the published name stays `@robmclarty/fascicle`.

## Names

- **`@robmclarty/fascicle`** — the one thing you install from npm. Bundles the composition primitives and the engine.
- **`@repo/core`, `@repo/engine`, `@repo/observability`, `@repo/stores`, `@repo/fascicle`** — workspace-only. Contributors see these internally; they are never published.

Only `@robmclarty/fascicle` reaches npm. Contributors work against `@repo/*` symlinks inside this pnpm workspace.

The monorepo split is an **architectural boundary enforcement mechanism**, not a distribution strategy. `@repo/core` cannot import from adapter packages; `@repo/engine` cannot reach outside its providers; `packages/config/` is the only place allowed to read `process.env`. Keeping those boundaries as separate workspace packages lets the dependency graph, fallow, and the ast-grep rules in `rules/` police them directly. Consumers still see one package.

## Layout

```text
├── packages/
│   ├── fascicle/               umbrella: re-exports core + engine
│   ├── core/                    composition layer (16 primitives, run, describe)
│   ├── engine/                  AI engine layer (create_engine, generate)
│   │   └── src/providers/       anthropic, openai, google, openrouter, ollama, lmstudio, claude_cli
│   ├── config/                  zod-validated env loader; only package that reads process.env
│   ├── observability/           TrajectoryLogger adapters (noop, filesystem JSONL)
│   └── stores/                  CheckpointStore adapters (filesystem)
├── examples/                    runnable reference harnesses (hello, streaming, ensemble, suspend, ollama)
├── rules/                       ast-grep structural rules
├── scripts/check.mjs            the check orchestrator
├── .ridgeline/                  ridgeline project constraints, taste, and build dirs
├── docs/                        concepts, providers, configuration, cookbook, CLI, harness guide
├── fallow.toml  vitest.config.ts  stryker.config.mjs  cspell.json  sgconfig.yml
├── AGENTS.md  CLAUDE.md         agent contracts
└── package.json                 scripts + all devDependencies live here
```

Runtime dependencies live in the package that imports them; devDependencies live at the root. Cross-package imports go through workspace names (`@repo/core`), not relative paths.

## The check contract

`pnpm check:all` is the single source of truth for "is this done?". `pnpm check` runs the same pipeline minus the opt-in `mutation` step and is the command to use during iteration.

| Check      | Tool                             | Catches                                                      |
| ---------- | -------------------------------- | ------------------------------------------------------------ |
| `types`    | `tsc`                            | Type errors (ground truth)                                   |
| `lint`     | `oxlint` + `oxlint-tsgolint`     | Syntax rules, floating promises, unsafe any, 50+ type-aware rules |
| `struct`   | `ast-grep`                       | Project-specific structural rules (see `rules/`)             |
| `dead`     | `fallow`                         | Unused exports/files/deps, circular deps, duplication, complexity, boundary violations |
| `test`     | `vitest` + `@vitest/coverage-v8` | Unit test failures and coverage below thresholds             |
| `docs`     | `markdownlint-cli2`              | Broken markdown                                              |
| `spell`    | `cspell`                         | Misspellings in source and docs                              |
| `mutation` | `stryker` (opt-in)               | Tests that pass trivially (run via `pnpm check:all` or `--include mutation`) |

Deeper passes on demand:

- `pnpm check:all` — full pipeline including Stryker mutation testing
- `pnpm check --include mutation` — same as `check:all` but via the flag
- `pnpm check:mutation` — Stryker only (bypasses the orchestrator)
- `pnpm check:security` — `pnpm audit --audit-level=high`
- `pnpm check:fix` — auto-fix oxlint and fallow issues where possible

## Quick start

```bash
pnpm install
pnpm check
```

Output lands in `.check/`:

- `.check/summary.json` — aggregate result for agents
- `.check/lint.json`, `.check/dead.json`, `.check/struct.json`, `.check/test.json` — raw per-tool JSON
- `.check/coverage/` — vitest coverage report

## Using the composition layer

```typescript
import { run, sequence, step } from '@robmclarty/fascicle';

const flow = sequence([
  step('a', (n: number) => n + 1),
  step('b', (n: number) => n * 2),
]);

const result = await run(flow, 1); // 4
```

Inject adapters per run:

```typescript
import { filesystem_logger } from '@repo/observability';
import { filesystem_store } from '@repo/stores';

await run(flow, input, {
  trajectory: filesystem_logger({ output_path: '/tmp/run.jsonl' }),
  checkpoint_store: filesystem_store({ root_dir: '/tmp/checkpoints' }),
});
```

`run.stream(flow, input)` returns `{ events, result }` for observation. See [`packages/core/README.md`](./packages/core/README.md) for the full surface and [`examples/`](./examples/) for runnable references.

## Using the engine layer

```typescript
import { create_engine } from '@robmclarty/fascicle';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env.ANTHROPIC_API_KEY! } },
});

const result = await engine.generate({
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: 'hello' }],
});

await engine.dispose();
```

Provider adapters are wired behind optional peer dependencies; install only the ones you use. See [`docs/providers.md`](./docs/providers.md) for the full provider matrix, [`docs/configuration.md`](./docs/configuration.md) for engine config, and [`docs/cli.md`](./docs/cli.md) for the `claude_cli` adapter.

## Agent use

The contract: **if `pnpm check` exits 0, the work is done. If it exits non-zero, read `.check/summary.json` for which checks failed, then the corresponding tool JSON for diagnostics.**

```jsonc
// .check/summary.json
{
  "timestamp": "2026-04-20T...",
  "ok": false,
  "total_duration_ms": 4821,
  "checks": [
    { "name": "types", "ok": true,  "exit_code": 0, "duration_ms": 1200, "output_file": null },
    { "name": "lint",  "ok": false, "exit_code": 1, "duration_ms": 340,  "output_file": "lint.json" }
  ]
}
```

Flags:

- `pnpm check --json` — machine-readable to stdout, no human decoration
- `pnpm check --bail` — stop at the first failure
- `pnpm check --only types,lint` — run a subset during iteration
- `pnpm check --skip spell,docs` — skip slow or noisy checks

## Working across packages

`pnpm check` always runs over the whole workspace — that's the shipping gate. For tighter per-package loops:

```bash
pnpm --filter @repo/core test        # run one package's tests
pnpm --filter @repo/engine add zod   # add a runtime dep to one package
pnpm add -w -D typescript@latest     # upgrade a root devDependency
```

Inter-package deps use the workspace protocol:

```bash
pnpm --filter @repo/fascicle add @repo/core --workspace
```

## MCP servers

`.mcp.json` wires two servers for agent clients (Claude Code / Cursor / Windsurf):

- **`fallow`** — structured codebase analysis (`analyze`, `check_changed`, `find_dupes`, `check_health`, `fix_preview`, `fix_apply`, `project_info`). Use during implementation for real-time dead-code and boundary feedback instead of waiting for the final `pnpm check`.
- **`ast-grep`** — structural code search and rule testing against the YAML rules in `rules/`.

Confirm with `claude mcp list`.

## Extending

**Add a check.** Edit `scripts/check.mjs` and append to `CHECKS`:

```js
{
  name: 'agent',
  description: 'agnix: AI config linting',
  command: 'pnpm',
  args: ['exec', 'agnix', '--format', 'json', '.'],
  output_file: 'agent.json',
}
```

**Add a structural rule.** Drop a YAML file into `rules/`. Existing rules enforce no classes, no default exports, snake_case exports, no `process.env` outside `@repo/config`, no provider SDK imports outside `packages/engine/src/providers`, no `child_process` outside the `claude_cli` adapter, and several cross-package import boundaries. ast-grep picks new rules up automatically.

**Add an architecture boundary.** Edit `fallow.toml`:

```toml
[[boundaries.rules]]
from = "packages/*/src/**"
cannotImport = ["../*/src/**"]  # no cross-package relative imports; use workspace names
```

**Add a package.** Create `packages/<name>/package.json` (name `@repo/<name>`, `type: module`, `private: true`, `exports`) and `packages/<name>/src/index.ts`. Run `pnpm install` to wire the symlink. Root `tsconfig.json`, `vitest.config.ts`, `fallow.toml`, `cspell.json`, `stryker.config.mjs`, and `rules/` already glob across `packages/*/src/**`.

## Philosophy

1. **The check is the contract.** A single command the agent can trust. No hidden CI gates.
2. **Structured output over stderr chatter.** Every JSON-capable tool is configured to emit JSON. Agents parse structured data, not colorized text.
3. **The orchestrator is dumb.** It shells out, captures exit codes, and writes files. It does not parse diagnostics.
4. **Tools, not frameworks.** Each tool is independently swappable. If something better than oxlint ships next year, you change one line in `CHECKS`.
5. **Step-as-value.** In the composition layer, every unit is a `Step<i, o>` and every composer returns one. Substitutability, introspectability, and no coupling fall out of that one invariant.

## Related docs

- [AGENTS.md](./AGENTS.md) — universal contract for any coding agent
- [CLAUDE.md](./CLAUDE.md) — Claude-specific workflow notes
- [CHANGELOG.md](./CHANGELOG.md) — version history
- [docs/getting-started.md](./docs/getting-started.md) — install + first flow
- [docs/concepts.md](./docs/concepts.md) — step-as-value, composition, trajectories
- [docs/configuration.md](./docs/configuration.md) — engine config, aliases, provider setup
- [docs/providers.md](./docs/providers.md) — per-provider adapter notes
- [docs/cli.md](./docs/cli.md) — `claude_cli` subprocess adapter
- [docs/cookbook.md](./docs/cookbook.md) — worked patterns (retries, fan-out, judges, HITL)
- [docs/writing-a-harness.md](./docs/writing-a-harness.md) — building a runner around fascicle
- [packages/core/README.md](./packages/core/README.md) — composition layer surface
- [.ridgeline/](./.ridgeline/) — project constraints, taste, and ridgeline build history

# Changelog

## v0.4.0 — 2026-05-07

### Fixed
- `claude_cli` adapter: `build_env` now seeds the standard process-env keys (`PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `LANG`, `TMPDIR`) under every `auth_mode` (was: only inherited under `oauth`). Sandbox-enabled runs under `auto`/`api_key` previously spawned with an empty `PATH` and failed with `ENOENT` looking up `greywall`/`bwrap`. Set `inherit_env: false` to opt out of the standard-key seeding.
- `claude_cli` adapter: greywall sandbox plan now writes a temp settings JSON (`{ network: { allowHosts }, filesystem: { allowWrite } }`) and forwards `--settings <path>` instead of the removed `--allow-host`/`--rw` flags. greywall 0.3.0+ rejected the old flags as unknown and exited 1. Consumers managing their own settings file can pass `sandbox.settings_path` to skip the temp-file generation.
- `fascicle-viewer` CLI: replaced the fragile `argv[1].endsWith('/cli.ts'|'/cli.js')` self-execution guard with an `import.meta.url`-based check. The umbrella bundles `cli.ts` into `dist/index.js`, so any consumer whose entry script was named `cli.js` was accidentally hijacked into running the viewer at import time.

## v0.3.8 — 2026-05-06

### Fixed
- `examples/mcp-server/` lint failures that blocked `prepublishOnly`: rewrote the `reverse_text` tool to use `Intl.Segmenter` + `Array#toReversed()` (grapheme-correct, lint-clean), and replaced the chained `as` casts in `client.ts:text_of` with a small `is_record` user-defined type guard. Smoke test output unchanged.

## v0.3.7 — 2026-05-05

### Added
- Public `fascicle/adapters` subpath exposing `filesystem_logger`, `filesystem_store`, `http_logger`, `tee_logger`, and `noop_logger`. Previously these adapters lived in workspace-private packages and were unreachable by `npm install fascicle` consumers despite being referenced throughout the docs.
- Minimal stdio MCP server example under `examples/mcp-server/`, demonstrating how to expose a `Step<i, o>` as an MCP tool.
- `CONTRIBUTING.md` with contribution guidelines, linked from the README.

### Changed
- README hero illustration is now an animated mycelium diagram showing model_call, step, and tool fruiting from a shared substrate; viewer screenshot moved into the live-dashboard section.
- Documented two adapter limits in `docs/concepts.md`: `filesystem_logger` writes synchronously via `appendFileSync`, and the in-memory span stack in `filesystem_logger`/`http_logger` is not async-context-aware. README, getting-started, cookbook, and writing-a-harness all cross-reference the new "Adapter limits" section.
- README primitives count corrected to 18, with `loop` and `compose` listed in the table.

### Internal
- Added `docs/plans/menu.md` cataloguing considered-but-unshipped work.

## v0.3.6 — 2026-04-30

### Added
- `bench` primitive in `@repo/composites`: online counterpart to `learn`. `bench(flow, cases, judges, options?)` runs a flow against a fixture set, scores each output via judges, and returns a structured `BenchReport` with per-case results and summary (pass_rate, mean_scores per judge, total/mean cost). Per-case observability via `trajectory_dir` (one JSONL per case) and `live_url` (push to a viewer); both can be combined. Cost is tracked in-process by intercepting `cost` events on the trajectory pipeline.
- `judge_equals`, `judge_with`, `judge_llm` in `@repo/composites`: stock judges over `{ input, output, meta }`. `judge_llm` takes a `Step<string, string>` model so composites stays engine-free; users wire their own `model_call({...})` into the judge.
- `regression_compare`, `read_baseline`, `write_baseline`: diff two `BenchReport`s against `pass_rate`, per-judge means, and a relative cost threshold (default 10%). Doesn't short-circuit; full delta + per-case report.
- `tee_logger` adapter in `@repo/observability`: fan one `TrajectoryLogger` contract out to N sinks. First sink's `start_span` id is canonical; per-sink ids are translated back on `end_span`; sinks that throw don't derail the others.
- `examples/bench_reviewer.ts` + `bench/reviewer/{cases.json,baseline.json}`: end-to-end driver against `@repo/agents`'s `reviewer`. `WRITE_BASELINE=1` records, subsequent runs compare and exit 1 on regression.
- Cost rendering in the viewer: per-span cost badges that roll up the tree, plus a header running total (`<n> events · <m> errors · $<total>`). Run filter narrows the total. Cost attribution uses an open-span stack per `run_id`; format is 4 decimals under $0.01, 2 decimals otherwise.
- `examples/amplify` opt-in viewer push via `AMPLIFY_VIEWER_URL`: tees the on-disk trajectory with `http_logger` when set; standalone runs without the env var keep the existing single-sink behaviour.

### Changed
- The viewer ships as part of the `fascicle` umbrella. `start_viewer` is importable from `'fascicle'`; the `fascicle-viewer` bin ships with the published tarball at `dist/bin/fascicle-viewer.js` (with `dist/static/viewer.html` copied alongside). `scripts/check-deps.mjs` now asserts inclusion (was: isolation). Runtime install graph stays free of HTTP-server deps because the viewer only uses `node:*` + `zod` + `@repo/core`.
- README promotes the viewer to a headline surface section with `pnpm dlx fascicle-viewer` and the programmatic `start_viewer` shape.

### Internal
- `scripts/build.mjs` copies `viewer.html` into `dist/static/` and writes a tiny `dist/bin/fascicle-viewer.js` shim that drives `run_viewer_cli` from the bundled umbrella; smoke test asserts `start_viewer` and `run_viewer_cli` are exported.
- `spec/eval.md` records the four-wedge plan and seven open questions surfaced during execution (judge_llm wiring, judge abstention encoding, bench parallelism, baseline `run_id` non-determinism, two viewer UI papercuts, and the live-amplify dogfood result: 51 events, $0.1725 cost, both transports verified end-to-end).
- `spec/viewer.md` reframed packaging and §12 done-def items 2–3 marked verified.

## v0.3.5 — 2026-04-30

### Added
- `@repo/viewer` package and `fascicle-viewer` CLI: minimal in-repo dev dashboard for visualizing a fascicle run as it executes. Single static HTML page (vanilla JS, no build step), an SSE-fed span tree with active/error/emit highlighting, and a click-to-expand event log. Two transports feed one in-process broadcaster: file-tail (`fascicle-viewer .trajectory.jsonl`) for the primary case and HTTP push (`fascicle-viewer --listen` plus the new `http_logger`) for low-latency or remote attach. Localhost-only by default. Programmatic embed via `start_viewer({...})`. See `packages/viewer/README.md`.
- `http_logger` adapter in `@repo/observability`: a `TrajectoryLogger` that POSTs each event as one line of NDJSON to a configured URL. Drops on transport error, never blocks the user flow. Wire format mirrors `filesystem_logger` byte-for-byte and parses back via `trajectory_event_schema`.

### Internal
- New ast-grep boundary rule (`rules/no-engine-import-from-viewer.yml`) keeps the viewer dev tool isolated from `@repo/engine`, composites, agents, the umbrella, stores, observability, and any provider SDK.
- `scripts/check-deps.mjs` gains a `check_viewer_isolation` invariant: `@repo/viewer` must not appear in `@repo/fascicle`'s dependency graph, so the published `fascicle` install graph stays free of HTTP-server deps.
- `spec/viewer.md` documents the v1 plan, scope boundaries, and the explicit non-goals that separate this dev tool from the larger `spec/studio.md` PDR.

## v0.3.4 — 2026-04-30

### Internal
- Switch to ASI-only style: trailing statement semicolons and multi-line interface/type-member separators removed across all TS sources.
- Add ast-grep rules (`no-semicolons`, `no-semicolons-types`) and a small orchestrator script (`scripts/strip-semicolons.mjs`) wired into `check:fix` to enforce the style going forward.

## v0.3.3 — 2026-04-29

### Added
- `improve` composite in `@repo/composites`: bounded online self-improvement loop with parallel proposers, structured lessons accumulator, plateau detection, and configurable wall-clock + round budgets. Online counterpart to `learn`. Example at `examples/improve.ts`.
- `ensemble_step` composite: Step-based sibling of `ensemble` for cases where scoring is itself a `Step`. Returns `winner_id`, `winner`, structured `winner_scored`, and the full `scored` map.

## v0.3.2 — 2026-04-29

### Added
- `@repo/agents` package: markdown-driven `define_agent` loader plus `reviewer`, `documenter`, and `researcher` agents. `reviewer` and `documenter` are markdown-defined; `researcher` is bespoke TypeScript that drives `loop` from core over injected `search`/`fetch` callables, with a per-round summarizer that itself uses `define_agent`.
- Examples wiring each new agent against an in-process stub engine, plus an end-to-end `learn_reviewer` demo that runs the reviewer over three diffs (writing JSONL via `filesystem_logger`) and feeds the directory to `learn` to derive prompt-tightening proposals.

### Internal
- Tightened `learn` tests in `@repo/composites` around truncation events and `flow_description` equality.

## v0.3.1 — 2026-04-29

### Internal
- Colocated unit tests under `__tests__/` subfolders (e.g. `packages/core/src/branch.ts` ↔ `packages/core/src/__tests__/branch.test.ts`); cross-cutting tests under `packages/<name>/test/` are unchanged.

## v0.3.0 — 2026-04-29

### Added

- New core primitives `loop` and `compose`, plus a universal `name?` option on every composer.
- New `learn` composer in `@repo/composites` for offline self-improvement, with file-path and directory sources, exported from the package index.
- `amplify` self-improvement loop example with a demo helper providing chart, measure, and reset utilities.
- `learn` example with smoke test.
- `EffortLevel` extended with `xhigh` and `max`, and reasoning support added to the `claude_cli` adapter.
- `spec/plans/ideas.md` capturing possible directions to build on fascicle.

### Changed

- `adversarial`, `ensemble`, `tournament`, and `consensus` extracted from `@repo/core` into a new `@repo/composites` package.

### Fixed

- `loop` type parameter renamed from `out` to `o` so tsx can parse the source.

### Internal

- Codegraph config plus ignore rules for db/cache files.
- Gitignored the rgr example trajectory output (per-run telemetry).
- Repaired the amplify cascade under tsc 6.x and `pnpm exec`.
- Imported adversarial types directly in the rgr harness; drive-by lint fixes for `pnpm check:all`.

## v0.2.0 — 2026-04-26

### Added

- Phase 0 library surfaces preparing for an upcoming `fascicle-studio` web UI: a `STEP_KINDS` const string union (plus `is_step_kind` and `StepKind`), structured Zod schemas for the trajectory wire format (`span_start_event_schema`, `span_end_event_schema`, `emit_event_schema`, `custom_event_schema`, and the combined `trajectory_event_schema`) configured to allow unknown fields so additional metadata survives a parse / re-serialize round-trip, an optional third-form `step(id, fn, meta?)` overload with `StepMetadata` (display name, description, port labels) echoed on `FlowNode` by `describe.json`, and automatic `run_id` stamping on every emitted trajectory event (a caller-supplied `run_id` is preserved). All re-exported through the `fascicle` umbrella.
- Contract tests locking the studio-facing invariants: `describe.json` is stable per `Step` instance, every emitted event id matches a node id in the flow tree, every event carries `run_id`, and every primitive's `kind` is in `STEP_KINDS`.
- Studio design doc plus parallel research notes at `spec/studio.md` and `spec/research/` capturing decisions for the sibling `fascicle-studio` repo.
- A red/green/refactor TDD harness example at `examples/red-green-refactor/`.
- `docs/til.md` with extracted snippets from pre-squash history.

### Changed

- Dropped the npm scope from the published name (now `fascicle`). README streamlined.
- `prepublishOnly` no longer runs the Stryker mutation check; it stays available via `pnpm check:all`.

## v0.1.13 — 2026-04-25

Initial public release. Fresh git baseline — prior internal commit history is intentionally not carried forward.

The v0.1.13 surface:

- Composition layer (`fascicle` / internal `@repo/core`) — 16 primitives (`step`, `sequence`, `parallel`, `branch`, `map`, `pipe`, `retry`, `fallback`, `timeout`, `adversarial`, `ensemble`, `tournament`, `consensus`, `checkpoint`, `suspend`, `scope`/`stash`/`use`), `run`, `run.stream`, `describe`.
- AI engine layer (`@repo/engine`) — `create_engine(config)` returning a unified `generate` surface over seven Vercel AI SDK provider adapters: Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio, and a `claude_cli` subprocess adapter that drives the Claude Code CLI.
- Adapter packages — `@repo/observability` (trajectory loggers), `@repo/stores` (checkpoint stores).
- Check pipeline — `pnpm check` / `pnpm check:all` orchestrate types, lint, struct (ast-grep), dead-code (fallow), tests, docs, spell, and opt-in mutation testing (Stryker).

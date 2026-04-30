# Changelog

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

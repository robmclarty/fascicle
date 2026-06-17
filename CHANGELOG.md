# Changelog

## v0.8.0 — 2026-06-17

### Changed

- Collapsed the internal pnpm workspace (the nine `@repo/*` packages) into a single package with `src/<module>/` deep modules. The published `fascicle` surface is unchanged — same exports, same bundle, same install; this restructures the repo's source layout and dev-time tooling only.

### Internal

- Cross-module access is sealed through barrel-only `#<module>` import aliases (declared in `package.json` `imports`, mirrored in `tsconfig.json` paths and the vitest alias); `rules/no-cross-module-relative-import.yml` closes the relative-path escape, so every module is reachable only through its `index.ts`.
- Replaced the per-package manifest dependency graph with a directory-level default-deny boundary DAG in `fallow.toml`, plus `no-core-npm-dep-except-zod` and `no-engine-npm-dep-except-ai-zod` ast-grep rules that recover the old `check-deps.mjs` dependency-shape invariants at the import level.
- Removed the unused `config` module; examples now import the published surface (`fascicle`, `fascicle/adapters`, `fascicle/agents`) and depend on the library via `fascicle: workspace:*`.
- Realigned AGENTS.md, README, docs, and `.ridgeline/{taste,constraints}.md` to the single-package layout (taste Principles 15 and 16 rewritten).

## v0.7.0 — 2026-06-16

### Added

- **AWS Bedrock provider.** A new `bedrock` adapter reaches Bedrock-hosted models (Claude, Llama, Nova, …) through the `@ai-sdk/amazon-bedrock` optional peer, wired like every other AI SDK provider: `create_engine({ providers: { bedrock: { region, ... } } })`, then `generate({ provider: 'bedrock', model: '<bedrock-model-id>' })`. Authenticates with a Bedrock API key (bearer), SigV4 keys, or the ambient AWS credential chain; `region` is required. Reasoning effort maps to Bedrock's `reasoningConfig.budgetTokens` for Claude models. Adds `BEDROCK_*` config env vars and `get_bedrock_*` getters in `@repo/config`.

### Changed

- **Breaking: model resolution is now a verbatim pass-through.** `model` is an opaque string sent to the provider unchanged; `provider` selects the transport. There is one canonical input shape — separate `provider` + `model` params — and no interpretation in between.
  - Removed the `provider:model` colon shorthand. Pass `{ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' }` instead of `model: 'openrouter:anthropic/claude-sonnet-4.5'`. Model ids that contain colons (Ollama tags like `qwen3-coder:30b`, Bedrock `...-v1:0`) now ride through untouched.
  - Removed the built-in `MODEL_FAMILIES` catalog and the `families` engine-config field. Family tokens (`opus`, `sonnet`, `gpt`, `gemini`) no longer expand — pass the provider's concrete id. (The `claude_cli` transport still resolves `opus`/`sonnet`/`haiku` itself, via the CLI.)
  - Removed the user alias table: `Engine.register_alias` / `unregister_alias` / `resolve_alias` / `list_aliases` and `EngineConfig.aliases`. Keep your own name→id map in your harness if you want shortcuts.
  - `generate` with no `model` and no `defaults.model` now throws the new `model_required_error` (previously fell back silently to `sonnet`).

### Removed

- **Breaking:** types `AliasTable` and `FamilyCatalog`, and errors `model_not_found_error` and `model_family_unavailable_error`. The resolved-target type `AliasTarget` is renamed `ResolvedModel` (`{ provider, model_id }`).

## v0.6.3 — 2026-06-11

### Fixed
- CI `pnpm install --frozen-lockfile` no longer fails with `ERR_PNPM_IGNORED_BUILDS`; the `esbuild` build script is now approved in the `allowBuilds` map, classifying a transitive dependency that a recent toolchain bump introduced.

## v0.6.2 — 2026-06-11

### Internal
- Stopped tracking the local `.codegraph` tooling config (`config.json` and its `.gitignore`). These are per-machine artifacts and no longer belong in version control.

## v0.6.1 — 2026-06-11

### Fixed
- AI-SDK adapter: the caller's `system` prompt is now delivered through the AI SDK's top-level `system` option instead of as a `role: "system"` entry in the `messages` array. This removes the SDK's "System messages in the prompt or messages fields can be a security risk..." warning that fired on every `generateText`/`streamText` call (most visibly on non-Claude providers, flooding build logs), without changing what the model receives. A leading run of system messages is joined into the single `system` option; the `claude_cli` subprocess transport is unaffected.

## v0.6.0 — 2026-06-10

### Added
- Observability now produces correct span trees: `parent_span_id` is populated so nested spans nest, events carry timestamps, tool results are recorded, and `claude_cli` errors are surfaced instead of being dropped.

### Fixed
- **Security.** The sandbox now isolates the network entirely when the allowlist is empty, instead of leaving it open.
- Packaging: the `./adapters` subpath is now published and the package front door (main export) resolves correctly.
- Engine: `provider_options` are threaded through to the provider and reasoning-effort translation is corrected.
- Core: composers no longer swallow control-flow signals.
- Addressed adversarial-review and publish-audit findings across the library and the examples.

### Internal
- Docs reconciled with the shipped API, plus a snippet typecheck harness and CI step that validate doc snippets against the built types.
- Added the release workflow, base CI workflow, opt-in live-provider smoke tests, roadmap, a Stryker baseline note, and the committed `pnpm-lock`.

## v0.5.0 — 2026-06-03

### Added
- Two-axis model resolution. `model` now names either a **family** (`opus`, `sonnet`, `haiku`, `gpt`, `gemini` — "latest of that family") or a specific vendor id (`claude-opus-4-8`), and a new `provider` axis names the transport (`anthropic`, `claude_cli`, `openrouter`, …). `provider` is accepted per-call on `generate` / `model_call` and as an engine default; the same `model: 'opus'` now runs on any transport by swapping `provider`.
- `MODEL_FAMILIES` catalog mapping each family to the latest id per provider, plus a `families` engine-config field that deep-merges per `(family, provider)` so you can pin newer ids or add new families. Exported `FamilyCatalog` type.
- `examples/swebench`: `claude_cli` provider option, selectable via `SWEBENCH_PROVIDER`.

### Changed
- **Breaking.** `create_engine` no longer ships default aliases — the alias table starts empty and is reserved for your own named pins. The built-in `cli-*`, `or:*`, `gemini-pro`/`gemini-flash`, and `gpt-4o*` aliases are gone; use `{ model, provider }` pairs (e.g. `{ model: 'sonnet', provider: 'claude_cli' }`) or the colon form (`openrouter:meta-llama/llama-3.3-70b-instruct`).
- **Breaking.** `resolve_model` signature is now `resolve_model(model, provider, { families, aliases })`. Resolution order: colon-form `provider:id` → user alias → family lookup → pass-through specific id. When `model`/`provider` are omitted, `model` defaults to `sonnet` and `provider` resolves to per-call → `defaults.provider` → the sole configured provider → `anthropic`.

### Fixed
- A family with no entry for the chosen provider (e.g. `opus` on `openai`) now throws the descriptive `model_family_unavailable_error` instead of the generic not-found path.

## v0.4.3 — 2026-05-10

### Added
- `examples/swebench` — 5-instance smoke harness against SWE-bench Verified. Ships a `Sandbox` seam (`noop` / `local` / `docker` factories), five per-case tools (`read_file`, `write_file`, `run_command` argv-only, `list_files`, `grep_files`), a `solve_instance` flow that captures `git diff` against `base_commit`, and `evaluate_with_sb_cli` for the real eval. Scaling to the 500-instance Verified set is a scale change, not a shape change.
- `examples/pr-improve` Phase C, PR B: builder dispatches by provider. `make_builder_call` now takes `worktree_root` and `provider` explicit params; under `claude_cli` it keeps the schema-only path that delegates to the CLI's built-in Read/Write/Edit, and under API providers (`anthropic`, `openrouter`) it returns a `model_call` configured with the worktree-scoped tools from `make_builder_tools(worktree_root)`. The `Step<string, GenerateResult<Handoff>>` contract is unchanged; `flow.ts` ripples in one place via a new `FlowEnv = { worktree_root, provider }` arg to `build_flow`. The portability proof — same end-to-end result under `--provider claude_cli` and `--provider anthropic` — is now live.

### Internal
- `examples/pr-improve`: split `CLOUD_SPEC.md` out as the active spec for the remaining AWS/Fargate/Terraform deployment work (Fargate worker, webhook Lambda, single Terraform module). `SPEC.md` keeps a deprecation banner and is preserved as historical context.
- `examples/pr-improve` `post_improvement_pr`: dropped the "re-run with `--provider claude_cli`" hint from the no-edits follow-up message, now obsolete since API providers also edit files.
- `vitest.config.ts`: include `examples/pr-improve/src/stages/**/*.{test,spec}.ts` so the new builder-dispatch test runs alongside the tool tests.

## v0.4.2 — 2026-05-09

### Added
- `examples/pr-improve` Phase C, PR A: worktree-scoped builder tools and a safety harness. The builder runs in an isolated git worktree (clean cwd, branch named `fascicle/improve-<n>`) and gets bounded `read_file`, `write_file`, `edit_file`, `list_dir`, and `run_shell` tools that refuse paths outside the worktree, follow no symlinks past the root, and cap stdout/stderr per call.
- `@repo/engine` `claude_cli` provider: typed parsing for `rate_limit_event` stream lines. Trajectories now record a structured `cli_rate_limit_event` (status, rate-limit type, reset times, overage flag) instead of falling through to opaque `cli_unknown_event` blobs. Every field is optional in the schema for forward-compat with future CLI variants.

### Changed
- `@repo/engine` `parse_with_schema` now surfaces the first parseable candidate's schema-validation error, not the last. With multi-candidate JSON extraction (text → fenced blocks → outermost-brace slice → outermost-bracket slice), the bracket-slice fallback could grab an inner array and produce an "expected object, received array" error that buried the real shape mismatch and actively misdirected the schema-repair prompt. The first JSON-parseable candidate represents the model's intent and is what repair feedback should describe.

### Fixed
- `examples/pr-improve` stage prompts: the pragmatist, builder, and build-reviewer system prompts now describe their JSON output contracts explicitly — exact field names, length caps, and an emphatic "JSON only" footer (especially important for the builder, which uses tools and was previously ending its turn with markdown narration). Without the schema spelled out, models invented field names (`id` for `suggestion_id`, `summary` for `one_liner`) or exceeded the 120-char `one_liner` cap, exhausting the schema-repair budget.
- `examples/pr-improve` `run_shell` (auto-applied via PR #5): stream-byte caps now use `Buffer.byteLength` instead of UTF-16 string length, so non-ASCII output is truncated at the correct byte count. Promise settlement is deferred to the `close` event so `AbortController`-driven timeouts return `RunShellOutput { timed_out: true }` instead of always rejecting from the abort-triggered `error` event. Spawn environment strips `ANTHROPIC_*`, `GITHUB_*`, and `AWS_*` keys to prevent credential exfiltration via model-controlled commands.
- `examples/pr-improve` `read_file` / `edit_file` (auto-applied via PR #5): replaced the post-assert `stat()` with `lstat()`, closing a race window where a symlink swapped in after the initial symlink guard could be silently followed.
- `examples/pr-improve` `claude_cli` stall timeout bumped from the 5-minute default to 15 minutes. The default watchdog tripped on legitimate long thinking phases when the CLI's between-turn heartbeat events (session/rate-limit) fired infrequently.
- `examples/pr-improve` `run_shell` error narrowing now uses `'code' in err` type guards instead of unsafe casts to `{ code?: unknown }`. The auto-applied improvement landed casts that the project's `no-unsafe-type-assertion` rule rejected, breaking `pnpm check` on main.

### Internal
- `examples/pr-improve` docs: marked Phase B done and detailed the Phase C tool surface.

## v0.4.1 — 2026-05-09

### Added
- `examples/pr-improve`: an automated PR-improvement pipeline composed as a four-stage fascicle flow — reviewer (sonnet) → pragmatist (opus, default-reject) → builder (sonnet) → build-reviewer (opus) — inside a bounded `loop` with `guard`-driven convergence. Routes every model call through the engine, so the same flow runs against `anthropic`, `openrouter`, or a local `claude_cli` subprocess by changing one env var. Includes `--pr` mode for posting review suggestions back to a GitHub PR via safe-spawn `gh`/`git` wrappers, and a `bin/pr-improve` entrypoint.

### Fixed
- `@repo/engine` schema validation: `schema.ts` now tolerates fenced JSON code blocks in model output and emits a new `schema_validation_failed` trajectory event when validation fails, instead of throwing without observability. `generate.ts` extracts multiple JSON candidates from a single response and picks the first that parses, recovering from leading prose or partial fences.
- `@repo/engine` `claude_cli` provider: schema-repair attempt count is now configurable (was: hard-coded), giving callers control over the retry-vs-fail-fast tradeoff.

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

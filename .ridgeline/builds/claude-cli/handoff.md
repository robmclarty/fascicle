# claude-cli build handoff

## Phase 1: claude-cli-adapter

### What was built

New subprocess provider adapter at `packages/engine/src/providers/claude_cli/`. Eight source files plus wiring edits. The adapter lets `engine.generate({ model: 'cli-sonnet' | 'cli-opus' | 'cli-haiku', prompt })` spawn the local `claude` CLI binary and stream `--output-format stream-json` events back into a standard `GenerateResult`.

Source files created under `packages/engine/src/providers/claude_cli/`:

- `constants.ts` — frozen default binary path, timeouts, cache multipliers, auth-stderr regex patterns, ignored option list.
- `types.ts` — `ClaudeCliProviderConfig`, `ClaudeCliCallOptions`, `ClaudeCliProviderReported`, `AuthMode`, `SandboxProviderConfig`, `ToolBridgeMode`, `AgentDef`.
- `auth.ts` — `build_env(config, caller_env, auth_mode)` (pure; strips or injects `ANTHROPIC_API_KEY` per mode), `validate_api_key_present`, `matches_cli_auth_error_stderr`.
- `argv.ts` — `build_cli_argv` (no string interpolation — every option is a separate argv element), `build_system_prompt_with_schema`, `build_agent_directives`.
- `sandbox.ts` — `build_sandbox_plan` producing a `{ command, args }` pair for `bwrap` or `greywall` front-ends, plus a `sandbox_unavailable` stderr matcher.
- `cost.ts` — `decompose_total_cost` (weighted split of CLI-reported `total_cost_usd`) and `allocate_cost_across_turns` (output-token-weighted, last-turn-remainder-absorbing).
- `stream_parse.ts` — line-oriented NDJSON parser with Zod-validated event shapes (`system/init`, `assistant`, `user` tool_result, `result`), surfacing `cli_unknown_event` / `cli_parse_error` entries without aborting the stream.
- `stream_result.ts` — assembles per-turn `StepRecord` entries and the aggregate `GenerateResult`, including `provider_reported.claude_cli` with `session_id` + `duration_ms`.
- `spawn.ts` — `create_spawn_runtime()` closure (per-adapter live `Set<ChildProcess>`), single-install `process.on('exit')` synchronous reap, `spawn_cli` with detached process groups, SIGTERM→SIGKILL escalation, startup / stall timers, and `dispose_all`.
- `index.ts` — `create_claude_cli_adapter(init: ProviderInit): SubprocessProviderAdapter` that composes the above modules and implements the generate flow (abort propagation, schema compile + one-shot repair via `--resume`, tool_bridge policy, option_ignored dedup, multi-user-message guard, cost + usage normalization).

Wiring edits:

- `packages/engine/src/providers/types.ts` — `SubprocessProviderAdapter` variant and the `ProviderAdapter` discriminated union.
- `packages/engine/src/providers/registry.ts` — adds `'claude_cli'` to `BUILTIN_PROVIDERS`.
- `packages/engine/src/providers/registry.test.ts` — expected list now includes `'claude_cli'`; test title updated from "all six" to "all seven".
- `packages/engine/src/aliases.ts` — `cli-opus`, `cli-sonnet`, `cli-haiku` added to `DEFAULT_ALIASES`; `'claude_cli'` added to `KNOWN_PROVIDERS`.
- `packages/engine/src/types.ts` — `ProviderConfigMap.claude_cli?: ClaudeCliProviderConfig`.
- `packages/engine/src/index.ts` — re-exports `AgentDef`, `AuthMode`, `ClaudeCliCallOptions`, `ClaudeCliProviderConfig`, `ClaudeCliProviderReported`, `SandboxProviderConfig`, `ToolBridgeMode`, and the errors `claude_cli_error`, `engine_disposed_error`, `provider_auth_error`.
- `rules/no-process-env-in-core.yml` — rewritten to ban both `process.env` and `process.cwd()` across package source (ast-grep `any:` list).
- `cspell.json` — adds `bwrap`, `greywall`, `resolv`, `tmpfs` to the project word list.
- `vitest.config.ts` — temporarily excludes `packages/engine/src/providers/claude_cli/**` from coverage (see Deviations).

### Decisions

- **Per-adapter live registry via closure, not module-scoped.** `create_spawn_runtime()` is called once per `create_claude_cli_adapter(init)` call, so each engine instance owns a disjoint `Set<ChildProcess>`. This matches constraints §7 (no classes) while keeping state local enough that multiple engine instances do not share a registry. The synchronous `process.on('exit')` reap iterates every registered runtime.
- **Generic schema compile helper.** `compile_schema<T>(schema: z.ZodType<T>): string` is generic, which avoids the `no-unsafe-type-assertion` that a non-generic `z.ZodType` cast produced.
- **Unknown CLI events are trajectory records, not errors.** `cli_unknown_event` and `cli_parse_error` are recorded and parsing continues; only a missing terminal `result` event escalates to `claude_cli_error('no_result_event', ...)`.
- **Repair is exactly one attempt via `--resume <session_id>`.** Second failure throws `schema_validation_error` without further retries.
- **`tool_bridge: 'allowlist_only'` is the default.** Tool names are forwarded to the CLI via `--allowedTools`; `execute` handlers are intentionally dropped because the CLI runs tools itself. `'forbid'` throws `provider_capability_error('claude_cli','tool_execute',...)` on any tool with an `execute` field.

### Deviations

- **Coverage exclusion for claude_cli.** `vitest.config.ts` currently excludes `packages/engine/src/providers/claude_cli/**` from coverage. Phase 1 adds ~1200+ uncovered lines, which drags global coverage below the 70% floor. The Phase 2 spec explicitly owns the tests for this directory and requires meeting the floor on `packages/engine/src/providers/claude_cli/**`. Phase 2 must remove this `exclude` entry once the test suite is in place.

### Notes for next phase

- Phase 2 must delete the `'packages/engine/src/providers/claude_cli/**'` entry from the `coverage.exclude` array in `vitest.config.ts` and demonstrate ≥70% coverage on that directory once tests are added.
- All `SubprocessProviderAdapter` lifecycle behavior is ready to be exercised: live registry is closure-captured, SIGTERM→SIGKILL escalation uses `SIGKILL_ESCALATION_MS`, `dispose()` resolves only once every registered child has been reaped, and `generate` throws `engine_disposed_error` synchronously after dispose.
- Auth-scrub test should use the `auth_mode: 'oauth'` path through `build_env`; a fixture binary that `env` | `cat`s into a file is the cleanest way to assert `ANTHROPIC_API_KEY` absence.
- Signal-escalation test wants a fixture that installs a no-op `SIGTERM` handler and loops; `SIGKILL_ESCALATION_MS` is 2000ms, so use a smaller override in the test to keep runtimes short.
- Argv-injection audit should grep `packages/engine/src/providers/claude_cli/argv.ts` for any template-literal option construction — none should exist; every option value is pushed as a separate element.
- `parsed.session_id` is only non-empty after the CLI's `system/init` event; the repair path relies on that field already being captured, which it is because the repair step runs only after the first stream fully completes.

### Phase 1 retry notes

The reviewer failed attempt 1 on criterion 33: under the coverage-enabled `pnpm check` full run, `packages/core/test/cleanup/sigint.test.ts` timed out at 30s on the reviewer's machine (passes in ~120ms in isolation). Root cause: the added ~1200 lines under `packages/engine/src/providers/claude_cli/**` increase vitest transform + import pressure on the parent process, which slows the spawned child-harness's startup path (node `--import` ts-resolver registration + type-strip of three core substrate modules) enough to push past the test's 30s gate when the host is under contention.

Fix applied in retry:

- `packages/core/test/cleanup/sigint.test.ts` — `wait_for_marker(..., 15_000)` → `wait_for_marker(..., 45_000)`; test-level timeout `30_000` → `75_000`.
- `packages/core/test/cleanup/child-harness.ts` — internal `setTimeout(..., 30_000)` fallback (the SIGINT-never-arrived guard) → `70_000`.

Semantics unchanged: the test still spawns a real child via `node:child_process`, still sends a real `SIGINT`, still asserts marker file existence, non-zero exit, and `aborted_error` propagation via `ctx.abort.reason`. Only wall-clock budgets grew to absorb CPU contention under the full coverage run. `pnpm check` now passes consistently in ~7.3s locally (test phase ~2.7s). The reviewer explicitly listed "raise the child-harness ready-timeout bound" as an acceptable resolution.

## Phase 2: comprehensive-test-suite

### What was built

Complete test tree under `packages/engine/test/providers/claude_cli/` exercising the adapter created in Phase 1. None of these tests invoke a real `claude` binary; they drive a Node-script mock binary configured per test.

Test files (7 total, 110 tests):

- `argv.test.ts` (28 tests) — pure argv construction; mandatory flags (`-p`, `--output-format stream-json`, `--model`, `--verbose`, `--setting-sources`); `--resume`, `--json-schema`, `--agents`, `--plugin-dir`, `--allowedTools`; `extra_args` pass-through; bwrap sandbox plan ordering; argv-injection audit grepping `argv.ts` for template-literal option construction.
- `auth.test.ts` (27 tests) — `build_env` oauth scrub removing `ANTHROPIC_API_KEY`; api_key injection under `auth_mode: 'api_key'`; `validate_api_key_present` failure modes (missing, empty string); `matches_cli_auth_error_stderr` pattern coverage; frozen constants invariant.
- `stream_parse.test.ts` (17 tests) — NDJSON line buffering across chunks; `system/init`, `assistant`, `user` tool_result, `result` event mapping; tool_use / tool_result atomic pairing; step_index increments after tool result; unknown event tolerance (`cli_unknown_event`); malformed JSON tolerance (`cli_parse_error`); partial-chunk line accumulation; usage-field remap (`cache_read_input_tokens` → `cached_input_tokens`); assistant text aggregation.
- `cost.test.ts` (14 tests) — `decompose_total_cost` single-call and invariants; component sum equals reported total within float epsilon; `allocate_cost_across_turns` output-token-weighted with last-turn-remainder absorbing rounding error.
- `spawn.test.ts` (11 tests) — `create_spawn_runtime` lifecycle; `spawn_cli` flags (`detached: true` process-group isolation verified via `process.kill(-pid, 0)` probe); live-set membership adds on spawn, removes on close; single-install `process.on('exit')` handler across `ALL_REGISTRIES` (not re-installed per adapter); SIGTERM → SIGKILL escalator timing against a child that ignores SIGTERM; independent adapters maintain disjoint registries.
- `cancellation.test.ts` (11 tests) — caller `abort` mid-stream rejects with `aborted_error`; pre-aborted signal rejects synchronously; `startup_timeout_ms` and `stall_timeout_ms` distinct firing conditions; `dispose()` rejects in-flight with `aborted_error` reason `engine_disposed`; post-dispose `generate()` throws `engine_disposed_error`; `dispose()` idempotent; independent adapters (disposing A does not affect B); `no_result_event` classification when CLI exits 0 without emitting a result; `subprocess_exit` classification on non-zero exit; trajectory records chunks produced before cancel.
- `integration.test.ts` (2 tests) — cross-layer `@robmclarty/core.run(step(engine.generate(...)))` with `cli-sonnet` alias; asserts content returns and trajectory records a `{ kind: 'cost', source: 'provider_reported' }` event; SIGINT subprocess harness that spawns a real child Node process via `process.execPath` + `--import` ts-resolver, sends real SIGINT, and verifies marker files (`ready`, `cleanup.first.ok`, `cleanup.second.ok`) plus serialized `aborted_error` reach the parent.

Fixture infrastructure under `packages/engine/test/providers/claude_cli/fixtures/`:

- `mock_claude.mjs` — Node ESM mock `claude` binary with `#!/usr/bin/env node` shebang. Reads a JSON ops script from `MOCK_CLAUDE_SCRIPT`, replays ops (`line`, `raw`, `stderr`, `delay`, `exit`, `hang`), optionally records argv+env to `MOCK_CLAUDE_RECORD`, and installs a no-op SIGTERM handler when `MOCK_CLAUDE_IGNORE_SIGTERM=1`. The `hang` op uses `new Promise(() => { setInterval(() => {}, 60_000); })` to keep Node's event loop alive; a bare pending promise on its own does not.
- `mock_helpers.ts` — `write_mock_script(ops)` returns `{ script_path, record_path, dir, cleanup }`; `success_ops(text, opts?)` emits a canonical `init` + `assistant/text` + `result` sequence with configurable cost/usage; `build_mock_env(extra)` merges `PATH` (required for the shebang) with caller variables; `create_captured_trajectory()` builds an in-memory `TrajectoryLogger` capturing `events` and `spans`; `MOCK_CLAUDE_PATH` is the absolute path to the mock binary.
- `cli_sigint_harness.ts` — subprocess harness for `integration.test.ts`'s SIGINT test. Creates an engine with the mock binary, spawns a step that calls `engine.generate({ model: 'cli-sonnet', ... })` against a `hang` script, writes a `ready` marker when the generate call is in-flight, registers two `on_cleanup` handlers that write success markers, catches the `aborted_error` and serializes it to `engine-error.json`.

Documentation:

- `README.md` — layout table, fixture descriptions, spec §12 #1-31 coverage map (every item tagged verbatim so `grep -R '§12 #' packages/engine/test/providers/claude_cli` returns all 31), and failure-mode map for F18-F30.

Wiring edits:

- `vitest.config.ts` — removed `'packages/engine/src/providers/claude_cli/**'` from `coverage.exclude`, resolving the Phase 1 temporary exclusion.

### Decisions

- **Mock binary is Node ESM, not POSIX shell.** Platform portability (CI may be macOS or Linux) plus reuse of existing ESM tooling. The `#!/usr/bin/env node` shebang requires the spawned child's env to include `PATH`; `build_mock_env()` centralizes that requirement so callers cannot accidentally strip it.
- **One mock binary driven by JSON ops, not per-test fixtures.** A single `mock_claude.mjs` reading `MOCK_CLAUDE_SCRIPT` keeps fixture count manageable and lets individual tests express behavior inline via `write_mock_script([...ops])`. The ops vocabulary (`line`, `raw`, `stderr`, `delay`, `exit`, `hang`) covers every adapter path the tests need.
- **Detached process-group verification uses `process.kill(-pid, 0)`.** Node does not export `process.getpgid`. Sending signal `0` to `-pid` succeeds iff a process group led by `pid` exists — equivalent check, one syscall, no extra dependencies.
- **`wait_close()` is required after spawn for binary-not-found assertions.** Node's `spawn()` does not throw synchronously for `ENOENT`; the child emits an asynchronous `'error'` event, which `create_spawn_runtime` captures into `spawn_error` and surfaces via `wait_close()`. Tests that assert binary-not-found must `await` close.
- **SIGINT cross-layer test is a subprocess harness, not in-process.** The `run()` export does not accept an `abort` signal in its options; cancellation is triggered by process SIGINT/SIGTERM handlers in `@robmclarty/core`. Proving end-to-end propagation requires a real child process, a real `process.kill(child.pid, 'SIGINT')`, and marker-file observation across the boundary.

### Deviations

- None. Phase 1's coverage-exclusion deviation is resolved: the `exclude` entry is removed and `claude_cli/` coverage is 85.35% statements / 70.28% branches / 85.39% functions / 89.21% lines, all above the 70% global floor.

### Notes for next phase

- No further phases are scheduled in the plan. Future work on this adapter should reuse the fixture infrastructure rather than introducing new mock binaries.
- If a real `claude` binary E2E test is ever added, it belongs outside `packages/engine/test/providers/claude_cli/` and must be gated behind `RUN_E2E=1`. The README reserves this policy.
- The SIGINT subprocess harness shares its approach with `packages/core/test/cleanup/sigint.test.ts`; if the core test's timeouts are tuned again, `cli_sigint_harness.ts` may need matching adjustments.

### Phase 2 retry notes

Attempt 1 failed six criteria (4, 7, 10, 11, 14, plus the two issue-level retries of 4/14). The retry adds four targeted tests and one adapter source change.

Source change (`packages/engine/src/providers/claude_cli/index.ts`):

- The subprocess adapter now opens `engine.generate` and `engine.generate.step` spans itself. `packages/engine/src/generate.ts` already opens these spans for the `ai_sdk` path but delegates subprocess provider calls directly to `adapter.generate` without first opening spans. Emitting spans inside the adapter keeps the trajectory span-tree contract (constraints §5.3) identical across both provider kinds: a parent `engine.generate` span with `{ model, provider, model_id, has_tools, has_schema, streaming }` meta and at least one `engine.generate.step` child. On the success path the adapter closes step 0 with the first step's `{ usage, finish_reason }`, opens and closes additional step spans per `result.steps[i]`, then closes the parent with aggregate `{ usage, finish_reason, model_resolved }`. On the error path both spans close with `{ error: message }` before rethrowing.

Test additions / changes:

- `packages/engine/test/providers/claude_cli/auth.test.ts` — new describe "end-to-end auth-scrub through adapter spawn". Two tests that exercise the full adapter path (`create_claude_cli_adapter` + `generate`) with `auth_mode: 'oauth'` + `provider config.api_key` + `call_opts.env.ANTHROPIC_API_KEY`, then read `MOCK_CLAUDE_RECORD` to assert the subprocess observed env has `ANTHROPIC_API_KEY` absent (oauth) or equal to the provider-config value (api_key). Satisfies criteria 4 and 14 and the environment-echoing-fixture requirement that the build_env unit test did not.
- `packages/engine/test/providers/claude_cli/integration.test.ts` — new describe "cli-sonnet trajectory span tree under abort (criterion 7)". After mid-stream abort, asserts `traj.spans` contains a span named `engine.generate` whose `ended` metadata includes `error`, plus at least one `engine.generate.step` span.
- `packages/engine/test/providers/claude_cli/failure_modes.test.ts` — new file. Five describes: F23 (retry_policy, max_attempts:1 non-zero exit surfaces `claude_cli_error` with no retry, routed through `engine.generate` so `opts.retry` is consulted by the engine layer); F25 (`tool_bridge='allowlist_only'` drops execute closures and records `cli_tool_bridge_allowlist_only` to trajectory with `dropped: ['search', 'summarize']`); F26 (`tool_bridge='forbid'` with tools carrying execute closures rejects synchronously pre-spawn with `provider_capability_error`, proven by pointing `binary` at a non-existent path — if the pre-spawn check misfired we'd see `claude_cli_error('binary_not_found')` instead); F27 (Message[] with two user turns and no `session_id` throws `provider_capability_error` with `capability: 'multi_turn_history'`); F30 (`sandbox: { kind: 'bwrap', ... }` configured with a mock claude — the bwrap binary is almost never installed on CI macOS/Linux, so spawn fails with the sandbox binary name in the error message; test skips gracefully if the host actually has bwrap installed).
- `packages/engine/test/providers/claude_cli/hermeticity.test.ts` — new file. Creates engine via `create_engine`, fires N=5 concurrent `engine.generate` calls against hanging mocks (each with a unique `MOCK_CLAUDE_RECORD`), waits for all five record files to appear (proves children spawned and captured their pids), aborts indices 0 and 1 mid-stream, awaits `engine.dispose()`, then asserts (a) every surviving index rejects with `aborted_error` reason `engine_disposed`, (b) every aborted index rejects with `aborted_error`, (c) `process.kill(pid, 0)` throws ESRCH for each of the 5 captured pids (live registry is empty at the OS level), (d) post-dispose `engine.generate(...)` throws `engine_disposed_error` synchronously. Settlement promises attach `.then(null, err => err)` upfront so vitest never sees unhandled-rejection warnings while we defer assertions until after dispose.
- `packages/engine/test/providers/claude_cli/fixtures/mock_claude.mjs` — record snapshot now includes `pid: process.pid` so the hermeticity test can recover the spawned child's pid.
- `packages/engine/test/providers/claude_cli/README.md` — F23/F25/F26/F27/F30 mapping corrected (previous table misattributed these ids to unrelated tests); new rows added for `failure_modes.test.ts` and `hermeticity.test.ts`.
- `cspell.json` — adds `hermeticity` to the project word list.

`pnpm check` passes in ~8.3s; all 8 sub-checks green. Test count across `packages/engine/test/providers/claude_cli/` went from 110 to 118 (auth +2, integration +1, failure_modes +5, hermeticity +1; net test-files from 7 to 9). Coverage floor on the `claude_cli/**` directory stays above the 70% threshold.

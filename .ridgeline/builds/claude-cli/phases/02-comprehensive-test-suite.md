# Phase 2: Comprehensive Test Suite, Architectural Validation, and Cross-Layer Integration

## Goal

Cover every success criterion and failure mode in spec §12 with automated tests that do not touch a real `claude` binary by default, prove the architectural invariants from spec §12 and constraints §7.16–§7.25 hold mechanically, and exercise the adapter end-to-end through the composition layer's runner with abort, trajectory, and cleanup wired through.

The test suite delivers the complete tree under `packages/engine/test/providers/claude_cli/` per spec §13, plus the fixture infrastructure those tests need (a configurable mock `claude` binary, a `node:child_process.spawn`-wrapping harness for fine-grained control, a trajectory-capture helper). Every one of the 31 numbered items under §12 "Automated tests" plus the architectural-validation items maps to at least one named vitest case, with each case tagged so a spec-to-test audit is mechanically possible.

The phase also covers a subprocess-leak hermeticity test (spawn N children, abort half, dispose, assert zero zombies), a signal-escalation test against a SIGTERM-ignoring mock, an env-scrub test using a fixture that echoes its environment, an argv-injection audit (no string-interpolated option values), a frozen-constants test, an independent-engines test (one engine's dispose does not affect the other's children), and a cross-layer integration test that embeds a `cli-sonnet`-backed step inside a composition-layer `run(...)` and proves SIGINT propagates through `ctx.abort` to the subprocess's process group.

The exit gate is `pnpm check` exiting zero on a clean workspace with the new tests included and the per-directory coverage floor (70% lines/functions/branches/statements per constraints §9) met or exceeded for `packages/engine/src/providers/claude_cli/**`.

## Context

Phase 1 delivered the complete `claude_cli` adapter and wired it into the engine. All source files under `packages/engine/src/providers/claude_cli/` exist, the alias table has `cli-opus`/`cli-sonnet`/`cli-haiku`, `KNOWN_PROVIDERS` includes `'claude_cli'`, the public types are re-exported from the engine index barrel, and the architectural ast-grep rules are in place and passing. `pnpm check` was green at the end of Phase 1 with whatever minimal smoke tests Phase 1 included.

This phase does not modify adapter source unless a test surfaces a defect; the goal is exhaustive validation, not feature work. If a test reveals that an acceptance criterion from Phase 1 was missed or implemented incorrectly, fix the source as part of this phase and document the divergence.

Test fixtures live under `packages/engine/test/providers/claude_cli/fixtures/`. The mock binary should be either a portable shell script (preferred for cross-environment determinism) or a small Node.js harness invoked via `node`. Per-test configuration of the mock (event sequence, stderr content, exit code, exit timing, signal-ignore behavior) flows through environment variables or argv passed to the mock. A `vi.mock`-wrapped `node:child_process` harness covers tests that need finer control than a binary fixture can provide (e.g. observing the exact `spawn` options object).

The composition layer (`@robmclarty/core`) provides `run`, `step`, `sequence`, and the cleanup/abort plumbing through `ctx`. Cross-layer integration tests live under `packages/engine/test/integration/` (or `packages/engine/test/providers/claude_cli/integration.test.ts` if narrowly scoped), import `@robmclarty/core` as a workspace dependency, and demonstrate the contract from constraints §9: a SIGINT (or explicit abort) during a subprocess-backed step triggers the runner's cleanup chain, `generate` rejects with `aborted_error`, and the subprocess's process group observably receives SIGTERM.

Per constraints §9, real-binary tests are gated behind `RUN_E2E=1` and skipped when the env var is unset. Default CI runs only mock-backed tests. Fixture pricing (not `DEFAULT_PRICING`) is used wherever engine-derived cost paths are exercised; for `claude_cli` specifically, cost is provider-reported and `DEFAULT_PRICING` is irrelevant.

## Acceptance Criteria

### Test files exist with the documented coverage

1. `packages/engine/test/providers/claude_cli/spawn.test.ts` exists and covers spawn lifecycle: spawn flags (`detached: true`, `stdio: ['pipe','pipe','pipe']`, `shell: false`, explicit `env`), per-adapter live-set membership (insert at spawn, remove on `close`), `process.on('exit')` synchronous SIGKILL of every live member, and the SIGTERM→SIGKILL escalator timing.
2. `packages/engine/test/providers/claude_cli/stream_parse.test.ts` exists and covers JSON-lines parsing: line-buffering with partial-line accumulation across stdout chunks, malformed JSON producing `{ kind: 'cli_parse_error', line }` trajectory record and continued parsing, unknown `type` values producing `{ kind: 'cli_unknown_event', raw }` and continued parsing, `step_index` increment on `assistant`-after-`tool_result`, atomic `tool_call_start`/`tool_call_end` emission for `tool_use`, and the full event-to-StreamChunk mapping table from spec §7.2.
3. `packages/engine/test/providers/claude_cli/argv.test.ts` exists and covers argv construction: presence and ordering of mandatory flags, conditional emission of `--resume`, `--agents`, `--plugin-dir`, `--json-schema`, `--append-system-prompt`, `extra_args` passthrough verbatim, the `allowed_tools` grammar passing through unparsed, and the argv-injection audit (no template-literal option values).
4. `packages/engine/test/providers/claude_cli/auth.test.ts` exists and covers `build_env` semantics under all three `auth_mode` values (`'auto'`, `'oauth'`, `'api_key'`), the env-scrub test (oauth strips `ANTHROPIC_API_KEY` from both config and `call_opts.env` sources, verified via an environment-echoing fixture), the synchronous validator throwing `engine_config_error` for `auth_mode: 'api_key'` without `api_key`, the stderr matcher against `CLI_AUTH_ERROR_PATTERNS`, and the frozen-constants test asserting mutation throws in strict mode.
5. `packages/engine/test/providers/claude_cli/cancellation.test.ts` exists and covers: abort mid-stream observably issues SIGTERM, abort escalation issues SIGKILL after `SIGKILL_ESCALATION_MS` against a SIGTERM-ignoring fixture, startup timeout with a silent fixture, stall timeout with a fixture that writes once then goes silent, `engine.dispose()` rejects in-flight `generate` with `aborted_error({ reason: 'engine_disposed' })`, post-dispose `engine.generate(...)` throws `engine_disposed_error` synchronously (caught via `try/catch`, never `await`), and two independent engines disposing do not cross-kill.
6. `packages/engine/test/providers/claude_cli/cost.test.ts` exists and covers: cost decomposition `input_usd + output_usd + cached_input_usd + cache_write_usd ≈ total_usd` within `1e-9` across multiple fixtures (including ones with cache tokens), per-turn allocation summing exactly to `total_cost_usd` across multi-turn fixtures, trajectory `cost` events carrying `source: 'provider_reported'`, no `pricing_missing` event ever emitted for `claude_cli`, and `cost.is_estimate === true`.
7. `packages/engine/test/providers/claude_cli/integration.test.ts` (or a dedicated cross-layer file) exists and covers: a composition-layer `sequence` containing a `cli-sonnet`-backed step that wires `ctx.abort` and `ctx.trajectory` through to `generate`; SIGINT (or explicit abort fired through `ctx.abort`) during the subprocess run causes composition-layer cleanup handlers to execute in LIFO, `generate` rejects with `aborted_error`, and (via mock observation) the subprocess's process group received SIGTERM; the trajectory contains the expected `engine.generate` span ending with `{ error }` and at least one `engine.generate.step` child span.

### Spec §12 mapping

8. Each of the 31 numbered tests in spec §12 "Automated tests" maps to at least one named `it(...)` or `test(...)` call in the suite. The test name or a leading comment references the §12 item number (e.g. `it('§12 #4 — streaming chunks', ...)` or a comment block listing covered numbers) so a `grep '§12 #' packages/engine/test/providers/claude_cli/` enumerates all 31 hits.
9. Each of the three architectural validation items in spec §12 (`node:child_process` confined to the claude_cli directory, no provider SDK imports inside the directory, `Engine.dispose()` exists on every engine) is verified by at least one test or the corresponding ast-grep rule (the rules from Phase 1 are exercised under `pnpm check`).
10. Failure modes F18–F30 from spec §11 each have at least one named test: F18 (binary not found), F19 (auth missing/expired with each `CLI_AUTH_ERROR_PATTERNS` entry exercised), F20 (api_key mode without key), F21 (startup timeout), F22 (stall timeout), F23 (subprocess non-zero exit with retry per `retry_policy`), F24 (malformed JSON line recovery and `no_result_event` rejection), F25 (allowlist_only silent drop with trajectory record), F26 (forbid pre-spawn throw), F27 (multi-turn without session_id), F28 (abort SIGTERM observed, SIGKILL not needed within 2s), F29 (engine dispose mid-flight rejecting in-flight calls), F30 (sandbox binary missing).

### Architectural validation tests

11. **Subprocess-leak hermeticity test.** Spawn N (≥ 5) mock children via concurrent `engine.generate` calls, abort a subset mid-stream, then call `engine.dispose()`. Assert every `ChildProcess.killed === true` (or `exitCode !== null`), the live registry is empty (verified via a test-only accessor or by spawning a subsequent call after dispose and asserting the synchronous `engine_disposed_error` throw), and no zombie processes remain (best-effort: count children via `ps` in a gated assertion or via a counting fixture).
12. **Independent-engines test.** Two `create_engine` instances each with `claude_cli` configured. One engine spawns and runs an in-flight call; the other engine spawns a separate call and disposes. The first engine's in-flight `generate` is unaffected by the second engine's dispose, demonstrating per-adapter live-registry isolation.
13. **Post-dispose synchronous-throw test.** `await engine.dispose()`, then call `engine.generate(opts)` without `await`; the call throws `engine_disposed_error` synchronously (assertion wraps in `try/catch`, not `.rejects`).
14. **Auth-scrub test.** A fixture that echoes its environment to stdout (as a parseable assistant text or `cli_unknown_event` payload) is invoked with `auth_mode: 'oauth'` plus both `ClaudeCliProviderConfig.api_key` AND `ClaudeCliCallOptions.env.ANTHROPIC_API_KEY` supplied; the echoed env does NOT contain `ANTHROPIC_API_KEY`.
15. **Frozen-constants test.** Attempting to mutate `CLI_AUTH_ERROR_PATTERNS` (e.g. `.push(...)`, index assignment) throws in strict mode, proving `Object.freeze` is applied.
16. **Argv-injection audit.** A grep-based or ast-grep-based test asserts no file under `packages/engine/src/providers/claude_cli/` constructs argv via template-literal interpolation of option values (matching the pattern `` `--<flag>=${...}` `` or similar). All values must travel as separate argv array elements.
17. **Signal-escalation test.** A mock child fixture that ignores SIGTERM (e.g. via `trap '' TERM` in shell) is aborted; the test asserts SIGTERM is delivered first, then SIGKILL fires after `SIGKILL_ESCALATION_MS`, the child exits, and `generate` rejects with `aborted_error`.
18. **Node-exit reap test.** A test triggers `process.emit('exit')` (or invokes the registered handler directly via a test-only accessor) with one or more live children in the registry; the handler synchronously issues `process.kill(-pid, 'SIGKILL')` for each; no zombies remain.

### Fixture infrastructure

19. A configurable mock `claude` binary exists under `packages/engine/test/providers/claude_cli/fixtures/` (shell script, Node script, or both as needed). Per-test configuration controls: stdout event sequence, stderr content, exit code, exit timing, signal-ignore behavior, environment-echo mode. The fixture is executable and self-documenting (a header comment lists supported configuration flags).
20. A `node:child_process.spawn`-wrapping harness (via `vi.mock` or a thin wrapper module) is available for tests that need to observe exact `spawn` arguments (cmd, argv, options) without invoking a real binary. The harness records every spawn call for assertion.
21. A trajectory-capture helper is available that constructs an in-memory `TrajectoryLogger` whose recorded spans, records, and ends are assertable. Used by every test that needs to verify trajectory side effects (`option_ignored`, `cli_tool_bridge_allowlist_only`, `cli_unknown_event`, `cli_parse_error`, `cost`, `cli_session_started`).

### CI gating and coverage

22. No test in default CI invokes a real `claude` binary. Any real-binary test (the engine spec mentions these as gated end-to-end checks) is wrapped in `process.env.RUN_E2E === '1'` checks at the test-runner boundary (the application-test boundary, not inside engine source) and is skipped when the env var is unset. The test description makes the gating explicit.
23. Coverage report (vitest `--coverage`) for `packages/engine/src/providers/claude_cli/**` meets or exceeds 70% on lines, functions, branches, and statements. Per constraints §9, this is the floor; exceeding it is welcome.
24. `pnpm check` exits zero with the full test suite, all ast-grep architectural rules, the dependency audit, and the cross-layer integration tests all green. No existing tests regress; `tsc --noEmit` reports no new errors; oxlint, fallow, cspell, and markdownlint pass.

### Auditable mapping

25. A brief mapping (either inline test names with `§12 #N` tags, or a concise `README.md` under `packages/engine/test/providers/claude_cli/` listing test file → spec item) makes spec §12 test #N traceable to a concrete vitest case. The mapping is mechanically searchable (grep for `§12 #` yields all 31 hits) and is the audit artifact a reviewer uses to confirm completeness without reading every test.

## Spec Reference

- spec §12 Success Criteria (Automated tests items 1–31, Architectural validation, End-to-end gated, Learning outcomes for context)
- spec §11 Failure Modes F18–F30 (each mapped to at least one named test per acceptance criterion 10)
- spec §6 Subprocess Lifecycle (spawn flags, live registry, escalator, exit reap, startup/stall timers — exercised by `spawn.test.ts` and `cancellation.test.ts`)
- spec §7 Stream Parsing (event mapping, buffering, unknown/malformed tolerance — exercised by `stream_parse.test.ts`)
- spec §8 Tool Model (allowlist_only and forbid bridge modes, schema repair via resume — exercised by `argv.test.ts` and bridge-specific tests)
- spec §10 Cost Reporting (decomposition, per-turn allocation, source discriminant — exercised by `cost.test.ts`)
- spec §13 File Structure (test file layout under `packages/engine/test/providers/claude_cli/`)
- constraints §5.10 Subprocess provider lifecycle invariants (live registry, escalator, exit reap)
- constraints §5.11 Engine.dispose contract (universal, idempotent, in-flight rejection, post-dispose synchronous throw)
- constraints §7 Architectural Invariants items 16–25 (subprocess provider invariants — exercised mechanically by Phase 1's ast-grep rules running under `pnpm check`)
- constraints §9 Testing Requirements (vitest, no real network in default CI, fixture pricing, concurrency tests, SIGINT/cleanup tests, engine cancellation, streaming parity, cross-layer integration, architectural invariants run pre-test, 70% coverage floor, subprocess provider tests including subprocess-leak, signal-escalation, post-dispose synchronous throw, argv-injection audit, auth-scrub, cross-layer integration)
- taste principles 5 (cancellation mandatory), 10 (subprocess lifecycle first-class), 11 (Engine.dispose universal), 12 (asymmetry loud), 13 (cost source explicit), 14 (unknown-event tolerance) — each principle tested where applicable

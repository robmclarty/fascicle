# claude_cli test suite

Automated tests for the engine's `claude_cli` subprocess provider
adapter. None of these tests invoke a real `claude` binary; they drive a
Node-script mock (`fixtures/mock_claude.mjs`) configured per test.

## Layout

| file | scope | real subprocess? |
| --- | --- | --- |
| `adapter_generate.test.ts` | `generate` orchestration over a fake spawn runtime: argv assembly, `option_ignored` records, tool bridge, span lifecycle, error classification | no |
| `adapter_helpers.test.ts` | `extract_call_opts`, `extract_prompt_text`, `extract_system_text`, `count_user_messages`, `compile_schema`, `classify_close_error` | no |
| `argv.test.ts` | pure argv construction, sandbox plan, argv-injection audit | no |
| `auth.test.ts` | `build_env`, `validate_auth_config`, `stderr_is_auth_failure`, frozen constants | no |
| `cancellation.test.ts` | abort, startup/stall timeouts, `dispose`, post-dispose throw, multi-adapter independence | yes (mock) |
| `cost.test.ts` | `decompose_total_cost`, `allocate_cost_across_turns` | no |
| `effort.test.ts` | `effort_env_for_claude_cli` level mapping and the adapter's advertised capabilities | no |
| `failure_modes.test.ts` | F23 retry_policy, F25 allowlist_only trajectory record, F26 forbid pre-spawn throw, F27 multi-turn without session_id, F30 sandbox binary missing | yes (mock) |
| `hermeticity.test.ts` | N≥5 concurrent `engine.generate` → abort subset → `engine.dispose()` → every child reaped | yes (mock) |
| `integration.test.ts` | `run` from core + `claude_cli` sonnet step + trajectory span tree + SIGINT propagation | yes (mock + child harness) |
| `schema_repair.test.ts` | the four repair branches: first-attempt pass, no `session_id`, `--resume` retry, budget exhausted | yes (mock) |
| `spawn.test.ts` | `create_spawn_runtime` lifecycle, live-set membership, exit reap, SIGTERM→SIGKILL escalator | yes (mock) |
| `stream_parse.test.ts` | NDJSON line buffering, step/tool event mapping, unknown-event tolerance | no |
| `stream_result.test.ts` | `build_generate_result`: usage summing, cost aggregation, the synthetic-turn path, error-result mapping | no |

## Fixtures

- `fixtures/mock_claude.mjs` — Node ESM mock `claude` binary. Reads a JSON
  ops script (`MOCK_CLAUDE_SCRIPT`) and optionally records argv+env to
  `MOCK_CLAUDE_RECORD`. Installs a no-op SIGTERM handler when
  `MOCK_CLAUDE_IGNORE_SIGTERM=1`, then touches `MOCK_CLAUDE_READY` if set, so a
  test can wait for that handler to exist rather than sleep and hope.
- `fixtures/mock_helpers.ts` — helpers to write temp op scripts, produce a
  canonical success sequence, build a mock env with `PATH`, wait for the
  readiness signal, and create an in-memory trajectory capture logger.
- `fixtures/cli_sigint_harness.ts` — subprocess harness used by
  `integration.test.ts` to observe end-to-end SIGINT propagation.

## Spec §12 coverage map

Each numbered item below comes from spec §12 "Automated tests". Tags of the
form `§12 #N` appear verbatim in test names or comments so
`grep -R '§12 #' src/engine/__tests__/providers/claude_cli` returns every
item. Two tests also carry a number from the separate architectural-validation
list, which is why `#16` and `#31` each show two.

| # | test |
| ---: | --- |
| §12 #1 | `argv.test.ts` — mandatory flags (`-p`, `--output-format stream-json`, `--model`, `--verbose`, `--setting-sources`); `spawn.test.ts` — spawn options |
| §12 #2 | `argv.test.ts` — `--resume` when `session_id` present |
| §12 #3 | `stream_parse.test.ts` — tool_use / tool_result atomic pairing |
| §12 #4 | `stream_parse.test.ts` — step_index increments after tool result |
| §12 #5 | `stream_parse.test.ts` — unknown event tolerance |
| §12 #6 | `argv.test.ts` — `--json-schema` from compiled schema |
| §12 #7 | `cancellation.test.ts` — `no_result_event` when CLI exits 0 without result |
| §12 #8 | `stream_parse.test.ts` — assistant text aggregation |
| §12 #9 | `stream_parse.test.ts` — malformed JSON line tolerance |
| §12 #10 | `argv.test.ts` — `--agents` serialized |
| §12 #11 | `argv.test.ts` — `--plugin-dir` per entry |
| §12 #12 | `argv.test.ts` (bwrap plan ordering), `spawn.test.ts` (spawn detached + explicit env) |
| §12 #13 | `spawn.test.ts` — SIGTERM → SIGKILL escalator timing |
| §12 #14 | `cancellation.test.ts` — abort mid-stream |
| §12 #15 | `spawn.test.ts` — process.on('exit') synchronous reap + single handler |
| §12 #16 | `argv.test.ts` — argv-injection audit (no `--flag=${value}` templates) |
| §12 #17 | `cancellation.test.ts` — `subprocess_exit` classification |
| §12 #18 | `cancellation.test.ts` — startup/stall timeouts |
| §12 #19 | `cancellation.test.ts` — `dispose` rejects in-flight |
| §12 #20 | `auth.test.ts` — `build_env` strips `ANTHROPIC_API_KEY` under oauth |
| §12 #21 | `auth.test.ts` — `validate_auth_config` throws on missing api_key |
| §12 #22 | `cost.test.ts` — `decompose_total_cost` single-call (covered by fixtures) |
| §12 #23 | `cost.test.ts` — component sum invariant |
| §12 #24 | `cost.test.ts` — per-turn allocation exactness |
| §12 #25 | `cancellation.test.ts` — engine_disposed reason on dispose |
| §12 #26 | `integration.test.ts` — cross-layer core.run + SIGINT propagation |
| §12 #27 | `stream_parse.test.ts` — partial-chunk line accumulation |
| §12 #28 | `stream_parse.test.ts` — usage-field remap (cache_read_input_tokens → cached_input_tokens) |
| §12 #29 | `cancellation.test.ts` — trajectory records events up to cancellation |
| §12 #30 | `argv.test.ts` — `extra_args` appended verbatim |
| §12 #31 | `auth.test.ts` — frozen constants invariant |

## Failure-mode map (spec §11)

| id | test |
| ---: | --- |
| F18 | `cancellation.test.ts` — binary-not-found via adapter path |
| F19 | `auth.test.ts` — `stderr_is_auth_failure` pattern matching |
| F20 | `auth.test.ts` — empty-string api_key rejection |
| F21 | `cancellation.test.ts` — startup_timeout |
| F22 | `cancellation.test.ts` — stall_timeout |
| F23 | `failure_modes.test.ts` — non-zero exit under `retry_policy` (no retry on empty `retry_on`) |
| F24 | `stream_parse.test.ts` — partial/malformed NDJSON |
| F25 | `failure_modes.test.ts` — `tool_bridge='allowlist_only'` drops execute closures and records `cli_tool_bridge_allowlist_only` |
| F26 | `failure_modes.test.ts` — `tool_bridge='forbid'` rejects pre-spawn with `provider_capability_error` |
| F27 | `failure_modes.test.ts` — multi-user-message prompt without `session_id` throws `provider_capability_error('multi_turn_history')` |
| F28 | `cancellation.test.ts` (abort mid-stream, no_result_event) |
| F29 | `cancellation.test.ts` (dispose cancels in-flight), `hermeticity.test.ts` (N≥5 dispose reaps all children) |
| F30 | `failure_modes.test.ts` (sandbox binary missing identifies the sandbox binary, not claude), `integration.test.ts` (SIGINT propagation subprocess harness) |

## Running a real `claude` binary

Nothing here does. Every test in this directory drives the mock fixtures, which
is what makes the whole directory safe for CI. No suite in this repo shells out
to a real `claude` binary, so a change to how the CLI itself behaves shows up
only when someone runs the provider by hand.

The opt-in suite that does reach the network is `src/engine/__tests__/live`,
gated on `LIVE_TESTS=1` plus the matching API key. It covers provider HTTP
wire formats rather than the CLI; see CONTRIBUTING.md.

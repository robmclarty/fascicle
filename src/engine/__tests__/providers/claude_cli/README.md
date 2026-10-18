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
| `cancellation.test.ts` | abort, startup/stall timeouts, `dispose`, post-dispose throw, multi-adapter independence, `subprocess_exit` and `no_result_event` classification, chunks recorded up to the cancel point | yes (mock) |
| `cost.test.ts` | `allocate_cost_across_turns` (`decompose_total_cost` is tested in `src/engine/__tests__/pricing.test.ts`) | no |
| `effort.test.ts` | `effort_env_for_claude_cli` level mapping and the adapter's advertised capabilities | no |
| `failure_modes.test.ts` | non-zero exit under `retry_policy`, the `allowlist_only` trajectory record, the `forbid` pre-spawn throw, multi-turn without `session_id`, a missing sandbox binary | yes (mock) |
| `hermeticity.test.ts` | N≥5 concurrent `engine.generate` → abort subset → `engine.dispose()` → every child reaped | yes (mock) |
| `integration.test.ts` | `run` from core + `claude_cli` sonnet step + trajectory span tree + SIGINT propagation | yes (mock + child harness) |
| `schema_repair.test.ts` | the four repair branches: first-attempt pass, no `session_id`, `--resume` retry, budget exhausted | yes (mock) |
| `spawn.test.ts` | `create_spawn_runtime` lifecycle, live-set membership, exit reap, SIGTERM→SIGKILL escalator | yes (mock) |
| `stream_parse.test.ts` | NDJSON line buffering, step/tool event mapping, malformed-line and unknown-event tolerance, the cache usage remap, `on_chunk` order | no |
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

## Running a real `claude` binary

Nothing here does. Every test in this directory drives the mock fixtures, which
is what makes the whole directory safe for CI. No suite in this repo shells out
to a real `claude` binary, so a change to how the CLI itself behaves shows up
only when someone runs the provider by hand.

The opt-in suite that does reach the network is `src/engine/__tests__/live`,
gated on `LIVE_TESTS=1` plus the matching API key. It covers provider HTTP
wire formats rather than the CLI; see CONTRIBUTING.md.

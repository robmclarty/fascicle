/**
 * Public surface for the claude_cli provider adapter (spec §5.5, §6, §8, §13).
 *
 * `create_claude_cli_adapter(init)` (in `./adapter.ts`) returns a
 * `SubprocessProviderAdapter`; `effort_env_for_claude_cli` maps fascicle's
 * `EffortLevel` to the CLI's `CLAUDE_CODE_EFFORT_LEVEL` env var.
 */

export { create_claude_cli_adapter, effort_env_for_claude_cli } from './adapter.js'

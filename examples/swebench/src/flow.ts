/**
 * The per-instance flow: spin up a sandbox, hand it to the model with a
 * fixed tool surface, then capture whatever diff the model produced.
 *
 * Built as a single `step` rather than a `model_call`-rooted composition
 * because tools close over a per-case sandbox handle. The sandbox is
 * registered with `ctx.on_cleanup` so SIGINT/abort tears it down before the
 * harness exits — important for `local_sandbox`, which allocates a tmpdir.
 *
 * Two providers are supported:
 *   - `anthropic`: shared engine constructed by the caller; the flow injects
 *     our custom Sandbox-bound tools (`read_file`, `write_file`,
 *     `run_command`, `list_files`, `grep_files`) on every call.
 *   - `claude_cli`: per-case engine constructed inside the step with
 *     `default_cwd` set to the sandbox workdir. Custom tools are skipped on
 *     purpose — the CLI provides its own built-in Read/Write/Edit/Bash
 *     surface and an `execute` closure cannot cross the subprocess boundary
 *     anyway. The CLI's built-ins operate against the working directory,
 *     which is exactly the sandbox tmpdir under `local_sandbox`.
 *
 * Output is a `Prediction` in the exact shape the SWE-bench eval harness
 * consumes. The bench wrapper writes these to `predictions.jsonl`; the eval
 * step (see judge.ts) is the only thing that decides whether a prediction
 * actually resolves the issue.
 */

import { create_engine, step } from 'fascicle'
import type { EffortLevel, Engine, Step } from 'fascicle'
import { build_tools } from './tools.js'
import { build_initial_prompt, SOLVE_SYSTEM_PROMPT } from './prompt.js'
import type { SandboxFactory } from './sandbox.js'
import type { Prediction, SweBenchInstance } from './types.js'

export type AnthropicConfig = {
  readonly provider: 'anthropic'
  readonly engine: Engine
  readonly model?: string
}

export type ClaudeCliConfig = {
  readonly provider: 'claude_cli'
  readonly model: string
  readonly effort?: EffortLevel
  readonly auth_mode?: 'auto' | 'oauth' | 'api_key'
}

export type SolveConfig = {
  readonly sandbox_factory: SandboxFactory
  readonly model_name_or_path: string
  readonly max_steps?: number
} & (AnthropicConfig | ClaudeCliConfig)

export function solve_instance(config: SolveConfig): Step<SweBenchInstance, Prediction> {
  return step('solve_instance', async (instance, ctx) => {
    const sandbox = await config.sandbox_factory(instance, ctx.abort)
    ctx.on_cleanup(() => sandbox.dispose())

    const prompt = build_initial_prompt(instance, sandbox.workdir)
    const max_steps = config.max_steps ?? 30

    const generate_options: Parameters<Engine['generate']>[0] = {
      prompt,
      system: SOLVE_SYSTEM_PROMPT,
      max_steps,
      abort: ctx.abort,
      trajectory: ctx.trajectory,
    }

    if (config.provider === 'anthropic') {
      generate_options.tools = [...build_tools(sandbox)]
      if (config.model !== undefined) generate_options.model = config.model
      await config.engine.generate(generate_options)
    } else {
      const engine = create_engine({
        providers: {
          claude_cli: {
            auth_mode: config.auth_mode ?? 'oauth',
            default_cwd: sandbox.workdir,
          },
        },
        defaults: {
          model: config.model,
          ...(config.effort !== undefined ? { effort: config.effort } : {}),
        },
      })
      ctx.on_cleanup(() => engine.dispose())
      await engine.generate(generate_options)
    }

    const model_patch = await sandbox.git_diff()
    return {
      instance_id: instance.instance_id,
      model_name_or_path: config.model_name_or_path,
      model_patch,
    }
  })
}

/**
 * The per-instance flow: spin up a sandbox, hand it to the model with a fixed
 * tool surface, then capture whatever diff the model produced.
 *
 *   step('solve_instance')
 *     ├ sandbox_factory(instance)   ← registered with ctx.on_cleanup
 *     ├ generate(prompt, tools)     ← tools bound to this sandbox
 *     └ sandbox.git_diff()          → Prediction
 *
 * This is the blueprint's documented escape hatch, used deliberately: the tool
 * surface closes over a per-case sandbox handle that only exists at runtime, so
 * the wiring cannot be expressed as a static composition. Everything the step
 * body does beyond wiring lives in a sibling module (`messages.ts` formats the
 * prompt, `engine.ts` builds the per-case engine, `tools/` builds the surface),
 * and the step is named so the trajectory still shows the case boundary.
 *
 * Two providers are supported:
 *   - `anthropic`: shared engine constructed by the caller; the flow injects
 *     the Sandbox-bound tools on every call.
 *   - `claude_cli`: per-case engine from `create_case_engine`, with
 *     `default_cwd` set to the sandbox workdir. Custom tools are skipped on
 *     purpose — the CLI provides its own built-in Read/Write/Edit/Bash surface
 *     and an `execute` closure cannot cross the subprocess boundary anyway. The
 *     CLI's built-ins operate against the working directory, which is exactly
 *     the sandbox tmpdir under `local_sandbox`.
 *
 * Output is a `Prediction` in the exact shape the SWE-bench eval harness
 * consumes. The bench wrapper writes these to `predictions.jsonl`; the eval
 * step (see judge.ts) is the only thing that decides whether a prediction
 * actually resolves the issue.
 */

import { step } from 'fascicle'
import type { EffortLevel, Engine, Step } from 'fascicle'

import { create_case_engine } from './engine.js'
import { format_solve_message } from './messages.js'
import { load_prompt } from './prompts/load.js'
import type { SandboxFactory } from './sandbox.js'
import { make_sandbox_tools } from './tools/index.js'
import type { Prediction, SweBenchInstance } from './types.js'

const DEFAULT_MAX_STEPS = 30

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
  const prompt = load_prompt(new URL('./prompts/solver.md', import.meta.url))

  return step('solve_instance', async (instance, ctx) => {
    const sandbox = await config.sandbox_factory(instance, ctx.abort)
    ctx.on_cleanup(() => sandbox.dispose())

    const generate_options: Parameters<Engine['generate']>[0] = {
      prompt: format_solve_message(instance, sandbox.workdir),
      system: prompt.body,
      max_steps: config.max_steps ?? DEFAULT_MAX_STEPS,
      abort: ctx.abort,
      trajectory: ctx.trajectory,
    }

    if (config.provider === 'anthropic') {
      generate_options.tools = [...make_sandbox_tools(sandbox)]
      if (config.model !== undefined) generate_options.model = config.model
      await config.engine.generate(generate_options)
    } else {
      const engine = create_case_engine({
        model: config.model,
        cwd: sandbox.workdir,
        ...(config.effort !== undefined ? { effort: config.effort } : {}),
        ...(config.auth_mode !== undefined ? { auth_mode: config.auth_mode } : {}),
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

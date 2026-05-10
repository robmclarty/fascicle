/**
 * The per-instance flow: spin up a sandbox, hand it to the model with a
 * fixed tool surface, then capture whatever diff the model produced.
 *
 * Built as a single `step` rather than a `model_call`-rooted composition
 * because tools close over a per-case sandbox handle. The sandbox is
 * registered with `ctx.on_cleanup` so SIGINT/abort tears it down before the
 * harness exits — important for `local_sandbox`, which allocates a tmpdir.
 *
 * Output is a `Prediction` in the exact shape the SWE-bench eval harness
 * consumes. The bench wrapper writes these to `predictions.jsonl`; the eval
 * step (see judge.ts) is the only thing that decides whether a prediction
 * actually resolves the issue.
 */

import { step } from '@repo/fascicle'
import type { Engine, Step } from '@repo/fascicle'
import { build_tools } from './tools.js'
import { build_initial_prompt, SOLVE_SYSTEM_PROMPT } from './prompt.js'
import type { SandboxFactory } from './sandbox.js'
import type { Prediction, SweBenchInstance } from './types.js'

export type SolveConfig = {
  readonly engine: Engine
  readonly model?: string
  readonly sandbox_factory: SandboxFactory
  readonly model_name_or_path: string
  readonly max_steps?: number
}

export function solve_instance(config: SolveConfig): Step<SweBenchInstance, Prediction> {
  return step('solve_instance', async (instance, ctx) => {
    const sandbox = await config.sandbox_factory(instance, ctx.abort)
    ctx.on_cleanup(() => sandbox.dispose())

    const tools = build_tools(sandbox)
    const prompt = build_initial_prompt(instance, sandbox.workdir)

    const generate_options: Parameters<Engine['generate']>[0] = {
      prompt,
      system: SOLVE_SYSTEM_PROMPT,
      tools: [...tools],
      max_steps: config.max_steps ?? 30,
      abort: ctx.abort,
      trajectory: ctx.trajectory,
    }
    if (config.model !== undefined) generate_options.model = config.model

    await config.engine.generate(generate_options)

    const model_patch = await sandbox.git_diff()
    return {
      instance_id: instance.instance_id,
      model_name_or_path: config.model_name_or_path,
      model_patch,
    }
  })
}

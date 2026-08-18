/**
 * Stage: researcher. Runs once at startup to name techniques worth trying.
 *
 * Two factories for the same contract, because the web variant can fail in
 * ways the offline one cannot: an older CLI without `WebSearch`, or a search
 * that errors. `flow.ts` wires them with `fallback`, so the degradation is a
 * visible edge in the topology rather than a `try` buried in a step body.
 */

import { model_step, type Engine, type Step } from 'fascicle'

import { load_prompt } from '../prompts/load.js'

const RESEARCH_EFFORT = 'low'

function research_prompt(): string {
  return load_prompt(new URL('../prompts/researcher.md', import.meta.url)).body
}

/**
 * Researcher with the CLI's hosted `WebSearch` tool enabled.
 *
 * Only the `claude_cli` provider honours `allowed_tools`; on other providers
 * the option is inert and this is simply the offline call.
 */
export function make_web_researcher_step(
  engine: Engine,
  model: string,
): Step<string, string> {
  return model_step({
    engine,
    model,
    system: research_prompt(),
    effort: RESEARCH_EFFORT,
    provider_options: { claude_cli: { allowed_tools: ['WebSearch'] } },
    id: 'research_web',
  })
}

export function make_offline_researcher_step(
  engine: Engine,
  model: string,
): Step<string, string> {
  return model_step({
    engine,
    model,
    system: research_prompt(),
    effort: RESEARCH_EFFORT,
    id: 'research_offline',
  })
}

/**
 * acp-coder: a coding agent for Zed, served over the Agent Client Protocol.
 *
 * One model call with fascicle/acp's workspace tools answers each prompt: it
 * reads, searches, and edits the files in the folder Zed opened, and runs
 * commands there. Edits and commands ask in Zed first, as often as the mode
 * picked in Zed's agent panel says to (Manual, the default, asks before
 * every one). The prompt that sets how it works is prompts/coder.md.
 *
 * It answers with anthropic/claude-sonnet-5.5 on OpenRouter unless --model
 * names another model, and --provider switches the provider, through the
 * same switch as examples/acp-agent (engines.ts lists the providers and the
 * key each one reads). Commands run with the agent's environment minus those
 * keys, so a command the model runs can't read them.
 *
 * --effort sets how hard the model thinks, from none to max. Without it the
 * model keeps its own default, and Claude Sonnet 5.5 decides for itself when
 * a prompt needs thinking, so Zed's thought block fills in without the flag.
 *
 * Stdout carries the protocol, so nothing here writes to it. Zed launches
 * this file itself, and README.md has the settings entry that tells it how.
 *
 * Run directly (it waits for an ACP client on stdin until stdin closes):
 *   pnpm exec tsx --env-file=.env examples/acp-coder/main.ts
 *   pnpm exec tsx --env-file=.env examples/acp-coder/main.ts --model openai/gpt-5.5
 *   pnpm exec tsx --env-file=.env examples/acp-coder/main.ts --effort high
 */

import { readFileSync } from 'node:fs'
import { model_step, sequence, step } from 'fascicle'
import type { CacheSetting, EffortLevel, Engine, Step } from 'fascicle'
import { serve_acp, workspace_tools } from 'fascicle/acp'
import type { AcpSession, AcpTurn, ServeAcpConfig } from 'fascicle/acp'
import { API_KEYS, engine_for, flag } from '../acp-agent/engines.js'
import { to_messages } from '../acp-agent/main.js'

const CODER_PROMPT = readFileSync(new URL('./prompts/coder.md', import.meta.url), 'utf8')

const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5'

// Keyed by EffortLevel so tsc flags this table whenever the engine's levels
// change, and the flag's error lists exactly what the engine takes.
const EFFORT_LEVELS: Readonly<Record<EffortLevel, true>> = {
  none: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
}

/** Whether a command-line value names one of the engine's effort levels. */
function is_effort(value: string): value is EffortLevel {
  return Object.hasOwn(EFFORT_LEVELS, value)
}

/**
 * The effort that `--effort` names, or undefined when the flag is absent,
 * which leaves the model's own default. An unknown level fails here, listing
 * the levels, rather than reaching the provider.
 */
export function parse_effort(value: string | undefined): EffortLevel | undefined {
  if (value === undefined || is_effort(value)) return value
  throw new Error(`unknown effort ${value}: use ${Object.keys(EFFORT_LEVELS).join(', ')}`)
}

/**
 * The coder's prompt, followed by where the session's workspace is, so the
 * model knows where relative paths start without a call to find out.
 */
function system_for(session: AcpSession): string {
  const lines = [`The workspace root is ${session.cwd}, and relative paths start there.`]
  if (session.additional_directories.length > 0) {
    lines.push(`These directories are in the workspace too: ${session.additional_directories.join(', ')}.`)
  }
  lines.push(`Commands run with /bin/sh on ${process.platform}.`)
  return `${CODER_PROMPT.trimEnd()}\n\n## Workspace\n\n${lines.join('\n')}\n`
}

/**
 * The agent's environment without the provider keys, for the commands the
 * model runs. A command can read any variable it inherits and send it
 * anywhere, and in Auto nobody is watching.
 */
export function command_env(env: NodeJS.ProcessEnv): Record<string, string> {
  const keys = new Set<string>(Object.values(API_KEYS))
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !keys.has(entry[0])),
  )
}

export type CoderConfig = {
  readonly engine: Engine
  readonly model: string
  /** How hard the model thinks. Left out, the model keeps its own default. */
  readonly effort?: EffortLevel
  /** Prompt caching for the coder's model call. Left out, the provider's default applies. */
  readonly cache?: CacheSetting
  /** The whole environment the model's commands run with. */
  readonly command_env: Readonly<Record<string, string>>
}

/**
 * The coding agent: per session, the earlier turns and the new prompt go to
 * one model call that holds the session's workspace tools and asks the
 * client before an edit or a command whenever the session's mode says to.
 * It hands `serve_acp` its engine, so the engine is disposed once Zed
 * disconnects.
 */
export function coder_agent(config: CoderConfig): ServeAcpConfig<AcpTurn, string> {
  return {
    name: 'fascicle-coder',
    flow: (session: AcpSession): Step<AcpTurn, string> =>
      sequence([
        step('history', to_messages),
        model_step({
          id: 'coder',
          engine: config.engine,
          model: config.model,
          ...(config.effort === undefined ? {} : { effort: config.effort }),
          ...(config.cache === undefined ? {} : { cache: config.cache }),
          system: system_for(session),
          tools: workspace_tools(session, { command_env: config.command_env }),
          max_steps: 100,
          on_tool_approval: session.approve,
        }),
      ]),
    to_input: (turn) => turn,
    engine: config.engine,
  }
}

/**
 * The model the command line names, on the provider it names. The default
 * model is an OpenRouter id, so another provider needs `--model` as well.
 */
function chosen_model(provider: string): string {
  const model = flag('--model')
  if (model !== undefined) return model
  if (provider === 'openrouter') return DEFAULT_MODEL
  throw new Error(`--provider ${provider} needs --model too: ${DEFAULT_MODEL} is an OpenRouter model id`)
}

/**
 * The cache a session asks for: five minutes for a Claude model, which takes
 * Anthropic's cache on the anthropic provider and through OpenRouter, where
 * caching is opt-in. A coding turn sends the whole session and the workspace
 * tools again on every step, so every step after the first reads that prefix
 * back. Other models get the provider's default, since OpenAI and Gemini
 * cache on their own.
 */
function cache_for(provider: string, model: string): CacheSetting | undefined {
  return provider === 'anthropic' || model.startsWith('anthropic/') ? '5m' : undefined
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const provider = flag('--provider') ?? 'openrouter'
  const model = chosen_model(provider)
  const effort = parse_effort(flag('--effort'))
  const cache = cache_for(provider, model)
  await serve_acp(
    coder_agent({
      engine: engine_for(provider),
      model,
      ...(effort === undefined ? {} : { effort }),
      ...(cache === undefined ? {} : { cache }),
      command_env: command_env(process.env),
    }),
  )
}

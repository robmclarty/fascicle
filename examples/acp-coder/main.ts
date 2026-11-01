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
 * key each one reads). Each --model adds one to Zed's model picker, and a
 * thread starts on the first. Commands run with the agent's environment
 * minus those keys, so a command the model runs can't read them.
 *
 * The MCP servers configured in Zed reach the model beside the workspace
 * tools, and each of their calls asks first unless the mode is Auto.
 * --context-window gives Zed the window to draw its context ring against.
 * Threads are kept under ~/.local/state/fascicle-acp-coder/sessions (or
 * --sessions <dir>), so Zed can open one again after a restart.
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
import { homedir } from 'node:os'
import { join } from 'node:path'
import { model_step, sequence, step } from 'fascicle'
import type { CacheSetting, EffortLevel, Engine, Step } from 'fascicle'
import { filesystem_session_store, serve_acp, workspace_tools } from 'fascicle/acp'
import type { AcpSession, AcpSessionStore, AcpTurn, ServeAcpConfig } from 'fascicle/acp'
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
 * Every value given for a flag that may repeat, in order, read from `argv`.
 */
export function flags(name: string, argv: ReadonlyArray<string> = process.argv): string[] {
  return argv.flatMap((arg, index) => {
    const value = argv[index + 1]
    return arg === name && value !== undefined ? [value] : []
  })
}

/**
 * The window that `--context-window` names, in tokens, or undefined when
 * the flag is absent. Anything but a whole number above zero fails here.
 */
export function parse_context_window(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const tokens = Number(value)
  if (Number.isInteger(tokens) && tokens > 0) return tokens
  throw new Error(`--context-window takes a whole number of tokens above zero, not ${value}`)
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
  /** The models Zed's picker offers, in order; a thread starts on the first. */
  readonly models: ReadonlyArray<string>
  /** How hard the model thinks. Left out, the model keeps its own default. */
  readonly effort?: EffortLevel
  /** Prompt caching for a model call on `model`. Left out, the provider's default applies. */
  readonly cache_for?: (model: string) => CacheSetting | undefined
  /** The context window Zed draws its context ring against. Left out, Zed draws none. */
  readonly context_window?: number
  /** Where threads are kept, so Zed can open one again after a restart. */
  readonly session_store?: AcpSessionStore
  /** The whole environment the model's commands run with. */
  readonly command_env: Readonly<Record<string, string>>
}

/**
 * The coding agent: per session, the earlier turns and the new prompt go to
 * one model call on the model picked in Zed, holding the session's workspace
 * tools and the tools of its MCP servers, and asking the client before an
 * edit, a command, or an MCP call whenever the session's mode says to. Zed
 * rebuilds the flow when the user picks another model. It hands `serve_acp`
 * its engine, so the engine is disposed once Zed disconnects.
 */
export function coder_agent(config: CoderConfig): ServeAcpConfig<AcpTurn, string> {
  return {
    name: 'fascicle-coder',
    models: config.models.map((id) => ({ id })),
    mcp_servers: true,
    flow: (session: AcpSession): Step<AcpTurn, string> => {
      const model = session.model()
      const cache = model === undefined ? undefined : config.cache_for?.(model)
      return sequence([
        step('history', to_messages),
        model_step({
          id: 'coder',
          engine: config.engine,
          ...(model === undefined ? {} : { model }),
          ...(config.effort === undefined ? {} : { effort: config.effort }),
          ...(cache === undefined ? {} : { cache }),
          system: system_for(session),
          tools: [...workspace_tools(session, { command_env: config.command_env }), ...session.mcp_tools],
          max_steps: 100,
          on_tool_approval: session.approve,
        }),
      ])
    },
    to_input: (turn) => turn,
    ...(config.context_window === undefined ? {} : { context_window: config.context_window }),
    ...(config.session_store === undefined ? {} : { session_store: config.session_store }),
    engine: config.engine,
  }
}

/**
 * The models the command line names, on the provider it names. The default
 * model is an OpenRouter id, so another provider needs `--model` as well.
 */
function chosen_models(provider: string): string[] {
  const models = flags('--model')
  if (models.length > 0) return models
  if (provider === 'openrouter') return [DEFAULT_MODEL]
  throw new Error(`--provider ${provider} needs --model too: ${DEFAULT_MODEL} is an OpenRouter model id`)
}

/**
 * Where threads are kept: `--sessions` when it's given, and otherwise a
 * directory under the user's state directory, outside every workspace.
 */
function sessions_dir(): string {
  const state = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state')
  return flag('--sessions') ?? join(state, 'fascicle-acp-coder', 'sessions')
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
  const effort = parse_effort(flag('--effort'))
  const context_window = parse_context_window(flag('--context-window'))
  await serve_acp(
    coder_agent({
      engine: engine_for(provider),
      models: chosen_models(provider),
      ...(effort === undefined ? {} : { effort }),
      cache_for: (model) => cache_for(provider, model),
      ...(context_window === undefined ? {} : { context_window }),
      session_store: filesystem_session_store({ root_dir: sessions_dir() }),
      command_env: command_env(process.env),
    }),
  )
}

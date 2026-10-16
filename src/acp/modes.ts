/**
 * modes: the three ways a coding session runs, and when each asks the
 * client before a workspace tool acts.
 *
 * Reads and searches never ask. Manual asks before every edit and every
 * command, Accept edits only before a command, and Auto never asks. That is
 * the contract Claude Agent set and Zed's mode picker presents. Auto runs
 * commands with nobody watching, so it belongs in a container or a
 * throwaway worktree.
 *
 * ACP reports a session's mode two ways, as `modes` and as a config option
 * in the `mode` category, and a client reads one or the other. Both come
 * from the one table here, and every change sends both updates, so the two
 * can't disagree in front of the user.
 */

import type { SessionConfigOption, SessionMode, SessionModeState, SessionUpdate } from '@agentclientprotocol/sdk'
import type { AcpMode } from './types.js'

/** The mode a session starts in unless `ServeAcpConfig.default_mode` says otherwise. */
export const DEFAULT_MODE: AcpMode = 'manual'

/** The id of the config option that carries the mode, the only option this agent has. */
export const MODE_CONFIG_ID = 'mode'

/** What a workspace tool does that a mode may want to ask about first. */
export type GatedAction = 'edit' | 'command'

type ModeEntry = {
  readonly name: string
  readonly description: string
  readonly asks: Readonly<Record<GatedAction, boolean>>
}

/** Every mode, in the order a client lists them. */
const MODES: Readonly<Record<AcpMode, ModeEntry>> = {
  manual: {
    name: 'Manual',
    description: 'Ask before every edit and every command',
    asks: { edit: true, command: true },
  },
  accept_edits: {
    name: 'Accept edits',
    description: 'Edit files without asking, and ask before every command',
    asks: { edit: false, command: true },
  },
  auto: {
    name: 'Auto',
    description: 'Edit files and run commands without asking, for a container or a throwaway worktree',
    asks: { edit: false, command: false },
  },
}

/**
 * Whether `id` names one of the modes. An own-key check, so an id such as
 * `toString` that every object answers to isn't taken for one.
 */
export function is_acp_mode(id: unknown): id is AcpMode {
  return typeof id === 'string' && Object.hasOwn(MODES, id)
}

/**
 * The refusal for a mode id the agent doesn't know, naming the ones it does.
 */
export function unknown_mode_message(id: unknown): string {
  return `unknown mode ${JSON.stringify(id)}; choose one of ${Object.keys(MODES).join(', ')}`
}

/**
 * Whether a session in `mode` asks the client before a tool does `action`.
 */
export function asks_before(mode: AcpMode, action: GatedAction): boolean {
  return MODES[mode].asks[action]
}

/**
 * Every mode as ACP lists one: its id, its name, and what it asks.
 */
function available_modes(): SessionMode[] {
  return Object.entries(MODES).map(([id, { name, description }]) => ({ id, name, description }))
}

/**
 * The session's modes as `session/new` reports them in `modes`.
 */
export function mode_state(mode: AcpMode): SessionModeState {
  return { currentModeId: mode, availableModes: available_modes() }
}

/**
 * The session's config options, the mode as a select being the only one, as
 * `session/new` and `session/set_config_option` report them.
 */
export function config_options(mode: AcpMode): SessionConfigOption[] {
  return [
    {
      id: MODE_CONFIG_ID,
      name: 'Mode',
      description: 'When the agent asks before it edits a file or runs a command',
      category: 'mode',
      type: 'select',
      currentValue: mode,
      options: Object.entries(MODES).map(([value, { name, description }]) => ({ value, name, description })),
    },
  ]
}

/**
 * A session's mode as the agent holds it: what it is now, and the one way
 * to change it, which tells the client both ways it may be reading it.
 */
export type SessionModes = {
  readonly current: () => AcpMode
  readonly switch_to: (mode: AcpMode) => Promise<void>
}

/**
 * Hold a session's mode, starting at `initial`. A switch takes effect before
 * the client hears of it, so a tool call that asks after the switch reads
 * the new mode, and the two updates go out in order through `send`.
 */
export function session_modes(initial: AcpMode, send: (update: SessionUpdate) => Promise<void>): SessionModes {
  let mode = initial
  return {
    current: () => mode,
    switch_to: async (next) => {
      mode = next
      await send({ sessionUpdate: 'current_mode_update', currentModeId: next })
      await send({ sessionUpdate: 'config_option_update', configOptions: config_options(next) })
    },
  }
}

/**
 * modes: the three ways a coding session runs, and when each asks the
 * client before a workspace tool acts.
 *
 * Reads and searches never ask. Manual asks before every edit and every
 * command, Accept edits only before a command, and Auto never asks. That is
 * the contract Claude Agent set and Zed's mode picker presents. Auto runs
 * commands with nobody watching, so it belongs in a container or a
 * throwaway worktree, and an agent that runs anywhere else leaves it out
 * with `ServeAcpConfig.modes`.
 *
 * ACP reports a session's mode two ways, as `modes` and as a config option
 * in the `mode` category, and a client reads one or the other. Both come
 * from the one table here and the one `ModeOffer` an agent builds from its
 * config, and every change sends both updates, so the two can't disagree in
 * front of the user.
 */

import type { SessionConfigOption, SessionModeState, SessionUpdate } from '@agentclientprotocol/sdk'
import type { AcpMode } from './types.js'

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
 * The modes an agent offers, in the table's order and each once, and the
 * mode each of its sessions starts in. `acp_agent` builds one from its
 * config, and every list, check, and start mode reads it.
 */
export type ModeOffer = {
  readonly modes: ReadonlyArray<AcpMode>
  readonly default_mode: AcpMode
}

/** Every mode's id, as the refusals list them. */
const MODE_NAMES = Object.keys(MODES).join(', ')

/**
 * The modes an agent offers and where its sessions start, from the config's
 * `modes` (default: all three) and `default_mode` (default: the first mode
 * offered). Throws an `Error` that names the problem for an empty `modes`,
 * an entry that isn't a mode, or a `default_mode` the agent doesn't offer,
 * so `acp_agent` fails as it's built rather than at every `session/new`.
 */
export function mode_offer(config: {
  readonly modes?: ReadonlyArray<AcpMode> | undefined
  readonly default_mode?: AcpMode | undefined
}): ModeOffer {
  // A caller with no types can pass anything, so each entry is checked as unknown.
  const listed: ReadonlyArray<unknown> = config.modes ?? Object.keys(MODES)
  if (listed.length === 0) {
    throw new Error(
      `acp_agent: modes is empty; list at least one of ${MODE_NAMES}, or leave modes out to offer all three`,
    )
  }
  for (const entry of listed) {
    if (!is_acp_mode(entry)) {
      throw new Error(`acp_agent: modes lists ${JSON.stringify(entry)}, which isn't a mode; use one of ${MODE_NAMES}`)
    }
  }
  const modes = Object.keys(MODES).filter((id): id is AcpMode => listed.includes(id))
  const wanted = config.default_mode ?? modes[0]
  const default_mode = modes.find((mode) => mode === wanted)
  if (default_mode === undefined) {
    throw new Error(
      `acp_agent: default_mode ${JSON.stringify(config.default_mode)} isn't one of the modes this agent offers (${modes.join(', ')}); add it to modes or leave default_mode out`,
    )
  }
  return { modes, default_mode }
}

/**
 * The refusal for a mode id the agent doesn't offer, naming the ones it does.
 */
export function unknown_mode_message(id: unknown, offer: ModeOffer): string {
  return `unknown mode ${JSON.stringify(id)}; choose one of ${offer.modes.join(', ')}`
}

/**
 * Whether a session in `mode` asks the client before a tool does `action`.
 */
export function asks_before(mode: AcpMode, action: GatedAction): boolean {
  return MODES[mode].asks[action]
}

/** A mode as ACP lists one: its id, its name, and what it asks. */
type ListedMode = { readonly id: AcpMode; readonly name: string; readonly description: string }

/**
 * Every mode the agent offers as ACP lists one, in the table's order.
 */
function available_modes(offer: ModeOffer): ListedMode[] {
  return offer.modes.map((id) => ({ id, name: MODES[id].name, description: MODES[id].description }))
}

/**
 * The session's modes as `session/new` reports them in `modes`.
 */
export function mode_state(offer: ModeOffer, mode: AcpMode): SessionModeState {
  return { currentModeId: mode, availableModes: available_modes(offer) }
}

/**
 * The session's config options, the mode as a select being the only one, as
 * `session/new` and `session/set_config_option` report them.
 */
export function config_options(offer: ModeOffer, mode: AcpMode): SessionConfigOption[] {
  return [
    {
      id: MODE_CONFIG_ID,
      name: 'Mode',
      description: 'When the agent asks before it edits a file or runs a command',
      category: 'mode',
      type: 'select',
      currentValue: mode,
      options: available_modes(offer).map(({ id, name, description }) => ({ value: id, name, description })),
    },
  ]
}

/**
 * A session's mode as the agent holds it: what it is now, whether the agent
 * offers a mode, and the one way to change it, which tells the client both
 * ways it may be reading it.
 */
export type SessionModes = {
  readonly current: () => AcpMode
  readonly offers: (mode: unknown) => mode is AcpMode
  readonly switch_to: (mode: AcpMode) => Promise<void>
}

/**
 * Hold a session's mode, starting at the offer's `default_mode`. A switch
 * takes effect before the client hears of it, so a tool call that asks after
 * the switch reads the new mode, and the two updates go out in order through
 * `send`.
 */
export function session_modes(offer: ModeOffer, send: (update: SessionUpdate) => Promise<void>): SessionModes {
  let mode = offer.default_mode
  const offered: ReadonlyArray<unknown> = offer.modes
  return {
    current: () => mode,
    offers: (candidate): candidate is AcpMode => offered.includes(candidate),
    switch_to: async (next) => {
      mode = next
      await send({ sessionUpdate: 'current_mode_update', currentModeId: next })
      await send({ sessionUpdate: 'config_option_update', configOptions: config_options(offer, next) })
    },
  }
}

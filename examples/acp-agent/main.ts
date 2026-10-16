/**
 * acp-agent: a Fascicle flow as an Agent Client Protocol agent for Zed.
 *
 * Keyless by default: a plain step echoes each prompt with its turn number,
 * which is enough to check the wiring between Zed and the agent with no API
 * key at all. Pass --model to answer with a model instead, on OpenRouter
 * unless --provider names another (engines.ts lists them, along with the key
 * that each one reads).
 *
 * Stdout carries the protocol, so nothing here writes to it. Zed launches
 * this file itself, and README.md has the settings entry that tells it how.
 *
 * Run directly (it waits for an ACP client on stdin until stdin closes):
 *   pnpm exec tsx examples/acp-agent/main.ts
 *   pnpm exec tsx examples/acp-agent/main.ts --model anthropic/claude-sonnet-5.5
 */

import { model_step, sequence, step } from 'fascicle'
import type { Message } from 'fascicle'
import { serve_acp } from 'fascicle/acp'
import type { AcpTurn, ServeAcpConfig } from 'fascicle/acp'
import { engine_for, flag } from './engines.js'

const NAME = 'fascicle-example'

// Counts the user's earlier turns rather than halving the history, since a
// cancelled turn can record the user's text with no reply after it.
const echo = step('echo', (turn: AcpTurn): string => {
  const number = turn.history.filter((entry) => entry.role === 'user').length + 1
  return `turn ${number}: you said "${turn.text}"`
})

/** The agent with no engine: it needs no key and makes no network call. */
export const keyless_agent: ServeAcpConfig<AcpTurn, string> = {
  name: NAME,
  flow: echo,
  to_input: (turn) => turn,
}

/** What the model reads after the last text of a turn the user stopped. */
const STOPPED = '[The user stopped this turn here. Leave what it asked for unless they ask again.]'

/**
 * Earlier turns and the new prompt, as the conversation that a model reads.
 * A turn the user stopped says so where it stopped, or the model reads its
 * request as still waiting and carries it out at the next prompt.
 */
export function to_messages(turn: AcpTurn): Message[] {
  const earlier = turn.history.map((entry): Message => {
    const content = entry.cancelled === true ? `${entry.text}\n\n${STOPPED}` : entry.text
    return entry.role === 'user' ? { role: 'user', content } : { role: 'assistant', content }
  })
  return [...earlier, { role: 'user', content: turn.text }]
}

/**
 * The agent that answers with `model`. It hands `serve_acp` its engine, so
 * the engine is disposed once Zed disconnects.
 */
function model_agent(provider: string, model: string): ServeAcpConfig<AcpTurn, string> {
  const engine = engine_for(provider)
  return {
    name: NAME,
    flow: sequence([step('history', to_messages), model_step({ engine, model, system: 'Answer briefly.' })]),
    to_input: (turn) => turn,
    engine,
  }
}

/** The agent the command line asks for: keyless unless it names a model. */
function chosen_agent(): ServeAcpConfig<AcpTurn, string> {
  const model = flag('--model')
  const provider = flag('--provider')
  if (model !== undefined) return model_agent(provider ?? 'openrouter', model)
  if (provider !== undefined) {
    throw new Error(`--provider ${provider} needs --model too: pass the id of the model to send each prompt to`)
  }
  return keyless_agent
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  await serve_acp(chosen_agent())
}

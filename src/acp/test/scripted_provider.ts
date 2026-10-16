/**
 * Test helpers: an engine that plays a script, so a test can run a real
 * `model_call` through the engine's own tool loop and see what it streams,
 * the approvals it asks for, and the tools it runs, with no model behind it.
 *
 * The canned engine doubles in fascicle/testing hand back finished results
 * and never call a tool, its approval check, or an approval handler. This
 * script registers as a native provider through `create_engine`'s
 * `custom_providers` instead, and the engine runs its loop around the script
 * the way it would around a real model.
 */

import { create_engine } from '#engine'
import type { Engine, TurnRequest, TurnResult } from '#engine'

const PROVIDER = 'scripted'

/** One tool call a scripted turn makes. */
export type ScriptedCall = {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

/** One model turn: the tool calls it makes, or the text it ends on. */
export type ScriptedTurn = ReadonlyArray<ScriptedCall> | string

/**
 * Play one scripted turn the way a native provider streams it: its text as
 * one chunk, or each call's start and then its whole input.
 */
async function play(req: TurnRequest, turn: ScriptedTurn | undefined): Promise<TurnResult> {
  if (turn === undefined) throw new Error('the script has no turn left for this model call')
  const usage = { input_tokens: 1, output_tokens: 1 }
  const step_index = req.step_index
  if (typeof turn === 'string') {
    await req.dispatch_chunk?.({ kind: 'text', text: turn, step_index })
    return { text: turn, tool_calls: [], finish_reason: 'stop', usage }
  }
  for (const call of turn) {
    await req.dispatch_chunk?.({ kind: 'tool_call_start', id: call.id, name: call.name, step_index })
    await req.dispatch_chunk?.({ kind: 'tool_call_end', id: call.id, input: call.input, step_index })
  }
  return { text: '', tool_calls: turn, finish_reason: 'tool_calls', usage }
}

/**
 * An engine whose one provider, its default along with a default model,
 * plays `turns` in order: a turn each time any model call made through it
 * asks the model for one. Each request lands in `seen` first, so a test can
 * read what the model was sent, its tool results included.
 */
export function scripted_engine(turns: ReadonlyArray<ScriptedTurn>, seen: TurnRequest[] = []): Engine {
  const left = [...turns]
  return create_engine({
    providers: { [PROVIDER]: {} },
    custom_providers: {
      [PROVIDER]: () => ({
        kind: 'native',
        name: PROVIDER,
        supports: () => true,
        invoke_turn: (req) => {
          seen.push(req)
          return play(req, left.shift())
        },
      }),
    },
    defaults: { model: 'script' },
  })
}

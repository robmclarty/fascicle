/**
 * streaming_chat: observe token-like events through run.stream().
 *
 * A step emits a small sequence of chunks via `ctx.emit`; the caller
 * iterates the event stream as the flow runs. Final result equals what
 * plain `run(...)` would return (spec.md §6.7 invariant).
 *
 * Deterministic stub `fn` bodies — no engine layer, no network, no LLM calls.
 */

import { run, step } from '@repo/fascicle'

const flow = step('chat', async (prompt: string, ctx): Promise<string> => {
  const chunks = [prompt, ' ...', ' done']
  for (const text of chunks) {
    ctx.emit({ text })
  }
  return chunks.join('')
})

export async function run_streaming_chat(): Promise<{
  readonly tokens: ReadonlyArray<string>
  readonly result: string
}> {
  const handle = run.stream(flow, 'hello', { install_signal_handlers: false })
  const tokens: string[] = []
  const reader = (async (): Promise<void> => {
    for await (const event of handle.events) {
      if (event.kind === 'emit' && typeof event['text'] === 'string') {
        tokens.push(event['text'])
      }
    }
  })()
  const result = await handle.result
  await reader
  return { tokens, result }
}

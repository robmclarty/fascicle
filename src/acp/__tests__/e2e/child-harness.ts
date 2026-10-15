/**
 * Child process for the serve_acp spawn tests.
 *
 * A real `serve_acp` agent, spawned by `serve_acp.test.ts` to verify the
 * process glue from the host's side of the pipe: only the protocol on
 * stdout, the console on stderr, the engine disposed when stdin closes, and
 * a signal aborting the turn in flight before the process exits.
 *
 * The prompt's text picks what the flow does:
 *   - 'stall': write a ready marker, wait for the turn's abort, and record
 *     its reason in an aborted marker before the process can exit.
 *   - anything else: `console.log` a line, then echo the text.
 *
 * Environment inputs:
 *   - MARKER_DIR: where 'stall' writes its markers.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { step } from '../../../core/step.js'
import { serve_acp } from '../../serve_acp.js'

const marker_dir = process.env['MARKER_DIR'] ?? '.'

const flow = step('harness', async (text: string, ctx) => {
  if (text !== 'stall') {
    // oxlint-disable-next-line no-console
    console.log('harness: console.log from the flow')
    return `echo: ${text}`
  }
  writeFileSync(join(marker_dir, 'ready'), 'ready')
  await new Promise<void>((resolve) => {
    // Written synchronously, so the marker is on disk before the process exits.
    ctx.abort.addEventListener('abort', () => {
      const reason: unknown = ctx.abort.reason
      writeFileSync(join(marker_dir, 'aborted'), reason instanceof Error ? reason.message : String(reason))
      resolve()
    })
  })
  throw ctx.abort.reason
})

const engine = {
  dispose: async () => {
    process.stderr.write('harness: engine disposed\n')
  },
}

void serve_acp({ name: 'harness-agent', flow, engine })

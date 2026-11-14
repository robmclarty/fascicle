/**
 * Child process for the serve_a2a spawn test.
 *
 * A real `serve_a2a` agent, spawned by `serve_a2a.test.ts` to verify the
 * process glue from outside: the server answers on the port it was given,
 * and a signal aborts the drive in flight, disposes the engine, and exits
 * with the signal's code.
 *
 * The message's text picks what the flow does:
 *   - 'stall': write a ready marker, wait for the drive's abort, and record
 *     its reason in an aborted marker before the process can exit.
 *   - anything else: echo the text.
 *
 * Environment inputs:
 *   - MARKER_DIR: where the harness writes its markers.
 *   - PORT: the port to listen on.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { step } from '../../../core/step.js'
import { serve_a2a } from '../../serve_a2a.js'

const marker_dir = process.env['MARKER_DIR'] ?? '.'
const port = Number(process.env['PORT'] ?? 0)

const flow = step('harness', async (text: string, ctx) => {
  if (text !== 'stall') return `echo: ${text}`
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

const server = await serve_a2a({
  flow,
  card: {
    name: 'harness-agent',
    description: 'Echoes, or stalls until it is aborted.',
    url: `http://127.0.0.1:${port}/`,
    skills: [],
  },
  port,
  engine,
})
writeFileSync(join(marker_dir, 'url'), server.url)

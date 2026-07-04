/**
 * Child process for the stdio contract tests.
 *
 * A real `run_stdio` agent, spawned by `stdio.test.ts` to verify the process
 * contract from the parent's side of the pipe: one JSON document on stdout,
 * JSONL trajectory on stderr with the failure object as the last line, exit
 * code as the verdict.
 *
 * Environment inputs:
 *   - MODE: 'ok' (echo the input), 'throw' (flow fails), or 'slow' (wait
 *     abort-aware for a forwarded SIGINT).
 *   - MARKER_DIR: where 'slow' mode writes its ready marker.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { step } from '../../../core/step.js'
import { run_stdio } from '../../run_stdio.js'

const input_schema = z.object({ topic: z.string() })
const output_schema = z.object({ headline: z.string() })

const mode = process.env['MODE'] ?? 'ok'

const flows = {
  ok: step('echo', (input: { readonly topic: string }) => ({
    headline: `about ${input.topic}`,
  })),
  throw: step('boom', (_input: { readonly topic: string }): { headline: string } => {
    throw new Error('kaboom')
  }),
  slow: step('slow_io', async (_input: { readonly topic: string }, ctx) => {
    const marker_dir = process.env['MARKER_DIR']
    if (marker_dir !== undefined) {
      await writeFile(join(marker_dir, 'ready'), 'ready')
    }
    await new Promise<never>((_resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error('harness timeout: SIGINT never arrived'))
      }, 70_000)
      ctx.abort.addEventListener(
        'abort',
        () => {
          clearTimeout(deadline)
          const reason = ctx.abort.reason
          reject(reason instanceof Error ? reason : new Error(`aborted: ${String(reason)}`))
        },
        { once: true },
      )
    })
    return { headline: 'unreachable' }
  }),
}

const flow = mode === 'throw' ? flows.throw : mode === 'slow' ? flows.slow : flows.ok

void run_stdio(flow, { input_schema, output_schema })

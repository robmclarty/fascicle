/**
 * viewer_demo: produce a rich, deterministic trajectory.jsonl for the viewer.
 *
 * Exercises nested sequences, parallel branches, a retry that fails once
 * before succeeding, a map over a list, and a fallback that recovers from
 * an error. No engine layer, no network, no LLM calls.
 *
 *   pnpm tsx examples/viewer_demo.ts
 *   pnpm fascicle-viewer .trajectory.jsonl
 */

import {
  fallback,
  map,
  parallel,
  retry,
  run,
  sequence,
  step,
} from '@repo/fascicle'
import { filesystem_logger } from '@repo/observability'

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const fetch_brief = step('fetch_brief', async (topic: string) => {
  await sleep(40)
  return { topic, sources: ['rfc-001', 'rfc-002', 'rfc-003'] }
})

const summarize = step('summarize', async (s: string) => {
  await sleep(30)
  return `summary(${s})`
})

const score = step('score', async (s: string) => {
  await sleep(20)
  return { source: s, score: s.length % 7 }
})

let flaky_attempts = 0
const flaky_enrich = step('flaky_enrich', async (input: { topic: string }) => {
  flaky_attempts += 1
  await sleep(25)
  if (flaky_attempts < 2) throw new Error('transient upstream error')
  return { ...input, enriched: true }
})

const always_throws = step('always_throws', async (_: unknown) => {
  await sleep(15)
  throw new Error('primary path unavailable')
})

const safe_default = step('safe_default', async () => {
  await sleep(10)
  return { fallback_used: true, value: 'default-brief' }
})

const flow = sequence([
  fetch_brief,
  step('explode_sources', (b: { topic: string; sources: readonly string[] }) => b.sources),
  parallel({
    summaries: map({ items: (xs: readonly string[]) => xs, do: summarize }),
    scores: map({ items: (xs: readonly string[]) => xs, do: score, concurrency: 2 }),
  }),
  step('to_topic', () => ({ topic: 'beta-feature' })),
  retry(flaky_enrich, { max_attempts: 3, backoff_ms: 25 }),
  fallback(always_throws, safe_default),
  step('finalize', (x: unknown) => ({ ok: true, payload: x })),
])

async function main(): Promise<void> {
  const result = await run(flow, 'beta-feature', {
    install_signal_handlers: false,
    trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }),
  })
  process.stdout.write(`done: ${JSON.stringify(result)}\n`)
}

void main().catch((err: unknown) => {
  process.stderr.write(`viewer_demo failed: ${String(err)}\n`)
  process.exit(1)
})

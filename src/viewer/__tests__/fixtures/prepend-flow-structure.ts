/**
 * Regenerate the `flow_structure` first line of the frozen viewer design
 * fixture (plumbbob D8, fixture-prepend).
 *
 * The six artboards and the viewer acceptance criteria pin one exact run:
 * `42b20e54...`, with its ids, timings, and header numbers. So the fixture is
 * stamped by hand rather than re-recorded: the 41 span/run_end lines stay
 * frozen, and this script only owns line one. It rebuilds the viewer-demo flow
 * (the same composition `examples/viewer-demo/main.ts` runs), takes its
 * `describe.json` tree, and writes the `flow_structure` event that an observed
 * run of that flow now emits first (see `start_run` in `src/core/runner.ts`).
 *
 * The run id and timestamp are read back from the fixture's own first event so
 * the stamp can never drift from the frozen run: line one carries the same
 * `run_id` and the first `ts` already on the wire.
 *
 * Idempotent: an existing `flow_structure` line one is replaced, never stacked.
 *
 * The fixture is tracked rather than left in gitignored working notes because
 * the later canvas steps replay it inside `pnpm check`, which also runs in CI
 * (plumbbob D13, fixture-tracked-home).
 *
 *   pnpm exec tsx src/viewer/__tests__/fixtures/prepend-flow-structure.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, fallback, map, parallel, retry, sequence, step } from '#core'

// The viewer-demo flow, rebuilt for its structure alone. describe.json walks
// composition (kinds, ids, config, children), never the bodies, so the step
// functions are copied verbatim only so a reader can match them one to one.
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

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixture.trajectory.jsonl')

const raw = readFileSync(FIXTURE, 'utf8')
const lines = raw.split('\n')

// Drop a stale flow_structure line one (idempotent re-run) but touch nothing
// else, so the frozen 41-line body stays byte for byte identical.
if (lines[0]?.includes('"kind":"flow_structure"')) {
  lines.shift()
}

// The frozen run's identity, read from the wire so the stamp cannot drift.
function is_stamped(value: unknown): value is { run_id: string; ts: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'run_id' in value &&
    typeof value.run_id === 'string' &&
    'ts' in value &&
    typeof value.ts === 'number'
  )
}

const head = lines[0] ?? ''
if (head.trim() === '') {
  throw new Error('fixture has no events: nothing to read the run id and ts from')
}

const first: unknown = JSON.parse(head)
if (!is_stamped(first)) {
  throw new Error('fixture first event is missing a string run_id or numeric ts')
}

const event = {
  kind: 'flow_structure',
  structure: describe.json(flow),
  run_id: first.run_id,
  ts: first.ts,
}

writeFileSync(FIXTURE, `${JSON.stringify(event)}\n${lines.join('\n')}`)

process.stdout.write(`prepended flow_structure (run ${first.run_id.slice(0, 8)}, ts ${first.ts})\n`)

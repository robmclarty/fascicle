/**
 * Synthetic log generator. Produces a deterministic ~5MB log file mixing
 * INFO / WARN / ERROR lines across a fixed set of services, with stable
 * counts so a benchmark can compare wall-clock runs apples-to-apples.
 *
 * Usage:
 *   pnpm --filter @repo/example-amplify gen-fixture
 */

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(HERE, 'sample.log')

const SERVICES = ['auth', 'billing', 'search', 'orders', 'inventory'] as const
const LEVELS = ['INFO', 'WARN', 'ERROR'] as const
const REASONS = [
  'ok',
  'slow',
  'db timeout',
  'invalid token',
  'rate-limited',
  'card declined',
  'not found',
  'forbidden',
  'retrying',
  'cache miss',
]

// Linear congruential generator — deterministic, no Math.random.
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function pick<T>(rng: () => number, items: ReadonlyArray<T>): T {
  const item = items[Math.floor(rng() * items.length)]
  if (item === undefined) throw new Error('gen: empty pick list')
  return item
}

const TARGET_BYTES = 5 * 1024 * 1024

async function main(): Promise<void> {
  const rng = lcg(42)
  const lines: string[] = []
  let bytes = 0
  let request_id = 1

  while (bytes < TARGET_BYTES) {
    const ts = `2024-01-01T${String(Math.floor(request_id / 3600) % 24).padStart(2, '0')}:${String(Math.floor(request_id / 60) % 60).padStart(2, '0')}:${String(request_id % 60).padStart(2, '0')}Z`
    const level = pick(rng, LEVELS)
    const service = pick(rng, SERVICES)
    const reason = pick(rng, REASONS)
    const line = `${ts} ${level.padEnd(5)} request=${String(request_id)} service=${service} ${reason}`
    lines.push(line)
    bytes += line.length + 1
    request_id += 1
  }

  const text = `${lines.join('\n')}\n`
  await writeFile(OUT_PATH, text, 'utf8')
  console.log(
    `wrote ${OUT_PATH} (${String(lines.length)} lines, ${String(text.length)} bytes)`,
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})

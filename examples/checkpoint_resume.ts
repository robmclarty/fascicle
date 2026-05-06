/**
 * checkpoint_resume: memoize an expensive step by key.
 *
 * First run: cache miss, `inner` executes, result is persisted to the
 * filesystem store. Second run: cache hit, `inner` is skipped and the stored
 * value is returned. A shared counter proves the skip.
 *
 * Writes to a fresh temp directory so the example is hermetic and can be run
 * repeatedly without stale state.
 *
 * Deterministic stub — no engine layer, no network, no LLM calls.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkpoint, run, step } from '@repo/fascicle'
import { filesystem_store } from '@repo/fascicle/adapters'

type build_spec = { readonly hash: string }

export async function run_checkpoint_resume(): Promise<{
  readonly first: string
  readonly second: string
  readonly call_count: number
}> {
  let call_count = 0

  const inner = step('expensive_build', (spec: build_spec): string => {
    call_count += 1
    return `index:${spec.hash}`
  })

  const flow = checkpoint(inner, { key: (spec) => `expensive_build:${spec.hash}` })

  const root_dir = await mkdtemp(join(tmpdir(), 'fascicle-checkpoint-'))
  const store = filesystem_store({ root_dir })

  try {
    const first = await run(flow, { hash: 'abc123' }, {
      install_signal_handlers: false,
      checkpoint_store: store,
    })
    const second = await run(flow, { hash: 'abc123' }, {
      install_signal_handlers: false,
      checkpoint_store: store,
    })
    return { first, second, call_count }
  } finally {
    await rm(root_dir, { recursive: true, force: true })
  }
}

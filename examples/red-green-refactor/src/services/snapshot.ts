/**
 * Snapshot the toy package's test files so the backstop can compare before
 * and after each phase.
 *
 * Exposed as a port (`Snapshotter`) for the same reason as the test oracle:
 * the flow takes it as data, so a test can inject scripted snapshots.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { FileEntry, Snapshot } from '../types.js'
import { TOY_SRC } from './vitest.js'

export type Snapshotter = () => Promise<Snapshot>

const TEST_CALL_RE = /\b(?:it|test)\s*(?:\.\w+)?\s*\(/g

function count_tests(content: string): number {
  return (content.match(TEST_CALL_RE) ?? []).length
}

async function list_test_files(root: string): Promise<readonly string[]> {
  let entries: readonly string[]
  try {
    entries = await readdir(root, { recursive: true })
  } catch {
    return []
  }
  return entries
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => join(root, name))
    .toSorted()
}

export async function snapshot_tests(): Promise<Snapshot> {
  const files = await list_test_files(TOY_SRC)
  const entries = await Promise.all(
    files.map(async (path): Promise<[string, FileEntry]> => {
      const content = await readFile(path, 'utf8')
      return [path, { content, test_count: count_tests(content) }]
    }),
  )
  return new Map(entries)
}

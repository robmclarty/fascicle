/**
 * Minimal unified-diff parser: just enough structure for the detectors and
 * the privacy screen. Tracks per-file status, added lines with their new-file
 * line numbers, and removal counts. Not a general patch tool.
 */

import type { DiffFile, DiffLine, DiffStatus } from '../types.js'

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function block_path(block: string): string {
  const plus = block.match(/^\+\+\+ b\/(.+)$/m)
  if (plus) return plus[1] ?? ''
  const header = block.match(/^a\/(?:.+) b\/(.+)$/m)
  return header?.[1] ?? ''
}

function block_status(block: string): DiffStatus {
  if (/^new file mode /m.test(block)) return 'added'
  if (/^deleted file mode /m.test(block)) return 'deleted'
  if (/^rename to /m.test(block)) return 'renamed'
  return 'modified'
}

export function parse_unified_diff(diff: string): ReadonlyArray<DiffFile> {
  const blocks = diff.split(/^diff --git /m).filter((b) => b.trim().length > 0)
  return blocks.map((block) => {
    const path = block_path(block)
    const added_lines: DiffLine[] = []
    let removed_count = 0
    let new_line = 0
    for (const line of block.split('\n')) {
      const hunk = line.match(HUNK_HEADER)
      if (hunk) {
        new_line = Number.parseInt(hunk[1] ?? '0', 10)
        continue
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added_lines.push({ line: new_line, content: line.slice(1) })
        new_line += 1
        continue
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        removed_count += 1
        continue
      }
      if (new_line > 0 && !line.startsWith('\\')) new_line += 1
    }
    return {
      path,
      status: block_status(block),
      added_lines,
      removed_count,
      raw: `diff --git ${block}`,
    }
  })
}

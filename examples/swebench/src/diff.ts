/**
 * Cheap shape checks for unified-diff strings.
 *
 * Used by `judge_patch_shape` so the harness can flag "agent gave up" or
 * "agent emitted prose instead of a patch" without spinning up a sandbox.
 * The real eval still has to apply and run the patch — these checks are only
 * the first gate.
 */

const FILE_HEADER_RE = /^diff --git a\/.+? b\/.+?$/m
const HUNK_HEADER_RE = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m

export function is_nonempty_patch(patch: string): boolean {
  return patch.trim().length > 0
}

export function looks_like_unified_diff(patch: string): boolean {
  if (!is_nonempty_patch(patch)) return false
  return FILE_HEADER_RE.test(patch) && HUNK_HEADER_RE.test(patch)
}

export function count_files_touched(patch: string): number {
  let count = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) count += 1
  }
  return count
}

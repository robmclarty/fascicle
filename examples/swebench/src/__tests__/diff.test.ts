import { describe, expect, it } from 'vitest'
import {
  count_files_touched,
  is_nonempty_patch,
  looks_like_unified_diff,
} from '../diff.js'

const SAMPLE_PATCH = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
-old
+new
 unchanged
diff --git a/src/bar.ts b/src/bar.ts
index 111..222 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -10,2 +10,2 @@
-old line
+new line
`

describe('diff helpers', () => {
  it('is_nonempty_patch detects empty strings', () => {
    expect(is_nonempty_patch('')).toBe(false)
    expect(is_nonempty_patch('   \n  ')).toBe(false)
    expect(is_nonempty_patch(SAMPLE_PATCH)).toBe(true)
  })

  it('looks_like_unified_diff requires both file and hunk headers', () => {
    expect(looks_like_unified_diff(SAMPLE_PATCH)).toBe(true)
    expect(looks_like_unified_diff('I think the fix is...')).toBe(false)
    expect(looks_like_unified_diff('diff --git a/x b/y\n')).toBe(false)
  })

  it('count_files_touched counts diff --git headers', () => {
    expect(count_files_touched(SAMPLE_PATCH)).toBe(2)
    expect(count_files_touched('')).toBe(0)
  })
})

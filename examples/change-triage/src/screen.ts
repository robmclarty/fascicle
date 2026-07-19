/**
 * Privacy screen for the model's view of the diff.
 *
 * Fixture, seed, and snapshot files often contain realistic-looking personal
 * data, so their content never reaches the model: the detectors already ran
 * over the full diff, and a risk inside a withheld path is still scored. Kept
 * files get their text scrubbed of obvious PII shapes (emails, long digit
 * runs). The report discloses every withheld path.
 */

import type { DiffFile, ScreenResult } from './types.js'

const SENSITIVE_PATHS: ReadonlyArray<RegExp> = [
  /(^|\/)__?fixtures__?\//i,
  /(^|\/)seeds?\//i,
  /\.seed\.\w+$/i,
  /\.snap$/,
]

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g
const LONG_DIGITS = /\b\d{7,}\b/g

export function is_sensitive_path(path: string): boolean {
  return SENSITIVE_PATHS.some((re) => re.test(path))
}

export function scrub_text(text: string): string {
  return text.replace(EMAIL, '[redacted-email]').replace(LONG_DIGITS, '[redacted-number]')
}

export function screen_files(files: ReadonlyArray<DiffFile>): ScreenResult {
  const skipped = files.filter((f) => is_sensitive_path(f.path)).map((f) => f.path)
  const screened = files
    .filter((f) => !is_sensitive_path(f.path))
    .map((f) => ({
      ...f,
      raw: scrub_text(f.raw),
      added_lines: f.added_lines.map((l) => ({ ...l, content: scrub_text(l.content) })),
    }))
  return { screened, skipped }
}

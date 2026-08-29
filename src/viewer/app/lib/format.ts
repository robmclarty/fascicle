/**
 * Header formatting for the run canvas.
 *
 * Pure string work, kept out of the components so it can be mutation-gated
 * (D4). The full header stat line lives here now that the fold produces its
 * numbers: `T+130MS · 1 RETRY ABSORBED · SCARS 0 · $0.0000` is the artboard-01
 * reference string, and `format_header_stats` is the one place its shape is
 * decided.
 */

const RUN_ID_CHARS = 8

/** The header's id slot before any event has named the run. */
export const RUN_ID_PLACEHOLDER = '\u00b7'.repeat(RUN_ID_CHARS)

/**
 * Truncates a run id to the 8-char prefix the header shows.
 *
 * The wire carries a full UUID, which is unreadable at 17px and pushes the
 * LIVE chip off the header baseline. Eight characters is what artboard 01
 * pins and is still collision-free at any run count a human will scroll.
 */
export function short_run_id(run_id: string): string {
  return run_id.slice(0, RUN_ID_CHARS)
}

/**
 * Elapsed run time in the header's mono register: milliseconds under a
 * second, truncated centiseconds under a minute, then minutes and whole
 * seconds so a ten-minute play-mode run stays readable. Truncation, never
 * rounding: elapsed time must not display a moment the run has not reached,
 * and a fractional playhead position should not flicker the label forward.
 */
export function format_t_plus(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms))
  if (clamped < 1000) return `T+${clamped}MS`
  if (clamped < 60_000) return `T+${(Math.floor(clamped / 10) / 100).toFixed(2)}S`
  const minutes = Math.floor(clamped / 60_000)
  const seconds = Math.floor((clamped % 60_000) / 1000)
  return `T+${minutes}M${String(seconds).padStart(2, '0')}S`
}

/**
 * The run's cost rule, carried over from the old page: under one cent to four
 * decimals so a cheap run reads as a real number instead of $0.00, two
 * decimals once cents exist.
 */
export function format_cost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

/**
 * The pluralized word for the absorbed-retry stat. Numeral and word carry
 * different opacities in the header, so they are separate parts.
 */
export function retry_word(count: number): string {
  return count === 1 ? 'RETRY' : 'RETRIES'
}

export type HeaderStatsInput = {
  readonly t_plus_ms: number
  readonly retries_absorbed: number
  readonly scars: number
  readonly cost_usd: number
}

/**
 * One span of the header stat line. Values sit at 78%, words at 38%, and the
 * dot separators at 20% (artboard 05), so the renderer needs the line as
 * role-tagged parts rather than one string.
 */
export type HeaderStatPart = {
  readonly text: string
  readonly role: 'value' | 'word' | 'sep'
}

const STAT_SEP: HeaderStatPart = { text: '·', role: 'sep' }

/**
 * The header's right-aligned stat line, artboard-01 order and separators,
 * as parts the component renders one span each. The caller chooses the T+
 * value (the fold's clock, or a scrub playhead) because which moment the
 * header names is a renderer decision, not a formatting one.
 */
export function header_stat_parts(stats: HeaderStatsInput): ReadonlyArray<HeaderStatPart> {
  return [
    { text: format_t_plus(stats.t_plus_ms), role: 'value' },
    STAT_SEP,
    { text: String(stats.retries_absorbed), role: 'value' },
    { text: `${retry_word(stats.retries_absorbed)} ABSORBED`, role: 'word' },
    STAT_SEP,
    { text: 'SCARS', role: 'word' },
    { text: String(stats.scars), role: 'value' },
    STAT_SEP,
    { text: format_cost(stats.cost_usd), role: 'value' },
  ]
}

/**
 * The stat line as one string: the parts joined the way the artboard reads
 * aloud. Tests and logs want the sentence; the header wants the parts.
 */
export function format_header_stats(stats: HeaderStatsInput): string {
  return header_stat_parts(stats)
    .map((part) => part.text)
    .join(' ')
}

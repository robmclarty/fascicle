/**
 * Header formatting for the run canvas.
 *
 * Pure string work, kept out of the components so it can be mutation-gated,
 * since the `.tsx` files stay markup. The full header stat line lives here:
 * `T+130MS · 1 RETRY ABSORBED · SCARS 0 · $0.0000` is the design fixture's
 * mid-run reference string, and `format_header_stats` is the one place its
 * shape is decided.
 */

import type { SseStatus } from '../sse.js'
import type { RunStatus } from './reduce.js'

const RUN_ID_CHARS = 8

/** The header's id slot before any event has named the run. */
export const RUN_ID_PLACEHOLDER = '\u00b7'.repeat(RUN_ID_CHARS)

/**
 * Truncates a run id to the 8-char prefix the header shows.
 *
 * The wire carries a full UUID, which is unreadable at 17px and pushes the
 * LIVE chip off the header baseline. Eight characters fit the header and are
 * still collision-free at any run count a human will scroll.
 */
export function short_run_id(run_id: string): string {
  return run_id.slice(0, RUN_ID_CHARS)
}

/**
 * The status chip's look. `live` pulses its dot, `ended` holds a static
 * glow, and `offline` dims the whole chip, for a stream still connecting as
 * much as for one that dropped. Every tone is in the white family, never
 * amber, which marks only the geometry a run is alive inside.
 */
export type ChipTone = 'live' | 'ended' | 'offline'

/** What the header's status chip shows: its word and its look. */
export type StatusChip = {
  readonly label: string
  readonly tone: ChipTone
}

const CLOSED_STREAM_LABEL: Record<Exclude<SseStatus, 'live'>, string> = {
  connecting: 'CONNECTING',
  offline: 'OFFLINE',
}

const RUN_END_LABEL: Record<RunStatus, string> = {
  done: 'DONE',
  failed: 'FAILED',
  aborted: 'ABORTED',
  suspended: 'SUSPENDED',
}

/**
 * The status chip while the app follows the newest event.
 *
 * A stream that isn't open says so whatever the run did, because nothing
 * new reaches the canvas until it is, and a suspended run can still resume
 * into the same file. An open stream reads LIVE until the run's `run_end`
 * folds, then says how the run ended, so a finished run never reads as a
 * live one.
 */
export function status_chip(status: SseStatus, run_status: RunStatus | null): StatusChip {
  if (status !== 'live') return { label: CLOSED_STREAM_LABEL[status], tone: 'offline' }
  if (run_status === null) return { label: 'LIVE', tone: 'live' }
  return { label: RUN_END_LABEL[run_status], tone: 'ended' }
}

/**
 * A duration in the mono register: milliseconds under a second, truncated
 * centiseconds under a minute, then minutes and whole seconds so a
 * ten-minute run stays readable. Truncation, never rounding: elapsed time
 * must not display a moment the run has not reached, and a fractional
 * playhead position should not flicker the label forward. The header's T+
 * and a node meta's `42MS` share this so the canvas never disagrees with
 * itself about what a span of time is called.
 */
export function format_duration(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms))
  if (clamped < 1000) return `${clamped}MS`
  if (clamped < 60_000) return `${(Math.floor(clamped / 10) / 100).toFixed(2)}S`
  const minutes = Math.floor(clamped / 60_000)
  const seconds = Math.floor((clamped % 60_000) / 1000)
  return `${minutes}M${String(seconds).padStart(2, '0')}S`
}

/** Elapsed run time as the header names it. */
export function format_t_plus(ms: number): string {
  return `T+${format_duration(ms)}`
}

/**
 * The run's cost rule: under one cent to four decimals so a cheap run reads as
 * a real number instead of $0.00, two decimals once cents exist.
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
  /** The run's summed input and cache traffic; absent, the header shows no cache stat. */
  readonly cache?: CacheStatsInput
}

export type CacheStatsInput = {
  readonly input_tokens: number
  readonly cached_input_tokens: number
  readonly cache_write_tokens: number
  readonly misses: number
}

/**
 * One span of the header stat line. Values sit at 78%, words at 38%, and the
 * dot separators at 20%, so the renderer needs the line as role-tagged parts
 * rather than one string. The `scar` role is the one place ember reaches the
 * header: a scar count above zero is the numeral drawn in ember, while a zero
 * stays an ordinary value, because ember marks a failure and nothing else.
 */
export type HeaderStatPart = {
  readonly text: string
  readonly role: 'value' | 'word' | 'sep' | 'scar'
}

const STAT_SEP: HeaderStatPart = { text: '·', role: 'sep' }

/**
 * The run's cache hit ratio as a whole percent: the share of its input read
 * from the prompt cache, or undefined when no turn had cache traffic (reads
 * plus writes of zero), so a run that only wrote reads 0%.
 */
export function format_cache_ratio(cache: CacheStatsInput): string | undefined {
  if (cache.cached_input_tokens + cache.cache_write_tokens <= 0) return undefined
  const ratio = cache.input_tokens > 0 ? cache.cached_input_tokens / cache.input_tokens : 0
  return `${String(Math.round(ratio * 100))}%`
}

/** The pluralized word for the cache-miss stat. */
export function miss_word(count: number): string {
  return count === 1 ? 'MISS' : 'MISSES'
}

/**
 * The header's cache parts: `CACHE 87%` once any turn had cache traffic, and
 * then `2 MISSES` when the run recorded any `cache_miss`, each behind its own
 * separator. A miss is no failure, so its numeral stays an ordinary value.
 */
function cache_stat_parts(cache: CacheStatsInput | undefined): ReadonlyArray<HeaderStatPart> {
  if (cache === undefined) return []
  const ratio = format_cache_ratio(cache)
  if (ratio === undefined) return []
  const parts: HeaderStatPart[] = [STAT_SEP, { text: 'CACHE', role: 'word' }, { text: ratio, role: 'value' }]
  if (cache.misses > 0) {
    parts.push(STAT_SEP, { text: String(cache.misses), role: 'value' }, { text: miss_word(cache.misses), role: 'word' })
  }
  return parts
}

/**
 * The header's right-aligned stat line, in its fixed order and separators,
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
    { text: String(stats.scars), role: stats.scars > 0 ? 'scar' : 'value' },
    ...cache_stat_parts(stats.cache),
    STAT_SEP,
    { text: format_cost(stats.cost_usd), role: 'value' },
  ]
}

/**
 * The stat line as one string: the parts joined the way the header reads
 * aloud. Tests and logs want the sentence; the header wants the parts.
 */
export function format_header_stats(stats: HeaderStatsInput): string {
  return header_stat_parts(stats)
    .map((part) => part.text)
    .join(' ')
}

/**
 * The score floor: hard detector signals impose a minimum score the model
 * cannot undercut, and the band is always derived from the floored score in
 * code. A model that shrugs at a database migration still yields at least a
 * medium-risk report, and the band can never disagree with the score.
 */

import type { Band, Signal } from './types.js'

const FLOOR_BY_SIGNAL: Readonly<Record<string, number>> = {
  'secret-material': 50,
  'auth-change': 50,
  'db-migration': 25,
}

/** Raise the model's score to the highest floor any hard signal imposes. Never lowers. */
export function floor_score(score: number, signals: ReadonlyArray<Signal>): number {
  const floors = signals.map((s) => FLOOR_BY_SIGNAL[s.id] ?? 0)
  return Math.max(score, ...floors, 0)
}

export function band_for_score(score: number): Band {
  if (score >= 75) return 'critical'
  if (score >= 50) return 'high'
  if (score >= 25) return 'medium'
  return 'low'
}

const BAND_RANK: Readonly<Record<Band, number>> = { low: 0, medium: 1, high: 2, critical: 3 }

/** True when `band` is at or above `threshold` (for a CI-style --fail-on gate). */
export function band_at_or_above(band: Band, threshold: Band): boolean {
  return BAND_RANK[band] >= BAND_RANK[threshold]
}

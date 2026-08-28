/**
 * Header formatting for the run canvas.
 *
 * Pure string work, kept out of the components so it can be mutation-gated
 * (D4). Later steps grow this module into the full header stat set; the run id
 * and the event count are what the scaffold shell already knows.
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
 * The pluralized word for an event tally, rendered beside the numeral.
 *
 * Value and word carry different opacities in the header (78% against 38%),
 * so they are two spans and this returns only the word. The count is the
 * scaffold's one honest stat: before the fold lands there is no elapsed time,
 * no cost, and no scar count, and inventing a zero for each would claim
 * knowledge the canvas does not have.
 */
export function event_count_word(count: number): string {
  return count === 1 ? 'EVENT' : 'EVENTS'
}

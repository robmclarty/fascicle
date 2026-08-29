import { For, type JSX } from 'solid-js'
import { TOKENS } from './lib/layout'
import type { Timeline } from './lib/timeline'

/*
 * The time scrubber: the run's spine of time along the bottom margin.
 *
 * Drawn in the line grammar, not as a media player (spec track V): the run
 * behind the playhead is traversed grey, the run ahead is the same dim dashed
 * scaffold the canvas draws for the unbuilt, error closes are ember crosses
 * always on the spine, and the playhead is a single amber point, the only amber
 * the timeline strip ever carries (Q2). The component stays markup (D4): the
 * time domain, the event positions, and the failure fractions are all decided
 * in `lib/timeline.ts`; this file maps them onto the spine and turns a drag into
 * a fraction the app resolves to an event.
 *
 * The drawn line is thin, so the hit target is not: a transparent band gives
 * the pointer the padded reach Q5 asks for. Positions are in the canvas's own
 * pixel space (the strip spans the full width and shares the header's margins),
 * so a fraction reads straight off the pointer's x within the band.
 */

/** The strip's height; the visible spine sits on its centerline. */
const STRIP_HEIGHT = 40
const SPINE_Y = STRIP_HEIGHT / 2

/** Q5's padded hit band: 24px of reach around the thin drawn line. */
const HIT_BAND = 24

/** An error cross's half-arm on the spine. */
const FAIL_ARM = 4

/** The amber playhead's radius, the single lit point on the strip. */
const PLAYHEAD_RADIUS = 3.5

export type ScrubberProps = {
  readonly timeline: Timeline
  /** The playhead position, 0 at T+0 and 1 at the live edge. */
  readonly fraction: number
  /** The canvas width, so the spine shares the header's pixel margins. */
  readonly width: number
  /** A drag or click resolves to a fraction the app maps back to an event. */
  readonly on_seek: (fraction: number) => void
}

/** The run's spine of time: scaffold ahead, traversed behind, one amber point. */
export function Scrubber(props: ScrubberProps): JSX.Element {
  const right = (): number => props.width - TOKENS.margin
  const span = (): number => Math.max(0, right() - TOKENS.margin)
  const x_at = (fraction: number): number => TOKENS.margin + fraction * span()
  const head_x = (): number => x_at(clamp01(props.fraction))

  const seek_from = (clientX: number, band: DOMRect): void => {
    const usable = band.width - 2 * TOKENS.margin
    const fraction = usable <= 0 ? 0 : (clientX - band.left - TOKENS.margin) / usable
    props.on_seek(clamp01(fraction))
  }

  return (
    <svg class="scrubber" data-testid="scrubber" height={STRIP_HEIGHT} fill="none">
      <line class="scrub-spine-ahead" x1={head_x()} y1={SPINE_Y} x2={right()} y2={SPINE_Y} />
      <line
        class="scrub-spine-traversed"
        x1={TOKENS.margin}
        y1={SPINE_Y}
        x2={head_x()}
        y2={SPINE_Y}
      />
      <For each={props.timeline.failures}>
        {(fraction) => (
          <>
            <line
              class="scrub-fail"
              x1={x_at(fraction) - FAIL_ARM}
              y1={SPINE_Y - FAIL_ARM}
              x2={x_at(fraction) + FAIL_ARM}
              y2={SPINE_Y + FAIL_ARM}
            />
            <line
              class="scrub-fail"
              x1={x_at(fraction) + FAIL_ARM}
              y1={SPINE_Y - FAIL_ARM}
              x2={x_at(fraction) - FAIL_ARM}
              y2={SPINE_Y + FAIL_ARM}
            />
          </>
        )}
      </For>
      <circle
        class="scrub-playhead"
        data-testid="playhead"
        cx={head_x()}
        cy={SPINE_Y}
        r={PLAYHEAD_RADIUS}
      />
      <rect
        class="scrub-band"
        x={0}
        y={SPINE_Y - HIT_BAND / 2}
        width={props.width}
        height={HIT_BAND}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          seek_from(event.clientX, event.currentTarget.getBoundingClientRect())
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          seek_from(event.clientX, event.currentTarget.getBoundingClientRect())
        }}
      />
    </svg>
  )
}

/** Hold a fraction inside the spine's inclusive range. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

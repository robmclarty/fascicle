import type { JSX } from 'solid-js'
import { play_label, type Playback } from './lib/playback'

/*
 * The playback controls: play mode's dials in the mono meta register, seated
 * under the time spine beside the scrubber, plus the spine's DENSITY dial in
 * the same register. The cluster is markup only (D4): every playback
 * transition a click can trigger is decided in `lib/playback.ts` and wired
 * through the app, and density is a view preference the app persists. Even
 * the leading chip's label is a decision the lib makes, because that chip
 * plays, pauses, or advances depending on the mode. An engaged toggle
 * brightens rather than colors, because hierarchy is opacity and amber
 * belongs to the canvas (C4).
 */

export type ControlsProps = {
  readonly playback: Playback
  /** The DENSITY dial's state: a view preference, not playback state. */
  readonly density: boolean
  /** The leading chip: advance a beat while stepping, else start or stop the clock. */
  readonly on_play_chip: () => void
  readonly on_toggle_step: () => void
  readonly on_cycle_speed: () => void
  readonly on_toggle_compress: () => void
  readonly on_toggle_loop: () => void
  readonly on_toggle_density: () => void
}

type ChipProps = {
  readonly testid: string
  readonly label: string
  /** Only the three toggles carry an engaged state; play and speed relabel. */
  readonly active?: boolean
  /** Play alone holds a fixed width, so relabeling to PAUSE moves nothing. */
  readonly play?: boolean
  readonly on_click: () => void
}

/** One chrome chip: engaged brightens via data-active, never color (C4). */
function Chip(props: ChipProps): JSX.Element {
  return (
    <button
      type="button"
      class={props.play ? 'pb-button pb-button-play' : 'pb-button'}
      data-testid={props.testid}
      data-active={props.active ? 'true' : undefined}
      onClick={() => props.on_click()}
    >
      {props.label}
    </button>
  )
}

/** Play, step, the speed dial, gap compression, the loop toggle, and density. */
export function Controls(props: ControlsProps): JSX.Element {
  return (
    <div class="playback" data-testid="playback">
      <Chip
        testid="play-toggle"
        label={play_label(props.playback)}
        play
        on_click={props.on_play_chip}
      />
      <Chip
        testid="step-toggle"
        label="STEP"
        active={props.playback.stepping}
        on_click={props.on_toggle_step}
      />
      <Chip testid="speed" label={`${props.playback.speed}X`} on_click={props.on_cycle_speed} />
      <Chip
        testid="compress-toggle"
        label="COMPRESS"
        active={props.playback.compress}
        on_click={props.on_toggle_compress}
      />
      <Chip
        testid="loop-toggle"
        label="LOOP"
        active={props.playback.loop}
        on_click={props.on_toggle_loop}
      />
      <Chip
        testid="density-toggle"
        label="DENSITY"
        active={props.density}
        on_click={props.on_toggle_density}
      />
    </div>
  )
}

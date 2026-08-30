import type { JSX } from 'solid-js'
import type { Playback } from './lib/playback'

/*
 * The playback controls: play mode's four dials in the mono meta register,
 * seated under the time spine beside the scrubber, plus the spine's DENSITY
 * dial in the same register. The cluster is markup only (D4): every playback
 * transition a click can trigger is decided in `lib/playback.ts` and wired
 * through the app, and density is a view preference the app persists. An
 * engaged toggle brightens rather than colors, because hierarchy is opacity
 * and amber belongs to the canvas (C4).
 */

export type ControlsProps = {
  readonly playback: Playback
  /** The DENSITY dial's state: a view preference, not playback state. */
  readonly density: boolean
  readonly on_toggle_play: () => void
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
  readonly on_click: () => void
}

/** One chrome chip: engaged brightens via data-active, never color (C4). */
function Chip(props: ChipProps): JSX.Element {
  return (
    <button
      type="button"
      class="pb-button"
      data-testid={props.testid}
      data-active={props.active ? 'true' : undefined}
      onClick={() => props.on_click()}
    >
      {props.label}
    </button>
  )
}

/** Play, the speed dial, gap compression, the loop toggle, and density. */
export function Controls(props: ControlsProps): JSX.Element {
  return (
    <div class="playback" data-testid="playback">
      <Chip
        testid="play-toggle"
        label={props.playback.playing ? 'PAUSE' : 'PLAY'}
        on_click={props.on_toggle_play}
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

import type { JSX } from 'solid-js'
import type { Playback } from './lib/playback'

/*
 * The playback controls: play mode's four dials in the mono meta register,
 * seated under the time spine beside the scrubber. The cluster is markup only
 * (D4): every transition a click can trigger is decided in `lib/playback.ts`
 * and wired through the app. An engaged toggle brightens rather than colors,
 * because hierarchy is opacity and amber belongs to the canvas (C4).
 */

export type ControlsProps = {
  readonly playback: Playback
  readonly on_toggle_play: () => void
  readonly on_cycle_speed: () => void
  readonly on_toggle_compress: () => void
  readonly on_toggle_loop: () => void
}

/** Play, the speed dial, gap compression, and the loop toggle. */
export function Controls(props: ControlsProps): JSX.Element {
  return (
    <div class="playback" data-testid="playback">
      <button
        type="button"
        class="pb-button"
        data-testid="play-toggle"
        onClick={() => props.on_toggle_play()}
      >
        {props.playback.playing ? 'PAUSE' : 'PLAY'}
      </button>
      <button
        type="button"
        class="pb-button"
        data-testid="speed"
        onClick={() => props.on_cycle_speed()}
      >
        {`${props.playback.speed}X`}
      </button>
      <button
        type="button"
        class="pb-button"
        data-testid="compress-toggle"
        data-active={props.playback.compress ? 'true' : undefined}
        onClick={() => props.on_toggle_compress()}
      >
        COMPRESS
      </button>
      <button
        type="button"
        class="pb-button"
        data-testid="loop-toggle"
        data-active={props.playback.loop ? 'true' : undefined}
        onClick={() => props.on_toggle_loop()}
      >
        LOOP
      </button>
    </div>
  )
}

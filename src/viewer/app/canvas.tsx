import { For, Show, createMemo, type JSX } from 'solid-js'
import { live_t_plus_ms } from './lib/clock'
import { RUN_ID_PLACEHOLDER, header_stat_parts, short_run_id } from './lib/format'
import { t_plus_ms } from './lib/reduce'
import type { Session } from './lib/scene'
import type { Timeline } from './lib/timeline'
import { Scrubber } from './scrubber'
import type { SseStatus } from './sse'
import { Stage, type Viewport } from './stage'

/*
 * The run canvas shell: ground, header chrome, the stage the metro geometry is
 * drawn into, and the time spine along the bottom.
 *
 * Components stay this thin on purpose (D4). Everything with a decision in it
 * lives in `lib/`, mutation-gated; what is left here is markup the Playwright
 * suite photographs. Component names are PascalCase because Solid's JSX reads
 * a lowercase tag as an HTML element, which is the one place the codebase's
 * snake_case export rule cannot reach.
 *
 * The header names which timeline is live. While the app follows the newest
 * event the chip is the SSE status and the clock counts real time between
 * frames; scrubbed off that edge the chip reads REPLAY in the white family
 * (never amber, C4), the clock freezes at the folded prefix's own T+, and a
 * return-to-live control re-attaches to the edge.
 */

const STATUS_LABEL: Record<SseStatus, string> = {
  connecting: 'CONNECTING',
  live: 'LIVE',
  offline: 'OFFLINE',
}

export type CanvasProps = {
  readonly session: Session
  readonly status: SseStatus
  readonly viewport: Viewport
  /** When the newest frame arrived, on the same clock as `now_ms`. */
  readonly received_at_ms: number | null
  /** The shell's monotonic clock, advanced once per animation frame. */
  readonly now_ms: number
  /** True while the app is pinned to the newest event; false when scrubbed back. */
  readonly following: boolean
  /** The run's spine of time, for the scrubber the header rides over. */
  readonly timeline: Timeline
  /** The playhead position, 0 at T+0 and 1 at the live edge. */
  readonly fraction: number
  /** A scrubber drag resolves to a fraction the app maps back to an event. */
  readonly on_seek: (fraction: number) => void
  /** Re-attach to the newest event from a scrubbed position. */
  readonly on_return_to_live: () => void
}

/** The status chip: a white dot and a word, never amber (C4). */
function StatusChip(props: { readonly status: SseStatus }): JSX.Element {
  return (
    <span
      class={props.status === 'live' ? 'status status-live' : 'status status-offline'}
      data-testid="status"
    >
      <i class="status-dot" />
      {STATUS_LABEL[props.status]}
    </span>
  )
}

/** The whole canvas: header chrome over the scaffold stage and the time spine. */
export function Canvas(props: CanvasProps): JSX.Element {
  const stats = createMemo(() =>
    header_stat_parts({
      t_plus_ms: live_t_plus_ms({
        fold_t_plus_ms: t_plus_ms(props.session.state),
        run_over: props.session.state.run_status !== null,
        connected: props.following && props.status === 'live',
        received_at_ms: props.received_at_ms,
        now_ms: props.now_ms,
      }),
      retries_absorbed: props.session.state.retries_absorbed,
      scars: props.session.state.scars,
      cost_usd: props.session.state.cost_usd,
    }),
  )
  return (
    <div class="canvas">
      <header class="canvas-header">
        <div class="run">
          <span class="run-key">run</span>
          <span class="run-id" data-testid="run-id">
            {props.session.state.run_id === null
              ? RUN_ID_PLACEHOLDER
              : short_run_id(props.session.state.run_id)}
          </span>
          <Show
            when={props.following}
            fallback={
              <span class="status status-replay" data-testid="status">
                <i class="status-dot" />
                REPLAY
              </span>
            }
          >
            <StatusChip status={props.status} />
          </Show>
          <Show when={!props.following}>
            <button
              type="button"
              class="return-live"
              data-testid="return-to-live"
              onClick={() => props.on_return_to_live()}
            >
              RETURN TO LIVE
            </button>
          </Show>
        </div>
        <div class="stats" data-testid="stats">
          <For each={stats()}>
            {(part) => <span class={`stats-${part.role}`}>{part.text}</span>}
          </For>
        </div>
      </header>
      <Stage session={props.session} viewport={props.viewport} />
      <Show when={props.timeline.count > 0}>
        <Scrubber
          timeline={props.timeline}
          fraction={props.fraction}
          width={props.viewport.width}
          on_seek={props.on_seek}
        />
      </Show>
    </div>
  )
}

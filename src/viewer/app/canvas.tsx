import type { JSX } from 'solid-js'
import { RUN_ID_PLACEHOLDER, event_count_word, short_run_id } from './lib/format'
import type { SseStatus } from './sse'

/*
 * The run canvas shell: ground, header chrome, and the empty stage the metro
 * geometry will be drawn into.
 *
 * Components stay this thin on purpose (D4). Everything with a decision in it
 * lives in `lib/`, mutation-gated; what is left here is markup the Playwright
 * suite photographs. Component names are PascalCase because Solid's JSX reads
 * a lowercase tag as an HTML element, which is the one place the codebase's
 * snake_case export rule cannot reach.
 */

const STATUS_LABEL: Record<SseStatus, string> = {
  connecting: 'CONNECTING',
  live: 'LIVE',
  offline: 'OFFLINE',
}

export type CanvasProps = {
  readonly run_id: string | null
  readonly status: SseStatus
  readonly event_count: number
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

/** The whole canvas: header chrome over an empty stage. */
export function Canvas(props: CanvasProps): JSX.Element {
  return (
    <div class="canvas">
      <header class="canvas-header">
        <div class="run">
          <span class="run-key">run</span>
          <span class="run-id" data-testid="run-id">
            {props.run_id === null ? RUN_ID_PLACEHOLDER : short_run_id(props.run_id)}
          </span>
          <StatusChip status={props.status} />
        </div>
        <div class="stats" data-testid="stats">
          <span class="stats-value">{props.event_count}</span>{' '}
          <span class="stats-word">{event_count_word(props.event_count)}</span>
        </div>
      </header>
      <svg class="stage" data-testid="stage" fill="none" />
    </div>
  )
}

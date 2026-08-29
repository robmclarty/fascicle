import { For, createMemo, type JSX } from 'solid-js'
import { RUN_ID_PLACEHOLDER, header_stat_parts, short_run_id } from './lib/format'
import { t_plus_ms } from './lib/reduce'
import type { Session } from './lib/scene'
import type { SseStatus } from './sse'
import { Stage, type Viewport } from './stage'

/*
 * The run canvas shell: ground, header chrome, and the stage the metro
 * geometry is drawn into.
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
  readonly session: Session
  readonly status: SseStatus
  readonly viewport: Viewport
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

/** The whole canvas: header chrome over the scaffold stage. */
export function Canvas(props: CanvasProps): JSX.Element {
  const stats = createMemo(() =>
    header_stat_parts({
      t_plus_ms: t_plus_ms(props.session.state),
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
          <StatusChip status={props.status} />
        </div>
        <div class="stats" data-testid="stats">
          <For each={stats()}>
            {(part) => <span class={`stats-${part.role}`}>{part.text}</span>}
          </For>
        </div>
      </header>
      <Stage session={props.session} viewport={props.viewport} />
    </div>
  )
}

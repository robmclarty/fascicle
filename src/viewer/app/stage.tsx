import { For, Show, createMemo, type JSX } from 'solid-js'
import { TOKENS, fit_viewport, layout } from './lib/layout'
import { build_scene, type Session } from './lib/scene'

/*
 * The stage: the metro geometry drawn into the canvas's SVG layer.
 *
 * Everything here is a one-to-one mapping from scene records to elements
 * (D4): coordinates come from layout, text and status from the scene, and
 * treatment from CSS keyed off `data-status`. At T+0 that treatment is the
 * whole scaffold, dashed and pending; the runtime layers (amber traversal,
 * traversed grey, ticks) arrive in later steps as more scene fields, not as
 * component logic.
 */

export type Viewport = {
  readonly width: number
  readonly height: number
}

export type StageProps = {
  readonly session: Session
  readonly viewport: Viewport
}

/** The SVG stage: scaffold segments, node pucks, labels, all under one fit. */
export function Stage(props: StageProps): JSX.Element {
  const structure = createMemo(() => props.session.structure)
  const flow = createMemo(() => layout(structure()))
  const scene = createMemo(() => build_scene(flow(), props.session))
  const fit = createMemo(() =>
    fit_viewport(flow(), props.viewport.width, props.viewport.height),
  )
  return (
    <svg class="stage" data-testid="stage" fill="none">
      <g
        transform={`translate(${fit().offset_x} ${fit().offset_y}) scale(${fit().scale})`}
      >
        <g class="scaffold" data-testid="scaffold">
          <For each={flow().segments}>
            {(segment) => (
              <path
                class="seg seg-unbuilt"
                d={segment.path}
                data-role={segment.role}
                data-to={segment.to}
              />
            )}
          </For>
        </g>
        <For each={scene().nodes}>
          {(node) => (
            <g
              class="node"
              data-status={node.status}
              data-node-id={node.glyph.id}
              data-testid="node"
            >
              <circle
                class="puck"
                cx={node.glyph.center.x}
                cy={node.glyph.center.y}
                r={node.glyph.radius}
              />
              <Show when={node.glyph.terminus}>
                <circle
                  class="terminus-ring"
                  cx={node.glyph.center.x}
                  cy={node.glyph.center.y}
                  r={TOKENS.terminus_ring_radius}
                />
              </Show>
              <text class="node-name" x={node.glyph.name_anchor.x} y={node.glyph.name_anchor.y}>
                {node.glyph.label}
              </text>
              <text class="node-meta" x={node.glyph.meta_anchor.x} y={node.glyph.meta_anchor.y}>
                {node.meta}
              </text>
            </g>
          )}
        </For>
        <For each={scene().junctions}>
          {(junction) => (
            <g class="junction" data-status={junction.status} data-testid="junction">
              <circle
                class="puck"
                cx={junction.glyph.center.x}
                cy={junction.glyph.center.y}
                r={junction.glyph.radius}
              />
              <text
                class="junction-label"
                x={junction.glyph.label_anchor.x}
                y={junction.glyph.label_anchor.y}
              >
                {junction.label}
              </text>
            </g>
          )}
        </For>
        <For each={scene().group_labels}>
          {(label) => (
            <g class="group-label" data-owner={label.anchor.owner} data-testid="group-label">
              <line
                class="group-tick"
                x1={label.anchor.tick.x}
                y1={label.anchor.tick.y}
                x2={label.anchor.tick.x + TOKENS.group_tick_length}
                y2={label.anchor.tick.y}
              />
              <text class="group-text" x={label.anchor.text_anchor.x} y={label.anchor.text_anchor.y}>
                {label.text}
              </text>
            </g>
          )}
        </For>
      </g>
    </svg>
  )
}

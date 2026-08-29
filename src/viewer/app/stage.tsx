import { For, Show, createMemo, type JSX } from 'solid-js'
import { TOKENS, fit_viewport, layout } from './lib/layout'
import {
  BLOOM_RADIUS,
  HALO_RADIUS,
  build_scene,
  type SceneSegment,
  type Session,
} from './lib/scene'

/*
 * The stage: the metro geometry drawn into the canvas's SVG layer.
 *
 * Everything here is a one-to-one mapping from scene records to elements
 * (D4): coordinates come from layout, text and status from the scene, and
 * treatment from CSS keyed off `data-status` and `data-state`. The scene
 * decides where the light is; this file only stacks the artboard's layers in
 * order: ambient bloom under everything, the line work, the halo, pucks and
 * their type, then the ember marks.
 */

export type Viewport = {
  readonly width: number
  readonly height: number
}

export type StageProps = {
  readonly session: Session
  readonly viewport: Viewport
}

/** The half-length of a fail mark's ✕ arms, from artboard 01. */
const MARK_ARM = 4.5

/** A live segment is the artboard's amber trio: two glow washes, one march. */
function LiveSegment(props: { readonly scene_segment: SceneSegment }): JSX.Element {
  return (
    <g
      class="seg-live"
      data-role={props.scene_segment.segment.role}
      data-to={props.scene_segment.segment.to}
      data-state="live"
    >
      <path class="seg seg-live-outer" d={props.scene_segment.segment.path} />
      <path class="seg seg-live-inner" d={props.scene_segment.segment.path} />
      <path class="seg seg-live-march" d={props.scene_segment.segment.path} />
    </g>
  )
}

/** The SVG stage: segments, pucks, labels, and the light, all under one fit. */
export function Stage(props: StageProps): JSX.Element {
  const structure = createMemo(() => props.session.structure)
  const flow = createMemo(() => layout(structure()))
  const scene = createMemo(() => build_scene(flow(), props.session))
  const active_nodes = createMemo(() =>
    scene().nodes.filter((node) => node.status === 'active'),
  )
  const fit = createMemo(() =>
    fit_viewport(flow(), props.viewport.width, props.viewport.height),
  )
  return (
    <svg class="stage" data-testid="stage" fill="none">
      <defs>
        <radialGradient id="halo">
          <stop offset="0%" stop-color="#FFAC33" stop-opacity="0.5" />
          <stop offset="45%" stop-color="#FFAC33" stop-opacity="0.16" />
          <stop offset="78%" stop-color="#FFAC33" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="bloom">
          <stop offset="0%" stop-color="#FFAC33" stop-opacity="0.055" />
          <stop offset="70%" stop-color="#FFAC33" stop-opacity="0" />
        </radialGradient>
        <filter id="glow-2" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2" />
        </filter>
        <filter id="glow-4" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      <g
        transform={`translate(${fit().offset_x} ${fit().offset_y}) scale(${fit().scale})`}
      >
        <For each={active_nodes()}>
          {(node) => (
            <circle
              class="bloom"
              cx={node.glyph.center.x}
              cy={node.glyph.center.y}
              r={BLOOM_RADIUS}
            />
          )}
        </For>
        <g class="scaffold" data-testid="scaffold">
          <For each={scene().segments}>
            {(scene_segment) => (
              <Show
                when={scene_segment.state === 'live'}
                fallback={
                  <path
                    class={
                      scene_segment.state === 'traversed'
                        ? 'seg seg-traversed'
                        : 'seg seg-unbuilt'
                    }
                    d={scene_segment.segment.path}
                    data-role={scene_segment.segment.role}
                    data-to={scene_segment.segment.to}
                    data-state={scene_segment.state}
                  />
                }
              >
                <LiveSegment scene_segment={scene_segment} />
              </Show>
            )}
          </For>
        </g>
        <For each={active_nodes()}>
          {(node) => (
            <circle
              class="halo"
              cx={node.glyph.center.x}
              cy={node.glyph.center.y}
              r={HALO_RADIUS}
            />
          )}
        </For>
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
                r={
                  node.status === 'active'
                    ? node.glyph.radius + 0.5
                    : node.glyph.radius
                }
              />
              <Show when={node.status === 'active'}>
                <circle
                  class="puck-core"
                  cx={node.glyph.center.x}
                  cy={node.glyph.center.y}
                  r={2.5}
                />
              </Show>
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
        <For each={scene().fail_marks}>
          {(mark) => (
            <path
              class="fail-mark"
              d={
                `M ${mark.x - MARK_ARM} ${mark.y - MARK_ARM} L ${mark.x + MARK_ARM} ${mark.y + MARK_ARM} ` +
                `M ${mark.x + MARK_ARM} ${mark.y - MARK_ARM} L ${mark.x - MARK_ARM} ${mark.y + MARK_ARM}`
              }
            />
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

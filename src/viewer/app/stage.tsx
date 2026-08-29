import { For, Match, Show, Switch, createMemo, type JSX } from 'solid-js'
import { TOKENS, fit_viewport, layout } from './lib/layout'
import {
  BLOOM_RADIUS,
  HALO_RADIUS,
  build_scene,
  type InstanceTick,
  type ScarMark,
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

/** The half-length of an ember ✕'s arms, from artboards 01 and 04. */
const MARK_ARM = 4.5

/** A map instance tick's half-height, the perpendicular mark on the line (03). */
const TICK_HALF = 6

/** A failed instance keeps its slot as this smaller ember ✕ (artboard 03). */
const TICK_MARK_ARM = 4

/** The scar puck's broken ring radius and its ground mask, from artboard 04. */
const SCAR_RING_RADIUS = 8.5
const SCAR_MASK_RADIUS = 13

/** Rotating the dashes off the cardinal axes reads as a shattered ring (04). */
const SCAR_RING_ROTATE = -32

/** The two-stroke ✕ the retry fail marks and the scar mark both draw. */
function cross_path(x: number, y: number, arm: number): string {
  return (
    `M ${x - arm} ${y - arm} L ${x + arm} ${y + arm} ` +
    `M ${x + arm} ${y - arm} L ${x - arm} ${y + arm}`
  )
}

/**
 * A scarred node's puck (artboard 04): a ground mask that hides the dead line
 * beneath it, the broken ring in place of the whole one, and the ember ✕
 * orbiting its seat. The mask sits first so the ring and mark draw over clean
 * ground.
 */
function ScarPuck(props: {
  readonly center: { readonly x: number; readonly y: number }
  readonly mark: ScarMark
}): JSX.Element {
  return (
    <>
      <circle
        class="scar-mask"
        cx={props.center.x}
        cy={props.center.y}
        r={SCAR_MASK_RADIUS}
      />
      <circle
        class="scar-ring"
        cx={props.center.x}
        cy={props.center.y}
        r={SCAR_RING_RADIUS}
        transform={`rotate(${SCAR_RING_ROTATE} ${props.center.x} ${props.center.y})`}
      />
      <path class="scar-mark" d={cross_path(props.mark.x, props.mark.y, MARK_ARM)} />
    </>
  )
}

/**
 * One map instance tick (artboard 03): a done instance is a grey mark, an alive
 * one the only amber on the lane (a crisp stroke over a blurred wash), and a
 * failed one keeps its slot as an ember ✕ rather than a line.
 */
function Tick(props: { readonly tick: InstanceTick }): JSX.Element {
  const top = (): number => props.tick.y - TICK_HALF
  const bottom = (): number => props.tick.y + TICK_HALF
  return (
    <Switch>
      <Match when={props.tick.status === 'failed'}>
        <path
          class="tick-fail"
          d={cross_path(props.tick.x, props.tick.y, TICK_MARK_ARM)}
        />
      </Match>
      <Match when={props.tick.status === 'live'}>
        <line
          class="tick tick-live-glow"
          x1={props.tick.x}
          y1={top()}
          x2={props.tick.x}
          y2={bottom()}
        />
        <line
          class="tick tick-live"
          x1={props.tick.x}
          y1={top()}
          x2={props.tick.x}
          y2={bottom()}
        />
      </Match>
      <Match when={props.tick.status === 'done'}>
        <line
          class="tick tick-done"
          x1={props.tick.x}
          y1={top()}
          x2={props.tick.x}
          y2={bottom()}
        />
      </Match>
    </Switch>
  )
}

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
        <For each={scene().tick_lanes}>
          {(lane) => (
            <g class="tick-lane" data-owner={lane.owner} data-testid="tick-lane">
              <For each={lane.ticks}>{(tick) => <Tick tick={tick} />}</For>
              <For each={lane.decades}>
                {(decade) => (
                  <text class="tick-decade" x={decade.x} y={decade.y}>
                    {decade.value}
                  </text>
                )}
              </For>
            </g>
          )}
        </For>
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
              data-scar={node.scar === null ? undefined : 'true'}
              data-node-id={node.glyph.id}
              data-testid="node"
            >
              <Show
                when={node.scar}
                fallback={
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
                }
              >
                {(mark) => <ScarPuck center={node.glyph.center} mark={mark()} />}
              </Show>
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
                <Show when={node.meta_fail}>
                  {(fail) => (
                    <>
                      <tspan> · </tspan>
                      <tspan class="meta-fail">{fail()}</tspan>
                    </>
                  )}
                </Show>
              </text>
            </g>
          )}
        </For>
        <For each={scene().fail_marks}>
          {(mark) => (
            <path class="fail-mark" d={cross_path(mark.x, mark.y, MARK_ARM)} />
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

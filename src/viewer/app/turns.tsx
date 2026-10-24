import { Index, Show, createMemo, createSignal, type JSX } from 'solid-js'
import {
  captured_turn_json,
  copy_label,
  drawer_meta,
  fold_text,
  request_view,
  response_view,
  selected_index,
  turn_row,
  type CopyState,
  type MessageView,
  type TurnBlock,
  type ViewerTurn,
} from './lib/turns'

/*
 * The turn inspector: the drawer a node's turns badge opens.
 *
 * It lists the turns a model call captured, newest selected first, and lays
 * the selected turn's request (its system prompt, its tool names, and its
 * messages by role) beside the reply the provider sent. Every string and
 * every fold point comes from `lib/turns.ts`, so this file is markup, the
 * same split the canvas keeps. The drawer stays in the canvas's language:
 * the warm ground, the mono meta register, hierarchy by opacity, no amber
 * (nothing in it is alive), and ember only as the ✕ beside a tool result
 * that went back flagged `is_error`.
 *
 * The copy control hands the turn, in the `CapturedTurn` shape that
 * `replay_turn` takes, to a clipboard writer the app injects, because the
 * clipboard is a browser global and only the entry module touches those.
 */

export type TurnDrawerProps = {
  /** The node's display name, as its puck is labelled. */
  readonly name: string
  readonly turns: ReadonlyArray<ViewerTurn>
  /** The drawer's width in pixels, which the stage fits the flow beside. */
  readonly width: number
  readonly copy_text: (text: string) => Promise<void>
  readonly on_close: () => void
}

/** A text that folds when it runs long, with the control that opens it. */
function Folded(props: { readonly text: string; readonly format: TurnBlock['format'] }): JSX.Element {
  const [open, set_open] = createSignal(false)
  const folded = createMemo(() => fold_text(props.text))
  return (
    <>
      <pre class={`td-text td-${props.format}`}>{open() ? props.text : folded().head}</pre>
      <Show when={folded().more}>
        {(more) => (
          <button
            type="button"
            class="td-fold"
            data-testid="fold-toggle"
            aria-expanded={open()}
            onClick={() => set_open(!open())}
          >
            {open() ? 'FOLD' : more()}
          </button>
        )}
      </Show>
    </>
  )
}

/** A label in the drawer's caption register, with the identifier it names kept verbatim. */
function Label(props: { readonly label: string; readonly name: string | null }): JSX.Element {
  return (
    <span class="td-label">
      {props.label}
      <Show when={props.name}>{(name) => <span class="td-name-ref">{name()}</span>}</Show>
    </span>
  )
}

/** One piece of a message or a reply: its label when it has one, and its folded body. */
function Block(props: { readonly block: TurnBlock }): JSX.Element {
  return (
    <div class="td-block">
      <Show when={props.block.label}>
        {(label) => <Label label={label()} name={props.block.name} />}
      </Show>
      <Folded text={props.block.body} format={props.block.format} />
    </div>
  )
}

/** One message of the request, its role leading it. */
function Message(props: { readonly view: MessageView }): JSX.Element {
  return (
    <div class="td-msg" data-role={props.view.role} data-testid="turn-message">
      <div class="td-msg-head">
        <Label label={props.view.label} name={props.view.name} />
        <Show when={props.view.error}>
          <span class="td-flag">
            <span class="td-error">✕</span> IS_ERROR
          </span>
        </Show>
      </div>
      <Index each={props.view.blocks}>{(block) => <Block block={block()} />}</Index>
    </div>
  )
}

/** The selected turn: its request in one column, the reply beside it. */
function TurnDetail(props: { readonly turn: ViewerTurn }): JSX.Element {
  const request = createMemo(() => request_view(props.turn))
  const response = createMemo(() => response_view(props.turn))
  return (
    <div class="td-body">
      <section class="td-col" data-testid="turn-request">
        <h3 class="td-sec">REQUEST</h3>
        <Show when={request().system.length > 0}>
          <div class="td-msg" data-role="system">
            <div class="td-msg-head">
              <Label label="SYSTEM" name={null} />
            </div>
            <Index each={request().system}>
              {(text) => (
                <div class="td-block">
                  <Folded text={text()} format="text" />
                </div>
              )}
            </Index>
          </div>
        </Show>
        <Show when={request().tools}>
          {(tools) => (
            <div class="td-msg" data-role="tools">
              <div class="td-msg-head">
                <Label label="TOOLS" name={null} />
              </div>
              <p class="td-tools" data-testid="turn-tools">
                {tools()}
              </p>
            </div>
          )}
        </Show>
        <Index each={request().messages}>{(view) => <Message view={view()} />}</Index>
      </section>
      <section class="td-col" data-testid="turn-response">
        <h3 class="td-sec">RESPONSE</h3>
        <Show when={response()} fallback={<p class="td-empty">NOT CAPTURED</p>}>
          {(blocks) => <Index each={blocks()}>{(block) => <Block block={block()} />}</Index>}
        </Show>
      </section>
    </div>
  )
}

/** The drawer: the node's turns listed, the selected one laid out, and the copy and close controls. */
export function TurnDrawer(props: TurnDrawerProps): JSX.Element {
  const [picked, set_picked] = createSignal<number | null>(null)
  const [copied, set_copied] = createSignal<CopyState | null>(null)
  const index = createMemo(() => selected_index(picked(), props.turns.length))
  const turn = createMemo(() => props.turns[index()])
  const meta = createMemo(() => drawer_meta(props.turns))
  const copy = (): void => {
    const shown = turn()
    if (shown === undefined) return
    const at = index()
    props.copy_text(captured_turn_json(shown)).then(
      () => set_copied({ index: at, ok: true }),
      () => set_copied({ index: at, ok: false }),
    )
  }
  return (
    <aside
      class="turns-drawer"
      data-testid="turn-drawer"
      aria-label={`Captured turns of ${props.name}`}
      style={{ width: `${props.width}px` }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') props.on_close()
      }}
    >
      <header class="td-head">
        <div class="td-title">
          <span class="td-node">{props.name}</span>
          <span class="td-meta">
            {meta().count}
            <Show when={meta().model}>
              {(model) => (
                <>
                  <span class="td-sep">·</span>
                  <span class="td-model">{model()}</span>
                </>
              )}
            </Show>
          </span>
        </div>
        <div class="td-actions">
          <button type="button" class="td-chip" data-testid="copy-turn" onClick={copy}>
            {copy_label(copied(), index())}
          </button>
          <button
            type="button"
            class="td-chip"
            data-testid="close-turns"
            onClick={() => props.on_close()}
          >
            CLOSE
          </button>
        </div>
      </header>
      <ol class="td-list" data-testid="turn-list">
        <Index each={props.turns}>
          {(item, at) => {
            const row = createMemo(() => turn_row(item()))
            return (
              <li>
                <button
                  type="button"
                  class="td-turn"
                  data-testid="turn-row"
                  data-selected={at === index() ? 'true' : undefined}
                  aria-pressed={at === index()}
                  onClick={() => set_picked(at)}
                >
                  <span class="td-step">{row().step}</span>
                  <span class="td-tokens">{row().tokens}</span>
                  <span class="td-cache">{row().cache}</span>
                </button>
              </li>
            )
          }}
        </Index>
      </ol>
      {/* Keyed on the position, so picking another turn folds its long content
          afresh, while a live run's new frames update the shown turn in place. */}
      <Show keyed when={index() + 1}>
        {(position) => (
          <Show when={props.turns[position - 1]}>{(shown) => <TurnDetail turn={shown()} />}</Show>
        )}
      </Show>
    </aside>
  )
}

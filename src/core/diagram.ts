/**
 * The renderer behind `describe.diagram(step)`: a flow drawn as an annotated
 * box-drawing tree.
 *
 * It reads only the `FlowNode` tree that `describe.json` produces, so the same
 * flow renders to the same bytes wherever it is built, and an app can hold the
 * diagram in its `flow.ts` header to the code with one equality test.
 *
 * Each node gets one row. A row is labelled with the node's display name, then
 * an id the author chose, then its kind. A counter-generated id never appears,
 * because its number depends on what else the process built first. Roles come
 * from the parent's kind (a branch's `then` and `else`, a loop's `guard`, a
 * parallel member's key, a chain's stages), never from a config dump.
 * Descriptions share one column after the widest row. A composer's description
 * follows its kind (`branch: ...`), and a node without one shows its kind.
 */

import { resolve_display_name } from './display_name.js'
import { is_step_kind } from './step_kinds.js'
import type { FlowNode, FlowValue } from './types.js'

export type DiagramOptions = {
  /** Throw `describe_cycle_error` on a cycle instead of drawing `<cycle>`, as `describe` does. */
  readonly strict?: boolean
  /** Wrap descriptions so that no line runs wider than this, `prefix` included. */
  readonly width?: number
  /** Written at the start of every line, for example `' * '` for a doc comment. */
  readonly prefix?: string
}

type Item = {
  readonly head: string
  readonly note: ReadonlyArray<string>
  readonly children: ReadonlyArray<Item>
}

type Row = {
  readonly lead: string
  readonly head: string
  readonly note: ReadonlyArray<string>
  readonly wrap_lead: string
}

// Built-in kinds whose id the caller supplies. Every other built-in kind
// numbers its id from a process-wide counter.
const CHOSEN_ID_KINDS: ReadonlySet<string> = new Set(['step', 'suspend'])

const BRANCH_ROLES: ReadonlyArray<string> = ['then', 'else']

const STAGE_PREFIX = 'stage:'

const COLUMN_GAP = 2

/**
 * Draw a `FlowNode` tree as rows of box-drawing glyphs, labels, and aligned
 * descriptions, joined with newlines and free of trailing whitespace.
 */
export function render_diagram(root: FlowNode, options?: DiagramOptions): string {
  const rows: Row[] = []
  flatten(to_item(root, undefined), '', '', rows)
  const column = Math.max(...rows.map((row) => row.lead.length + row.head.length)) + COLUMN_GAP
  const prefix = options?.prefix ?? ''
  const limit =
    options?.width === undefined ? Number.POSITIVE_INFINITY : options.width - prefix.length - column
  return rows
    .flatMap((row) => {
      const [first, ...rest] = wrap(row.note, limit)
      const head = `${row.lead}${row.head}`
      return [
        first === undefined ? head : `${head.padEnd(column)}${first}`,
        ...rest.map((line) => `${row.wrap_lead.padEnd(column)}${line}`),
      ]
    })
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

/**
 * Append `item` and its subtree to `rows` in reading order.
 *
 * `indent` is the glyph run this item's children are drawn after. A wrapped
 * description line reuses it, plus a bar when children follow, so the
 * vertical lines stay unbroken through the wrap.
 */
function flatten(item: Item, lead: string, indent: string, rows: Row[]): void {
  const has_children = item.children.length > 0
  rows.push({
    lead,
    head: item.head,
    note: item.note,
    wrap_lead: has_children ? `${indent}│` : indent,
  })
  item.children.forEach((child, index) => {
    const last = index === item.children.length - 1
    flatten(child, `${indent}${last ? '└─ ' : '├─ '}`, `${indent}${last ? '   ' : '│  '}`, rows)
  })
}

/**
 * Break a description's words into lines no longer than `limit`. A word
 * longer than `limit` gets a line to itself rather than being split.
 */
function wrap(words: ReadonlyArray<string>, limit: number): ReadonlyArray<string> {
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current === '') {
      current = word
    } else if (current.length + 1 + word.length <= limit) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

/**
 * Convert one node into the item the layout draws. `role` is the name the
 * parent gives this child, and it is dropped when it only repeats the label.
 */
function to_item(node: FlowNode, role: string | undefined): Item {
  const { label, by_kind } = label_of(node)
  return {
    head: role === undefined || role === label ? label : `${role}  ${label}`,
    note: note_of(node, by_kind),
    children: child_items(node),
  }
}

/**
 * Pick a node's label: its display name, else an id its author chose, else
 * its kind. `by_kind` reports the last case, where the kind already shows.
 */
function label_of(node: FlowNode): { readonly label: string; readonly by_kind: boolean } {
  const display = resolve_display_name(node, '')
  if (display !== '') return { label: display, by_kind: false }
  if (has_chosen_id(node)) return { label: node.id, by_kind: false }
  return { label: node.kind, by_kind: true }
}

/**
 * True when a node's id was chosen by its author. Anonymous steps, cycle
 * markers, and every built-in composer carry generated ids. A kind outside
 * the built-in set belongs to a hand-built step, whose id is its author's.
 */
function has_chosen_id(node: FlowNode): boolean {
  if (node.anonymous === true || node.kind === '<cycle>') return false
  return !is_step_kind(node.kind) || CHOSEN_ID_KINDS.has(node.kind)
}

/**
 * The words of a row's description column.
 *
 * A row labelled by its kind shows only the description. A plain step shows
 * its description, or `step` without one. Any other node shows its kind, then
 * the description after a colon. Whitespace in a description collapses, so a
 * multi-line string still draws as one wrapped column.
 */
function note_of(node: FlowNode, by_kind: boolean): ReadonlyArray<string> {
  const words = (node.meta?.description ?? '').split(/\s+/).filter((word) => word !== '')
  if (by_kind) return words
  if (node.kind === 'step') return words.length > 0 ? words : ['step']
  return words.length > 0 ? [`${node.kind}:`, ...words] : [node.kind]
}

/**
 * Convert a node's children, naming each by the role its parent's kind gives
 * it.
 */
function child_items(node: FlowNode): ReadonlyArray<Item> {
  const children = node.children ?? []
  if (node.kind === 'branch') return children.map((child, i) => to_item(child, BRANCH_ROLES[i]))
  if (node.kind === 'loop') {
    return children.map((child, i) => to_item(child, i === 1 ? 'guard' : undefined))
  }
  if (node.kind === 'parallel') {
    const keys = string_list(node.config?.['keys'])
    return children.map((child, i) => to_item(child, keys[i]))
  }
  if (node.kind === 'chain') return staged_items(children, string_list(node.config?.['plan']))
  return children.map((child) => to_item(child, undefined))
}

/**
 * Convert a chain's children in plan order, nesting the entries after each
 * `.stage(name)` under a row for that stage, which is how the stage's span
 * encloses them in the trajectory. Children the plan does not account for
 * follow in order, so a node without a plan still draws every child.
 */
function staged_items(
  children: ReadonlyArray<FlowNode>,
  plan: ReadonlyArray<string>,
): ReadonlyArray<Item> {
  const top: Item[] = []
  let target = top
  let next = 0
  for (const entry of plan) {
    if (entry.startsWith(STAGE_PREFIX)) {
      const members: Item[] = []
      top.push({ head: `stage  ${entry.slice(STAGE_PREFIX.length)}`, note: [], children: members })
      target = members
    } else {
      const child = children[next]
      next += 1
      if (child !== undefined) target.push(to_item(child, undefined))
    }
  }
  for (const child of children.slice(next)) target.push(to_item(child, undefined))
  return top
}

/**
 * Read a config value as a list of strings, as `parallel` records its keys
 * and `chain` its plan. Anything else reads as an empty list.
 */
function string_list(value: FlowValue | undefined): ReadonlyArray<string> {
  if (!Array.isArray(value)) return []
  const list: ReadonlyArray<unknown> = value
  return list.filter((entry): entry is string => typeof entry === 'string')
}

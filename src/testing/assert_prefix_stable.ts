/**
 * assert_prefix_stable: a check that each turn of a tool loop only appends.
 *
 * A provider's prompt cache matches a request by its prefix: the system
 * prompt, the tools, and the messages, as the wire sends them. A loop whose
 * every turn sends the turn before it whole, with new messages after it,
 * keeps that prefix, so each turn can read the last one from the cache. A
 * loop that rewrites the prefix (a `prepare_step` sliding window, a tool
 * list rebuilt in another order, a system prompt that changes) misses the
 * cache on every turn, and nothing else fails to say so. This check reads
 * the requests that a double such as make_loop_engine recorded and throws
 * at the first turn that changed what an earlier turn sent.
 *
 * Requests carry no call id, so the check splits them into calls wherever a
 * `step_index` doesn't increase. It reads calls that ran one at a time:
 * calls that ran at once interleave on one engine, so a `parallel` flow
 * takes one double per branch. A retried turn repeats its `step_index`, so
 * it starts a new call in the check.
 */

import type { Message, Tool, TurnRequest } from '#engine'
import { to_json_schema } from '#schema'

const ONE_AT_A_TIME = 'the check reads calls that ran one at a time, so a parallel flow takes one double per branch'

/** A tool list as its names, in order, the way a message prints it. */
function listed(tools: ReadonlyArray<Tool>): string {
  return `[${tools.map((tool) => tool.name).join(', ')}]`
}

/**
 * How a tool's schema changed since the earlier turn: nothing when both
 * turns hold the same object or the same JSON Schema, and a difference that
 * names the tool when they don't, or when a new object can't be converted.
 */
function schema_difference(before: Tool, after: Tool, step: number): string | undefined {
  if (after.input_schema === before.input_schema) return undefined
  try {
    const same =
      JSON.stringify(to_json_schema(after.input_schema)) === JSON.stringify(to_json_schema(before.input_schema))
    return same ? undefined : `the input schema of tool ${after.name} differs from step ${step}`
  } catch {
    return `the input schema of tool ${after.name} is a new object since step ${step}, and it has no JSON Schema to compare`
  }
}

/** The first way the later turn's tools differ from the earlier turn's: their names in order, a description, or a schema. */
function tool_difference(earlier: ReadonlyArray<Tool>, later: ReadonlyArray<Tool>, step: number): string | undefined {
  const renamed = `the tools are ${listed(later)} where step ${step} sent ${listed(earlier)}`
  for (const [i, before] of earlier.entries()) {
    const after = later[i]
    if (after === undefined || after.name !== before.name) return renamed
    if (after.description !== before.description) {
      return `the description of tool ${after.name} differs from step ${step}`
    }
    const schema = schema_difference(before, after, step)
    if (schema !== undefined) return schema
  }
  return later.length > earlier.length ? renamed : undefined
}

/** The first message of the earlier turn that the later turn doesn't send again as the same JSON text. */
function message_difference(
  earlier: ReadonlyArray<Message>,
  later: ReadonlyArray<Message>,
  step: number,
): string | undefined {
  for (const [i, before] of earlier.entries()) {
    if (JSON.stringify(later[i]) !== JSON.stringify(before)) {
      return later.length > i ? `message ${i} differs from step ${step}` : `message ${i} from step ${step} is missing`
    }
  }
  return undefined
}

/** The first way the later turn changed what the earlier turn of its call sent. */
function first_difference(earlier: TurnRequest, later: TurnRequest): string | undefined {
  const step = earlier.step_index
  if (later.system !== earlier.system) return `the system prompt differs from step ${step}`
  return tool_difference(earlier.tools, later.tools, step) ?? message_difference(earlier.messages, later.messages, step)
}

/**
 * Check that every turn of every call in `requests` sends the turn before it
 * unchanged: the same system prompt, the same tools in the same order
 * (names, descriptions, and input schemas), and every earlier message again,
 * as the same JSON text, before any new one.
 *
 * Throws a plain `Error` at the first difference, naming the call (counted
 * from 1), the step (its `step_index`), and the difference, with message and
 * tool positions as the request's arrays hold them, from 0. A new call
 * starts wherever a `step_index` doesn't increase, so the check reads calls
 * that ran one at a time, and a `parallel` flow takes one double per branch.
 */
export function assert_prefix_stable(requests: ReadonlyArray<TurnRequest>): void {
  let call = 0
  let earlier: TurnRequest | undefined
  for (const later of requests) {
    if (earlier === undefined || later.step_index <= earlier.step_index) {
      call += 1
    } else {
      const difference = first_difference(earlier, later)
      if (difference !== undefined) {
        throw new Error(
          `assert_prefix_stable: call ${call}, step ${later.step_index}: ${difference} (${ONE_AT_A_TIME})`,
        )
      }
    }
    earlier = later
  }
}

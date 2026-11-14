import type { ObjectClient, ObjectPutCondition } from 'fascicle/adapters'

type Stored = { readonly body: string; readonly etag: string }

export type Call =
  | { readonly op: 'get' | 'delete'; readonly key: string }
  | { readonly op: 'put'; readonly key: string; readonly body: string; readonly condition?: ObjectPutCondition }
  | { readonly op: 'list'; readonly prefix: string; readonly start_after?: string }

export type MemoryClient = ObjectClient & {
  readonly bucket: Map<string, Stored>
  readonly calls: Call[]
}

// Small, so a scope with more than a page of keys goes through `next`.
const PAGE_SIZE = 3

// Wait a turn of the event loop, the way a request waits on the network, so
// racing callers interleave.
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

// An in-memory bucket behind the client interface, which honors both
// conditions in one step, gives every put a fresh ETag, and keeps a list of
// the calls it took.
export function memory_client(): MemoryClient {
  const bucket = new Map<string, Stored>()
  const calls: Call[] = []
  let puts = 0
  return {
    bucket,
    calls,
    get: async (key) => {
      calls.push({ op: 'get', key })
      await tick()
      return bucket.get(key)
    },
    put: async (key, body, condition) => {
      calls.push({ op: 'put', key, body, ...(condition === undefined ? {} : { condition }) })
      await tick()
      const current = bucket.get(key)
      if (condition !== undefined) {
        const holds = 'if_none_match' in condition ? current === undefined : current?.etag === condition.if_match
        if (!holds) return false
      }
      puts += 1
      bucket.set(key, { body, etag: `etag-${puts}` })
      return true
    },
    delete: async (key) => {
      calls.push({ op: 'delete', key })
      await tick()
      bucket.delete(key)
    },
    list: async (prefix, start_after) => {
      calls.push({ op: 'list', prefix, ...(start_after === undefined ? {} : { start_after }) })
      await tick()
      return page_of(under(bucket, prefix), start_after)
    },
  }
}

// The bucket's keys that begin with `prefix`, in the order a listing gives.
function under(bucket: ReadonlyMap<string, Stored>, prefix: string): string[] {
  return [...bucket.keys()].filter((key) => key.startsWith(prefix)).toSorted()
}

// One page of `sorted` after `start_after`, naming its last key as `next`
// while more keys follow it.
function page_of(
  sorted: ReadonlyArray<string>,
  start_after: string | undefined,
): { readonly keys: ReadonlyArray<string>; readonly next?: string } {
  const from = start_after === undefined ? 0 : sorted.findLastIndex((key) => key <= start_after) + 1
  const keys = sorted.slice(from, from + PAGE_SIZE)
  const next = keys.at(-1)
  return next !== undefined && from + PAGE_SIZE < sorted.length ? { keys, next } : { keys }
}

// A client whose conditional puts land and then report a failed condition,
// the way an SDK's retry of a put whose answer got lost does.
export function losing_answers(client: MemoryClient): ObjectClient {
  return {
    ...client,
    put: async (key, body, condition) => {
      const landed = await client.put(key, body, condition)
      return condition === undefined ? landed : false
    },
  }
}

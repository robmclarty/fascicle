/**
 * Filesystem-backed checkpoint store.
 *
 * Satisfies `CheckpointStore` from `core`, every optional capability
 * included. Each key is stored as
 * a JSON file under the configured root directory. Writes are all-or-nothing:
 * values are written to a temporary sibling file and then atomically renamed
 * into place, so an interrupted write never leaves a partially written file
 * at the target key. On `get`, a missing file, a partial temp file that was
 * never atomically renamed, or a JSON parse failure each read as a cache
 * miss (returning `null`) rather than an error. Any other failure to read
 * (a permission error, a failing disk) surfaces, because reading it as a miss
 * could start a durable run over, or hand a live claim to a second owner.
 *
 * A scope is a directory beside the values (`<prefix>.scope/`), which makes
 * `clear` one recursive delete. A claim is a directory of numbered
 * generations (`<key>.claim/<n>.json`), and the newest one is the claim. A
 * claimer takes a free or expired key by creating the next generation with
 * `link`, which makes the file appear whole and refuses a target that
 * already exists, so two claimers can't both create it. Taking an expired
 * claim never overwrites a live one, which a rename into place couldn't
 * promise, and a claimer that finds a newer generation than its own has lost.
 *
 * A value's version, for `get_versioned` and `set_if`, is a hash of its
 * file's bytes, so the files stay where they always were. Every write to a
 * key holds a lock on it while it works, `set` and `delete` included, which
 * is what makes `set_if` atomic against all of them. The lock is an empty
 * directory beside the value (`<key>.lock/`), made with one `mkdir`, which
 * refuses a directory that exists, and removed with one `rmdir` when the
 * write is done, so nothing stays behind. Under the lock, `set_if` writes its
 * temporary file, reads the bytes at the key, and renames the file into place
 * only when their hash is the version it was given. A create
 * (`expected: null`) needs no lock, because it's the same `link` a claim
 * uses.
 *
 * The lock costs a write two calls more than it would make without one: a
 * `set` is four filesystem calls, a `delete` three, and a `set_if` on a
 * version six. Writers to one key go one at a time. Those in one process
 * queue in memory, and those in other processes ask for the lock again every
 * couple of milliseconds, so a key that many writers want at once is as slow
 * as the queue is long.
 *
 * A writer that dies between its `mkdir` and its `rmdir` leaves the lock
 * behind. A lock older than ten seconds counts as abandoned, and the writer
 * that finds one removes it while holding a claim on the directory's
 * `lock.recovery/`, so two writers can't both clear the way and a lock taken
 * since is never the one removed. That directory appears the first time a
 * lock is recovered and stays. A writer that stalls for longer than ten
 * seconds inside a write is taken for dead, and the write it finishes late
 * is no longer exclusive.
 *
 * All of this leans on `link`, `rename`, and `mkdir` being atomic and on a
 * directory listing being current, which a local filesystem gives and a network
 * filesystem may not. So this is a store for the processes of one machine,
 * and a run that events reach on several hosts wants `object_store`.
 *
 * Paths are accepted at construction; the store never reads `process.env`.
 */

import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CheckpointStore } from '#core'

export type FilesystemStoreConfig = {
  readonly root_dir: string
}

/**
 * What `filesystem_store` returns: a `CheckpointStore` with every optional
 * capability, which is what `durable` needs from its store.
 */
export type FilesystemStore = Required<Omit<CheckpointStore, 'scope'>> & {
  readonly scope: (prefix: string) => FilesystemScopedStore
}

/**
 * A scope of a `filesystem_store`, which can also `clear`.
 */
export type FilesystemScopedStore = FilesystemStore & {
  readonly clear: () => Promise<void>
}

type ClaimRecord = {
  readonly owner: string
  readonly expires_at: number
}

// How old a write's lock gets before it counts as abandoned, which only
// happens when the process that took it died.
const LOCK_MS = 10_000

// How long a writer waits before it asks for a held lock again.
const LOCK_RETRY_MS = 2

// The claim directory a writer holds while it removes an abandoned lock, one
// to each directory of values. No key's files can take the name, since each
// of those carries the key's hash.
const RECOVERY = 'lock.recovery'

// The last write this process queued on each lock path, there while a write
// on that path is under way.
const turns = new Map<string, Promise<void>>()

/**
 * Turn a key or a scope prefix into a filesystem-safe name.
 *
 * Slugs it down to `[a-zA-Z0-9._-]` and appends a short hash of the whole
 * string, so two strings that slug alike still land on distinct names.
 */
function safe_name(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 12)
  const slug = key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
  return `${slug}.${hash}`
}

/**
 * Read the `code` a Node filesystem error carries, if it has one.
 */
function error_code(err: unknown): unknown {
  return err instanceof Error ? Reflect.get(err, 'code') : undefined
}

/**
 * Serialize a value for disk. A value JSON has no text for (`undefined`, a
 * bare function) is written as `null`, which reads back as a miss.
 */
function to_json(value: unknown): string {
  const text: string | undefined = JSON.stringify(value)
  return text ?? 'null'
}

/**
 * Write `value` to `path` through a temporary sibling and a rename, so a
 * reader sees the old file or the new one and never a torn one.
 */
async function write_atomic(path: string, value: unknown): Promise<void> {
  // Stryker disable next-line MethodExpression: the temporary name only has to be unique, which the whole UUID is as well.
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, to_json(value))
  await rename(tmp, path)
}

/**
 * Create `path` holding `value` unless something is already there.
 *
 * The JSON goes to a temporary file first and is hard-linked into place, so
 * the file appears whole, and `link` refuses an existing target, so exactly
 * one of several racing creators sees true.
 */
async function create_exclusive(path: string, value: unknown): Promise<boolean> {
  // Stryker disable next-line MethodExpression: the temporary name only has to be unique, which the whole UUID is as well.
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, to_json(value))
  try {
    await link(tmp, path)
    return true
  } catch (err) {
    if (error_code(err) === 'EEXIST') return false
    throw err
  } finally {
    await rm(tmp)
  }
}

/**
 * The path of one generation in a claim directory.
 */
function generation_path(dir: string, generation: number): string {
  return join(dir, `${generation}.json`)
}

/**
 * The newest generation in a claim directory, or 0 when it holds none or
 * doesn't exist yet.
 */
async function latest_generation(dir: string): Promise<number> {
  return Math.max(0, ...(await generations(dir)))
}

/**
 * Every generation number present in a claim directory.
 */
async function generations(dir: string): Promise<number[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if (error_code(err) === 'ENOENT') return []
    throw err
  }
  return names.flatMap((name) => {
    const match = /^(\d+)\.json$/.exec(name)
    return match === null ? [] : [Number(match[1])]
  })
}

/**
 * Read and parse the JSON at `path`, or `null` when the file is missing or
 * doesn't parse. Any other failure surfaces.
 */
async function read_json(path: string): Promise<unknown> {
  let raw: string
  try {
    // Stryker disable next-line StringLiteral: without an encoding readFile hands back a Buffer, which JSON.parse turns into the same text before parsing.
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (error_code(err) === 'ENOENT') return null
    throw err
  }
  return parse_json(raw)
}

/**
 * Parse stored text, or `null` when it isn't whole JSON.
 */
function parse_json(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/**
 * The bytes at `path`, or `undefined` when no file is there. Any other
 * failure surfaces.
 */
async function read_bytes(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (err) {
    if (error_code(err) === 'ENOENT') return undefined
    throw err
  }
}

/**
 * The version of a value whose file holds `bytes`: a hash of them, so it
 * moves whenever the stored text does.
 */
function version_of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Replace the value at `path` with `value` while the file there still
 * hashes to `expected`, resolving whether it did.
 *
 * The temporary file is written before the bytes are read. A scope that's
 * cleared and made again in between takes the temporary file with it, and
 * the rename then fails, where a file written after the read would land in
 * the new scope over a value this call never saw. A missing directory or a
 * missing file is a conflict like any other, since the key is absent.
 */
async function replace_if(path: string, value: unknown, expected: string): Promise<boolean> {
  // Stryker disable next-line MethodExpression: the temporary name only has to be unique, which the whole UUID is as well.
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(tmp, to_json(value))
    const bytes = await read_bytes(path)
    if (bytes === undefined || version_of(bytes) !== expected) return false
    await rename(tmp, path)
    return true
  } catch (err) {
    if (error_code(err) === 'ENOENT') return false
    throw err
  } finally {
    await rm(tmp, { force: true })
  }
}

/**
 * Wait `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * True when the lock at `path` is older than `LOCK_MS`. A lock that's gone
 * isn't abandoned, it was let go.
 */
async function is_abandoned(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > LOCK_MS
  } catch (err) {
    if (error_code(err) === 'ENOENT') return false
    throw err
  }
}

/**
 * Remove the abandoned lock at `path`, or wait a moment when another writer
 * is already removing one.
 *
 * Two writers that both found the lock abandoned can't both be let remove
 * it: the second would remove the lock a third writer took after the first
 * cleared the way. So the removal happens under a claim, and the lock's age
 * is read again once the claim is held. The claim lapses by itself when its
 * holder dies, which a second lock directory wouldn't.
 */
async function recover(path: string): Promise<void> {
  const dir = join(dirname(path), RECOVERY)
  const owner = randomUUID()
  if (!(await claim_in(dir, owner, LOCK_MS))) return sleep(LOCK_RETRY_MS)
  try {
    if (await is_abandoned(path)) await rm(path, { recursive: true, force: true })
  } finally {
    await release_in(dir, owner)
  }
}

/**
 * Take the lock at `path`, waiting for it while another writer has it.
 *
 * The lock is a directory, and `mkdir` refuses one that exists, so of the
 * writers that ask at once exactly one gets it. The first write to a store
 * finds no directory to make the lock in, and makes that first.
 */
async function take_lock(path: string): Promise<void> {
  for (;;) {
    try {
      await mkdir(path)
      return
    } catch (err) {
      const code = error_code(err)
      if (code === 'ENOENT') {
        await mkdir(dirname(path), { recursive: true })
        continue
      }
      if (code !== 'EEXIST') throw err
    }
    if (await is_abandoned(path)) await recover(path)
    else await sleep(LOCK_RETRY_MS)
  }
}

/**
 * Let go of the lock at `path`. A lock that vanished meanwhile (its scope
 * was cleared) has nothing left to let go of.
 */
async function drop_lock(path: string): Promise<void> {
  try {
    await rmdir(path)
  } catch (err) {
    if (error_code(err) !== 'ENOENT') throw err
  }
}

/**
 * Run `body` once every write this process began on `path` before it has
 * finished.
 *
 * The lock directory is for the other processes. Inside one process the
 * writers to a key queue here, so each takes the lock on its first try and
 * none of them spends its wait asking the disk for it.
 */
async function in_turn<t>(path: string, body: () => Promise<t>): Promise<t> {
  const ahead = turns.get(path)
  const done = Promise.withResolvers<void>()
  turns.set(path, done.promise)
  await ahead
  try {
    return await body()
  } finally {
    if (turns.get(path) === done.promise) turns.delete(path)
    done.resolve()
  }
}

/**
 * Run `body` while holding the lock at `path`, waiting for it when another
 * writer has it.
 */
function with_lock<t>(path: string, body: () => Promise<t>): Promise<t> {
  return in_turn(path, async () => {
    await take_lock(path)
    try {
      return await body()
    } finally {
      await drop_lock(path)
    }
  })
}

/**
 * Read the claim one generation holds, or null when the file is gone or
 * doesn't hold a claim.
 */
async function read_claim(path: string): Promise<ClaimRecord | null> {
  const parsed = await read_json(path)
  return is_claim_record(parsed) ? parsed : null
}

/**
 * True for the `{ owner, expires_at }` shape a generation file holds.
 */
function is_claim_record(value: unknown): value is ClaimRecord {
  // Stryker disable next-line BooleanLiteral: a value that isn't an object reads as free either way, since null fails the null check and a primitive has no expiry to keep it live.
  if (typeof value !== 'object' || value === null) return false
  return (
    typeof Reflect.get(value, 'owner') === 'string' &&
    typeof Reflect.get(value, 'expires_at') === 'number'
  )
}

/**
 * Delete every generation older than `keep`. A claimer only reads the newest
 * generation, so the older ones are history and nothing waits on them.
 */
async function prune(dir: string, keep: number): Promise<void> {
  const stale = (await generations(dir)).filter((generation) => generation < keep)
  await Promise.all(stale.map((generation) => rm(generation_path(dir, generation), { force: true })))
}

/**
 * Take or renew the claim in `dir` for `owner`.
 *
 * A live claim held by `owner` is renewed in place. Anything else that isn't
 * a live claim is taken by creating the next generation, and the claimer
 * still loses if a newer generation shows up before it confirms. Only a live
 * claim is ever renewed in place, so an expired one changes hands through
 * `create_exclusive` alone and two claimers can't both win it. A renewal that
 * lands at the very instant its claim expires can still race a takeover, and
 * it loses whenever the takeover's generation appears before it confirms.
 */
async function claim_in(dir: string, owner: string, ttl_ms: number): Promise<boolean> {
  await mkdir(dir, { recursive: true })
  const generation = await latest_generation(dir)
  const current = await read_claim(generation_path(dir, generation))
  const now = Date.now()
  const claim: ClaimRecord = { owner, expires_at: now + ttl_ms }
  if (current !== null && current.expires_at > now) {
    if (current.owner !== owner) return false
    await write_atomic(generation_path(dir, generation), claim)
    return (await latest_generation(dir)) === generation
  }
  const next = generation + 1
  if (!(await create_exclusive(generation_path(dir, next), claim))) return false
  if ((await latest_generation(dir)) !== next) return false
  await prune(dir, next)
  return true
}

/**
 * Release the claim in `dir` when `owner` holds it.
 *
 * The newest generation is rewritten as expired rather than deleted, so
 * generation numbers only ever grow and a slow claimer can't recreate one
 * that was already taken. A directory that vanished meanwhile (its scope was
 * cleared) has nothing left to release.
 */
async function release_in(dir: string, owner: string): Promise<void> {
  const generation = await latest_generation(dir)
  const path = generation_path(dir, generation)
  const current = await read_claim(path)
  if (current?.owner !== owner) return
  try {
    await write_atomic(path, { owner, expires_at: 0 })
  } catch (err) {
    if (error_code(err) !== 'ENOENT') throw err
  }
}

/**
 * Build the store rooted at `root_dir`, scopes and claims included.
 */
function store_at(root_dir: string): FilesystemStore {
  const value_path = (key: string): string => join(root_dir, `${safe_name(key)}.json`)
  const claim_dir = (key: string): string => join(root_dir, `${safe_name(key)}.claim`)

  const lock_dir = (key: string): string => join(root_dir, `${safe_name(key)}.lock`)

  const get = (key: string): Promise<unknown> => read_json(value_path(key))

  // Taking the lock makes the root when it isn't there yet.
  const set = (key: string, value: unknown): Promise<void> =>
    with_lock(lock_dir(key), () => write_atomic(value_path(key), value))

  const delete_key = (key: string): Promise<void> =>
    with_lock(lock_dir(key), () => rm(value_path(key), { force: true }))

  const get_versioned: FilesystemStore['get_versioned'] = async (key) => {
    const bytes = await read_bytes(value_path(key))
    if (bytes === undefined) return undefined
    const parsed = parse_json(bytes.toString('utf8'))
    return { value: parsed === null ? undefined : parsed, version: version_of(bytes) }
  }

  const set_if: FilesystemStore['set_if'] = async (key, value, expected) => {
    if (expected === null) {
      await mkdir(root_dir, { recursive: true })
      return create_exclusive(value_path(key), value)
    }
    return with_lock(lock_dir(key), () => replace_if(value_path(key), value, expected))
  }

  const scope = (prefix: string): FilesystemScopedStore => {
    const dir = join(root_dir, `${safe_name(prefix)}.scope`)
    return {
      ...store_at(dir),
      clear: () => rm(dir, { recursive: true, force: true }),
    }
  }

  return {
    get,
    set,
    delete: delete_key,
    scope,
    claim: (key, owner, ttl_ms) => claim_in(claim_dir(key), owner, ttl_ms),
    release: (key, owner) => release_in(claim_dir(key), owner),
    get_versioned,
    set_if,
  }
}

/**
 * Create a `CheckpointStore` backed by JSON files under `config.root_dir`.
 */
export function filesystem_store(config: FilesystemStoreConfig): FilesystemStore {
  return store_at(config.root_dir)
}

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
 * All of this leans on `link` and `rename` being atomic and on a directory
 * listing being current, which a local filesystem gives and a network
 * filesystem may not.
 *
 * Paths are accepted at construction; the store never reads `process.env`.
 */

import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type FilesystemStoreConfig = {
  readonly root_dir: string
}

/**
 * What `filesystem_store` returns: a `CheckpointStore` with every optional
 * capability, which is what `durable` needs from its store.
 */
export type FilesystemStore = {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: unknown) => Promise<void>
  readonly delete: (key: string) => Promise<void>
  readonly scope: (prefix: string) => FilesystemScopedStore
  readonly claim: (key: string, owner: string, ttl_ms: number) => Promise<boolean>
  readonly release: (key: string, owner: string) => Promise<void>
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
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
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

  const get = (key: string): Promise<unknown> => read_json(value_path(key))

  const set = async (key: string, value: unknown): Promise<void> => {
    await mkdir(root_dir, { recursive: true })
    await write_atomic(value_path(key), value)
  }

  const delete_key = async (key: string): Promise<void> => {
    await rm(value_path(key), { force: true })
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
  }
}

/**
 * Create a `CheckpointStore` backed by JSON files under `config.root_dir`.
 */
export function filesystem_store(config: FilesystemStoreConfig): FilesystemStore {
  return store_at(config.root_dir)
}

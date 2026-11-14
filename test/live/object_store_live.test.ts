/**
 * Opt-in live check of `object_store` against a real bucket.
 *
 * Runs `checkpoint_store_conformance` over `object_store` with the S3 client
 * that `docs/human-in-the-loop.md` prints (`test/fixtures/s3_object_client.ts`
 * is the same code). The in-memory client the default suite uses honors every
 * condition by construction. Whether a service checks `If-Match` and
 * `If-None-Match` on a put, and checks them atomically against a racing put
 * or delete, is a fact about that service, and this is the test that finds
 * out. Run it with:
 *
 *   LIVE_TESTS=1 FASCICLE_LIVE_S3_BUCKET=my-bucket FASCICLE_LIVE_S3_REGION=us-east-1 \
 *     AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *     pnpm exec vitest run test/live/object_store_live.test.ts
 *
 * It's skipped unless LIVE_TESTS=1 and FASCICLE_LIVE_S3_BUCKET are both set.
 *
 *   FASCICLE_LIVE_S3_BUCKET     the bucket, which has to exist already
 *   FASCICLE_LIVE_S3_REGION     its region (the SDK falls back to AWS_REGION)
 *   FASCICLE_LIVE_S3_ENDPOINT   the endpoint of an S3-compatible service
 *                               (Cloudflare R2, Tigris), addressed path-style
 *
 * Credentials come from the SDK's usual chain: AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY (with AWS_SESSION_TOKEN for temporary ones), or
 * AWS_PROFILE. They need `s3:GetObject`, `s3:PutObject`, and
 * `s3:DeleteObject` on the bucket's objects and `s3:ListBucket` on the
 * bucket.
 *
 * Every object goes under `fascicle-live/<uuid>/`, which is deleted when the
 * run ends, pass or fail. A run makes several hundred requests.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { CheckpointStore } from 'fascicle'
import { object_store, type ObjectClient } from 'fascicle/adapters'
import { checkpoint_store_conformance } from 'fascicle/testing'

const bucket = process.env['FASCICLE_LIVE_S3_BUCKET'] ?? ''
const region = process.env['FASCICLE_LIVE_S3_REGION'] ?? ''
const endpoint = process.env['FASCICLE_LIVE_S3_ENDPOINT'] ?? ''
const live = process.env['LIVE_TESTS'] === '1' && bucket !== ''

const ROOT = `fascicle-live/${randomUUID()}/`
const TIMEOUT_MS = 600_000

// Long enough that a claim outlasts the round trips of the check that took
// it, and short enough that the checks that wait one out stay quick.
const TTL_MS = 2_000

// Build the documented client over a real `S3Client`. The SDK is imported
// here, so a run with no bucket never loads it.
async function connect(): Promise<ObjectClient> {
  const { S3Client } = await import('@aws-sdk/client-s3')
  const { s3_object_client } = await import('../fixtures/s3_object_client.js')
  const s3 = new S3Client({
    ...(region === '' ? {} : { region }),
    ...(endpoint === '' ? {} : { endpoint, forcePathStyle: true }),
  })
  return s3_object_client(s3, bucket)
}

// Delete everything this run wrote, a page at a time.
async function sweep(client: ObjectClient): Promise<void> {
  let start_after: string | undefined
  for (;;) {
    const page = await client.list(ROOT, start_after)
    await Promise.all(page.keys.map((key) => client.delete(key)))
    if (page.next === undefined) return
    start_after = page.next
  }
}

describe.skipIf(!live)('object_store against a real bucket', () => {
  let client: ObjectClient | undefined

  afterAll(async () => {
    if (client !== undefined) await sweep(client)
  }, TIMEOUT_MS)

  it(
    'keeps the whole contract, with scopes, claims, and conditional writes',
    async () => {
      const connected = await connect()
      client = connected
      // The prefix each store was built on, so the damage hook can find a
      // value's object. The store keeps a short plain name at `<prefix>v/<name>`.
      const prefixes = new Map<CheckpointStore, string>()
      let made = 0
      const report = await checkpoint_store_conformance(
        () => {
          made += 1
          const prefix = `${ROOT}${made}/`
          const store = object_store({ client: connected, prefix })
          prefixes.set(store, prefix)
          return store
        },
        {
          ttl_ms: TTL_MS,
          corrupt: async (store, key) => {
            await connected.put(`${prefixes.get(store) ?? ''}v/${key}`, '{"torn')
          },
        },
      )
      expect(report.failed).toEqual([])
      expect(report.skipped).toEqual([])
      expect(report.passed).toHaveLength(49)
    },
    TIMEOUT_MS,
  )

  it(
    'leaves nothing under its prefix once it has swept',
    async () => {
      const connected = client ?? (await connect())
      await sweep(connected)
      expect((await connected.list(ROOT)).keys).toEqual([])
    },
    TIMEOUT_MS,
  )
})

/**
 * The `ObjectClient` over `@aws-sdk/client-s3` that
 * `docs/human-in-the-loop.md` prints for readers to paste.
 *
 * The doc's copy is typechecked by the `snippets` slot against the built
 * package, and this one by `tsc` with the rest of the tests, so neither can
 * drift from the SDK unnoticed. The live suite in
 * `test/live/object_store_live.test.ts` runs this one against a real bucket.
 * Keep the two the same but for the semicolons.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from '@aws-sdk/client-s3'
import type { ObjectClient } from 'fascicle/adapters'

// A 412 says the condition failed. S3 answers 409 when a conditional write
// overlapped another, and a 404 `NoSuchKey` when an `If-Match` finds the key
// gone, and the store reads the object again in every case.
function lost(err: unknown): boolean {
  if (!(err instanceof S3ServiceException)) return false
  const status = err.$metadata.httpStatusCode
  return status === 412 || status === 409 || err.name === 'NoSuchKey'
}

export function s3_object_client(s3: S3Client, Bucket: string): ObjectClient {
  return {
    get: async (Key) => {
      try {
        const found = await s3.send(new GetObjectCommand({ Bucket, Key }))
        return { body: (await found.Body?.transformToString()) ?? '', etag: found.ETag ?? '' }
      } catch (err) {
        if (err instanceof NoSuchKey) return undefined
        throw err
      }
    },
    put: async (Key, Body, condition) => {
      const IfNoneMatch = condition && 'if_none_match' in condition ? '*' : undefined
      const IfMatch = condition && 'if_match' in condition ? condition.if_match : undefined
      try {
        await s3.send(new PutObjectCommand({ Bucket, Key, Body, IfNoneMatch, IfMatch }))
        return true
      } catch (err) {
        if (condition !== undefined && lost(err)) return false
        throw err
      }
    },
    delete: async (Key) => {
      await s3.send(new DeleteObjectCommand({ Bucket, Key }))
    },
    list: async (Prefix, StartAfter) => {
      const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, StartAfter }))
      const keys = (page.Contents ?? []).flatMap(({ Key }) => (Key === undefined ? [] : [Key]))
      const last = keys.at(-1)
      return page.IsTruncated && last !== undefined ? { keys, next: last } : { keys }
    },
  }
}

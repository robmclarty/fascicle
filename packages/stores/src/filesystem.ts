/**
 * Filesystem-backed checkpoint store.
 *
 * Satisfies `CheckpointStore` from `@repo/core`. Each key is stored as
 * a JSON file under the configured root directory. Writes are all-or-nothing:
 * values are written to a temporary sibling file and then atomically renamed
 * into place, so an interrupted write never leaves a partially-written file
 * at the target key (spec.md §6.3, §6.8). On `get`, a missing file, a partial
 * temp file that is not atomically renamed, or a JSON parse failure each read
 * as a cache miss (returning `null`) rather than an error.
 *
 * Paths are accepted at construction; the store never reads `process.env`.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckpointStore } from '@repo/core';

export type FilesystemStoreOptions = {
  readonly root_dir: string;
};

function safe_filename(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 12);
  const slug = key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return `${slug}.${hash}.json`;
}

export function filesystem_store(options: FilesystemStoreOptions): CheckpointStore {
  const { root_dir } = options;

  const ensure_root = async (): Promise<void> => {
    await mkdir(root_dir, { recursive: true });
  };

  const path_for = (key: string): string => join(root_dir, safe_filename(key));

  const get = async (key: string): Promise<unknown> => {
    const path = path_for(key);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  };

  const set = async (key: string, value: unknown): Promise<void> => {
    await ensure_root();
    const target = path_for(key);
    const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(value), 'utf8');
    await rename(tmp, target);
  };

  const delete_key = async (key: string): Promise<void> => {
    const target = path_for(key);
    await rm(target, { force: true });
  };

  return { get, set, delete: delete_key };
}

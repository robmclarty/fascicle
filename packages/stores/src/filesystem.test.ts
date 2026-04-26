import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filesystem_store } from './filesystem.js';

let work_dir = '';

beforeEach(() => {
  work_dir = mkdtempSync(join(tmpdir(), 'fascicle-fs-store-'));
});

afterEach(() => {
  rmSync(work_dir, { recursive: true, force: true });
});

describe('filesystem_store', () => {
  it('get on a missing key returns null', async () => {
    const store = filesystem_store({ root_dir: work_dir });
    const v = await store.get('does-not-exist');
    expect(v).toBeNull();
  });

  it('set then get round-trips a JSON value', async () => {
    const store = filesystem_store({ root_dir: work_dir });
    const value = { candidate: 'a', converged: true, rounds: 2 };
    await store.set('k1', value);
    const read = await store.get('k1');
    expect(read).toEqual(value);
  });

  it('set is atomic: no .tmp file remains after completion', async () => {
    const store = filesystem_store({ root_dir: work_dir });
    await store.set('k2', { x: 1 });
    const files = readdirSync(work_dir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);
  });

  it('a corrupted JSON payload at a key reads as a miss', async () => {
    const store = filesystem_store({ root_dir: work_dir });
    await store.set('k3', { ok: true });
    const files = readdirSync(work_dir);
    const target = files.find((f) => f.endsWith('.json'));
    if (target === undefined) throw new Error('expected a json file');
    writeFileSync(join(work_dir, target), '{ not json');
    const read = await store.get('k3');
    expect(read).toBeNull();
  });

  it('a leftover .tmp file at a key is ignored on get (crashed write simulation)', async () => {
    const store = filesystem_store({ root_dir: work_dir });
    // Write only the tmp counterpart, never rename into place.
    writeFileSync(join(work_dir, 'anything.tmp'), '{ half-written');
    const read = await store.get('nothing-here');
    expect(read).toBeNull();
  });

  it('delete removes the key; subsequent get returns null', async () => {
    const store = filesystem_store({ root_dir: work_dir });
    await store.set('k4', { a: 1 });
    await store.delete('k4');
    const read = await store.get('k4');
    expect(read).toBeNull();
  });

  it('delete on a missing key does not throw', async () => {
    const store = filesystem_store({ root_dir: work_dir });
    await expect(store.delete('no-such-key')).resolves.toBeUndefined();
  });

  it('overwrites an existing value atomically on set', async () => {
    const store = filesystem_store({ root_dir: work_dir });
    await store.set('k5', { v: 1 });
    await store.set('k5', { v: 2 });
    const read = await store.get('k5');
    expect(read).toEqual({ v: 2 });
  });

  it('keys with characters that require sanitization still round-trip', async () => {
    const store = filesystem_store({ root_dir: work_dir });
    const key = 'build:abc/def?x=1';
    await store.set(key, { ok: true });
    const read = await store.get(key);
    expect(read).toEqual({ ok: true });
  });

  it('writes valid JSON to disk', async () => {
    const store = filesystem_store({ root_dir: work_dir });
    await store.set('k6', { a: 'b' });
    const files = readdirSync(work_dir);
    const target = files.find((f) => f.endsWith('.json'));
    if (target === undefined) throw new Error('expected a json file');
    const raw = await readFile(join(work_dir, target), 'utf8');
    expect(JSON.parse(raw)).toEqual({ a: 'b' });
  });
});

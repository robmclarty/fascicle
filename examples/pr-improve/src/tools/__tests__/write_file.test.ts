import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { make_ctx, type ToolExecContextStub } from './_helpers.js'
import { MAX_FILE_BYTES } from '../limits.js'
import { make_write_file, type WriteFileOutput } from '../write_file.js'

let root: string
let ctx: ToolExecContextStub

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pr-improve-write-file-'))
  ctx = make_ctx()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('write_file', () => {
  it('creates a new file and reports created: true', async () => {
    const tool = make_write_file(root)
    const out = (await tool.execute({ path: 'a.txt', content: 'hello' }, ctx)) as WriteFileOutput
    expect(out.created).toBe(true)
    expect(out.bytes_written).toBe(5)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello')
  })

  it('overwrites an existing file and reports created: false', async () => {
    await writeFile(join(root, 'a.txt'), 'old')
    const tool = make_write_file(root)
    const out = (await tool.execute(
      { path: 'a.txt', content: 'new content' },
      ctx,
    )) as WriteFileOutput
    expect(out.created).toBe(false)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new content')
  })

  it('auto-creates parent directories within root', async () => {
    const tool = make_write_file(root)
    await tool.execute({ path: 'a/b/c/d.txt', content: 'deep' }, ctx)
    expect(await readFile(join(root, 'a/b/c/d.txt'), 'utf8')).toBe('deep')
  })

  it('rejects path traversal escapes', async () => {
    const tool = make_write_file(root)
    await expect(
      tool.execute({ path: '../../etc/poison', content: 'x' }, ctx),
    ).rejects.toThrow(/escapes worktree root/)
  })

  it('rejects writing through an existing symlink', async () => {
    await writeFile(join(root, 'real.txt'), 'real')
    await symlink(join(root, 'real.txt'), join(root, 'link.txt'))
    const tool = make_write_file(root)
    await expect(tool.execute({ path: 'link.txt', content: 'pwned' }, ctx)).rejects.toThrow(
      /symlink/,
    )
    expect(await readFile(join(root, 'real.txt'), 'utf8')).toBe('real')
  })

  it('rejects overwriting a directory', async () => {
    await mkdir(join(root, 'sub'))
    const tool = make_write_file(root)
    await expect(tool.execute({ path: 'sub', content: 'x' }, ctx)).rejects.toThrow(
      /overwrite directory/,
    )
  })

  it('rejects content larger than MAX_FILE_BYTES', async () => {
    const oversized = 'a'.repeat(MAX_FILE_BYTES + 1)
    const tool = make_write_file(root)
    await expect(tool.execute({ path: 'big.txt', content: oversized }, ctx)).rejects.toThrow(
      /exceeds size cap/,
    )
  })

  it('counts bytes by utf-8 length, not char count', async () => {
    // Each "🌲" is 4 utf-8 bytes; 100 of them = 400 bytes, well under cap.
    const content = '🌲'.repeat(100)
    const tool = make_write_file(root)
    const out = (await tool.execute({ path: 'trees.txt', content }, ctx)) as WriteFileOutput
    expect(out.bytes_written).toBe(400)
  })
})

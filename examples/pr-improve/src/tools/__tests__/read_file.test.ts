import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { make_ctx, type ToolExecContextStub } from './_helpers.js'
import { MAX_FILE_BYTES } from '../limits.js'
import { make_read_file, type ReadFileOutput } from '../read_file.js'

let root: string
let ctx: ToolExecContextStub

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pr-improve-read-file-'))
  ctx = make_ctx()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('read_file', () => {
  it('reads a utf-8 file and reports bytes + line count', async () => {
    const text = 'line one\nline two\nline three\n'
    await writeFile(join(root, 'a.txt'), text)
    const tool = make_read_file(root)
    const out = (await tool.execute({ path: 'a.txt' }, ctx)) as ReadFileOutput
    expect(out.content).toBe(text)
    expect(out.bytes).toBe(Buffer.byteLength(text, 'utf8'))
    expect(out.lines).toBe(4)
  })

  it('reports zero lines for an empty file', async () => {
    await writeFile(join(root, 'empty.txt'), '')
    const tool = make_read_file(root)
    const out = (await tool.execute({ path: 'empty.txt' }, ctx)) as ReadFileOutput
    expect(out.content).toBe('')
    expect(out.bytes).toBe(0)
    expect(out.lines).toBe(0)
  })

  it('rejects when file does not exist', async () => {
    const tool = make_read_file(root)
    await expect(tool.execute({ path: 'missing.txt' }, ctx)).rejects.toThrow()
  })

  it('rejects directories', async () => {
    await mkdir(join(root, 'sub'))
    const tool = make_read_file(root)
    await expect(tool.execute({ path: 'sub' }, ctx)).rejects.toThrow(/not a regular file/)
  })

  it('rejects symlinks', async () => {
    await writeFile(join(root, 'target.txt'), 'hi')
    await symlink(join(root, 'target.txt'), join(root, 'link.txt'))
    const tool = make_read_file(root)
    await expect(tool.execute({ path: 'link.txt' }, ctx)).rejects.toThrow(/symlink/)
  })

  it('rejects path traversal', async () => {
    const tool = make_read_file(root)
    await expect(tool.execute({ path: '../../etc/passwd' }, ctx)).rejects.toThrow(
      /escapes worktree root/,
    )
  })

  it('rejects files larger than MAX_FILE_BYTES', async () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61) // 'a' bytes
    await writeFile(join(root, 'big.txt'), big)
    const tool = make_read_file(root)
    await expect(tool.execute({ path: 'big.txt' }, ctx)).rejects.toThrow(/exceeds size cap/)
  })

  it('rejects binary files (NUL byte detection)', async () => {
    const binary = Buffer.from([0x68, 0x69, 0x00, 0x21]) // 'hi\0!'
    await writeFile(join(root, 'binary.bin'), binary)
    const tool = make_read_file(root)
    await expect(tool.execute({ path: 'binary.bin' }, ctx)).rejects.toThrow(/binary file/)
  })
})

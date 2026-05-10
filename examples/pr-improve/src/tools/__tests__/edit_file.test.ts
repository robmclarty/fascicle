import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { make_ctx, type ToolExecContextStub } from './_helpers.js'
import { MAX_FILE_BYTES } from '../limits.js'
import { make_edit_file, type EditFileOutput } from '../edit_file.js'

let root: string
let ctx: ToolExecContextStub

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pr-improve-edit-file-'))
  ctx = make_ctx()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('edit_file', () => {
  it('replaces a unique occurrence and writes the file back', async () => {
    await writeFile(join(root, 'a.txt'), 'hello world\nbye world\n')
    const tool = make_edit_file(root)
    const out = (await tool.execute(
      { path: 'a.txt', find: 'hello', replace: 'hi' },
      ctx,
    )) as EditFileOutput
    expect(out.replacements).toBe(1)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hi world\nbye world\n')
  })

  it('errors when find string is missing', async () => {
    await writeFile(join(root, 'a.txt'), 'no match here')
    const tool = make_edit_file(root)
    await expect(
      tool.execute({ path: 'a.txt', find: 'absent', replace: 'x' }, ctx),
    ).rejects.toThrow(/not found/)
  })

  it('errors when find string is ambiguous and replace_all is not set', async () => {
    await writeFile(join(root, 'a.txt'), 'hi hi hi')
    const tool = make_edit_file(root)
    await expect(tool.execute({ path: 'a.txt', find: 'hi', replace: 'yo' }, ctx)).rejects.toThrow(
      /ambiguous/,
    )
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hi hi hi')
  })

  it('replaces all occurrences when replace_all is true', async () => {
    await writeFile(join(root, 'a.txt'), 'hi hi hi')
    const tool = make_edit_file(root)
    const out = (await tool.execute(
      { path: 'a.txt', find: 'hi', replace: 'yo', replace_all: true },
      ctx,
    )) as EditFileOutput
    expect(out.replacements).toBe(3)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('yo yo yo')
  })

  it('rejects path traversal', async () => {
    const tool = make_edit_file(root)
    await expect(
      tool.execute({ path: '../../etc/foo', find: 'a', replace: 'b' }, ctx),
    ).rejects.toThrow(/escapes worktree root/)
  })

  it('rejects symlinks', async () => {
    await writeFile(join(root, 'real.txt'), 'hi')
    await symlink(join(root, 'real.txt'), join(root, 'link.txt'))
    const tool = make_edit_file(root)
    await expect(
      tool.execute({ path: 'link.txt', find: 'hi', replace: 'yo' }, ctx),
    ).rejects.toThrow(/symlink/)
  })

  it('rejects post-edit content larger than MAX_FILE_BYTES', async () => {
    await writeFile(join(root, 'a.txt'), 'small')
    const tool = make_edit_file(root)
    const huge = 'x'.repeat(MAX_FILE_BYTES + 1)
    await expect(tool.execute({ path: 'a.txt', find: 'small', replace: huge }, ctx)).rejects.toThrow(
      /post-edit content exceeds size cap/,
    )
    // File untouched.
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('small')
  })

  it('rejects binary files', async () => {
    await writeFile(join(root, 'b.bin'), Buffer.from([0x68, 0x00, 0x69]))
    const tool = make_edit_file(root)
    await expect(tool.execute({ path: 'b.bin', find: 'h', replace: 'x' }, ctx)).rejects.toThrow(
      /binary file/,
    )
  })

  it('input schema rejects empty find string', () => {
    const tool = make_edit_file(root)
    const result = tool.input_schema.safeParse({ path: 'a.txt', find: '', replace: 'x' })
    expect(result.success).toBe(false)
  })
})

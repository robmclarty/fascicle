import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { make_ctx, type ToolExecContextStub } from './_helpers.js'
import { MAX_LIST_ENTRIES } from '../limits.js'
import { make_list_dir, type ListDirOutput } from '../list_dir.js'

let root: string
let ctx: ToolExecContextStub

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pr-improve-list-dir-'))
  ctx = make_ctx()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('list_dir', () => {
  it('lists files and dirs in the root', async () => {
    await writeFile(join(root, 'a.txt'), 'hi')
    await mkdir(join(root, 'sub'))
    const tool = make_list_dir(root)
    const out = (await tool.execute({ path: '.' }, ctx)) as ListDirOutput
    const sorted = out.entries.toSorted((x, y) => x.name.localeCompare(y.name))
    expect(sorted).toEqual([
      { name: 'a.txt', kind: 'file' },
      { name: 'sub', kind: 'dir' },
    ])
    expect(out.truncated).toBe(false)
  })

  it('reports symlinks as kind: symlink', async () => {
    await writeFile(join(root, 'target.txt'), 'hi')
    await symlink(join(root, 'target.txt'), join(root, 'link.txt'))
    const tool = make_list_dir(root)
    const out = (await tool.execute({ path: '.' }, ctx)) as ListDirOutput
    const link = out.entries.find((e) => e.name === 'link.txt')
    expect(link?.kind).toBe('symlink')
  })

  it('rejects when the target itself is a symlink', async () => {
    await mkdir(join(root, 'real_dir'))
    await symlink(join(root, 'real_dir'), join(root, 'link_dir'))
    const tool = make_list_dir(root)
    await expect(tool.execute({ path: 'link_dir' }, ctx)).rejects.toThrow(/symlink/)
  })

  it('rejects when path escapes the worktree root', async () => {
    const tool = make_list_dir(root)
    await expect(tool.execute({ path: '../../etc' }, ctx)).rejects.toThrow(/escapes worktree root/)
  })

  it('rejects when target is not a directory', async () => {
    await writeFile(join(root, 'a.txt'), 'hi')
    const tool = make_list_dir(root)
    await expect(tool.execute({ path: 'a.txt' }, ctx)).rejects.toThrow(/not a directory/)
  })

  it('truncates at MAX_LIST_ENTRIES and sets truncated: true', async () => {
    const total = MAX_LIST_ENTRIES + 5
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        writeFile(join(root, `f${String(i).padStart(5, '0')}.txt`), 'x'),
      ),
    )
    const tool = make_list_dir(root)
    const out = (await tool.execute({ path: '.' }, ctx)) as ListDirOutput
    expect(out.entries.length).toBe(MAX_LIST_ENTRIES)
    expect(out.truncated).toBe(true)
  })

  it('rejects empty path input via schema', () => {
    const tool = make_list_dir(root)
    const result = tool.input_schema.safeParse({ path: '' })
    expect(result.success).toBe(false)
  })
})

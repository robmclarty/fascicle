import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PathSafetyError, assert_not_symlink, resolve_within } from '../path_safety.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pr-improve-path-safety-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolve_within', () => {
  it('returns the resolved absolute path for a relative file inside root', () => {
    expect(resolve_within(root, 'a/b/c.txt')).toBe(join(root, 'a', 'b', 'c.txt'))
  })

  it('returns root itself when given "."', () => {
    expect(resolve_within(root, '.')).toBe(root)
  })

  it('rejects an empty string path', () => {
    expect(() => resolve_within(root, '')).toThrow(PathSafetyError)
  })

  it('rejects parent-traversal escapes', () => {
    expect(() => resolve_within(root, '../../etc/passwd')).toThrow(/escapes worktree root/)
  })

  it('rejects absolute-path inputs that fall outside root', () => {
    expect(() => resolve_within(root, '/etc/passwd')).toThrow(/escapes worktree root/)
  })

  it('rejects paths containing a NUL byte', () => {
    expect(() => resolve_within(root, 'a/b\0c')).toThrow(/NUL/)
  })

  it('collapses inner ".." segments that stay inside root', () => {
    expect(resolve_within(root, 'a/b/../c')).toBe(join(root, 'a', 'c'))
  })

  it('rejects paths that climb above root via inner ".." even if they look relative', () => {
    expect(() => resolve_within(root, 'a/../../outside')).toThrow(/escapes worktree root/)
  })

  it('treats sibling directories that share a prefix as outside root', async () => {
    // root = /tmp/pr-improve-path-safety-XYZ
    // sibling exists at the same level — `${root}-other`
    const sibling = `${root}-other`
    expect(() => resolve_within(`${root}${sep}`, sibling)).toThrow(/escapes worktree root/)
  })
})

describe('assert_not_symlink', () => {
  it('returns silently when the path does not exist', async () => {
    await expect(assert_not_symlink(join(root, 'missing.txt'), 'missing.txt')).resolves.toBeUndefined()
  })

  it('returns silently for a regular file', async () => {
    const file = join(root, 'regular.txt')
    await writeFile(file, 'hello')
    await expect(assert_not_symlink(file, 'regular.txt')).resolves.toBeUndefined()
  })

  it('returns silently for a regular directory', async () => {
    const dir = join(root, 'sub')
    await mkdir(dir)
    await expect(assert_not_symlink(dir, 'sub')).resolves.toBeUndefined()
  })

  it('rejects when the leaf is a symlink to a file inside root', async () => {
    const target = join(root, 'target.txt')
    await writeFile(target, 'hi')
    const link = join(root, 'link.txt')
    await symlink(target, link)
    await expect(assert_not_symlink(link, 'link.txt')).rejects.toThrow(PathSafetyError)
    await expect(assert_not_symlink(link, 'link.txt')).rejects.toThrow(/symlink/)
  })

  it('rejects when the leaf is a symlink to outside root', async () => {
    const link = join(root, 'escape')
    await symlink('/etc', link)
    await expect(assert_not_symlink(link, 'escape')).rejects.toThrow(PathSafetyError)
  })
})

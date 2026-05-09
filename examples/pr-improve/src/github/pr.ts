/**
 * `gh` CLI wrappers for Phase B.
 *
 * The `gh` CLI is the only GitHub client this app uses — no octokit, no PAT,
 * no `.npmrc`. Auth is the developer's existing `gh auth login`.
 *
 * Every call goes through `safe_spawn` (argv array, `shell: false`).
 */

import { safe_spawn, SafeSpawnError } from './spawn.js'

export type RepoOrigin = {
  readonly owner: string
  readonly repo: string
  readonly url: string
}

export type GhPrView = {
  readonly number: number
  readonly title: string
  readonly base_branch: string
  readonly head_branch: string
  readonly head_oid: string
  readonly url: string
  readonly repo_with_owner: string
  readonly head_repo_with_owner: string
}

export type GhPrCreateOpts = {
  readonly base: string
  readonly head: string
  readonly title: string
  readonly body_file: string
  readonly repo_with_owner: string
}

export type GhPrCreateResult = {
  readonly url: string
}

export async function gh_repo_origin(cwd: string): Promise<RepoOrigin | null> {
  let url: string
  try {
    const out = await safe_spawn({
      cmd: 'git',
      argv: ['-C', cwd, 'remote', 'get-url', 'origin'],
    })
    url = out.stdout.trim()
  } catch {
    return null
  }
  return parse_github_origin(url)
}

export function parse_github_origin(url: string): RepoOrigin | null {
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
  if (ssh !== null) {
    const owner = ssh[1]
    const repo = ssh[2]
    if (owner !== undefined && repo !== undefined) return { owner, repo, url }
  }
  const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (https !== null) {
    const owner = https[1]
    const repo = https[2]
    if (owner !== undefined && repo !== undefined) return { owner, repo, url }
  }
  return null
}

export async function ensure_git_repo(cwd: string): Promise<void> {
  try {
    await safe_spawn({
      cmd: 'git',
      argv: ['-C', cwd, 'rev-parse', '--is-inside-work-tree'],
    })
  } catch (err) {
    const detail = err instanceof SafeSpawnError ? err.stderr.trim() : String(err)
    throw new Error(`not a git repository at ${cwd}: ${detail}`, { cause: err })
  }
}

export async function gh_pr_view(cwd: string, n: number): Promise<GhPrView> {
  const out = await safe_spawn({
    cmd: 'gh',
    argv: [
      'pr',
      'view',
      String(n),
      '--json',
      'number,title,baseRefName,headRefName,headRefOid,url,headRepository,headRepositoryOwner',
    ],
    cwd,
  })
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const data = JSON.parse(out.stdout) as {
    number: number
    title: string
    baseRefName: string
    headRefName: string
    headRefOid: string
    url: string
    headRepository: { name: string }
    headRepositoryOwner: { login: string }
  }
  const head_repo_with_owner = `${data.headRepositoryOwner.login}/${data.headRepository.name}`
  const url_match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(data.url)
  const repo_with_owner = url_match?.[1] ?? head_repo_with_owner
  return {
    number: data.number,
    title: data.title,
    base_branch: data.baseRefName,
    head_branch: data.headRefName,
    head_oid: data.headRefOid,
    url: data.url,
    repo_with_owner,
    head_repo_with_owner,
  }
}

export async function gh_pr_diff(cwd: string, n: number): Promise<string> {
  const out = await safe_spawn({
    cmd: 'gh',
    argv: ['pr', 'diff', String(n), '--patch'],
    cwd,
  })
  return out.stdout
}

export async function gh_pr_review_comment(
  cwd: string,
  n: number,
  body_file: string,
  repo_with_owner: string,
): Promise<void> {
  await safe_spawn({
    cmd: 'gh',
    argv: ['pr', 'review', String(n), '--comment', '--body-file', body_file, '-R', repo_with_owner],
    cwd,
  })
}

export async function gh_pr_comment(
  cwd: string,
  n: number,
  body_file: string,
  repo_with_owner: string,
): Promise<void> {
  await safe_spawn({
    cmd: 'gh',
    argv: ['pr', 'comment', String(n), '--body-file', body_file, '-R', repo_with_owner],
    cwd,
  })
}

export async function gh_pr_create(cwd: string, opts: GhPrCreateOpts): Promise<GhPrCreateResult> {
  const out = await safe_spawn({
    cmd: 'gh',
    argv: [
      'pr',
      'create',
      '--base',
      opts.base,
      '--head',
      opts.head,
      '--title',
      opts.title,
      '--body-file',
      opts.body_file,
      '-R',
      opts.repo_with_owner,
    ],
    cwd,
  })
  return { url: out.stdout.trim() }
}

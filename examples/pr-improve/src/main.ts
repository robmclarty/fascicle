/**
 * pr-improve CLI entry — local end-to-end on a fixture diff (Phase A) or a
 * real GitHub PR via gh + claude_cli (Phase B).
 *
 * Phase A modes:
 *   pnpm --filter @repo/example-pr-improve improve:stub
 *   pnpm exec tsx examples/pr-improve/src/main.ts --stub --fixture <path>
 *
 * Phase B (single command demo):
 *   pr-improve <pr-number>             # → review comment + improvement PR + linking comment
 *   tsx src/main.ts --pr <n> --provider claude_cli
 *
 * Writes per-run artifacts under `.runs/<run_id>/`:
 *   - trajectory.jsonl   (also tee'd to stdout for CloudWatch)
 *   - REVIEW_COMMENT.md   (if any suggestions; same body posted as the PR review)
 *   - IMPROVEMENT_SPEC.md (stub mode only — pragmatist spec not on FinalResult)
 *   - HANDOFF.md          (if a build round produced one)
 *   - PR_COMMENT.md       (improvement_ready only — body of the link follow-up)
 *   - result.json         (FinalResult summary)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { run } from '@repo/fascicle'
import { filesystem_logger, tee_logger } from '@repo/fascicle/adapters'

import {
  create_app_engine,
  make_stub_engine,
  read_engine_env,
  type Provider,
  type StubResponse,
} from './engine.js'
import { build_flow, type FlowModels } from './flow.js'
import {
  ensure_git_repo,
  gh_pr_comment,
  gh_pr_create,
  gh_pr_diff,
  gh_pr_review_comment,
  gh_pr_view,
  gh_repo_origin,
} from './github/pr.js'
import {
  cleanup_worktree,
  commit_changes,
  has_uncommitted_edits,
  push_branch,
  setup_worktree,
} from './github/workspace.js'
import { stdout_logger } from './observability.js'
import {
  render_did_not_converge_followup,
  render_handoff,
  render_improvement_spec,
  render_no_pragmatic_followup,
  render_pr_comment_with_link,
  render_review_comment,
  render_review_comment_empty,
} from './render.js'
import { PragmatistOutputSchema, type FinalResult, type PRContext, type Suggestion } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const RUNS_DIR = join(PACKAGE_ROOT, '.runs')

type CliArgs = {
  readonly fixture?: string
  readonly pr?: number
  readonly provider?: Provider
  readonly stub: boolean
}

const VALID_PROVIDERS: ReadonlyArray<Provider> = ['anthropic', 'openrouter', 'claude_cli']

function parse_argv(argv: ReadonlyArray<string>): CliArgs {
  const args = argv.slice(2)
  let fixture: string | undefined
  let pr: number | undefined
  let provider: Provider | undefined
  let stub = false
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--stub') stub = true
    else if (a === '--fixture') {
      fixture = args[i + 1]
      i += 1
    } else if (a === '--pr') {
      const raw = args[i + 1]
      if (raw === undefined) throw new Error('--pr requires a number')
      const n = Number.parseInt(raw, 10)
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--pr expected a positive integer, got: ${raw}`)
      pr = n
      i += 1
    } else if (a === '--provider') {
      const raw = args[i + 1]
      if (raw === undefined) throw new Error('--provider requires a value')
      const found = VALID_PROVIDERS.find((p) => p === raw)
      if (found === undefined) throw new Error(`--provider must be one of ${VALID_PROVIDERS.join(', ')}`)
      provider = found
      i += 1
    }
  }
  if (fixture !== undefined && pr !== undefined) {
    throw new Error('--fixture and --pr are mutually exclusive')
  }
  if (fixture === undefined && pr === undefined) {
    throw new Error('Usage: tsx src/main.ts (--pr <number> [--provider <name>] | [--stub] --fixture <path>)')
  }
  if (stub && pr !== undefined) {
    throw new Error('--stub only works with --fixture')
  }
  const out: CliArgs = { stub }
  if (fixture !== undefined) Object.assign(out, { fixture })
  if (pr !== undefined) Object.assign(out, { pr })
  if (provider !== undefined) Object.assign(out, { provider })
  return out
}

function default_models(provider: Provider | undefined): FlowModels {
  if (provider === 'claude_cli') {
    return {
      reviewer: 'cli-sonnet',
      pragmatist: 'cli-opus',
      builder: 'cli-sonnet',
      build_reviewer: 'cli-opus',
    }
  }
  return { reviewer: 'sonnet', pragmatist: 'opus', builder: 'sonnet', build_reviewer: 'opus' }
}

async function load_pr_from_fixture(path: string): Promise<PRContext> {
  const diff = await readFile(path, 'utf8')
  return {
    repo: 'fascicle/code/fascicle',
    number: 1234,
    base_branch: 'main',
    head_branch: 'feat/sample',
    title: '(fixture) Sample PR for pr-improve',
    diff,
    project_context: 'Local fixture run — no real repo context loaded.',
  }
}

function stub_responses(): ReadonlyArray<StubResponse> {
  return [
    {
      match_system_prefix: 'pr-improve/stage1/reviewer',
      content: {
        suggestions: [
          {
            id: 'sug-1',
            file: 'src/payments.ts',
            line_range: [10, 14],
            category: 'bug',
            severity: 'high',
            one_liner: '`total` is declared `const` then reassigned inside the new branch.',
            rationale: 'This will not compile under strict TypeScript and indicates the new branch was untested.',
            proposed_change: 'Change to `let total` or rewrite as `total = Math.max(total, 0)`.',
          },
          {
            id: 'sug-2',
            file: 'src/payments.ts',
            line_range: [10, 14],
            category: 'clarity',
            severity: 'low',
            one_liner: 'New branch lacks an explanatory comment.',
            rationale: 'A reader cannot tell why we clamp negatives without a comment.',
            proposed_change: 'Add a one-line comment.',
          },
          {
            id: 'sug-3',
            file: 'src/payments.ts',
            line_range: [10, 14],
            category: 'naming',
            severity: 'low',
            one_liner: 'Consider renaming `total` to `subtotal`.',
            rationale: 'Personal preference — would read more clearly.',
            proposed_change: 'Rename.',
          },
        ],
      },
    },
    {
      match_system_prefix: 'pr-improve/stage2/pragmatist',
      content: {
        accepted: [
          {
            suggestion_id: 'sug-1',
            file: 'src/payments.ts',
            one_liner: 'Fix const reassignment that breaks compilation.',
            why_worth_it: 'Real bug — code will not build under strict mode.',
          },
        ],
        rejected: [
          { suggestion_id: 'sug-2', reason: 'Style-only; not a real complexity reduction.' },
          { suggestion_id: 'sug-3', reason: 'Personal naming preference — bar not met.' },
        ],
        constraints: [
          'Do not modify files outside src/payments.ts.',
          'Do not add new dependencies.',
        ],
      },
    },
    {
      match_system_prefix: 'pr-improve/stage3/builder',
      content: {
        files_touched: [
          { path: 'src/payments.ts', one_liner: 'Replaced `const total` with `let total` to allow reassignment.' },
        ],
        deviations: [],
        summary:
          'Fixed a const-reassignment compile error in src/payments.ts. Single-line change; no behavior or interface impact.',
      },
    },
    {
      match_system_prefix: 'pr-improve/stage4/build_reviewer',
      content: {
        kind: 'pass' as const,
        summary:
          'Fixed a const-reassignment compile error introduced by the new negative-total branch. One-line change, no behavioral impact.',
        rationale:
          'The build addresses sug-1 directly with the smallest possible change. Constraints respected (no other files touched, no new deps). Handoff is specific and accurate.',
      },
    },
  ]
}

async function write_review_artifact(run_dir: string, suggestions: ReadonlyArray<Suggestion>): Promise<string> {
  const path = join(run_dir, 'REVIEW_COMMENT.md')
  await writeFile(path, render_review_comment(suggestions))
  return path
}

async function write_artifacts(
  run_dir: string,
  pr: PRContext,
  result: FinalResult,
): Promise<void> {
  await writeFile(join(run_dir, 'result.json'), JSON.stringify(result, null, 2))
  if (result.kind === 'improvement_ready') {
    await writeFile(join(run_dir, 'HANDOFF.md'), render_handoff(result.handoff, pr, 1))
    await writeFile(join(run_dir, 'PR_COMMENT.md'), result.comment_body)
  }
}

type GithubPosting = {
  readonly cwd: string
  readonly pr_number: number
  readonly repo_with_owner: string
  readonly head_branch: string
  readonly improvement_branch: string
  readonly worktree_path: string
}

async function post_review(
  ctx: GithubPosting,
  run_dir: string,
  suggestions: ReadonlyArray<Suggestion>,
): Promise<void> {
  if (suggestions.length === 0) {
    const path = join(run_dir, 'REVIEW_COMMENT.md')
    await writeFile(path, render_review_comment_empty())
    await gh_pr_comment(ctx.cwd, ctx.pr_number, path, ctx.repo_with_owner)
    return
  }
  const path = await write_review_artifact(run_dir, suggestions)
  await gh_pr_review_comment(ctx.cwd, ctx.pr_number, path, ctx.repo_with_owner)
}

async function post_followup(
  ctx: GithubPosting,
  run_dir: string,
  filename: string,
  body: string,
): Promise<void> {
  const path = join(run_dir, filename)
  await writeFile(path, body)
  await gh_pr_comment(ctx.cwd, ctx.pr_number, path, ctx.repo_with_owner)
}

async function post_improvement_pr(
  ctx: GithubPosting,
  run_dir: string,
  pr: PRContext,
  result: Extract<FinalResult, { kind: 'improvement_ready' }>,
): Promise<void> {
  if (!(await has_uncommitted_edits(ctx.worktree_path))) {
    await post_followup(
      ctx,
      run_dir,
      'NO_EDITS_FOLLOWUP.md',
      'The builder produced a Handoff but did not edit any files in the worktree. ' +
        'This commonly happens under API providers that lack file-editing tools — re-run with `--provider claude_cli`. ' +
        'No improvement PR created.\n',
    )
    return
  }
  const commit_message = `fascicle: apply improvement spec for PR #${String(pr.number)}\n\n${result.handoff.summary}`
  const committed = await commit_changes(ctx.worktree_path, commit_message)
  if (!committed.committed) {
    await post_followup(
      ctx,
      run_dir,
      'NO_EDITS_FOLLOWUP.md',
      'No staged changes after the builder ran. No improvement PR created.\n',
    )
    return
  }

  await push_branch(ctx.worktree_path, ctx.improvement_branch)

  const pr_body_path = join(run_dir, 'PR_BODY.md')
  await writeFile(
    pr_body_path,
    [
      `Automated improvement PR generated by pr-improve for #${String(pr.number)}.`,
      '',
      result.handoff.summary,
      '',
      '---',
      '',
      `Original PR: ${pr.title} (#${String(pr.number)})`,
    ].join('\n'),
  )

  const created = await gh_pr_create(ctx.cwd, {
    base: ctx.head_branch,
    head: ctx.improvement_branch,
    title: `pr-improve: ${result.handoff.summary.split('.')[0] ?? `improvements for #${String(pr.number)}`}`,
    body_file: pr_body_path,
    repo_with_owner: ctx.repo_with_owner,
  })

  const link_path = join(run_dir, 'PR_LINK_COMMENT.md')
  await writeFile(link_path, render_pr_comment_with_link(created.url, result.handoff.summary))
  await gh_pr_comment(ctx.cwd, ctx.pr_number, link_path, ctx.repo_with_owner)
}

async function run_fixture_mode(
  args: CliArgs,
  run_dir: string,
  trajectory: ReturnType<typeof tee_logger>,
): Promise<FinalResult> {
  if (args.fixture === undefined) throw new Error('internal: run_fixture_mode without fixture')
  const engine = args.stub
    ? make_stub_engine(stub_responses())
    : create_app_engine(read_engine_env(process.env, args.provider))
  try {
    const pr = await load_pr_from_fixture(resolve(args.fixture))
    const flow = build_flow(engine, default_models(args.provider))
    const result = await run(flow, pr, { trajectory, install_signal_handlers: false })

    if (result.suggestions.length > 0) {
      await write_review_artifact(run_dir, result.suggestions)
    }

    if (result.kind === 'improvement_ready' && args.stub) {
      const stub_spec_raw = stub_responses().find((r) =>
        r.match_system_prefix.startsWith('pr-improve/stage2'),
      )?.content
      if (stub_spec_raw !== undefined) {
        await writeFile(
          join(run_dir, 'IMPROVEMENT_SPEC.md'),
          render_improvement_spec(pr, PragmatistOutputSchema.parse(stub_spec_raw)),
        )
      }
    }

    await write_artifacts(run_dir, pr, result)
    console.error(`\n→ run artifacts: ${run_dir}`)
    console.error(`→ result kind:  ${result.kind}`)
    return result
  } finally {
    await engine.dispose()
  }
}

async function run_pr_mode(
  args: CliArgs,
  run_dir: string,
  trajectory: ReturnType<typeof tee_logger>,
): Promise<FinalResult> {
  if (args.pr === undefined) throw new Error('internal: run_pr_mode without pr')
  const user_cwd = process.env['PR_IMPROVE_USER_CWD'] ?? process.cwd()
  await ensure_git_repo(user_cwd)
  const origin = await gh_repo_origin(user_cwd)
  if (origin === null) {
    throw new Error(
      `${user_cwd} does not have a GitHub remote at 'origin'. Run pr-improve from inside a checkout of a GitHub-hosted repository.`,
    )
  }

  const view = await gh_pr_view(user_cwd, args.pr)
  const diff = await gh_pr_diff(user_cwd, args.pr)
  const pr: PRContext = {
    repo: view.repo_with_owner,
    number: view.number,
    base_branch: view.base_branch,
    head_branch: view.head_branch,
    title: view.title,
    diff,
    project_context: `GitHub PR ${view.url}`,
  }

  const wt = await setup_worktree({
    cwd: user_cwd,
    run_id: run_dir.split('/').pop() ?? 'run',
    pr_number: pr.number,
    head_oid: view.head_oid,
  })
  console.error(`→ worktree: ${wt.worktree_path}`)
  console.error(`→ branch:   ${wt.improvement_branch}`)

  try {
    const env_provider = process.env['FASCICLE_PROVIDER']
    const provider: Provider =
      args.provider ?? (VALID_PROVIDERS.find((p) => p === env_provider)) ?? 'claude_cli'
    const cfg = read_engine_env(process.env, provider)
    const engine = create_app_engine(cfg, { cwd: wt.worktree_path })
    let result: FinalResult
    try {
      const flow = build_flow(engine, default_models(provider))
      result = await run(flow, pr, { trajectory, install_signal_handlers: false })
    } finally {
      await engine.dispose()
    }

    await write_artifacts(run_dir, pr, result)
    console.error(`→ flow result: ${result.kind}`)

    const ctx: GithubPosting = {
      cwd: user_cwd,
      pr_number: pr.number,
      repo_with_owner: view.repo_with_owner,
      head_branch: pr.head_branch,
      improvement_branch: wt.improvement_branch,
      worktree_path: wt.worktree_path,
    }

    await post_review(ctx, run_dir, result.suggestions)

    if (result.kind === 'no_changes_proposed') {
      if (result.suggestions.length > 0) {
        await post_followup(ctx, run_dir, 'NO_PRAGMATIC_FOLLOWUP.md', render_no_pragmatic_followup())
      }
      console.error('→ no improvement PR created (pragmatist accepted nothing)')
      return result
    }

    if (result.kind === 'did_not_converge') {
      await post_followup(
        ctx,
        run_dir,
        'DID_NOT_CONVERGE_FOLLOWUP.md',
        render_did_not_converge_followup(result.rounds),
      )
      console.error(`→ no improvement PR created (build_reviewer did not converge in ${String(result.rounds)} rounds)`)
      return result
    }

    await post_improvement_pr(ctx, run_dir, pr, result)
    console.error(`→ run artifacts: ${run_dir}`)
    return result
  } finally {
    // Always remove the worktree, even on schema validation, network, or
    // gh CLI failures. Cleanup failures are reported but never mask the
    // original error from try-block.
    try {
      await cleanup_worktree(user_cwd, wt.worktree_path)
    } catch (cleanup_err: unknown) {
      const message = cleanup_err instanceof Error ? cleanup_err.message : String(cleanup_err)
      console.error(`→ warning: worktree cleanup failed (${message}); prune manually with 'git worktree remove --force ${wt.worktree_path}'`)
    }
  }
}

export async function main(argv: ReadonlyArray<string> = process.argv): Promise<FinalResult> {
  const args = parse_argv(argv)
  const run_id = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const run_dir = join(RUNS_DIR, run_id)
  await mkdir(run_dir, { recursive: true })

  const trajectory = tee_logger(
    filesystem_logger({ output_path: join(run_dir, 'trajectory.jsonl') }),
    stdout_logger(),
  )

  if (args.pr !== undefined) {
    return run_pr_mode(args, run_dir, trajectory)
  }
  return run_fixture_mode(args, run_dir, trajectory)
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}

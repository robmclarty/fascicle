/**
 * pr-improve CLI entry — local end-to-end on a fixture diff.
 *
 * Phase A modes:
 *   pnpm --filter @repo/example-pr-improve improve:stub
 *   pnpm exec tsx examples/pr-improve/src/main.ts --stub --fixture <path>
 *
 * Phase B (real engine) target:
 *   pnpm exec tsx examples/pr-improve/src/main.ts --fixture <path>
 *
 * Writes per-run artifacts under `.runs/<run_id>/`:
 *   - trajectory.jsonl   (also tee'd to stdout for CloudWatch)
 *   - IMPROVEMENT_SPEC.md (if pragmatist accepted any change)
 *   - HANDOFF.md          (if a build round produced one)
 *   - result.json         (FinalResult summary)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { run } from '@repo/fascicle'
import { filesystem_logger, tee_logger } from '@repo/fascicle/adapters'

import { create_app_engine, make_stub_engine, read_engine_env, type StubResponse } from './engine.js'
import { build_flow, type FlowModels } from './flow.js'
import { stdout_logger } from './observability.js'
import { render_handoff, render_improvement_spec } from './render.js'
import { PragmatistOutputSchema, type FinalResult, type PRContext } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const RUNS_DIR = join(PACKAGE_ROOT, '.runs')

type CliArgs = {
  readonly fixture: string
  readonly stub: boolean
}

function parse_argv(argv: ReadonlyArray<string>): CliArgs {
  const args = argv.slice(2)
  let fixture: string | undefined
  let stub = false
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--stub') stub = true
    else if (a === '--fixture') {
      fixture = args[i + 1]
      i += 1
    }
  }
  if (fixture === undefined) {
    throw new Error('Usage: tsx src/main.ts [--stub] --fixture <path>')
  }
  return { fixture, stub }
}

function default_models(): FlowModels {
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

async function write_artifacts(
  run_dir: string,
  pr: PRContext,
  result: FinalResult,
): Promise<void> {
  await writeFile(join(run_dir, 'result.json'), JSON.stringify(result, null, 2))
  if (result.kind === 'improvement_ready') {
    await writeFile(
      join(run_dir, 'HANDOFF.md'),
      render_handoff(result.handoff, pr, 1),
    )
    await writeFile(
      join(run_dir, 'PR_COMMENT.md'),
      result.comment_body,
    )
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

  const engine = args.stub
    ? make_stub_engine(stub_responses())
    : create_app_engine(read_engine_env())

  try {
    const pr = await load_pr_from_fixture(resolve(args.fixture))
    const flow = build_flow(engine, default_models())

    const result = await run(flow, pr, {
      trajectory,
      install_signal_handlers: false,
    })

    // Pragmatist spec is intentionally not exposed by the flow's FinalResult,
    // because it's an intermediate artifact. We stub-serialize it from the
    // canned response when in stub mode, and from the trajectory in real mode.
    // For Phase A, just write a placeholder so the artifact set is complete.
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

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}

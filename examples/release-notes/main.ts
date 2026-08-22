/**
 * release-notes: a whole agent in one file.
 *
 * The blueprint (docs/blueprint.md) describes the layered layout for
 * multi-role apps. This example is deliberately the other end of that
 * spectrum: one model role, so the system prompt is an inline string, the
 * schema sits beside it, and the whole topology is a single `chain` read
 * top to bottom. Reach for the layered layout when roles multiply or the
 * prompt deserves its own review surface, not before.
 *
 *   chain
 *     ├ log      ← raw `git log --oneline` text
 *     ├ commits  ← parse hash + subject per line (pure)
 *     ├ grouped  ← bucket subjects by conventional-commit type (pure)
 *     ├ notes    ← writer (model_step via ctx.call, the only model boundary)
 *     └ output: render the release-notes markdown (pure)
 *
 * The engine is a canned stub so the example runs with no keys and no
 * network; swap `make_stub_engine()` for `create_engine({...})` to go live.
 *
 * Run directly:
 *   pnpm exec tsx examples/release-notes/main.ts
 */

import { z } from 'zod'

import { chain, model_step, run } from 'fascicle'
import { make_stub_engine } from 'fascicle/testing'
import type { Engine, Step } from 'fascicle'

export const notes_schema = z.object({
  headline: z.string(),
  highlights: z.array(z.string()).min(1),
})

export type Notes = z.infer<typeof notes_schema>

export const WRITER_SYSTEM =
  'You are a release-notes writer. From grouped conventional-commit subjects, ' +
  'produce a short headline and 2-5 user-facing highlights. Plain language, ' +
  'no commit hashes, nothing outside the schema.'

type Commit = { readonly hash: string; readonly subject: string }

export function parse_commits(log: string): ReadonlyArray<Commit> {
  return log
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash = '', ...rest] = line.split(' ')
      return { hash, subject: rest.join(' ') }
    })
}

export function group_by_type(
  commits: ReadonlyArray<Commit>,
): Readonly<Record<string, ReadonlyArray<string>>> {
  const grouped: Record<string, string[]> = {}
  for (const commit of commits) {
    const type = /^([a-z]+)[(!:]/.exec(commit.subject)?.[1] ?? 'other'
    const bucket = grouped[type] ?? []
    bucket.push(commit.subject)
    grouped[type] = bucket
  }
  return grouped
}

function render_markdown(
  notes: Notes,
  grouped: Readonly<Record<string, ReadonlyArray<string>>>,
  commit_count: number,
): string {
  const highlights = notes.highlights.map((h) => `- ${h}`).join('\n')
  const breakdown = Object.entries(grouped)
    .map(([type, subjects]) => `- ${type}: ${subjects.length}`)
    .join('\n')
  return `# ${notes.headline}\n\n${highlights}\n\n## In this release (${commit_count} commits)\n\n${breakdown}\n`
}

export function build_flow(engine: Engine, model: string): Step<string, string> {
  const writer = model_step({
    engine,
    model,
    system: WRITER_SYSTEM,
    schema: notes_schema,
    schema_repair_attempts: 2,
    id: 'writer',
  })

  return chain<string, 'log'>('log')
    .step('commits', ({ log }) => parse_commits(log))
    .step('grouped', ({ commits }) => group_by_type(commits))
    .step('notes', ({ grouped }, ctx) => ctx.call(writer, JSON.stringify(grouped, null, 2)))
    .output(({ commits, grouped, notes }) => render_markdown(notes, grouped, commits.length))
}

const SAMPLE_LOG = `\
bc46bb3 feat(core): add chain and ctx.call primitives
bfaf23d chore(gitignore): ignore the research scratch dir
a22f521 fix(engine): dispose claude_cli subprocesses on abort
9c01d22 docs(readme): re-tier the primitives table
77ab510 feat(viewer): live span tree for running flows
`

export async function run_with_stub(
  build: (engine: Engine, model: string) => Step<string, string>,
  log: string,
  canned: Notes,
): Promise<string> {
  const engine = make_stub_engine([{ prefix: '', content: canned }])
  try {
    return await run(build(engine, 'stub'), log, { install_signal_handlers: false })
  } finally {
    await engine.dispose()
  }
}

export function run_release_notes(log = SAMPLE_LOG): Promise<string> {
  return run_with_stub(build_flow, log, {
    headline: 'Composable chains and a live viewer',
    highlights: [
      'Flows can now be written as a single typed chain of named steps.',
      'The live viewer shows the span tree of a running flow.',
      'Aborting a run now cleans up CLI subprocesses reliably.',
    ],
  })
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_release_notes()
    .then((markdown) => {
      console.log(markdown)
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}

/**
 * web-research: answer a question from the web and cite the pages it read.
 *
 * Hands `web_tools(...)` from `fascicle/web` to one `generate` call. The model
 * searches, fetches the pages that look useful, and answers with the URLs it
 * leaned on. Each tool call is printed as it happens, so the run shows what
 * was searched for, what was fetched, and how much text came back.
 *
 * The search is the first of three that the environment allows:
 *   BRAVE_API_KEY set   Brave's Search API
 *   SEARXNG_URL set     a SearXNG server of your own
 *   neither             the Wikipedia search in ./wikipedia_search.ts
 *
 * Prereqs:
 *   OPENROUTER_API_KEY exported, or set in the root .env (see .env.example).
 *
 * Run directly:
 *   pnpm exec tsx --env-file=.env examples/web-research/main.ts
 *   pnpm exec tsx --env-file=.env examples/web-research/main.ts "Who designed the Sydney Opera House?"
 *   pnpm exec tsx --env-file=.env examples/web-research/main.ts --allow-host wikipedia.org "Who designed the Sydney Opera House?"
 */

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { create_engine } from 'fascicle'
import type { Tool } from 'fascicle'
import { brave_search, searxng_search, web_tools } from 'fascicle/web'
import type { WebSearch } from 'fascicle/web'

import { wikipedia_search } from './wikipedia_search.js'

const is_main = import.meta.url === `file://${process.argv[1] ?? ''}`

const DEFAULT_QUESTION = 'Who designed the Sydney Opera House, and why did he leave before it was finished?'

const engine = create_engine({
  providers: { openrouter: { api_key: process.env['OPENROUTER_API_KEY'] ?? '' } },
  defaults: { model: 'openai/gpt-4o-mini' },
})

export type WebResearchOptions = {
  readonly allow_hosts?: ReadonlyArray<string>
}

export type WebResearchResult = {
  readonly question: string
  readonly answer: string
  /** The final URL of every page a `web_fetch` call brought back, in order. */
  readonly pages: ReadonlyArray<string>
}

/**
 * Pick the search the environment allows, and say which on stderr.
 *
 * The order runs from the widest index to the narrowest. Wikipedia comes last
 * because it needs nothing, so the example always has a search.
 */
function pick_search(): WebSearch {
  const api_key = process.env['BRAVE_API_KEY'] ?? ''
  if (api_key.length > 0) {
    console.error('search: Brave (BRAVE_API_KEY is set)')
    return brave_search({ api_key })
  }
  const base_url = process.env['SEARXNG_URL'] ?? ''
  if (base_url.length > 0) {
    console.error(`search: SearXNG at ${base_url} (SEARXNG_URL is set)`)
    return searxng_search({ base_url })
  }
  console.error('search: Wikipedia (set BRAVE_API_KEY or SEARXNG_URL to search the whole web)')
  return wikipedia_search
}

/**
 * Read one string field off a tool call's input.
 *
 * The input is whatever the model sent, so the field is read without trusting
 * its shape, and anything that isn't a string reads as empty.
 */
function input_field(input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) return ''
  const value: unknown = Reflect.get(input, key)
  return typeof value === 'string' ? value : ''
}

/**
 * Wrap a tool so each call prints one line, and each fetched page is noted.
 *
 * A search prints its query before it runs. A fetch prints after, because its
 * line carries how many characters came back. A refusal prints too and is
 * thrown again, so the engine still hands it to the model as the tool's result.
 */
function announce(tool: Tool, pages: string[]): Tool {
  return {
    ...tool,
    execute: async (input, ctx) => {
      if (tool.name === 'web_search') {
        console.log(`search  ${JSON.stringify(input_field(input, 'query'))}`)
        return tool.execute(input, ctx)
      }
      const url = input_field(input, 'url')
      try {
        const output = String(await tool.execute(input, ctx))
        // The first line of a fetched page is `URL: <the address that answered>`.
        pages.push(/^URL: (.+)$/m.exec(output)?.[1] ?? url)
        console.log(`fetch   ${url} (${output.length.toLocaleString('en-US')} characters)`)
        return output
      } catch (err: unknown) {
        console.log(`fetch   ${url} failed: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
    },
  }
}

/**
 * Answer one question from the web.
 *
 * `allow_hosts` narrows `web_fetch` to the hosts named, which is the control
 * to reach for when the pages an agent may read should be a short list.
 */
export async function run_web_research(
  question = DEFAULT_QUESTION,
  options: WebResearchOptions = {},
): Promise<WebResearchResult> {
  const system = await readFile(new URL('./prompts/system.md', import.meta.url), 'utf8')
  const pages: string[] = []
  const tools = web_tools({
    search: pick_search(),
    ...(options.allow_hosts !== undefined ? { allow_hosts: options.allow_hosts } : {}),
  }).map((tool) => announce(tool, pages))
  const result = await engine.generate({ prompt: question, system, tools, max_steps: 12 })
  return { question, answer: result.content, pages: [...new Set(pages)] }
}

if (is_main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { 'allow-host': { type: 'string', multiple: true } },
    allowPositionals: true,
  })
  const question = positionals.join(' ')
  const allow_hosts = values['allow-host']
  if (allow_hosts !== undefined) console.error(`fetch: only ${allow_hosts.join(', ')}`)
  console.log(`question: ${question.length > 0 ? question : DEFAULT_QUESTION}\n`)
  run_web_research(
    question.length > 0 ? question : undefined,
    allow_hosts !== undefined ? { allow_hosts } : {},
  )
    .then(({ answer, pages }) => {
      console.log(`\n${answer}`)
      if (pages.length > 0) console.log(`\npages read:\n${pages.map((url) => `  ${url}`).join('\n')}`)
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
    .finally(() => {
      void engine.dispose()
    })
}

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * C3, on the sources. A localhost dev tool must fetch nothing at runtime, and
 * the cheapest way to reintroduce a fetch is a `<link>` to Google Fonts or a
 * CDN `src` pasted in from an artboard, which is what the artboards actually
 * carry at the top of every file.
 *
 * The built bytes are checked separately, by `scripts/build.mjs` under the
 * `build` slot, because a bundler can add a remote reference no source names.
 * This half runs on every `pnpm check` so a paste is caught the same minute it
 * lands rather than at the next release build.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(HERE, '..', 'app')

const SCANNED_EXT = new Set(['.css', '.html', '.ts', '.tsx'])
const EXTERNAL_URL_RE = /(?:https?:)?\/\/(?!\/)[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)]*/gi

// XML namespace URIs are identifiers, not addresses: no browser fetches them,
// and the SVG spec requires the literal string.
const NAMESPACE_URL_RE = /\/\/www\.w3\.org\//

/** Every scannable source file under the app, recursively. */
function app_sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return app_sources(full)
    return SCANNED_EXT.has(extname(entry.name)) ? [full] : []
  })
}

describe('the canvas app fetches nothing at runtime', () => {
  const sources = app_sources(APP_DIR)

  it('has sources to scan', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it.each(sources.map((file) => [file.slice(APP_DIR.length + 1), file]))(
    '%s names no external host',
    (_label, file) => {
      const text = readFileSync(file, 'utf8')
      const hits = (text.match(EXTERNAL_URL_RE) ?? []).filter((u) => !NAMESPACE_URL_RE.test(u))
      expect(hits).toEqual([])
    },
  )

  it('vendors both font families beside their licenses (D9)', () => {
    const fonts = readdirSync(join(APP_DIR, 'public', 'fonts'))
    expect(fonts).toContain('sora-latin.woff2')
    expect(fonts).toContain('sora-OFL.txt')
    expect(fonts).toContain('spline-sans-mono-latin.woff2')
    expect(fonts).toContain('spline-sans-mono-OFL.txt')
  })
})

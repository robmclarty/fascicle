/**
 * The built-in HTML converter of `web_fetch`: a page's markup in, markdown
 * the model can read out.
 *
 * It works in one pass over the tokens of the page, with no tree and no
 * recursion, so a page that nests a hundred thousand tags deep costs the same
 * as a flat one. Every search either finds what it looks for and moves past
 * it, or gives up and takes the rest of the input, which is what keeps the
 * pass linear on markup that was written to make it slow. It never throws on
 * malformed markup, because the pages worth reading are rarely well formed.
 */

type TextToken = { readonly kind: 'text'; readonly text: string }

type RawToken = { readonly kind: 'raw'; readonly name: string; readonly text: string }

type OpenToken = {
  readonly kind: 'open'
  readonly name: string
  readonly attrs: ReadonlyMap<string, string>
  readonly self_closing: boolean
}

type CloseToken = { readonly kind: 'close'; readonly name: string }

type Token = TextToken | RawToken | OpenToken | CloseToken

type Tag = {
  readonly name: string
  readonly attrs: ReadonlyMap<string, string>
  readonly self_closing: boolean
  readonly end: number
}

/** A list item or a quote: something that puts a margin on each line inside it. */
type Margin = {
  readonly kind: 'item' | 'quote'
  readonly first: string
  readonly rest: string
  readonly shown: boolean
  started: boolean
}

type List = {
  readonly kind: 'list'
  readonly ordered: boolean
  next: number
  count: number
  item: number | undefined
}

type Table = {
  readonly kind: 'table'
  readonly rows: string[][]
  row: string[] | undefined
  caption: string
  nested: boolean
}

type Entry = Margin | List | Table

type Span = { readonly start: number; readonly spaced: boolean }

type Link = Span & { readonly href: string }

type CellInfo = {
  readonly table: Table
  readonly caption: boolean
  readonly span: number
}

/**
 * Where output is being written: the page itself, or one table cell.
 *
 * A cell gets a context of its own so that whatever it holds (a list, a code
 * block, another table) is rendered apart and can then be laid into its row.
 */
type Ctx = {
  readonly out: string[]
  parts: string[]
  spaced: boolean
  gap: number
  readonly stack: Entry[]
  readonly margins: Margin[]
  readonly lists: List[]
  orphan: number | undefined
  quotes: number
  tables: number
  fake_tables: number
  link: Link | undefined
  code: Span | undefined
  heading: number
  pre: string | undefined
  readonly cell: CellInfo | undefined
}

type Skip = { readonly name: string; depth: number; foreign: number }

type State = {
  ctx: Ctx
  readonly outer: Ctx[]
  base: URL | undefined
  based: boolean
  skip: Skip | undefined
}

type Opener = (state: State, token: OpenToken) => void

type Closer = (state: State, name: string) => void

const LT = 60
const GT = 62
const SLASH = 47
const BANG = 33
const QUESTION = 63
const EQUALS = 61
const DOUBLE_QUOTE = 34
const SINGLE_QUOTE = 39

/** Margins past this depth are not drawn, which bounds the width of a line's prefix. */
const MAX_MARGINS = 24

/** Tables nested past this depth are read as plain blocks, which bounds how often a cell's text is copied. */
const MAX_TABLE_DEPTH = 6

const MAX_COLUMN_SPAN = 16

const MAX_LIST_START = 999_999_999

const NO_BREAK_SPACE = String.fromCodePoint(0xa0)

const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd)

const WHITESPACE_RUN = new RegExp(`[ \\t\\n\\r\\f${NO_BREAK_SPACE}]+`, 'g')

const ENTITY = /&(?:#[xX]([0-9a-fA-F]{1,8})|#([0-9]{1,8})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g

const LINK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** What the code points 0x80 to 0x9f mean in a numeric reference, which is Windows-1252 and not Unicode. */
const WINDOWS_1252 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
]

// The names from here to the matching enable line are HTML's own vocabulary
// (tags, attributes, and character references), so the spell check skips them.
// cspell:disable

/** Elements whose content is not markup, and is dropped. */
const RAW_TAGS = ['script', 'style', 'noscript', 'title', 'textarea', 'iframe', 'xmp']

const PARAGRAPH_TAGS = [
  'address', 'article', 'aside', 'body', 'center', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'html', 'legend',
  'main', 'menu', 'nav', 'p', 'search', 'section', 'summary',
]

const LINE_TAGS = ['dd', 'optgroup', 'option']

const HEADINGS: ReadonlyMap<string, number> = new Map([
  ['h1', 1], ['h2', 2], ['h3', 3], ['h4', 4], ['h5', 5], ['h6', 6],
])

const CODE_TAGS = ['code', 'kbd', 'samp', 'tt']

const ROW_TAGS = ['tr', 'thead', 'tbody', 'tfoot']

const CELL_TAGS: ReadonlySet<string> = new Set(['td', 'th', 'caption'])

/** Tags that end an open `pre`, since none of them can sit inside one. */
const PRE_ENDERS: ReadonlySet<string> = new Set([
  'table', 'caption', 'td', 'th', ...ROW_TAGS, 'ul', 'ol', 'li', 'blockquote', 'hr', ...HEADINGS.keys(),
])

/** HTML tags that cannot belong to an `svg`, so one of them means the `svg` was never closed. */
const SVG_BREAKOUT: ReadonlySet<string> = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta',
  'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table',
  'tt', 'u', 'ul', 'var',
])

const FOREIGN_OBJECT = 'foreignobject'

const BLOCKQUOTE = 'blockquote'

const COLSPAN = 'colspan'

const CDATA_OPEN = '<![CDATA['

/** The names of U+00A0 to U+00FF in order, which are also the names HTML accepts with no closing semicolon. */
const LATIN_1_NAMES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 ' +
  'acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde ' +
  'Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute ' +
  'Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde ' +
  'auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ' +
  'ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'

/** Runs of names whose code points follow one another, each run led by its first code point in hex. */
const NAME_RUNS = [
  '391 Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho',
  '3a3 Sigma Tau Upsilon Phi Chi Psi Omega',
  '3b1 alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega',
  '2190 larr uarr rarr darr harr',
  '21d0 lArr uArr rArr dArr hArr',
  '2018 lsquo rsquo sbquo',
  '201c ldquo rdquo bdquo',
  '2020 dagger Dagger bull',
  '2032 prime Prime',
  '2308 lceil rceil lfloor rfloor',
]

/** The other names, each with its code point in hex. */
const NAME_PAIRS =
  'quot=22 amp=26 apos=27 lt=3c gt=3e QUOT=22 AMP=26 LT=3c GT=3e COPY=a9 REG=ae TRADE=2122 Tab=9 NewLine=a ' +
  'OElig=152 oelig=153 Scaron=160 scaron=161 Yuml=178 fnof=192 circ=2c6 tilde=2dc thetasym=3d1 upsih=3d2 ' +
  'piv=3d6 ensp=2002 emsp=2003 thinsp=2009 zwnj=200c zwj=200d lrm=200e rlm=200f ndash=2013 mdash=2014 ' +
  'hellip=2026 permil=2030 lsaquo=2039 rsaquo=203a oline=203e frasl=2044 euro=20ac trade=2122 crarr=21b5 ' +
  'forall=2200 part=2202 exist=2203 empty=2205 nabla=2207 isin=2208 notin=2209 ni=220b prod=220f sum=2211 ' +
  'minus=2212 lowast=2217 radic=221a prop=221d infin=221e ang=2220 and=2227 or=2228 cap=2229 cup=222a ' +
  'int=222b there4=2234 sim=223c cong=2245 asymp=2248 ne=2260 equiv=2261 le=2264 ge=2265 sub=2282 ' +
  'sup=2283 nsub=2284 sube=2286 supe=2287 oplus=2295 otimes=2297 perp=22a5 sdot=22c5 lang=2329 rang=232a ' +
  'loz=25ca spades=2660 clubs=2663 hearts=2665 diams=2666'

/** Names HTML accepts with no semicolon, beside the Latin-1 ones. */
const BARE_NAMES = ['amp', 'lt', 'gt', 'quot', 'AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG']

// cspell:enable

/** The longest name in `BARE`, which bounds the search for one at the head of a longer word. */
const BARE_MAX = 6

/**
 * Build the table of block elements, each with the line breaks it asks for around itself.
 *
 * A 2 is a paragraph break, with a blank line, and a 1 is a new line.
 */
function block_gaps(): ReadonlyMap<string, number> {
  const gaps = new Map<string, number>()
  for (const name of PARAGRAPH_TAGS) gaps.set(name, 2)
  for (const name of LINE_TAGS) gaps.set(name, 1)
  return gaps
}

const BLOCK_GAPS = block_gaps()

/**
 * Build the table of named character references, name to text.
 *
 * It holds the references HTML 4 defined plus the uppercase few HTML 5
 * added, which is what pages use in practice. A name outside it stays in the
 * text as it was written.
 */
function named_entities(): ReadonlyMap<string, string> {
  const named = new Map<string, string>()
  LATIN_1_NAMES.split(' ').forEach((name, index) => {
    named.set(name, String.fromCodePoint(0xa0 + index))
  })
  for (const run of NAME_RUNS) {
    const [first = '', ...names] = run.split(' ')
    const start = Number.parseInt(first, 16)
    names.forEach((name, index) => {
      named.set(name, String.fromCodePoint(start + index))
    })
  }
  for (const pair of NAME_PAIRS.split(' ')) {
    const [name = '', code = ''] = pair.split('=')
    named.set(name, String.fromCodePoint(Number.parseInt(code, 16)))
  }
  return named
}

const NAMED = named_entities()

/**
 * Build the table of references that count with no closing semicolon.
 */
function bare_entities(): ReadonlyMap<string, string> {
  const bare = new Map<string, string>()
  for (const name of [...LATIN_1_NAMES.split(' '), ...BARE_NAMES]) {
    bare.set(name, NAMED.get(name) ?? '')
  }
  return bare
}

const BARE = bare_entities()

/**
 * Build, for each raw text element, the pattern that finds its end tag.
 */
function raw_ends(): ReadonlyMap<string, RegExp> {
  const ends = new Map<string, RegExp>()
  for (const name of RAW_TAGS) ends.set(name, new RegExp(`</${name}(?=[\\s/>])`, 'gi'))
  return ends
}

const RAW_ENDS = raw_ends()

/**
 * Whether a character code is HTML whitespace.
 */
function is_space(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13
}

/**
 * Whether a character code is an ASCII letter.
 */
function is_letter(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90)
}

/**
 * Whether a character code ends a tag name or an attribute name.
 */
function ends_name(code: number): boolean {
  return is_space(code) || code === SLASH || code === GT
}

/**
 * The index of the first character at or after `from` that is not whitespace.
 */
function skip_spaces(html: string, from: number): number {
  let pos = from
  while (pos < html.length && is_space(html.charCodeAt(pos))) pos += 1
  return pos
}

/**
 * The index of the first character at or after `from` that ends a name.
 */
function name_end(html: string, from: number, stop_at_equals: boolean): number {
  let pos = from
  while (pos < html.length) {
    const code = html.charCodeAt(pos)
    if (ends_name(code) || (stop_at_equals && code === EQUALS)) break
    pos += 1
  }
  return pos
}

/**
 * The index just past an unquoted attribute value that starts at `from`.
 */
function bare_value_end(html: string, from: number): number {
  let pos = from
  while (pos < html.length && !is_space(html.charCodeAt(pos)) && html.charCodeAt(pos) !== GT) pos += 1
  return pos
}

/**
 * Read a tag from its name to its closing `>`, or undefined when the input ends first.
 *
 * `from` is the index of the name's first character. A quoted attribute value
 * runs to its closing quote, so a `>` inside one does not end the tag. A
 * repeated attribute keeps its first value, as a browser does.
 */
function read_tag(html: string, from: number): Tag | undefined {
  let pos = name_end(html, from, false)
  const name = html.slice(from, pos).toLowerCase()
  const attrs = new Map<string, string>()
  let self_closing = false
  for (;;) {
    pos = skip_spaces(html, pos)
    if (pos >= html.length) return undefined
    const code = html.charCodeAt(pos)
    if (code === GT) return { name, attrs, self_closing, end: pos + 1 }
    if (code === SLASH) {
      self_closing = html.charCodeAt(pos + 1) === GT
      pos += 1
      continue
    }
    // The first character belongs to the name whatever it is, a `=` included,
    // which is what guarantees each turn of the loop moves forward.
    const key_end = name_end(html, pos + 1, true)
    const key = html.slice(pos, key_end).toLowerCase()
    let value = ''
    pos = skip_spaces(html, key_end)
    if (html.charCodeAt(pos) === EQUALS) {
      pos = skip_spaces(html, pos + 1)
      const quote = html.charCodeAt(pos)
      if (quote === DOUBLE_QUOTE || quote === SINGLE_QUOTE) {
        const close = html.indexOf(quote === DOUBLE_QUOTE ? '"' : "'", pos + 1)
        if (close < 0) return undefined
        value = html.slice(pos + 1, close)
        pos = close + 1
      } else {
        const end = bare_value_end(html, pos)
        value = html.slice(pos, end)
        pos = end
      }
    }
    if (!attrs.has(key)) attrs.set(key, value)
  }
}

/**
 * Whether the `<` at `pos` opens markup, as opposed to being a character of text.
 */
function starts_markup(html: string, pos: number): boolean {
  const code = html.charCodeAt(pos + 1)
  if (code === SLASH) return pos + 2 < html.length
  return is_letter(code) || code === BANG || code === QUESTION
}

/**
 * The index of the next `<` at or after `from` that opens markup, or the input's length.
 */
function next_markup(html: string, from: number): number {
  let pos = from
  for (;;) {
    const at = html.indexOf('<', pos)
    if (at < 0) return html.length
    if (starts_markup(html, at)) return at
    pos = at + 1
  }
}

/**
 * Split a page into tokens, handed out one call at a time, undefined at the end.
 *
 * Comments, declarations, and processing instructions are dropped here. The
 * content of a raw text element (a `script`, a `style`, a `title`) arrives as
 * one `raw` token that runs to the element's own end tag, so a `</` inside a
 * script's string closes nothing. A construct the input never closes takes
 * the rest of the input, which is what a browser does with it too.
 */
function tokenizer(html: string): () => Token | undefined {
  const length = html.length
  let pos = 0
  let cdata_can_end = true
  const skip_past = (needle: string, from: number): void => {
    const at = html.indexOf(needle, from)
    pos = at < 0 ? length : at + needle.length
  }
  const skip_declaration = (): void => {
    if (html.startsWith('<!--', pos)) {
      if (html.charCodeAt(pos + 4) === GT) pos += 5
      else if (html.startsWith('->', pos + 4)) pos += 6
      else skip_past('-->', pos + 4)
      return
    }
    if (cdata_can_end && html.startsWith(CDATA_OPEN, pos)) {
      const end = html.indexOf(']]>', pos + CDATA_OPEN.length)
      if (end >= 0) {
        pos = end + 3
        return
      }
      // A failed search is remembered, so a page of unclosed sections does
      // not scan to the end of the input once for each of them.
      cdata_can_end = false
    }
    skip_past('>', pos + 2)
  }
  return () => {
    while (pos < length) {
      if (html.charCodeAt(pos) !== LT || !starts_markup(html, pos)) {
        const start = pos
        pos = next_markup(html, pos + 1)
        return { kind: 'text', text: html.slice(start, pos) }
      }
      const code = html.charCodeAt(pos + 1)
      if (code === BANG) {
        skip_declaration()
        continue
      }
      const closing = code === SLASH
      if (code === QUESTION || (closing && !is_letter(html.charCodeAt(pos + 2)))) {
        skip_past('>', pos + 2)
        continue
      }
      const tag = read_tag(html, closing ? pos + 2 : pos + 1)
      if (tag === undefined) break
      pos = tag.end
      if (closing) return { kind: 'close', name: tag.name }
      const raw_end = RAW_ENDS.get(tag.name)
      if (raw_end === undefined) {
        return { kind: 'open', name: tag.name, attrs: tag.attrs, self_closing: tag.self_closing }
      }
      raw_end.lastIndex = pos
      const found = raw_end.exec(html)
      const text = html.slice(pos, found === null ? length : found.index)
      if (found === null) pos = length
      else skip_past('>', found.index)
      return { kind: 'raw', name: tag.name, text }
    }
    pos = length
    return undefined
  }
}

/**
 * The text a numeric character reference stands for.
 *
 * The range 0x80 to 0x9f is read as Windows-1252, which is what the pages
 * that use it mean and what a browser does. A code that is no character at
 * all becomes U+FFFD.
 */
function code_point_text(code: number): string {
  if (code >= 0x80 && code <= 0x9f) return String.fromCodePoint(WINDOWS_1252[code - 0x80] ?? code)
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return REPLACEMENT_CHARACTER
  return String.fromCodePoint(code)
}

/**
 * The text one matched reference stands for, or undefined when it stands for nothing.
 *
 * A name with its semicolon is looked up whole. A name without one counts
 * only when it is one of the old Latin-1 names, and in text it may be the
 * head of a longer word (`&copyright` reads as the sign and `right`). In an
 * attribute that looser reading is off, and so is a bare name followed by
 * `=`, which is what keeps `?a=1&copy=2` in a link intact.
 */
function entity_text(match: RegExpExecArray, text: string, in_attribute: boolean): string | undefined {
  const [whole, hex, decimal, name] = match
  if (hex !== undefined) return code_point_text(Number.parseInt(hex, 16))
  if (decimal !== undefined) return code_point_text(Number.parseInt(decimal, 10))
  if (name === undefined) return undefined
  const closed = whole.endsWith(';')
  if (closed) {
    const exact = NAMED.get(name)
    if (exact !== undefined) return exact
  }
  if (in_attribute) {
    if (closed || text.charCodeAt(match.index + whole.length) === EQUALS) return undefined
    return BARE.get(name)
  }
  for (let size = Math.min(name.length, BARE_MAX); size >= 2; size -= 1) {
    const bare = BARE.get(name.slice(0, size))
    if (bare !== undefined) return bare + whole.slice(size + 1)
  }
  return undefined
}

/**
 * Decode the character references in a run of text or an attribute value, once.
 *
 * One pass means `&amp;lt;` comes out as `&lt;` and not as `<`.
 */
function decode_entities(text: string, in_attribute: boolean): string {
  if (!text.includes('&')) return text
  const pieces: string[] = []
  let last = 0
  ENTITY.lastIndex = 0
  for (let match = ENTITY.exec(text); match !== null; match = ENTITY.exec(text)) {
    const decoded = entity_text(match, text, in_attribute)
    if (decoded === undefined) continue
    pieces.push(text.slice(last, match.index), decoded)
    last = match.index + match[0].length
  }
  pieces.push(text.slice(last))
  return pieces.join('')
}

/**
 * Turn each run of whitespace, no-break spaces included, into one space.
 */
function collapse(text: string): string {
  return text.replace(WHITESPACE_RUN, ' ')
}

/**
 * Trim each line of a block, drop the empty ones at its ends, and keep at most one between the rest.
 */
function tidy_lines(text: string): string[] {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' && (lines.length === 0 || lines[lines.length - 1] === '')) continue
    lines.push(line)
  }
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Fold rendered text onto one line, which is the form a table cell needs.
 */
function one_line(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ')
}

/**
 * The length of the longest run of backticks in a piece of code.
 */
function longest_backtick_run(text: string): number {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  return longest
}

/**
 * Write inline code, fenced by one more backtick than the code itself holds.
 */
function code_span(text: string): string {
  const fence = '`'.repeat(longest_backtick_run(text) + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/**
 * Parse an address, or return undefined when it is not one.
 */
function parse_url(text: string, base: URL | undefined): URL | undefined {
  try {
    return base === undefined ? new URL(text) : new URL(text, base)
  } catch {
    return undefined
  }
}

/**
 * The absolute address an `href` points at, or undefined when the link should degrade to its text.
 *
 * A link the model could not follow or cite (a script, a data URL, an `href`
 * that does not parse) is worth only its text. The characters that would end
 * a markdown link early are percent-encoded.
 */
function link_target(href: string | undefined, base: URL | undefined): string | undefined {
  if (href === undefined) return undefined
  const text = decode_entities(href, true).trim()
  if (text === '') return undefined
  const url = parse_url(text, base)
  if (url === undefined || !LINK_SCHEMES.has(url.protocol)) return undefined
  return url.href.replace(/[ ()<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * The language a code block names in its `class`, or an empty string.
 */
function language_of(attrs: ReadonlyMap<string, string>): string {
  for (const token of (attrs.get('class') ?? '').split(/[ \t\n\r\f]+/)) {
    const language = /^lang(?:uage)?-([A-Za-z0-9_+#.-]{1,32})$/.exec(token)?.[1]
    if (language !== undefined) return language
  }
  return ''
}

/**
 * Read a whole number from an attribute, held to `max`, or `fallback` when it is not one or is under `min`.
 */
function whole_number(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (Number.isNaN(parsed) || parsed < min) return fallback
  return Math.min(parsed, max)
}

/**
 * Make an empty output context, for the page or for one table cell.
 */
function new_ctx(cell: CellInfo | undefined): Ctx {
  return {
    out: [],
    parts: [],
    spaced: true,
    gap: 0,
    stack: [],
    margins: [],
    lists: [],
    orphan: undefined,
    quotes: 0,
    tables: 0,
    fake_tables: 0,
    link: undefined,
    code: undefined,
    heading: 0,
    pre: undefined,
    cell,
  }
}

/**
 * Ask for at least `lines` line breaks before the next block: 1 for a new line, 2 for a blank line between.
 *
 * Inside a list item or a quote that has printed nothing yet the request is
 * dropped, so the first block of an item sits on the line of its marker.
 */
function request_gap(ctx: Ctx, lines: number): void {
  const inner = ctx.margins[ctx.margins.length - 1]
  if (inner !== undefined && !inner.started) return
  if (lines > ctx.gap) ctx.gap = lines
}

/**
 * The margin of the next line: each open item's marker or indent, each open quote's `> `.
 */
function line_prefix(ctx: Ctx): string {
  let prefix = ''
  for (const margin of ctx.margins) {
    prefix += margin.started ? margin.rest : margin.first
    margin.started = true
  }
  return prefix
}

/**
 * The margin of a blank line between two blocks, which belongs only to the containers both blocks sit in.
 */
function blank_prefix(ctx: Ctx): string {
  let prefix = ''
  for (const margin of ctx.margins) {
    if (!margin.started) break
    prefix += margin.rest
  }
  return prefix.trimEnd()
}

/**
 * Write a block's lines to the output, each under the margins open right now.
 */
function emit_block(ctx: Ctx, lines: ReadonlyArray<string>): void {
  if (lines.length === 0) return
  if (ctx.out.length > 0) {
    ctx.out.push('\n')
    if (ctx.gap >= 2) ctx.out.push(blank_prefix(ctx), '\n')
  }
  lines.forEach((line, index) => {
    const prefix = line_prefix(ctx)
    if (index > 0) ctx.out.push('\n')
    ctx.out.push(line === '' ? prefix.trimEnd() : prefix + line)
  })
  ctx.gap = 0
}

/**
 * Add decoded text to the current line, with its whitespace collapsed against what is already there.
 */
function push_text(ctx: Ctx, text: string): void {
  const collapsed = collapse(text)
  const piece = ctx.spaced && collapsed.startsWith(' ') ? collapsed.slice(1) : collapsed
  if (piece === '') return
  ctx.parts.push(piece)
  ctx.spaced = piece.endsWith(' ')
}

/**
 * Close an inline span (a link or inline code) by replacing what was written since it opened.
 *
 * Whitespace at either end of the span moves outside it, so `foo<a> bar</a>`
 * reads `foo [bar](...)`. A span with no text leaves nothing behind.
 */
function close_span(ctx: Ctx, span: Span, render: (text: string) => string): void {
  const raw = collapse(ctx.parts.splice(span.start).join(''))
  const text = raw.trim()
  const lead = raw.startsWith(' ') && !span.spaced
  if (lead) ctx.parts.push(' ')
  if (text === '') {
    ctx.spaced = lead || span.spaced
    return
  }
  ctx.parts.push(render(text))
  ctx.spaced = raw.endsWith(' ')
  if (ctx.spaced) ctx.parts.push(' ')
}

/**
 * Close the open inline code span, if one is open.
 */
function close_code(ctx: Ctx): void {
  const span = ctx.code
  if (span === undefined) return
  ctx.code = undefined
  close_span(ctx, span, code_span)
}

/**
 * Close the open link, if one is open, writing it as `[text](address)`.
 */
function close_link(ctx: Ctx): void {
  const link = ctx.link
  if (link === undefined) return
  ctx.link = undefined
  // Code opened inside the link and never closed ends with it.
  close_code(ctx)
  close_span(ctx, link, (text) => `[${text.replace(/[[\]]/g, '\\$&')}](${link.href})`)
}

/**
 * End the open `pre` and write it as a fenced code block.
 *
 * The fence is longer than any run of backticks in the code, the newline
 * right after the opening tag is dropped as HTML says, and the whitespace
 * inside is otherwise kept.
 */
function end_pre(ctx: Ctx): void {
  const language = ctx.pre ?? ''
  ctx.pre = undefined
  const raw = ctx.parts.join('').replace(/\r\n?/g, '\n').replaceAll(NO_BREAK_SPACE, ' ')
  ctx.parts = []
  ctx.spaced = true
  const code = (raw.startsWith('\n') ? raw.slice(1) : raw).trimEnd()
  if (code === '') return
  const fence = '`'.repeat(Math.max(3, longest_backtick_run(code) + 1))
  emit_block(ctx, [fence + language, ...code.split('\n'), fence])
  request_gap(ctx, 2)
}

/**
 * End the current line of text and write it as a block: a paragraph, or a heading when one is open.
 *
 * A link that is still open is closed for this block and opened again for
 * the next, so a link wrapped around a heading and a paragraph links both.
 * A heading takes the first block with text in it and no more, so one that
 * is never closed does not turn the rest of the page into headings.
 */
function flush_inline(ctx: Ctx): void {
  if (ctx.pre !== undefined) {
    end_pre(ctx)
    return
  }
  const link = ctx.link
  close_code(ctx)
  close_link(ctx)
  const lines = tidy_lines(ctx.parts.join(''))
  ctx.parts = []
  ctx.spaced = true
  if (link !== undefined) ctx.link = { href: link.href, start: 0, spaced: true }
  if (lines.length === 0) return
  if (ctx.heading === 0) {
    emit_block(ctx, lines)
    return
  }
  emit_block(ctx, [`${'#'.repeat(ctx.heading)} ${lines.join(' ')}`])
  ctx.heading = 0
}

/**
 * Break the flow at a block boundary, asking for `lines` line breaks before whatever comes next.
 *
 * Inside a `pre` a block boundary is only a new line of code.
 */
function break_block(ctx: Ctx, lines: number): void {
  if (ctx.pre !== undefined) {
    if (!ctx.spaced) ctx.parts.push('\n')
    ctx.spaced = true
    return
  }
  flush_inline(ctx)
  request_gap(ctx, lines)
}

/**
 * Close a table row, keeping it when it has cells.
 */
function end_row(table: Table): void {
  if (table.row !== undefined && table.row.length > 0) table.rows.push(table.row)
  table.row = undefined
}

/**
 * Write a finished table.
 *
 * A table of two or more columns is a markdown table, with its first row as
 * the header since markdown has no table without one, and each cell folded
 * onto one line. A table that holds another table, or has a single column,
 * is taken for page layout, and its cells are written as blocks one after
 * another.
 */
function emit_table(ctx: Ctx, table: Table): void {
  end_row(table)
  request_gap(ctx, 2)
  const caption = one_line(table.caption)
  if (caption !== '') {
    emit_block(ctx, [caption])
    request_gap(ctx, 2)
  }
  const width = table.rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  if (table.nested || width < 2) {
    for (const text of table.rows.flat()) {
      if (text === '') continue
      emit_block(ctx, text.split('\n'))
      request_gap(ctx, 2)
    }
    return
  }
  if (table.rows.every((row) => row.every((text) => text === ''))) return
  const lines: string[] = []
  table.rows.forEach((row, index) => {
    const cells = row.map((text) => one_line(text).replaceAll('|', '\\|'))
    // Only the header is padded: its width has to match the rule under it,
    // while a short body row is legal and padding each would cost rows times columns.
    while (index === 0 && cells.length < width) cells.push('')
    lines.push(`| ${cells.join(' | ')} |`)
    if (index === 0) lines.push(`|${' --- |'.repeat(width)}`)
  })
  emit_block(ctx, lines)
}

/**
 * Close the innermost open container (list, item, quote, or table) and return it.
 */
function pop_entry(ctx: Ctx): Entry | undefined {
  flush_inline(ctx)
  const entry = ctx.stack.pop()
  if (entry === undefined) return undefined
  if (entry.kind === 'table') {
    ctx.tables -= 1
    emit_table(ctx, entry)
    request_gap(ctx, 2)
    return entry
  }
  if (entry.kind === 'list') {
    ctx.lists.pop()
    request_gap(ctx, 2)
    return entry
  }
  if (entry.shown) ctx.margins.pop()
  if (entry.kind === 'quote') {
    ctx.quotes -= 1
    request_gap(ctx, 2)
    return entry
  }
  const list = ctx.lists[ctx.lists.length - 1]
  if (list !== undefined && list.item === ctx.stack.length) list.item = undefined
  else if (ctx.orphan === ctx.stack.length) ctx.orphan = undefined
  request_gap(ctx, 1)
  return entry
}

/**
 * Close containers until the stack is `size` deep.
 */
function pop_to(ctx: Ctx, size: number): void {
  while (ctx.stack.length > size) pop_entry(ctx)
}

/**
 * Close containers until one of the wanted kind has closed.
 */
function pop_through(ctx: Ctx, kind: Entry['kind']): void {
  let entry = pop_entry(ctx)
  while (entry !== undefined && entry.kind !== kind) entry = pop_entry(ctx)
}

/**
 * Close the cell being written and lay its text into its table.
 */
function close_cell(state: State): void {
  const ctx = state.ctx
  const parent = state.outer.pop()
  if (parent === undefined || ctx.cell === undefined) return
  pop_to(ctx, 0)
  flush_inline(ctx)
  state.ctx = parent
  const { table, caption, span } = ctx.cell
  const text = ctx.out.join('')
  if (caption) {
    table.caption = text
    return
  }
  const row = table.row ?? []
  table.row = row
  row.push(text)
  for (let extra = 1; extra < span; extra += 1) row.push('')
}

/**
 * Find the table a row or cell tag belongs to, closing whatever stands between it and the tag.
 *
 * Inside a cell with no table of its own, the tag speaks to the cell's
 * table, so the cell closes first. Returns undefined when no table is open.
 */
function table_target(state: State): Table | undefined {
  if (state.ctx.tables === 0) {
    if (state.ctx.cell === undefined) return undefined
    close_cell(state)
  }
  const ctx = state.ctx
  for (;;) {
    const top = ctx.stack[ctx.stack.length - 1]
    if (top === undefined) return undefined
    if (top.kind === 'table') return top
    pop_entry(ctx)
  }
}

/**
 * Open a heading: the next block of text is written with its `#` marks.
 */
function open_heading(state: State, token: OpenToken): void {
  break_block(state.ctx, 2)
  state.ctx.heading = HEADINGS.get(token.name) ?? 0
}

/**
 * Close a heading.
 */
function close_heading(state: State): void {
  break_block(state.ctx, 2)
  state.ctx.heading = 0
}

/**
 * Write a `br` as a line break inside the current block.
 */
function open_break(state: State): void {
  state.ctx.parts.push('\n')
  state.ctx.spaced = true
}

/**
 * Write an `hr` as a markdown rule.
 */
function open_rule(state: State): void {
  break_block(state.ctx, 2)
  emit_block(state.ctx, ['---'])
  request_gap(state.ctx, 2)
}

/**
 * Write an image as its `alt` text, which is the part of it a reader of text can use.
 */
function open_image(state: State, token: OpenToken): void {
  push_text(state.ctx, decode_entities(token.attrs.get('alt') ?? '', true))
}

/**
 * Open a link, closing one that is still open, since links do not nest.
 */
function open_link(state: State, token: OpenToken): void {
  const ctx = state.ctx
  close_link(ctx)
  if (ctx.code !== undefined) return
  const href = link_target(token.attrs.get('href'), state.base)
  if (href !== undefined) ctx.link = { href, start: ctx.parts.length, spaced: ctx.spaced }
}

/**
 * Close the open link.
 */
function close_anchor(state: State): void {
  close_link(state.ctx)
}

/**
 * Open an inline code span.
 */
function open_code(state: State): void {
  const ctx = state.ctx
  if (ctx.code === undefined) ctx.code = { start: ctx.parts.length, spaced: ctx.spaced }
}

/**
 * Close the open inline code span.
 */
function close_code_tag(state: State): void {
  close_code(state.ctx)
}

/**
 * Open a `pre`: text is kept as written until it closes.
 */
function open_pre(state: State, token: OpenToken): void {
  break_block(state.ctx, 2)
  state.ctx.pre = language_of(token.attrs)
}

/**
 * Open a block quote.
 */
function open_quote(state: State): void {
  const ctx = state.ctx
  break_block(ctx, 2)
  const quote: Margin = {
    kind: 'quote',
    first: '> ',
    rest: '> ',
    shown: ctx.margins.length < MAX_MARGINS,
    started: false,
  }
  ctx.stack.push(quote)
  if (quote.shown) ctx.margins.push(quote)
  ctx.quotes += 1
}

/**
 * Close the innermost block quote, with whatever is still open inside it.
 */
function close_quote(state: State): void {
  if (state.ctx.quotes > 0) pop_through(state.ctx, 'quote')
}

/**
 * Open a list. One that sits in a list item starts on the next line, with no blank line between.
 */
function open_list(state: State, token: OpenToken): void {
  const ctx = state.ctx
  const top = ctx.stack[ctx.stack.length - 1]
  break_block(ctx, top?.kind === 'item' ? 1 : 2)
  const list: List = {
    kind: 'list',
    ordered: token.name === 'ol',
    next: whole_number(token.attrs.get('start'), 1, 0, MAX_LIST_START),
    count: 0,
    item: undefined,
  }
  ctx.stack.push(list)
  ctx.lists.push(list)
}

/**
 * Close the innermost list, with whatever is still open inside it.
 */
function close_list(state: State): void {
  if (state.ctx.lists.length > 0) pop_through(state.ctx, 'list')
}

/**
 * Open a list item, closing the item before it when its end tag was left out.
 *
 * Items of one list sit on consecutive lines whatever blocks they hold. An
 * item outside any list is written as a bullet.
 */
function open_item(state: State): void {
  const ctx = state.ctx
  const list = ctx.lists[ctx.lists.length - 1]
  const open = list === undefined ? ctx.orphan : list.item
  if (open !== undefined) pop_to(ctx, open)
  flush_inline(ctx)
  if (list !== undefined && list.count > 0) ctx.gap = 1
  else request_gap(ctx, 1)
  const marker = list?.ordered === true ? `${String(list.next)}. ` : '- '
  const item: Margin = {
    kind: 'item',
    first: marker,
    rest: ' '.repeat(marker.length),
    shown: ctx.margins.length < MAX_MARGINS,
    started: false,
  }
  if (list === undefined) ctx.orphan = ctx.stack.length
  else {
    list.item = ctx.stack.length
    list.next += 1
    list.count += 1
  }
  ctx.stack.push(item)
  if (item.shown) ctx.margins.push(item)
}

/**
 * Close the open item of the innermost list.
 */
function close_item(state: State): void {
  const ctx = state.ctx
  const list = ctx.lists[ctx.lists.length - 1]
  const open = list === undefined ? ctx.orphan : list.item
  if (open !== undefined) pop_to(ctx, open)
}

/**
 * Open a table. Past the depth limit it is read as plain blocks.
 */
function open_table(state: State): void {
  const ctx = state.ctx
  break_block(ctx, 2)
  if (state.outer.length >= MAX_TABLE_DEPTH) {
    ctx.fake_tables += 1
    return
  }
  if (ctx.cell !== undefined) ctx.cell.table.nested = true
  ctx.stack.push({ kind: 'table', rows: [], row: undefined, caption: '', nested: false })
  ctx.tables += 1
}

/**
 * Open a row, or a row group, which ends the row before it.
 */
function open_row(state: State, token: OpenToken): void {
  const table = state.ctx.fake_tables > 0 ? undefined : table_target(state)
  if (table === undefined) {
    break_block(state.ctx, 1)
    return
  }
  end_row(table)
  if (token.name === 'tr') table.row = []
}

/**
 * Open a cell or a caption, which gets an output context of its own.
 */
function open_cell(state: State, token: OpenToken): void {
  const caption = token.name === 'caption'
  const table = state.ctx.fake_tables > 0 ? undefined : table_target(state)
  if (table === undefined) {
    if (caption) break_block(state.ctx, 2)
    else push_text(state.ctx, ' ')
    return
  }
  const span = caption ? 1 : whole_number(token.attrs.get(COLSPAN), 1, 1, MAX_COLUMN_SPAN)
  state.outer.push(state.ctx)
  state.ctx = new_ctx({ table, caption, span })
}

/**
 * Handle the end tag of a table, a row, a row group, a cell, or a caption.
 *
 * A cell's end tag is ignored while a table inside that cell is still open,
 * as a browser ignores it.
 */
function close_table_part(state: State, name: string): void {
  const ctx = state.ctx
  if (ctx.fake_tables > 0) {
    if (name === 'table') ctx.fake_tables -= 1
    if (name === 'table' || name === 'caption') break_block(ctx, 2)
    else if (!CELL_TAGS.has(name)) break_block(ctx, 1)
    return
  }
  if (CELL_TAGS.has(name)) {
    if (ctx.tables > 0) return
    if (ctx.cell !== undefined) close_cell(state)
    else if (name === 'caption') break_block(ctx, 2)
    return
  }
  const table = table_target(state)
  if (table === undefined) return
  if (name === 'table') pop_entry(state.ctx)
  else end_row(table)
}

/**
 * Take the page's `base` address, which relative links resolve against from then on. Only the first counts.
 */
function open_base(state: State, token: OpenToken): void {
  if (state.based) return
  const href = token.attrs.get('href')
  if (href === undefined) return
  state.based = true
  state.base = parse_url(decode_entities(href, true).trim(), state.base) ?? state.base
}

/**
 * Start dropping everything up to the matching end tag of an `svg` or a `template`.
 */
function open_skipped(state: State, token: OpenToken): void {
  if (token.name === 'svg' && token.self_closing) return
  state.skip = { name: token.name, depth: 1, foreign: 0 }
}

/**
 * Build the table of start tags that do more than break the flow, each with its handler.
 */
function openers(): ReadonlyMap<string, Opener> {
  const table = new Map<string, Opener>([
    ['br', open_break],
    ['hr', open_rule],
    ['img', open_image],
    ['a', open_link],
    ['pre', open_pre],
    [BLOCKQUOTE, open_quote],
    ['ul', open_list],
    ['ol', open_list],
    ['li', open_item],
    ['table', open_table],
    ['base', open_base],
    ['svg', open_skipped],
    ['template', open_skipped],
  ])
  for (const name of HEADINGS.keys()) table.set(name, open_heading)
  for (const name of CODE_TAGS) table.set(name, open_code)
  for (const name of ROW_TAGS) table.set(name, open_row)
  for (const name of CELL_TAGS) table.set(name, open_cell)
  return table
}

const OPENERS = openers()

/**
 * Build the table of end tags that do more than break the flow, each with its handler.
 */
function closers(): ReadonlyMap<string, Closer> {
  const table = new Map<string, Closer>([
    ['a', close_anchor],
    [BLOCKQUOTE, close_quote],
    ['ul', close_list],
    ['ol', close_list],
    ['li', close_item],
    ['table', close_table_part],
  ])
  for (const name of HEADINGS.keys()) table.set(name, close_heading)
  for (const name of CODE_TAGS) table.set(name, close_code_tag)
  for (const name of [...ROW_TAGS, ...CELL_TAGS]) table.set(name, close_table_part)
  return table
}

const CLOSERS = closers()

/**
 * Handle a tag while a `pre` is open, and say whether that was all the tag needed.
 *
 * Most tags in a `pre` are highlighting and are dropped. A `br` or a block
 * boundary is a new line of code, a `code` may name the language, and a tag
 * that cannot sit in a `pre` ends it and is then handled as usual.
 */
function handled_in_pre(ctx: Ctx, token: OpenToken | CloseToken): boolean {
  if (ctx.pre === undefined) return false
  const name = token.name
  if (PRE_ENDERS.has(name)) {
    end_pre(ctx)
    return false
  }
  if (token.kind === 'close') {
    if (name === 'pre') end_pre(ctx)
    else if (BLOCK_GAPS.has(name)) break_block(ctx, 1)
    return true
  }
  if (name === 'br') {
    ctx.parts.push('\n')
    ctx.spaced = true
  } else if (name === 'code') {
    if (ctx.pre === '' && ctx.parts.length === 0) ctx.pre = language_of(token.attrs)
  } else if (BLOCK_GAPS.has(name)) break_block(ctx, 1)
  return true
}

/**
 * Handle a start tag.
 */
function open_tag(state: State, token: OpenToken): void {
  if (handled_in_pre(state.ctx, token)) return
  const opener = OPENERS.get(token.name)
  if (opener !== undefined) {
    opener(state, token)
    return
  }
  const gap = BLOCK_GAPS.get(token.name)
  if (gap !== undefined) break_block(state.ctx, gap)
}

/**
 * Handle an end tag. One that matches nothing open is ignored.
 */
function close_tag(state: State, token: CloseToken): void {
  if (handled_in_pre(state.ctx, token)) return
  const closer = CLOSERS.get(token.name)
  if (closer !== undefined) {
    closer(state, token.name)
    return
  }
  const gap = BLOCK_GAPS.get(token.name)
  // A term's definition follows on the next line, with no blank line between.
  if (gap !== undefined) break_block(state.ctx, token.name === 'dt' ? 1 : gap)
}

/**
 * Handle a run of text between tags.
 */
function text_run(ctx: Ctx, raw: string): void {
  const text = decode_entities(raw, false)
  if (ctx.pre === undefined) {
    push_text(ctx, text)
    return
  }
  ctx.parts.push(text)
  ctx.spaced = text.endsWith('\n')
}

/**
 * While an `svg` or a `template` is being dropped, take a token and say whether it was dropped too.
 *
 * An `svg` that is never closed would swallow the rest of the page, so an
 * HTML tag that cannot belong to one ends the dropping, as it does in a
 * browser. Inside a `foreignObject` any HTML tag is legal, so the check is
 * off there.
 */
function dropped(state: State, token: Token): boolean {
  const skip = state.skip
  if (skip === undefined) return false
  if (token.kind === 'close') {
    if (token.name === skip.name) {
      skip.depth -= 1
      if (skip.depth === 0) state.skip = undefined
    } else if (token.name === FOREIGN_OBJECT && skip.foreign > 0) skip.foreign -= 1
    return true
  }
  if (token.kind !== 'open') return true
  const in_svg = skip.name === 'svg'
  if (token.name === skip.name) {
    if (!(in_svg && token.self_closing)) skip.depth += 1
    return true
  }
  if (!in_svg) return true
  if (token.name === FOREIGN_OBJECT) {
    if (!token.self_closing) skip.foreign += 1
    return true
  }
  if (skip.foreign > 0 || !SVG_BREAKOUT.has(token.name)) return true
  state.skip = undefined
  return false
}

/**
 * Convert an HTML document to markdown text.
 *
 * It has the signature of `WebToolsOptions.to_text`, so the two are
 * interchangeable. `url` is the page's own address, which relative links are
 * resolved against. Scripts, styles, `noscript`, `svg`, `template`, comments,
 * and the title are dropped. Headings, paragraphs, lists, links, code,
 * tables, and quotes are kept as markdown, and everything else is kept as
 * its text.
 */
export function html_to_text(html: string, url: string): string {
  const state: State = {
    ctx: new_ctx(undefined),
    outer: [],
    base: parse_url(url, undefined),
    based: false,
    skip: undefined,
  }
  const next = tokenizer(html)
  for (let token = next(); token !== undefined; token = next()) {
    if (dropped(state, token)) continue
    if (token.kind === 'text') text_run(state.ctx, token.text)
    else if (token.kind === 'open') open_tag(state, token)
    else if (token.kind === 'close') close_tag(state, token)
  }
  while (state.outer.length > 0) close_cell(state)
  pop_to(state.ctx, 0)
  flush_inline(state.ctx)
  return state.ctx.out.join('')
}

/**
 * The text of a document's `<title>`, with entities decoded and whitespace
 * collapsed, or undefined when it has none.
 *
 * Only the first title counts, and a `title` inside an `svg` is the name of a
 * drawing and not of the page.
 */
export function html_title(html: string): string | undefined {
  const next = tokenizer(html)
  let svg_depth = 0
  for (let token = next(); token !== undefined; token = next()) {
    if (token.kind === 'open' && token.name === 'svg' && !token.self_closing) svg_depth += 1
    else if (token.kind === 'close' && token.name === 'svg' && svg_depth > 0) svg_depth -= 1
    else if (token.kind === 'raw' && token.name === 'title' && svg_depth === 0) {
      const title = collapse(decode_entities(token.text, false)).trim()
      return title === '' ? undefined : title
    }
  }
  return undefined
}

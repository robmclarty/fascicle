import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { html_title, html_to_text } from '../html_to_text.js'

const PAGE = 'https://example.org/posts/tide/'

/**
 * Convert markup as a page at `PAGE`.
 */
const md = (html: string): string => html_to_text(html, PAGE)

/**
 * Read one of the HTML fixtures beside this file.
 */
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8')

/**
 * Run a conversion and return what it made with the milliseconds it took.
 */
const timed = (html: string): { text: string; ms: number } => {
  const start = performance.now()
  const text = md(html)
  return { text, ms: performance.now() - start }
}

/** Generous enough for a loaded machine, and far under what a quadratic pass over these inputs takes. */
const LINEAR_BUDGET_MS = 5000

describe('html_to_text on fixtures', () => {
  it('converts an article page, dropping its chrome of scripts, styles, svg, noscript, and template', () => {
    expect(md(fixture('article'))).toBe(
      [
        '[Home](https://example.org/) [Archive](https://example.org/archive) [About](https://example.org/about%20us)',
        '',
        '# The Tide & the Lighthouse',
        '',
        'By [Mara Ward](https://example.org/authors/m-ward) \u{b7} 12 March 2021',
        '',
        'The keeper\u{2019}s log is short, and most of it is weather. It runs to 3 \u{d7} 40 pages, kept in a tin box (see [the notes](https://example.org/posts/tide/notes.html#log)).',
        '',
        'The lighthouse at low tide',
        '',
        'Photo: the lamp room, 1\u{bd} miles out.',
        '',
        '## What the log says',
        '',
        '> Wind NNE, fresh. Lamp lit at 4.',
        '>',
        '> Nothing passed.',
        '',
        'Three things stand out:',
        '',
        '- The lamp was lit every night.',
        '- Supplies came by boat:',
        '  1. oil',
        '  2. flour & salt',
        '- Visitors were rare.',
        '',
        '## After 1950',
        '',
        'The light was automated.',
        'The log stops.',
        '',
        '---',
        '',
        '\u{a9} 2021 Coastal Notes. Write to [the editor](mailto:editor@example.org).',
      ].join('\n'),
    )
  })

  it('converts a docs page with code blocks, a table, and a base address', () => {
    expect(md(fixture('docs'))).toBe(
      [
        '- [retry](https://docs.example.com/v2/api/retry.html)',
        '- [Guide](https://docs.example.com/v2/guide/)',
        '',
        '# `retry(fn, options)`',
        '',
        'Calls `fn` until it succeeds. Pass `` `raw` `` names in `Ctrl`+`C` style.',
        '',
        '## Example',
        '',
        '```ts',
        'const result = await retry(() => fetch(url), {',
        '  attempts: 3,',
        '  on_error: (err) => console.log(`failed: ${err}`),',
        '})',
        '',
        '// <T> is inferred &amp; kept',
        '```',
        '',
        'From a shell:',
        '',
        '````sh',
        '$ npm install retry',
        "$ echo '```'",
        '````',
        '',
        '## Options',
        '',
        'Options of `retry`',
        '',
        '| Name | Type | Default | Notes |',
        '| --- | --- | --- | --- |',
        '| `attempts` | number | 3 | Total calls, the first included. |',
        '| `delay_ms` | number \\| function | 250 | See [backoff](https://docs.example.com/v2/api/backoff.html). May be a function. |',
        '| `on_error` | function |  |',
        '',
        '### Returns',
        '',
        'value',
        'Whatever `fn` returned.',
        '',
        'attempts',
        'How many calls it took.',
        '',
        '3. Install it.',
        '',
        '   Any version works.',
        '4. Import it.',
        '',
        '   ```',
        "   import { retry } from 'retry'",
        '   ```',
      ].join('\n'),
    )
  })

  it('converts a deliberately messy page without throwing or losing its text', () => {
    expect(md(fixture('messy'))).toBe(
      [
        'stray',
        '',
        'Quoted > signs',
        '',
        'First para with no closer',
        '',
        'Second para & without a semicolon, \u{a9} 2001, \u{ac}anentity; and AB\u{fffd}\u{2013}',
        '',
        '1 < 2 and 3 > 2, a <3 heart, and a stray',
        '',
        '- one',
        '- two bold both italic',
        '  - inner',
        '- three',
        '',
        'script link bad link [paren link](https://example.org/a%20%28b%29) no href [unclosed one](https://example.org/one) [two](https://example.org/two)',
        '',
        '| a \\| b | c |  |',
        '| --- | --- | --- |',
        '| wide |  | d |',
        '',
        'layout',
        '',
        '| x | y |',
        '| --- | --- |',
        '',
        'after an unclosed svg',
        '',
        '## Heading [link](https://example.org/posts/tide/#frag)',
        '',
        '```',
        '  keep   spaces',
        '\tand tabs <b>',
        'bold stays text',
        '```',
        '',
        '> quote ends the pre',
        '>',
        '> and goes on',
      ].join('\n'),
    )
  })

  it('reads the title of each fixture', () => {
    expect(html_title(fixture('article'))).toBe('The Tide & the Lighthouse \u{2014} Coastal Notes')
    expect(html_title(fixture('docs'))).toBe('retry \u{b7} API reference')
    expect(html_title(fixture('messy'))).toBe('Messy page')
  })
})

describe('html_to_text blocks', () => {
  it('returns an empty string for empty and for markup-only input', () => {
    expect(md('')).toBe('')
    expect(md('   \n\t ')).toBe('')
    expect(md('<div><p></p><ul><li></li></ul><blockquote></blockquote><pre></pre></div>')).toBe('')
  })

  it('writes each heading level with its marks', () => {
    expect(md('<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F</h6>')).toBe(
      '# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F',
    )
  })

  it('folds a line break inside a heading onto one line', () => {
    expect(md('<h2>A<br>B</h2>')).toBe('## A B')
  })

  it('gives an unclosed heading only its first block of text', () => {
    expect(md('<h2>Title<p>para<p>more')).toBe('## Title\n\npara\n\nmore')
    expect(md('<h1>\n<div>Title</div></h1><p>para</p>')).toBe('# Title\n\npara')
  })

  it('stops a heading at its end tag even when the levels differ', () => {
    expect(md('<h2>A</h3>b<h3></h3>c')).toBe('## A\n\nb\n\nc')
  })

  it('separates paragraphs and block elements with one blank line', () => {
    expect(md('<p>  a \n\t b  </p><p>c</p><div>d</div><section>e</section>f')).toBe('a b\n\nc\n\nd\n\ne\n\nf')
  })

  it('collapses whitespace, no-break spaces included, across inline tags', () => {
    expect(md('a&nbsp;&nbsp;b\u{a0}c <span> d </span> <b>e</b>f')).toBe('a b c d ef')
  })

  it('keeps a br as a line break and at most one empty line in a row', () => {
    expect(md('a <br> b<br><br><br>c<br>')).toBe('a\nb\n\nc')
    expect(md('<br><br>a')).toBe('a')
  })

  it('writes an hr as a rule', () => {
    expect(md('a<hr>b<hr/>')).toBe('a\n\n---\n\nb\n\n---')
  })

  it('writes an image as its alt text with entities decoded', () => {
    expect(md('<p>see <img src="x.png" alt="a &amp; b"> here <img src="y.png"><img alt=""></p>')).toBe('see a & b here')
  })

  it('writes a definition list as terms with their definitions on the next line', () => {
    expect(md('<dl><dt>a</dt><dd>1</dd><dt>b</dt><dd>2</dd><dd>3</dd></dl>')).toBe('a\n1\n\nb\n2\n3')
  })

  it('puts each option of a select on its own line', () => {
    expect(md('<select><option>a</option><option>b</option></select>')).toBe('a\nb')
  })

  it('ignores end tags that match nothing', () => {
    expect(md('a</li></ul></ol></blockquote></table></tr></td></th></caption></a></code></pre></h1></span>b')).toBe(
      'a\n\nb',
    )
    expect(md('a</span></b></a></code>b')).toBe('ab')
  })
})

describe('html_to_text lists', () => {
  it('writes nested unordered lists with two spaces of indent a level', () => {
    expect(md('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>')).toBe(
      '- a\n  - b\n    - c\n- d',
    )
  })

  it('numbers an ordered list from its start attribute', () => {
    expect(md('<ol><li>a</li><li>b</li></ol>')).toBe('1. a\n2. b')
    expect(md('<ol start="9"><li>a</li><li>b</li></ol>')).toBe('9. a\n10. b')
    expect(md('<ol start="0"><li>a</li></ol>')).toBe('0. a')
    expect(md('<ol start="x"><li>a</li></ol>')).toBe('1. a')
    expect(md('<ol start="-3"><li>a</li></ol>')).toBe('1. a')
    expect(md('<ol start="99999999999"><li>a</li></ol>')).toBe('999999999. a')
  })

  it('indents the later blocks of an item by the width of its marker', () => {
    expect(md('<ol start=10><li><p>a</p><p>b</p></li><li>c</li></ol>')).toBe('10. a\n\n    b\n11. c')
    expect(md('<ul><li><p>a</p><p>b</p></li></ul>')).toBe('- a\n\n  b')
  })

  it('keeps the items of a list on consecutive lines whatever they hold', () => {
    expect(md('<ul><li><p>a</p></li><li><div>b</div></li><li><h3>c</h3></li></ul>')).toBe('- a\n- b\n- ### c')
  })

  it('closes an item whose end tag was left out', () => {
    expect(md('<ul><li>a<li>b<li>c</ul>d')).toBe('- a\n- b\n- c\n\nd')
  })

  it('writes items outside any list as bullets', () => {
    expect(md('<li>a<li>b</li>c')).toBe('- a\n- b\nc')
  })

  it('mixes ordered and unordered lists', () => {
    expect(md('<ol><li>a<ul><li>b</li></ul></li><li>c<ol><li>d</li></ol></li></ol>')).toBe(
      '1. a\n   - b\n2. c\n   1. d',
    )
  })

  it('starts a list that opens an item on the line of the item', () => {
    expect(md('<ul><li><ul><li>x</li><li>y</li></ul></li></ul>')).toBe('- - x\n  - y')
  })

  it('puts a blank line before text that follows a nested list', () => {
    expect(md('<ul><li>a<ul><li>b</li></ul>more</li></ul>')).toBe('- a\n  - b\n\n  more')
  })

  it('separates a list from the paragraphs around it', () => {
    expect(md('<p>a</p><ul><li>b</li></ul><p>c</p>')).toBe('a\n\n- b\n\nc')
  })

  it('closes whatever is open inside a list when the list ends', () => {
    expect(md('<ul><li><blockquote>q</ul>after')).toBe('- > q\n\nafter')
  })

  it('skips an empty item without losing the count', () => {
    expect(md('<ol><li></li><li>b</li></ol>')).toBe('2. b')
  })
})

describe('html_to_text quotes', () => {
  it('prefixes each line of a quote, the blank ones included', () => {
    expect(md('<blockquote><p>a</p><p>b</p></blockquote>')).toBe('> a\n>\n> b')
  })

  it('nests quotes and returns to the outer margin', () => {
    expect(md('<blockquote>a<blockquote>b</blockquote>c</blockquote>d')).toBe('> a\n>\n> > b\n>\n> c\n\nd')
  })

  it('combines quote and list margins in either order', () => {
    expect(md('<blockquote><ul><li>a</li><li>b</li></ul></blockquote>')).toBe('> - a\n> - b')
    expect(md('<ul><li>a<blockquote>q</blockquote></li></ul>')).toBe('- a\n\n  > q')
  })

  it('closes a quote through an open list', () => {
    expect(md('<blockquote><ul><li>a</blockquote>b')).toBe('> - a\n\nb')
  })

  it('stops drawing margins past the depth limit', () => {
    expect(md(`${'<blockquote>'.repeat(30)}deep`)).toBe(`${'> '.repeat(24)}deep`)
    expect(md(`${'<blockquote>'.repeat(24)}a${'</blockquote>'.repeat(24)}b`)).toBe(`${'> '.repeat(24)}a\n\nb`)
    expect(md(`${'<blockquote>'.repeat(25)}a${'</blockquote>'.repeat(25)}b`)).toBe(`${'> '.repeat(24)}a\n\nb`)
  })
})

describe('html_to_text links', () => {
  it('resolves relative links against the page address', () => {
    expect(md('<a href="/a">1</a> <a href="b.html">2</a> <a href="../c">3</a> <a href="//cdn.example/x">4</a> <a href="#f">5</a> <a href="?q=1">6</a>')).toBe(
      '[1](https://example.org/a) [2](https://example.org/posts/tide/b.html) [3](https://example.org/posts/c) [4](https://cdn.example/x) [5](https://example.org/posts/tide/#f) [6](https://example.org/posts/tide/?q=1)',
    )
  })

  it('keeps an absolute link as it is', () => {
    expect(md('<a href="http://other.example/p?x=1">o</a>')).toBe('[o](http://other.example/p?x=1)')
  })

  it('decodes entities in an href without touching a bare name before an equals sign', () => {
    expect(md('<a href="/s?a=1&amp;b=2">x</a>')).toBe('[x](https://example.org/s?a=1&b=2)')
    expect(md('<a href="/s?a=1&copy=2&lt=3">x</a>')).toBe('[x](https://example.org/s?a=1&copy=2&lt=3)')
    expect(md('<a href="/s?a=1&copyx;">x</a>')).toBe('[x](https://example.org/s?a=1&copyx;)')
    expect(md('<a href="/&copy">x</a>')).toBe('[x](https://example.org/%C2%A9)')
    expect(md('<a href="/&copy;">x</a>')).toBe('[x](https://example.org/%C2%A9)')
    expect(md('<a href="/&bogus;">x</a>')).toBe('[x](https://example.org/&bogus;)')
  })

  it('trims an href and resolves it after a base element, the first one only', () => {
    expect(md('<a href="  /a\n">x</a>')).toBe('[x](https://example.org/a)')
    expect(md('<base href="https://b.example/dir/"><base href="https://c.example/"><a href="x">x</a>')).toBe(
      '[x](https://b.example/dir/x)',
    )
    expect(md('<base href="/root/"><a href="x">x</a>')).toBe('[x](https://example.org/root/x)')
    expect(md('<base target="_blank"><base href="/late/"><a href="x">x</a>')).toBe('[x](https://example.org/late/x)')
    expect(md('<base href="http://[bad"><a href="x">x</a>')).toBe('[x](https://example.org/posts/tide/x)')
  })

  it('degrades a link to its text when the href is missing, empty, bad, or not followable', () => {
    expect(md('<a>a</a> <a href="">b</a> <a href="http://[bad">c</a> <a href="javascript:alert(1)">d</a> <a href="data:text/html,x">e</a> <a href="ftp://f.example/">f</a>')).toBe(
      'a b c d e f',
    )
  })

  it('keeps mailto and tel links', () => {
    expect(md('<a href="mailto:a@b.example">m</a> <a href="tel:+15551234">t</a>')).toBe(
      '[m](mailto:a@b.example) [t](tel:+15551234)',
    )
  })

  it('degrades relative links to text when the page address does not parse, and keeps absolute ones', () => {
    expect(html_to_text('<a href="/x">a</a> <a href="https://b.example/">b</a>', 'not a url')).toBe(
      'a [b](https://b.example/)',
    )
  })

  it('encodes the characters that would end a markdown link early', () => {
    expect(md('<a href="/a (b)">x</a>')).toBe('[x](https://example.org/a%20%28b%29)')
    expect(md('<a href="mailto:a b@c.example?subject=<hi>">x</a>')).toBe('[x](mailto:a%20b@c.example?subject=%3Chi%3E)')
  })

  it('escapes square brackets in link text', () => {
    expect(md('<a href="/x">[1] a]</a>')).toBe('[\\[1\\] a\\]](https://example.org/x)')
  })

  it('moves whitespace at the ends of a link outside it', () => {
    expect(md('foo<a href="/x"> bar </a>baz')).toBe('foo [bar](https://example.org/x) baz')
    expect(md('foo <a href="/x"> bar</a> baz')).toBe('foo [bar](https://example.org/x) baz')
    expect(md('foo<a href="/x">bar</a>baz')).toBe('foo[bar](https://example.org/x)baz')
  })

  it('drops a link with no text and keeps the space it stood for', () => {
    expect(md('a<a href="/x"> </a>b')).toBe('a b')
    expect(md('a<a href="/x"></a>b')).toBe('ab')
    expect(md('a <a href="/x"></a> b')).toBe('a b')
    expect(md('a <a href="/x"><img src="i.png"></a>b')).toBe('a b')
  })

  it('folds a line break inside a link into a space', () => {
    expect(md('<a href="/x">a<br>b</a>')).toBe('[a b](https://example.org/x)')
  })

  it('uses an image alt as link text', () => {
    expect(md('<a href="/x"><img alt="Logo"></a>')).toBe('[Logo](https://example.org/x)')
  })

  it('closes an open link when another one opens', () => {
    expect(md('<a href="/1">one <a href="/2">two</a> three</a>')).toBe(
      '[one](https://example.org/1) [two](https://example.org/2) three',
    )
  })

  it('links each block when a link wraps several', () => {
    expect(md('<a href="/x"><h3>T</h3><p>d</p></a><p>e</p>')).toBe(
      '### [T](https://example.org/x)\n\n[d](https://example.org/x)\n\ne',
    )
  })

  it('writes a link inside code as code only, and code inside a link as both', () => {
    expect(md('<code><a href="/x">f</a></code>')).toBe('`f`')
    expect(md('<a href="/x"><code>f</code></a>')).toBe('[`f`](https://example.org/x)')
    expect(md('<a href="/x"><code>f</a> g')).toBe('[`f`](https://example.org/x) g')
  })

  it('takes the first of a repeated href', () => {
    expect(md('<a href="/1" href="/2">x</a>')).toBe('[x](https://example.org/1)')
  })
})

describe('html_to_text code', () => {
  it('wraps inline code, kbd, samp, and tt in backticks', () => {
    expect(md('<code>a</code> <kbd>b</kbd> <samp>c</samp> <tt>d</tt>')).toBe('`a` `b` `c` `d`')
  })

  it('fences inline code past the backticks it holds', () => {
    expect(md('<code>a`b</code>')).toBe('``a`b``')
    expect(md('<code>`x`</code>')).toBe('`` `x` ``')
    expect(md('<code>a``b`</code>')).toBe('``` a``b` ```')
    expect(md('<code>`a</code>')).toBe('`` `a ``')
  })

  it('moves whitespace out of inline code and drops empty code', () => {
    expect(md('a<code> b </code>c')).toBe('a `b` c')
    expect(md('a<code></code>b <code> </code>c')).toBe('ab c')
  })

  it('does not nest inline code', () => {
    expect(md('<code>a<code>b</code>c</code>')).toBe('`ab`c')
  })

  it('closes inline code at a block boundary', () => {
    expect(md('<code>a<p>b</code>c')).toBe('`a`\n\nbc')
  })

  it('keeps the whitespace of a pre and decodes its entities once', () => {
    expect(md('<pre>  a   b\n\tc\n\n  &lt;div&gt; &amp;amp; &nbsp;x</pre>')).toBe(
      '```\n  a   b\n\tc\n\n  <div> &amp;  x\n```',
    )
  })

  it('drops only the first newline of a pre and the whitespace at its end', () => {
    expect(md('<pre>\n\n a\n\n</pre>')).toBe('```\n\n a\n```')
    expect(md('<pre>a</pre>')).toBe('```\na\n```')
  })

  it('normalizes carriage returns in a pre', () => {
    expect(md('<pre>a\r\nb\rc</pre>')).toBe('```\na\nb\nc\n```')
  })

  it('reads the language of a code block from its class', () => {
    expect(md('<pre><code class="hljs language-js">x</code></pre>')).toBe('```js\nx\n```')
    expect(md('<pre class="lang-c++ wide">x</pre>')).toBe('```c++\nx\n```')
    expect(md('<pre class="language-py"><code class="language-js">x</code></pre>')).toBe('```py\nx\n```')
    expect(md('<pre>x<code class="language-js">y</code></pre>')).toBe('```\nxy\n```')
    expect(md('<pre class="language-a/b">x</pre>')).toBe('```\nx\n```')
    expect(md('<pre class="xlanguage-js language- languages-js">x</pre>')).toBe('```\nx\n```')
    expect(md(`<pre class="language-${'a'.repeat(33)}">x</pre>`)).toBe('```\nx\n```')
    expect(md(`<pre class="language-${'a'.repeat(32)}">x</pre>`)).toBe(`\`\`\`${'a'.repeat(32)}\nx\n\`\`\``)
  })

  it('drops highlighting tags, links, and inline code marks inside a pre', () => {
    expect(md('<pre><span class="k">let</span> <a href="/x">x</a> = <code>1</code> <img alt="no"></pre>')).toBe(
      '```\nlet x = 1\n```',
    )
  })

  it('reads a br and a block boundary inside a pre as a new line', () => {
    expect(md('<pre>a<br>b<br><br>c</pre>')).toBe('```\na\nb\n\nc\n```')
    expect(md('<pre><div>a</div><div>b</div><p>c</p>d</pre>')).toBe('```\na\nb\nc\nd\n```')
  })

  it('fences a code block past the backticks it holds', () => {
    expect(md('<pre>```\nx\n````</pre>')).toBe('`````\n```\nx\n````\n`````')
  })

  it('drops an empty pre and ignores a nested one', () => {
    expect(md('a<pre> \n </pre>b')).toBe('a\n\nb')
    expect(md('<pre>a<pre>b</pre>c</pre>d')).toBe('```\nab\n```\n\ncd')
  })

  it('writes a pre that is never closed', () => {
    expect(md('<p>a</p><pre>b\n c')).toBe('a\n\n```\nb\n c\n```')
  })

  it('ends a pre at a tag that cannot sit inside one', () => {
    expect(md('<pre>a<h2>b</h2>c')).toBe('```\na\n```\n\n## b\n\nc')
    expect(md('<ul><li><pre>a</li><li>b</li></ul>')).toBe('- ```\n  a\n  ```\n- b')
    expect(md('<pre>a<hr>b')).toBe('```\na\n```\n\n---\n\nb')
  })

  it('draws margins on every line of a code block, the blank ones included', () => {
    expect(md('<blockquote><pre>a\n\nb</pre></blockquote>')).toBe('> ```\n> a\n>\n> b\n> ```')
    expect(md('<ul><li>x<pre>a\n\n  b</pre></li></ul>')).toBe('- x\n\n  ```\n  a\n\n    b\n  ```')
  })
})

describe('html_to_text tables', () => {
  it('writes a table with its first row as the header', () => {
    expect(md('<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>')).toBe(
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
    )
    expect(md('<table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>')).toBe(
      '| 1 | 2 |\n| --- | --- |\n| 3 | 4 |',
    )
  })

  it('reads rows through thead, tbody, and tfoot', () => {
    expect(
      md('<table><thead><tr><th>a<th>b</thead><tbody><tr><td>1<td>2</tbody><tfoot><tr><td>3<td>4</tfoot></table>'),
    ).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
  })

  it('reads cells and rows whose end tags were left out', () => {
    expect(md('<table><tr><td>a<td>b<tr><td>c<td>d</table>e')).toBe('| a | b |\n| --- | --- |\n| c | d |\n\ne')
    expect(md('<table><td>a<td>b')).toBe('| a | b |\n| --- | --- |')
  })

  it('escapes pipes and folds a cell onto one line', () => {
    expect(md('<table><tr><td>a | b</td><td><p>x</p><p>y</p><ul><li>i</li><li>j</li></ul></td></tr></table>')).toBe(
      '| a \\| b | x y - i - j |\n| --- | --- |',
    )
    expect(md('<table><tr><td>a<br>b</td><td><pre>c\n  d</pre></td></tr></table>')).toBe(
      '| a b | ``` c d ``` |\n| --- | --- |',
    )
  })

  it('pads the header to the widest row and leaves short rows short', () => {
    expect(md('<table><tr><td>a</td></tr><tr><td>1</td><td>2</td><td>3</td></tr><tr><td>x</td></tr></table>')).toBe(
      '| a |  |  |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| x |',
    )
  })

  it('spreads a cell over the columns its colspan names, up to a limit', () => {
    expect(md('<table><tr><td colspan="2">a</td><td>b</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>')).toBe(
      '| a |  | b |\n| --- | --- | --- |\n| 1 | 2 | 3 |',
    )
    expect(md('<table><tr><td colspan="0">a</td><td colspan="x">b</td></tr></table>')).toBe('| a | b |\n| --- | --- |')
    expect(md('<table><tr><td colspan="1000">a</td></tr></table>')).toBe(
      `| a |${'  |'.repeat(15)}\n|${' --- |'.repeat(16)}`,
    )
  })

  it('writes a caption above its table', () => {
    expect(md('<table><caption>Cap<br>tion</caption><tr><td>a</td><td>b</td></tr></table>')).toBe(
      'Cap tion\n\n| a | b |\n| --- | --- |',
    )
    expect(md('<table><caption>only</caption></table>x')).toBe('only\n\nx')
  })

  it('writes a single-column table as blocks', () => {
    expect(md('<table><tr><td><p>a</p><p>b</p></td></tr><tr><td></td></tr><tr><td>c</td></tr></table>d')).toBe(
      'a\n\nb\n\nc\n\nd',
    )
  })

  it('writes a table that holds another as blocks, and the inner one as a table', () => {
    expect(
      md('<table><tr><td>nav</td><td><table><tr><td>x</td><td>y</td></tr></table>tail</td></tr></table>'),
    ).toBe('nav\n\n| x | y |\n| --- | --- |\n\ntail')
  })

  it('drops a table with no text in it', () => {
    expect(md('a<table><tr><td></td><td> </td></tr></table>b')).toBe('a\n\nb')
    expect(md('a<table></table>b<table><tr></tr></table>c')).toBe('a\n\nb\n\nc')
  })

  it('ignores a cell end tag while a table inside the cell is open', () => {
    expect(md('<table><tr><td><table><tr><td>x</td><td>y</td></tr></td><td>z</td></tr></table></td></tr></table>')).toBe(
      '| x | y |\n| --- | --- |\n| z |',
    )
  })

  it('closes a cell and what it holds at a row or table tag', () => {
    expect(md('<table><tr><td><ul><li>a<td>b</tr><tr><td>c<blockquote>q</table>d')).toBe(
      '| - a | b |\n| --- | --- |\n| c > q |\n\nd',
    )
    expect(md('<table><tr><td>a<td><b>b</tbody><tr><td>c</thead></table>')).toBe('| a | b |\n| --- | --- |\n| c |')
  })

  it('closes what is open between a table and its next cell', () => {
    expect(md('<table><tr><ul><li>stray<td>a<td>b</table>')).toBe('- stray\n\n| a | b |\n| --- | --- |')
  })

  it('writes text that sits in a table outside any cell before the table', () => {
    expect(md('<table>loose<tr><td>a<td>b</table>')).toBe('loose\n\n| a | b |\n| --- | --- |')
  })

  it('reads row and cell tags outside any table as lines and spaces', () => {
    expect(md('<tr><td>a</td><td>b</td></tr><tr><th>c<th>d</tr>')).toBe('a b\nc d')
    expect(md('x<caption>cap</caption>y<thead>z')).toBe('x\n\ncap\n\ny\nz')
  })

  it('draws the margins of a list or a quote on a table', () => {
    expect(md('<ul><li><table><tr><td>a<td>b<tr><td>c<td>d</table></li></ul>')).toBe(
      '- | a | b |\n  | --- | --- |\n  | c | d |',
    )
    expect(md('<blockquote>t<table><tr><td>a<td>b</table></blockquote>')).toBe('> t\n>\n> | a | b |\n> | --- | --- |')
  })

  it('reads tables nested past the depth limit as plain blocks', () => {
    const open = '<table><tr><td>'.repeat(6)
    expect(md(`${open}<table><caption>cap</caption><tr><td>a<td>b</td></tr><tr><td>c</table>after`)).toBe(
      'cap\n\na b\nc\n\nafter',
    )
    expect(md(`${'<table><tr><td>'.repeat(10)}x`)).toBe('x')
    expect(md(`${'<table><tr><td>'.repeat(5)}<table><tr><td>a<td>b</table>`)).toBe('| a | b |\n| --- | --- |')
    expect(md(`${open}<table><table><tr><td>a</table>b</table><tr><td>c<td>d</table>e`)).toBe(
      '| a b |  |\n| --- | --- |\n| c | d |\n\ne',
    )
  })

  it('writes a table opened directly inside another before the outer one', () => {
    expect(md('<table><tr><td>a<td>b</tr><table><tr><td>c<td>d</table></table>')).toBe(
      '| c | d |\n| --- | --- |\n\n| a | b |\n| --- | --- |',
    )
  })
})

describe('html_to_text dropped content', () => {
  it('drops a script whose strings hold end tags of other elements', () => {
    expect(md('a<script>var s = "</div></p><\\/script>"; if (a < b) x = "<p>";</script>b')).toBe('ab')
    expect(md('a<SCRIPT type="text/x">x</ScRiPt >b')).toBe('ab')
    expect(md('a<script>x</scripty>y</script\n>b')).toBe('ab')
    expect(md('a<script>x</script/>b')).toBe('ab')
  })

  it('drops the rest of the page after a script that is never closed', () => {
    expect(md('a<script>var x = 1; <p>hidden</p>')).toBe('a')
    expect(md('a<script>x</script')).toBe('a')
  })

  it('drops style, noscript, iframe, textarea, xmp, and title wherever they sit', () => {
    expect(
      md('a<style>p > b { color: red }</style><noscript><p>n</p></noscript><iframe><p>i</p></iframe><textarea><b>t</b></textarea><xmp><i>x</i></xmp><title>T</title>b'),
    ).toBe('ab')
  })

  it('drops an svg with what it holds, nested svg included', () => {
    expect(md('a<svg><g><text>t</text><svg><text>u</text></svg><text>v</text></g></svg>b')).toBe('ab')
    expect(md('a<svg/>b<svg />c')).toBe('abc')
    expect(md('a<svg><svg/><text>t</text></svg>b')).toBe('ab')
  })

  it('keeps HTML that follows an svg nobody closed', () => {
    expect(md('a<svg><circle r=1><text>t</text><p>b</p></svg>c')).toBe('a\n\nb\n\nc')
  })

  it('drops HTML inside a foreignObject of an svg', () => {
    expect(md('a<svg><foreignObject><div>f</div><p>g</p></foreignObject><text>t</text></svg>b')).toBe('ab')
    expect(md('a<svg><foreignObject/><text>t</text><p>b</p>')).toBe('a\n\nb')
    expect(md('a<svg></foreignObject><foreignObject></foreignObject></foreignObject><p>b</p>')).toBe('a\n\nb')
  })

  it('drops a template with what it holds, nested templates included', () => {
    expect(md('a<template><p>t</p><template><p>u</p></template><p>v</p></template>b')).toBe('ab')
    expect(md('a<template><svg></svg><p>t</p></template>b')).toBe('ab')
    expect(md('a<template/><p>t</p></template>b')).toBe('ab')
  })

  it('drops comments, including the short and the unterminated forms', () => {
    expect(md('a<!-- x > y <p>z</p> -- -->b')).toBe('ab')
    expect(md('a<!-->b<!--->c<!---->d')).toBe('abcd')
    expect(md('a<!-- never closed <p>b</p>')).toBe('a')
    expect(md('a<!--')).toBe('a')
    expect(md('a<!')).toBe('a')
  })

  it('drops declarations, processing instructions, and character data sections', () => {
    expect(md('<!DOCTYPE html><?xml version="1.0"?>a<!ELEMENT x>b<![CDATA[ c > d ]]>e')).toBe('abe')
    expect(md('a<![CDATA[ b > c')).toBe('a c')
    expect(md('a<![CDATA[ b >c<![CDATA[ d ]]>e')).toBe('ae')
    expect(md('a<![CDATA[ b >c<![CDATA[ d >e')).toBe('ace')
    expect(md('a<?php echo 1')).toBe('a')
  })

  it('drops head content and keeps the body', () => {
    expect(md('<html><head><meta charset="utf-8"><title>T</title><link rel="x" href="y"><style>s</style></head><body>b</body></html>')).toBe(
      'b',
    )
  })
})

describe('html_to_text entities', () => {
  it('decodes the common named references', () => {
    expect(md('&lt;&gt;&amp;&quot;&apos; &copy;&reg;&trade; &ndash;&mdash;&hellip; &lsquo;&rsquo;&ldquo;&rdquo; &laquo;&raquo; &bull;&middot;')).toBe(
      '<>&"\' \u{a9}\u{ae}\u{2122} \u{2013}\u{2014}\u{2026} \u{2018}\u{2019}\u{201c}\u{201d} \u{ab}\u{bb} \u{2022}\u{b7}',
    )
  })

  it('decodes accented letters, Greek, arrows, and math by their exact names', () => {
    expect(md('&eacute;&Eacute;&yuml;&szlig;&Agrave; &Alpha;&Rho;&Sigma;&Omega;&alpha;&rho;&sigmaf;&sigma;&omega; &larr;&uarr;&rarr;&darr;&harr;&rArr; &le;&ge;&ne;&times;&divide;&minus;&infin; &euro;&pound;&yen;&cent; &dagger;&Dagger;&prime;&Prime;&sbquo;&bdquo;&rfloor;&diams;&frac34;&sup2;')).toBe(
      '\u{e9}\u{c9}\u{ff}\u{df}\u{c0} \u{391}\u{3a1}\u{3a3}\u{3a9}\u{3b1}\u{3c1}\u{3c2}\u{3c3}\u{3c9} \u{2190}\u{2191}\u{2192}\u{2193}\u{2194}\u{21d2} \u{2264}\u{2265}\u{2260}\u{d7}\u{f7}\u{2212}\u{221e} \u{20ac}\u{a3}\u{a5}\u{a2} \u{2020}\u{2021}\u{2032}\u{2033}\u{201a}\u{201e}\u{230b}\u{2666}\u{be}\u{b2}',
    )
  })

  it('decodes the uppercase forms HTML allows and no others', () => {
    expect(md('&AMP;&LT;&GT;&QUOT;&COPY;&REG;&TRADE; &Amp; &Nbsp; &EACUTE;')).toBe('&<>"\u{a9}\u{ae}\u{2122} &Amp; &Nbsp; &EACUTE;')
  })

  it('decodes decimal and hexadecimal references, with or without the semicolon', () => {
    expect(md('&#65;&#x42;&#X43;&#x1F600;&#128512; &#65 &#x42 &#65x')).toBe('ABC\u{1f600}\u{1f600} A B Ax')
  })

  it('turns references to no character into the replacement character', () => {
    expect(md('&#0;&#xD800;&#xDFFF;&#x110000;&#99999999;&#xD7FF;&#xE000;&#x10FFFF;')).toBe(
      '\u{fffd}\u{fffd}\u{fffd}\u{fffd}\u{fffd}\u{d7ff}\u{e000}\u{10ffff}',
    )
  })

  it('reads the range 0x80 to 0x9f as Windows-1252', () => {
    expect(md('&#128;&#150;&#151;&#x99;&#159;&#127;&#160;x')).toBe('\u{20ac}\u{2013}\u{2014}\u{2122}\u{178}\u007f x')
  })

  it('reads a Latin-1 name with no semicolon, also at the head of a longer word', () => {
    expect(md('a &amp b &lt c &copy 2001 &copyright &notin; &notit; &ampere; AT&T &para1')).toBe(
      'a & b < c \u{a9} 2001 \u{a9}right \u{2209} \u{ac}it; &ere; AT&T \u{b6}1',
    )
  })

  it('leaves what is not a reference as it was written', () => {
    expect(md('& &; &#; &#x; &#xZ; &bogus; &b; &1; a&&b &hellip &rarr')).toBe('& &; &#; &#x; &#xZ; &bogus; &b; &1; a&&b &hellip &rarr')
  })

  it('decodes once, so an escaped reference stays visible', () => {
    expect(md('&amp;lt; &amp;amp; &#38;#38; &amp;#60;')).toBe('&lt; &amp; &#38; &#60;')
  })

  it('reads whitespace references as whitespace', () => {
    expect(md('a&Tab;b&NewLine;c&#10;d&#9;e&ensp;f')).toBe('a b c d e\u{2002}f')
  })

  it('stops a numeric reference at eight digits', () => {
    expect(md('&#000000065;&#x000000041;')).toBe('\u00065;\u00041;')
  })
})

describe('html_to_text malformed markup', () => {
  it('reads uppercase and mixed-case tags', () => {
    expect(md('<H1>T</H1><P>a<BR>b</P><UL><LI>c</LI></UL><A HREF="/x">d</A><PRE>e</PRE>')).toBe(
      '# T\n\na\nb\n\n- c\n\n[d](https://example.org/x)\n\n```\ne\n```',
    )
  })

  it('does not end a tag at a > inside a quoted attribute', () => {
    expect(md('<div title="a > b" data-x=\'c > d\'>text</div>')).toBe('text')
    expect(md('<a title="1 > 0" href="/x">t</a>')).toBe('[t](https://example.org/x)')
  })

  it('reads unquoted and oddly spaced attributes', () => {
    expect(md('<a href=/x>a</a> <a href = \'/y\' >b</a> <a\n\thref\n=\n"/z"\n>c</a> <a/href="/w">d</a> <a href=/v/>e</a>')).toBe(
      '[a](https://example.org/x) [b](https://example.org/y) [c](https://example.org/z) [d](https://example.org/w) [e](https://example.org/v/)',
    )
  })

  it('reads an attribute name that starts with an equals sign', () => {
    expect(md('<a =x href="/y">a</a> <a ==== href="/z">b</a>')).toBe('[a](https://example.org/y) [b](https://example.org/z)')
  })

  it('reads an attribute with no value and an empty unquoted value', () => {
    expect(md('<a hidden href="/x">a</a> <a href=>b</a> <ol reversed start=4><li>c</ol>')).toBe(
      '[a](https://example.org/x) b\n\n4. c',
    )
  })

  it('keeps a < that opens no tag as text', () => {
    expect(md('1 < 2, a<3, <<x>>, < p>, <1>, a <')).toBe('1 < 2, a<3, <>, < p>, <1>, a <')
    expect(md('a </')).toBe('a </')
    expect(md('<')).toBe('<')
  })

  it('drops an empty end tag and an end tag that names nothing', () => {
    expect(md('a</>b</ x>c</3>d')).toBe('abcd')
    expect(md('a</ never closed')).toBe('a')
  })

  it('reads self-closing forms of void tags', () => {
    expect(md('a<br/>b<br />c<hr/>d')).toBe('a\nb\nc\n\n---\n\nd')
  })

  it('reads attributes on an end tag without tripping on their quotes', () => {
    expect(md('<p>a</p title=">">b')).toBe('a\n\nb')
  })

  it('drops a tag the input ends inside', () => {
    expect(md('text<a href="x')).toBe('text')
    expect(md('text<div class=')).toBe('text')
    expect(md('text<div')).toBe('text')
    expect(md('text</div')).toBe('text')
    expect(md("text<p title='never closed >more")).toBe('text')
  })

  it('closes everything that is still open at the end of the input', () => {
    expect(md('<ul><li>a<blockquote>b<table><tr><td>c<td><a href="/x">d<code>e')).toBe(
      '- a\n\n  > b\n  >\n  > | c | [d`e`](https://example.org/x) |\n  > | --- | --- |',
    )
  })

  it('treats tags it does not know as inline', () => {
    expect(md('a<custom-el>b</custom-el><font>c</font><x:y>d</x:y>')).toBe('abcd')
  })

  it('never throws on a soup of fragments', () => {
    const fragments = ['<', '>', '</', '<!--', '-->', '<a href="', "'", '"', '<table>', '<td>', '</td>', '<li>', '</ul>', '<pre>', '</pre>', '<svg>', '<script>', '</script>', '&', '&#', ';', 'x', ' ', '\n', '<![CDATA[', ']]>', '<blockquote>', '<h1>', '</h2>', '<template>', '=', '/']
    let seed = 7
    for (let round = 0; round < 300; round += 1) {
      let html = ''
      for (let index = 0; index < 60; index += 1) {
        seed = (seed * 1103515245 + 12345) % 2147483648
        html += fragments[seed % fragments.length] ?? ''
      }
      expect(typeof md(html)).toBe('string')
      expect(() => html_title(html)).not.toThrow()
    }
  })
})

describe('html_to_text on hostile input', () => {
  const COUNT = 100_000

  it('survives a hundred thousand nested tags of each container kind', () => {
    for (const tag of ['div', 'span', 'blockquote', 'ul', 'ol', 'li', 'b', 'p', 'pre', 'code', 'svg', 'template', 'h1', 'td', 'tr']) {
      const { text, ms } = timed(`${`<${tag}>`.repeat(COUNT)}x${`</${tag}>`.repeat(COUNT)}y`)
      expect(typeof text).toBe('string')
      expect(ms).toBeLessThan(LINEAR_BUDGET_MS)
    }
  })

  it('keeps the text at the bottom of deep nesting', () => {
    expect(md(`${'<div>'.repeat(COUNT)}x${'</div>'.repeat(COUNT)}`)).toBe('x')
    expect(md(`${'<blockquote>'.repeat(COUNT)}x`)).toBe(`${'> '.repeat(24)}x`)
    expect(md(`${'<ul><li>'.repeat(COUNT)}x`)).toBe(`${'- '.repeat(24)}x`)
    expect(md(`${'<table><tr><td>'.repeat(COUNT)}x${'</td></tr></table>'.repeat(COUNT)}`)).toBe('x')
    expect(md(`${'<a href="/x">'.repeat(COUNT)}x`)).toBe('[x](https://example.org/x)')
  })

  it('stays linear on nested lists, tables, and links with text at every level', () => {
    for (const html of [
      '<ul><li>a'.repeat(COUNT),
      '<table><tr><td>a<td>b'.repeat(COUNT),
      '<a href="/x">a'.repeat(COUNT),
      '<blockquote>a<li>b'.repeat(COUNT),
      `${'<blockquote>'.repeat(COUNT)}${'</ul>'.repeat(COUNT)}${'<li>a'.repeat(COUNT)}`,
      `<p>${'<span>a</span> '.repeat(COUNT)}</p>`,
      `<pre>${'a\n'.repeat(COUNT)}</pre>`,
      `<table>${'<tr><td>a<td>b'.repeat(COUNT)}</table>`,
      `<table><tr>${'<td>a'.repeat(COUNT)}${'<tr><td>b'.repeat(COUNT)}</table>`,
      `<table><tr>${'<td colspan=1000>a'.repeat(COUNT)}</table>`,
    ]) {
      const { text, ms } = timed(html)
      expect(text.length).toBeGreaterThan(0)
      expect(ms).toBeLessThan(LINEAR_BUDGET_MS)
    }
  })

  it('stays linear on constructs that are opened over and over and never closed', () => {
    for (const html of [
      '<'.repeat(COUNT * 10),
      '</'.repeat(COUNT * 5),
      '<!'.repeat(COUNT * 5),
      '<!--'.repeat(COUNT * 3),
      '<![CDATA['.repeat(COUNT),
      '<![CDATA[>'.repeat(COUNT),
      '<?'.repeat(COUNT * 5),
      '<a "'.repeat(COUNT * 2),
      "<a href='".repeat(COUNT),
      '<a b=c '.repeat(COUNT),
      '<script>'.repeat(COUNT),
      '<script></scrip'.repeat(COUNT),
      '<title></titl'.repeat(COUNT),
      '<svg><foreignObject>'.repeat(COUNT),
      '&'.repeat(COUNT * 10),
      '&#'.repeat(COUNT * 5),
      '&amp'.repeat(COUNT * 2),
      `&${'a'.repeat(COUNT * 10)}`,
      `<pre>${' '.repeat(COUNT * 10)}x`,
      `<p>${' '.repeat(COUNT * 10)}x`,
      `<code>${'`'.repeat(COUNT)}</code>`,
      `<table><tr><td><pre>${' \n'.repeat(COUNT)}x</pre><td>y</table>`,
      `<a href="${'/x('.repeat(COUNT)}">y</a>`,
      `<div ${'a'.repeat(COUNT * 10)}>x`,
      `<${'a'.repeat(COUNT * 10)}`,
      `<p class="${' x'.repeat(COUNT)}">x`,
      `<pre class="${' language-'.repeat(COUNT)}">x`,
    ]) {
      const { text, ms } = timed(html)
      expect(typeof text).toBe('string')
      expect(ms).toBeLessThan(LINEAR_BUDGET_MS)
      const start = performance.now()
      html_title(html)
      expect(performance.now() - start).toBeLessThan(LINEAR_BUDGET_MS)
    }
  })

  it('converts a few megabytes of ordinary markup in linear time', () => {
    const row = '<tr><td>cell &amp; <a href="/x?y=1">link</a></td><td><code>code</code></td></tr>'
    const section = `<h2>Title</h2><p>Some <b>text</b> here.</p><ul><li>one<li>two</ul><table>${row.repeat(5)}</table><pre>x\n  y</pre>`
    const { text, ms } = timed(section.repeat(8000))
    expect(text.startsWith('## Title\n\nSome text here.\n\n- one\n- two\n\n| cell & [link](https://example.org/x?y=1) | `code` |\n| --- | --- |')).toBe(true)
    expect(text.endsWith('```\nx\n  y\n```')).toBe(true)
    expect(ms).toBeLessThan(LINEAR_BUDGET_MS)
  })
})

describe('html_title', () => {
  it('returns the text of the title with entities decoded and whitespace collapsed', () => {
    expect(html_title('<html><head><title>\n  A &amp; B &mdash;\tC&nbsp;D \n</title></head></html>')).toBe('A & B \u{2014} C D')
  })

  it('returns undefined when the page has no title or an empty one', () => {
    expect(html_title('')).toBeUndefined()
    expect(html_title('<html><body><h1>Not a title</h1></body></html>')).toBeUndefined()
    expect(html_title('<title></title>')).toBeUndefined()
    expect(html_title('<title> \n&nbsp;</title>')).toBeUndefined()
  })

  it('takes the first title only, even when it is empty', () => {
    expect(html_title('<title>One</title><title>Two</title>')).toBe('One')
    expect(html_title('<title></title><title>Two</title>')).toBeUndefined()
  })

  it('reads a title in any case and with attributes', () => {
    expect(html_title('<TITLE lang="en">Loud</TITLE >')).toBe('Loud')
  })

  it('keeps markup inside the title as text', () => {
    expect(html_title('<title>a <b>bold</b> &lt;i&gt; title</title>')).toBe('a <b>bold</b> <i> title')
  })

  it('reads a title that is never closed to the end of the input', () => {
    expect(html_title('<title>Open <p>ended')).toBe('Open <p>ended')
  })

  it('skips a title inside a comment, a script, or an svg', () => {
    expect(html_title('<!-- <title>No</title> --><script>"<title>No</title>"</script><svg><title>Icon</title></svg><title>Yes</title>')).toBe(
      'Yes',
    )
    expect(html_title('<svg><svg><title>Icon</title></svg><title>Still icon</title></svg><title>Yes</title>')).toBe('Yes')
    expect(html_title('<svg/><title>Yes</title>')).toBe('Yes')
    expect(html_title('</svg><title>Yes</title>')).toBe('Yes')
    expect(html_title('<svg></svg></svg><svg><title>Icon</title></svg><title>Yes</title>')).toBe('Yes')
  })
})

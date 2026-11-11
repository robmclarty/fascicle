/**
 * The built-in HTML converter of `web_fetch`: a page's markup in, markdown
 * the model can read out.
 */

/**
 * Convert an HTML document to markdown text.
 *
 * It has the signature of `WebToolsOptions.to_text`, so the two are
 * interchangeable. `url` is the page's own address, which relative links are
 * resolved against.
 */
export function html_to_text(html: string, url: string): string {
  throw new Error(`not implemented: html_to_text(${String(html.length)}, ${url})`)
}

/**
 * The text of a document's `<title>`, with entities decoded and whitespace
 * collapsed, or undefined when it has none.
 */
export function html_title(html: string): string | undefined {
  throw new Error(`not implemented: html_title(${String(html.length)})`)
}

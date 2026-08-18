/**
 * text_of: the user-visible prompt text of a captured GenerateOptions.
 *
 * Capture assertions care about what the model was asked, not how the prompt
 * was encoded. A prompt is a bare string or a Message[] whose user turns
 * carry either a string or typed content parts; navigating
 * `calls[0].prompt[0].content[0].text` by hand couples every assertion to
 * one encoding. System and assistant text are excluded on purpose: assert
 * those through `opts.system` and the raw messages.
 */

import type { GenerateOptions } from '#engine'

/**
 * Flatten the prompt's user-facing text into one string: a string prompt
 * verbatim, otherwise every user turn's text (string content, or the `text`
 * parts of a content-part array) joined with newlines. Total: absent or
 * non-text content yields ''.
 */
export function text_of<t = unknown>(opts: GenerateOptions<t>): string {
  if (typeof opts.prompt === 'string') return opts.prompt
  const texts: string[] = []
  for (const message of opts.prompt) {
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') {
      texts.push(message.content)
      continue
    }
    for (const part of message.content) {
      if (part.type === 'text') texts.push(part.text)
    }
  }
  return texts.join('\n')
}

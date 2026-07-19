/**
 * Privacy screen for the incoming question. Questions arrive from humans and
 * may embed emails or account numbers; scrub the obvious shapes before the
 * text reaches retrieval or the model. This is also the seam where richer
 * filtering would attach.
 */

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g
const LONG_DIGITS = /\b\d{7,}\b/g

export function screen_question(question: string): string {
  return question.replace(EMAIL, '[redacted-email]').replace(LONG_DIGITS, '[redacted-number]')
}

/**
 * hello_claude_cli_lisp: the same harness as hello_claude_cli.ts, rewritten in
 * a Lisp-flavored style. Functionally identical — different shape.
 *
 * The point of this example is pedagogical: TypeScript is an expression
 * language hiding inside a statement language, and if you lean on that you can
 * write something that maps almost line-for-line onto Scheme. Each technique
 * below is annotated so you can see the correspondence.
 *
 * Scheme shadow of the whole program (read top-to-bottom):
 *
 *   (define engine
 *     (create-engine
 *       '((providers ((claude-cli ((auth-mode . oauth)))))
 *         (defaults  ((model . cli-sonnet)
 *                     (system . "Reply in one short sentence. No preamble."))))))
 *
 *   (define (hello input)
 *     (run (sequence
 *            (list (model-call engine)
 *                  (step 'extract
 *                    (lambda (r)
 *                      (if (string? (content r))
 *                          (content r)
 *                          (to-json (content r)))))))
 *          input
 *          '((install-signal-handlers . #f))))
 *
 *   (define (main argv)
 *     (let ((input (if (null? argv) "say hello to fascicle" (join " " argv))))
 *       (dynamic-wind
 *         (lambda () '())
 *         (lambda () (display-pair input (hello input)))
 *         (lambda () (dispose engine)))))
 *
 * Run directly:
 *   pnpm exec tsx examples/hello_claude_cli_lisp.ts
 *   pnpm exec tsx examples/hello_claude_cli_lisp.ts "your prompt here"
 */

import {
  create_engine,
  model_call,
  run,
  sequence,
  step,
  type GenerateResult,
} from '@repo/fascicle';

// ── (define engine ...) ──────────────────────────────────────────────────────
// Straight `const`. This is the one spot where Lisp and JS agree exactly: a
// top-level binding to a constructed value. No tricks here.
const engine = create_engine({
  providers: { claude_cli: { auth_mode: 'oauth' } },
  defaults: {
    model: 'cli-sonnet',
    system: 'Reply in one short sentence. No preamble.',
  },
});

// ── (define (hello input) ...) ───────────────────────────────────────────────
// Single-expression function body via arrow + implicit return. In Lisp every
// function is an expression tree; here we build that tree inline instead of
// introducing `ask`, `extract`, and `flow` bindings. The `sequence([...])`
// argument is effectively an s-expression: `(sequence (list a b))`.
//
// Lisp-isms in play:
//   • Nested call composition — no intermediate `const` bindings.
//   • `step` takes an inline lambda, the TS analogue of `(lambda (r) ...)`.
//   • Destructuring `{ content }` stands in for a Scheme `(let ((content ...))
//     ...)` at the top of the lambda body.
//   • The ternary `typeof content === 'string' ? content : JSON.stringify(...)`
//     is an `(if ...)` expression — it *evaluates to* a value, unlike an
//     `if`-statement which merely executes.
const hello = (input: string): Promise<string> =>
  run(
    sequence([
      model_call({ engine }),
      step('extract', ({ content }: GenerateResult<unknown>): string =>
        typeof content === 'string' ? content : JSON.stringify(content)),
    ]),
    input,
    { install_signal_handlers: false },
  );

// ── exported entry point ─────────────────────────────────────────────────────
// `async` + single expression body keeps this as one expression: the return
// value is an object literal whose `output` field is the awaited promise.
// Equivalent to `(let ((output (hello input))) (list (cons 'input input)
// (cons 'output output)))` in Scheme.
export const run_hello_claude_cli_lisp = async (
  input = 'say hello to fascicle',
): Promise<{ readonly input: string; readonly output: string }> =>
  ({ input, output: await hello(input) });

// ── (define (main argv) ...) ─────────────────────────────────────────────────
// The whole CLI block is a single expression. Two Lisp techniques do the work:
//
//   1. IIFE as `let`. In Scheme, `(let ((x v)) body)` desugars to
//      `((lambda (x) body) v)`. That's literally what the outer
//      `((argv) => ...)(process.argv.slice(2).join(' '))` is — a lambda applied
//      to its bound value, establishing `argv` for the inner expression.
//
//   2. Comma operator as `begin`. Inside `.then(...)` we need to run two
//      `console.log` calls and yield a value. A statement block can't appear
//      in an arrow body that expects an expression, so we use the comma
//      operator: `(a, b)` evaluates `a`, discards it, evaluates `b`, returns
//      `b`. That matches Scheme's `(begin a b)` exactly.
//
// `.finally(() => void engine.dispose())` plays the role of the cleanup thunk
// in `(dynamic-wind before thunk after)` — it runs whether the promise
// resolved or rejected.
if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  void ((argv) =>
    run_hello_claude_cli_lisp(argv.length > 0 ? argv : undefined)
      .then(({ input, output }) => (
        console.log(`input:  ${input}`),
        console.log(`output: ${output}`)
      ))
      .catch((err: unknown) => (console.error(err), process.exit(1)))
      .finally(() => void engine.dispose())
  )(process.argv.slice(2).join(' '));
}

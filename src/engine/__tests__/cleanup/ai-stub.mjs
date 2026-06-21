/**
 * Stub for the `ai` module used by the engine SIGINT harness.
 *
 * Replaces `generateText` and `streamText` with abort-aware long waits so the
 * child process deterministically has an in-flight provider call at the
 * moment SIGINT arrives, without any network I/O. Only the shapes the engine
 * touches at runtime are stubbed — `tool`, `stepCountIs`, and the two call
 * entry points.
 */

export function stepCountIs(n) {
  return { stepCountIs: n };
}

export function tool(def) {
  return { type: 'tool', description: def.description, inputSchema: def.inputSchema };
}

// The engine statically imports these from `ai`; ESM linking requires the
// stub to provide them even though this harness never exercises a schema.
// isInstance is called on every generateText rejection (including the abort
// path here), so it must return false for non-schema errors rather than be
// absent.
export const Output = {
  object(cfg) {
    return { name: 'object', schema: cfg.schema };
  },
};

export const NoObjectGeneratedError = {
  isInstance() {
    return false;
  },
};

function hang_until_abort(abort_signal) {
  return new Promise((_, reject) => {
    const keepalive = setInterval(() => {}, 1_000);
    const fail = () => {
      clearInterval(keepalive);
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (abort_signal?.aborted) {
      fail();
      return;
    }
    abort_signal?.addEventListener('abort', fail, { once: true });
  });
}

export async function generateText(params) {
  await hang_until_abort(params.abortSignal);
  throw new Error('unreachable');
}

export function streamText(params) {
  async function* gen() {
    await hang_until_abort(params.abortSignal);
    yield { type: 'text-delta', text: '' };
  }
  return { fullStream: gen() };
}

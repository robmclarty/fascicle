/**
 * The ACP agent's serving loop, minus the process.
 *
 * `serve_streams` is everything `serve_acp` does once the console and the
 * signals are handled: connect `acp_agent` to a pair of ndjson byte streams,
 * hold the connection until the client hangs up or `shutdown` fires, then
 * dispose the engine. It takes its streams as arguments, mirroring
 * `execute_stdio` under `run_stdio`, so the disconnect path is unit-tested
 * here and the thin glue in `serve_acp.ts` owns the real stdin and stdout.
 *
 * Closing the connection is what aborts the runs: the SDK aborts every
 * in-flight request's signal as it closes, and each prompt turn's run
 * listens on its request's signal. So by the time `closed` resolves, every
 * active run has seen its abort, and only then is the engine disposed.
 */

import { acp_agent } from './acp_agent.js'
import { load_acp_sdk } from './sdk_loader.js'
import type { ServeAcpConfig } from './types.js'

type AcpServeIo = {
  /** What the client sends, as ndjson bytes; stdin under `serve_acp`. */
  readonly input: ReadableStream<Uint8Array>
  /** Where the protocol goes, as ndjson bytes; stdout under `serve_acp`. */
  readonly output: WritableStream<Uint8Array>
  /** Ends the connection from the agent's side, aborting every active run with its reason. */
  readonly shutdown?: AbortSignal | undefined
}

/**
 * Serve the config's flow as an ACP agent over `io` until the client
 * disconnects or `io.shutdown` fires, then dispose the engine once every
 * active run has been aborted.
 */
export async function serve_streams<i, o>(config: ServeAcpConfig<i, o>, io: AcpServeIo): Promise<void> {
  const sdk = await load_acp_sdk()
  const app = await acp_agent(config)
  const connection = app.connect(sdk.ndJsonStream(io.output, io.input))
  const { shutdown } = io
  if (shutdown !== undefined) {
    // A signal can land while the SDK loads, before there is a listener to hear it.
    if (shutdown.aborted) connection.close(shutdown.reason)
    else shutdown.addEventListener('abort', () => connection.close(shutdown.reason))
  }
  await connection.closed
  await config.engine?.dispose()
}
